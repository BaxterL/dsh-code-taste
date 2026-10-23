/**
 * dsh-code-taste: learns the user's coding conventions from explicit instructions
 * and corrections, stores them as confidence-scored rules in human-editable
 * markdown, and injects the active ones into each session's prompt.
 *
 * @module dsh-code-taste
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome, tasteDir, writeAtomic } from './lib/paths.js'
import {
  appendEvidence,
  contentId,
  identityOf,
  loadScope,
  loadScopeSync,
  loadState,
  loadStateSync,
  mergeScopes,
  parseMarkdown,
  readEvidence,
  renderMarkdown,
  saveScope,
  saveState,
  similarity,
} from './lib/store.js'
import { baseConfidence, classify, inferCategory, prefilter, toRuleText } from './lib/signals.js'
import { renderPrompt, selectRules } from './lib/inject.js'
import { canExtract, describeConfig, resolveConfig } from './lib/config.js'
import { complete, completeWithHost } from './lib/llm.js'
import { runExtraction } from './lib/extract.js'
import { createTasteTool } from './lib/tool.js'

export const name = 'taste'
export const inject = ['tools', 'systemPrompt', 'workingDirectory']

const MAX_PENDING = 20
const AUTO_CONFIDENCE = 0.5
const REINFORCE_STEP = 0.1
const APPROVE_STEP = 0.05
const CONFIDENCE_CEILING = 0.95
const SIMILARITY_MERGE = 0.8

/** @returns {string} plain text of a user message's content blocks. */
function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

/** @returns {string} a stable session id, synthesised when the session has none. */
function createSessionIdentity() {
  const known = new WeakMap()
  let counter = 0
  return session => {
    if (!session || typeof session !== 'object') return `s${++counter}`
    if (typeof session.id === 'string' && session.id.length > 0) return session.id
    let id = known.get(session)
    if (id === undefined) {
      id = `s${++counter}`
      known.set(session, id)
    }
    return id
  }
}

/**
 * Register the taste plane: capture, store, inject, and expose the tool.
 * @param {object} ctx - plugin context carrying tools, systemPrompt, workingDirectory.
 * @param {object} [rawConfig] - the row's config: mode, injection budget, model route.
 */
export function apply(ctx, rawConfig) {
  try {
    start(ctx, rawConfig)
  } catch (error) {
    reportBootError(ctx, error, 'apply')
  }
}

/**
 * Record a boot failure where the user can find it: the host only reports
 * "failed", so a stack in ~/.dsh/taste/boot-error.log is the only lead.
 */
function reportBootError(ctx, error, stage) {
  const message = `[${new Date().toISOString()}] ${stage}: ${error?.stack ?? String(error)}`
  try {
    ctx.logger?.warn?.('taste boot failed: %s', message)
  } catch {
    // logging must never be the thing that fails
  }
  try {
    const dir = join(dshHome(), 'taste')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'boot-error.log'), `${message}\n`)
  } catch {
    // a read-only home is not worth crashing for
  }
}

function start(ctx, rawConfig) {
  const { config, warnings } = resolveConfig(rawConfig)
  if (warnings.length > 0) ctx.logger?.warn?.('taste: %s', warnings.join('; '))
  const sessionIdOf = createSessionIdentity()
  /** session id -> unclaimed corrections */
  const pending = new Map()
  /** session id -> frozen merged rules */
  const snapshots = new Map()
  /** session id -> working directory the snapshot was built from */
  const cwds = new Map()
  /** session id -> ids already counted as used */
  const used = new Map()
  let fallbackRegistered = false
  let fallbackSessionId

  const cwdOf = session => {
    try {
      const path = ctx.workingDirectory.get(session)
      if (typeof path === 'string' && path.length > 0) return path
    } catch {
      // fall through
    }
    return process.cwd()
  }

  const attachState = (rules, state) =>
    rules.map(rule => {
      const record = state[rule.id]
      if (!record) return rule
      return {
        ...rule,
        created: record.created,
        lastSeen: record.lastSeen,
        lastUsed: record.lastUsed,
      }
    })

  const mergeFor = cwd => {
    const projectDir = tasteDir(cwd, 'project')
    const globalDir = tasteDir(cwd, 'global')
    const project = attachState(loadScopeSync(projectDir, 'project'), loadStateSync(projectDir))
    const global = attachState(loadScopeSync(globalDir, 'global'), loadStateSync(globalDir))
    return mergeScopes(project, global)
  }

  const refresh = (sessionId, cwd) => {
    cwds.set(sessionId, cwd)
    snapshots.set(sessionId, mergeFor(cwd))
  }

  /** Rebuild every live session snapshot that belongs to one workspace. */
  const refreshWorkspace = cwd => {
    for (const [sessionId, path] of cwds) {
      if (path === cwd) snapshots.set(sessionId, mergeFor(cwd))
    }
  }

  const renderFor = sessionId => {
    const rules = snapshots.get(sessionId) ?? []
    const pendingCount = rules.filter(rule => rule.status === 'pending').length
    markUsed(sessionId, rules)
    return renderPrompt(rules, { pendingCount, budget: config.injectBudgetChars })
  }

  const markUsed = (sessionId, rules) => {
    const cwd = cwds.get(sessionId)
    if (cwd === undefined) return
    const chosen = selectRules(rules)
    if (chosen.length === 0) return
    for (const rule of chosen) {
      const dir = tasteDir(cwd, rule.scope === 'global' ? 'global' : 'project')
      // usage is best-effort bookkeeping; a failure must never break assembly
      loadState(dir)
        .then(state => {
          const record = state[rule.id] ?? { created: new Date().toISOString() }
          state[rule.id] = {
            ...record,
            lastUsed: new Date().toISOString(),
            recalled: (record.recalled ?? 0) + 1,
          }
          return saveState(dir, state)
        })
        .catch(() => {})
    }
  }

  const registerContext = (scoped, sessionId) => {
    const isScoped = scoped && scoped !== ctx && typeof scoped.systemPrompt?.context === 'function'
    try {
      if (!isScoped) {
        if (fallbackRegistered) return
        fallbackRegistered = true
        fallbackSessionId = sessionId
        ctx.logger?.info?.('taste: event context is not agent-scoped; using one global prompt section')
        ctx.systemPrompt.context({
          name: 'taste',
          order: 920,
          required: false,
          text: () => renderFor(fallbackSessionId),
        })
        return
      }
      ctx.logger?.info?.('taste: registered an agent-scoped prompt section')
      scoped.systemPrompt.context({
        name: 'taste',
        order: 920,
        required: false,
        text: () => renderFor(sessionId),
      })
    } catch (error) {
      ctx.logger?.warn?.('taste: prompt section registration failed: %o', error)
    }
  }

  const findRule = async (cwd, id) => {
    for (const scope of ['project', 'global']) {
      const dir = tasteDir(cwd, scope)
      const rules = await loadScope(dir, scope)
      const rule = rules.find(candidate => candidate.id === id)
      if (rule) return { dir, scope, rules, rule }
    }
    return undefined
  }

  const addRule = async (cwd, input) => {
    const scope = input.scope === 'project' ? 'project' : 'global'
    const dir = tasteDir(cwd, scope)
    const rules = await loadScope(dir, scope)
    const state = await loadState(dir)
    const identity = identityOf(input.text)
    let existing = rules.find(rule => identityOf(rule.text) === identity)
    if (!existing) {
      let best = 0
      for (const rule of rules) {
        const score = similarity(rule.text, input.text)
        if (score > best) {
          best = score
          existing = rule
        }
      }
      if (best < SIMILARITY_MERGE) existing = undefined
    }
    const now = new Date().toISOString()
    const base = typeof input.confidence === 'number' ? input.confidence : baseConfidence(input.kind)
    let rule
    let created = false
    if (existing) {
      existing.confidence = Math.min(CONFIDENCE_CEILING, existing.confidence + REINFORCE_STEP)
      existing.evidenceCount += 1
      if (existing.evidenceCount >= 2) existing.status = 'active'
      if (input.category) existing.category = input.category
      if (input.glob) existing.glob = input.glob
      state[existing.id] = { created: state[existing.id]?.created ?? now, lastSeen: now }
      rule = existing
    } else {
      created = true
      rule = {
        id: contentId(input.text),
        text: input.text,
        category: input.category || inferCategory(input.text),
        scope,
        glob: input.glob,
        confidence: Math.min(CONFIDENCE_CEILING, Math.max(0.1, base)),
        evidenceCount: 1,
        source: input.source ?? input.kind ?? 'explicit',
        status: base >= 0.55 ? 'active' : 'pending',
        pinned: input.pinned === true,
        ineffective: 0,
      }
      state[rule.id] = { created: now, lastSeen: now }
      rules.push(rule)
    }
    await saveScope(dir, scope, rules)
    await saveState(dir, state)
    await appendEvidence(dir, {
      id: rule.id,
      at: now,
      kind: input.kind ?? 'explicit',
      patterns: input.patterns,
      quote: String(input.quote ?? input.text).slice(0, 200),
    })
    return { rule, created }
  }

  const reinforceRule = async (cwd, id) => {
    const found = await findRule(cwd, id)
    if (!found) return false
    const { dir, scope, rules, rule } = found
    rule.confidence = Math.min(CONFIDENCE_CEILING, rule.confidence + REINFORCE_STEP)
    rule.evidenceCount += 1
    rule.status = 'active'
    const state = await loadState(dir)
    state[id] = { created: state[id]?.created ?? new Date().toISOString(), lastSeen: new Date().toISOString() }
    await saveScope(dir, scope, rules)
    await saveState(dir, state)
    await appendEvidence(dir, { id, at: new Date().toISOString(), kind: 'positive', quote: 'positive feedback' })
    return true
  }

  const approveRule = async (cwd, id) => {
    const found = await findRule(cwd, id)
    if (!found) return false
    const { dir, scope, rules, rule } = found
    rule.status = 'active'
    rule.confidence = Math.min(CONFIDENCE_CEILING, Math.max(rule.confidence, 0.6) + APPROVE_STEP)
    const state = await loadState(dir)
    state[id] = { created: state[id]?.created ?? new Date().toISOString(), lastSeen: new Date().toISOString() }
    await saveScope(dir, scope, rules)
    await saveState(dir, state)
    await appendEvidence(dir, { id, at: new Date().toISOString(), kind: 'approved', quote: 'approved by user' })
    return true
  }

  const forgetRule = async (cwd, id, requestedScope) => {
    let removed = 0
    const scopes = requestedScope === 'global' ? ['global'] : requestedScope === 'project' ? ['project'] : ['project', 'global']
    for (const scope of scopes) {
      const dir = tasteDir(cwd, scope)
      const rules = await loadScope(dir, scope)
      const next = rules.filter(rule => rule.id !== id)
      if (next.length === rules.length) continue
      removed += rules.length - next.length
      const state = await loadState(dir)
      delete state[id]
      await saveScope(dir, scope, next)
      await saveState(dir, state)
    }
    return removed
  }

  const exportTaste = async (cwd, format) => {
    const rules = mergeFor(cwd).filter(rule => rule.status === 'active')
    if (rules.length === 0) return undefined
    const body = [
      '# Coding conventions',
      '',
      'Learned from this user\'s own corrections. Generated by dsh-code-taste; edit the rules in `.dsh/taste/TASTE.md` instead.',
      '',
      ...rules.map(rule => `- ${rule.text}`),
      '',
    ].join('\n')
    const name = format === 'claude' ? 'CLAUDE.taste.md' : 'AGENTS.taste.md'
    const path = join(tasteDir(cwd, 'project'), 'export', name)
    await writeAtomic(path, body)
    return path
  }

  const lastExtract = new Map()
  const extracting = new Set()
  let warnedHostRoute = false

  /** Resolve the model route the user picked: none / host / custom. */
  const resolveCallModel = () => {
    if (config.model.source === 'custom') {
      return prompt => complete(config, prompt)
    }
    const llm = ctx.get?.('llm')
    const selection = ctx.get?.('agentDefaultModel')?.currentSelection?.()
    if (!llm || !selection) {
      if (!warnedHostRoute) {
        warnedHostRoute = true
        ctx.logger?.warn?.('taste: model.source is "host" but the harness model route is unavailable; extraction skipped')
      }
      return undefined
    }
    return prompt =>
      completeWithHost(llm, selection, prompt, {
        maxOutputTokens: config.model.maxOutputTokens,
        temperature: config.model.temperature,
      })
  }

  /** One small call per batch, throttled per session. */
  const maybeExtract = (sessionId, cwd) => {
    if (!canExtract(config)) return
    const queue = pending.get(sessionId) ?? []
    if (queue.length < config.extract.minPending) return
    if (extracting.has(sessionId)) return
    const last = lastExtract.get(sessionId) ?? 0
    if (Date.now() - last < config.extract.throttleMinutes * 60_000) return
    const callModel = resolveCallModel()
    if (callModel === undefined) return
    const batch = [...queue]
    extracting.add(sessionId)
    lastExtract.set(sessionId, Date.now())
    runExtraction({ config, pending: batch, cwd, addRule, callModel })
      .then(stored => {
        const rest = (pending.get(sessionId) ?? []).filter(entry => !batch.includes(entry))
        pending.set(sessionId, rest)
        refreshWorkspace(cwd)
        if (stored > 0) ctx.logger?.info?.('taste: extracted %d rule(s) from %d signal(s)', stored, batch.length)
      })
      .catch(error => ctx.logger?.warn?.('taste: extraction failed: %o', error))
      .finally(() => extracting.delete(sessionId))
  }

  ctx.on('agent/created', function (payload) {
    const session = payload?.agent?.session
    if (!session) return
    const sessionId = sessionIdOf(session)
    try {
      refresh(sessionId, cwdOf(session))
      registerContext(this, sessionId)
    } catch (error) {
      ctx.logger?.warn?.('taste: session initialisation failed: %o', error)
    }
  })

  ctx.on('agent/inbox/claimed', payload => {
    const session = payload?.agent?.session
    if (!session) return
    const filtered = prefilter(messageText(payload?.message))
    if (!filtered.ok) return
    const signal = classify(filtered.text)
    if (signal === null) return
    const sessionId = sessionIdOf(session)
    const cwd = cwdOf(session)

    if (signal.kind === 'positive') {
      const rules = snapshots.get(sessionId) ?? []
      const target = selectRules(rules)[0]?.id
      if (target !== undefined) {
        reinforceRule(cwd, target)
          .then(() => refresh(sessionId, cwd))
          .catch(error => ctx.logger?.warn?.('taste: reinforcement failed: %o', error))
      }
      return
    }

    const queue = pending.get(sessionId) ?? []
    queue.push({ text: filtered.text, kind: signal.kind, patterns: signal.patterns, at: new Date().toISOString() })
    while (queue.length > MAX_PENDING) queue.shift()
    pending.set(sessionId, queue)

    if (signal.kind === 'explicit' || signal.kind === 'guardrail') {
      addRule(cwd, {
        text: toRuleText(filtered.text),
        kind: signal.kind,
        patterns: signal.patterns,
        confidence: signal.weight,
        source: signal.kind,
        quote: filtered.text,
      })
        .then(() => refresh(sessionId, cwd))
        .catch(error => ctx.logger?.warn?.('taste: auto-learn failed: %o', error))
    }
  })

  ctx.on('agent/turn-stopping', payload => {
    const session = payload?.agent?.session
    if (!session) return
    maybeExtract(sessionIdOf(session), cwdOf(session))
  })

  const tools = ctx.get?.('tools') ?? ctx.tools
  if (typeof tools?.register !== 'function') {
    reportBootError(ctx, new Error('tools service is unavailable at apply time'), 'tool-registration')
    return
  }
  tools.register(
    createTasteTool({
      cwdOf,
      sessionIdOf,
      configText: () => describeConfig(config, warnings),
      readMerged: async cwd => mergeFor(cwd),
      addRule: async (cwd, input) => {
        const result = await addRule(cwd, input)
        refreshWorkspace(cwd)
        return result
      },
      approveRule: async (cwd, id) => {
        const result = await approveRule(cwd, id)
        refreshWorkspace(cwd)
        return result
      },
      forgetRule: async (cwd, id, scope) => {
        const result = await forgetRule(cwd, id, scope)
        refreshWorkspace(cwd)
        return result
      },
      exportTaste,
      evidenceFor: async (cwd, id) => {
        const project = await readEvidence(tasteDir(cwd, 'project'), id)
        const global = await readEvidence(tasteDir(cwd, 'global'), id)
        return [...project, ...global]
      },
      takePending: sessionId => {
        const queue = pending.get(sessionId) ?? []
        pending.set(sessionId, [])
        return queue
      },
    }),
  )
}

export { contentId, parseMarkdown, renderMarkdown, similarity }
