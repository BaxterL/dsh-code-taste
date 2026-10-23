/**
 * dsh-taste: learns the user's coding conventions from explicit instructions
 * and corrections, stores them as confidence-scored rules in human-editable
 * markdown, and injects the active ones into each session's prompt.
 *
 * @module dsh-code-taste
 */

import { randomUUID } from 'node:crypto'
import { tasteDir } from './lib/paths.js'
import {
  appendEvidence,
  identityOf,
  loadScope,
  loadScopeSync,
  loadState,
  loadStateSync,
  mergeScopes,
  parseMarkdown,
  readEvidence,
  saveScope,
  saveState,
} from './lib/store.js'
import { classify, inferCategory, prefilter, toRuleText } from './lib/signals.js'
import { renderPrompt, selectRules } from './lib/inject.js'
import { createTasteTool } from './lib/tool.js'

export const name = 'taste'
export const inject = ['tools', 'systemPrompt', 'workingDirectory']

const MAX_PENDING = 20
const EXPLICIT_CONFIDENCE = 0.85
const AUTO_CONFIDENCE = 0.5
const REINFORCE_STEP = 0.1
const CONFIDENCE_CEILING = 0.95

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
 */
export function apply(ctx) {
  const sessionIdOf = createSessionIdentity()
  /** session id -> unclaimed corrections */
  const pending = new Map()
  /** session id -> frozen merged rules */
  const snapshots = new Map()
  /** session id -> ids rendered into the prompt */
  const injected = new Map()
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
      return { ...rule, created: record.created, lastSeen: record.lastSeen }
    })

  const mergeFor = cwd => {
    const projectDir = tasteDir(cwd, 'project')
    const globalDir = tasteDir(cwd, 'global')
    const project = attachState(loadScopeSync(projectDir, 'project'), loadStateSync(projectDir))
    const global = attachState(loadScopeSync(globalDir, 'global'), loadStateSync(globalDir))
    return mergeScopes(project, global)
  }

  const refresh = (sessionId, cwd) => {
    snapshots.set(sessionId, mergeFor(cwd))
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

  const renderFor = sessionId => {
    const rules = snapshots.get(sessionId) ?? []
    const text = renderPrompt(rules)
    injected.set(sessionId, selectRules(rules).map(rule => rule.id))
    return text
  }

  const addRule = async (cwd, input) => {
    const scope = input.scope === 'global' ? 'global' : 'project'
    const dir = tasteDir(cwd, scope)
    const rules = await loadScope(dir, scope)
    const state = await loadState(dir)
    const identity = identityOf(input.text)
    const existing = rules.find(rule => identityOf(rule.text) === identity)
    const now = new Date().toISOString()
    let rule
    if (existing) {
      existing.confidence = Math.min(CONFIDENCE_CEILING, existing.confidence + REINFORCE_STEP)
      existing.evidenceCount += 1
      existing.status = 'active'
      if (input.category) existing.category = input.category
      if (input.glob) existing.glob = input.glob
      state[existing.id] = { created: state[existing.id]?.created ?? now, lastSeen: now }
      rule = existing
    } else {
      const confidence = typeof input.confidence === 'number' ? input.confidence : AUTO_CONFIDENCE
      rule = {
        id: `r_${randomUUID().slice(0, 8)}`,
        text: input.text,
        category: input.category || inferCategory(input.text),
        scope,
        glob: input.glob,
        confidence: Math.min(CONFIDENCE_CEILING, Math.max(0.1, confidence)),
        evidenceCount: 1,
        source: input.source ?? 'explicit',
        status: confidence >= 0.55 ? 'active' : 'pending',
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
      quote: String(input.quote ?? input.text).slice(0, 200),
    })
    return { rule, created: existing === undefined }
  }

  const reinforceRule = async (cwd, id) => {
    for (const scope of ['project', 'global']) {
      const dir = tasteDir(cwd, scope)
      const rules = await loadScope(dir, scope)
      const rule = rules.find(candidate => candidate.id === id)
      if (!rule) continue
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
    return false
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

  ctx.on('agent/created', function (payload) {
    const session = payload?.agent?.session
    if (!session) return
    const sessionId = sessionIdOf(session)
    const cwd = cwdOf(session)
    try {
      refresh(sessionId, cwd)
      registerContext(this, sessionId)
    } catch (error) {
      ctx.logger?.warn?.('taste: session initialisation failed: %o', error)
    }
  })

  ctx.on('agent/inbox/claimed', payload => {
    const session = payload?.agent?.session
    if (!session) return
    const raw = messageText(payload?.message)
    const filtered = prefilter(raw)
    if (!filtered.ok) return
    const kind = classify(filtered.text)
    if (kind === null) return
    const sessionId = sessionIdOf(session)
    const cwd = cwdOf(session)

    if (kind === 'positive') {
      const ids = injected.get(sessionId) ?? []
      const target = ids[0]
      if (target !== undefined) {
        reinforceRule(cwd, target)
          .then(() => refresh(sessionId, cwd))
          .catch(error => ctx.logger?.warn?.('taste: reinforcement failed: %o', error))
      }
      return
    }

    const queue = pending.get(sessionId) ?? []
    queue.push({ text: filtered.text, kind, at: new Date().toISOString() })
    while (queue.length > MAX_PENDING) queue.shift()
    pending.set(sessionId, queue)

    if (kind === 'explicit') {
      const body = toRuleText(filtered.text)
      addRule(cwd, {
        text: body,
        confidence: EXPLICIT_CONFIDENCE,
        source: 'explicit',
        kind: 'explicit',
        quote: filtered.text,
      })
        .then(() => refresh(sessionId, cwd))
        .catch(error => ctx.logger?.warn?.('taste: auto-learn failed: %o', error))
    }
  })

  ctx.tools.register(
    createTasteTool({
      cwdOf,
      sessionIdOf,
      readMerged: async cwd => mergeFor(cwd),
      addRule,
      forgetRule,
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

export { parseMarkdown }
