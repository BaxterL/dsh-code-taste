/**
 * dsh-code-taste: learns the user's coding conventions from explicit instructions
 * and corrections, stores them as confidence-scored rules in human-editable
 * markdown, and injects the active ones into each session's prompt.
 *
 * @module dsh-code-taste
 */

import { appendFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
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
import { baseConfidence, captureText, comparable, classify, inferCategory, negationOf, prefilter, toRuleText } from './lib/signals.js'
import { withStoreLock } from './lib/lock.js'
import { ACTIVE_THRESHOLD, isCandidate, renderPrompt, selectRules } from './lib/inject.js'
import { canExtract, describeConfig, resolveConfig } from './lib/config.js'
import { coerceField, readSettings, toPublicConfig, writeSettings } from './lib/settings.js'
import { describeUsage, recordUsage, summarize } from './lib/usage.js'
import { complete, completeWithHost } from './lib/llm.js'
import { runExtraction } from './lib/extract.js'
import { createTasteTool } from './lib/tool.js'
import z from '@deepseek-ai/schemastery'

/**
 * Declarative configuration. The settings card on the plugin page writes these
 * fields one at a time, so every key is top level.
 */
export const Config = z.object({
  source: z
    .union(['none', 'host', 'custom'])
    .default('host')
    .description('none = no model calls · host = the harness\'s current model · custom = an OpenAI/Anthropic-compatible endpoint'),
  format: z.union(['openai', 'anthropic']).default('openai').description('Wire format of a custom endpoint'),
  baseURL: z.string().default('').description('Custom endpoint base URL, e.g. https://dashscope.aliyuncs.com/compatible-mode/v1 or http://127.0.0.1:11434/v1'),
  modelId: z.string().default('').description('Model id at that endpoint, e.g. qwen-plus or qwen2.5-coder:7b'),
  apiKey: z.string().default('').description('Literal key for a custom endpoint; prefer apiKeyEnv'),
  apiKeyEnv: z.string().default('').description('Environment variable that holds the key, e.g. DASHSCOPE_API_KEY'),
  maxOutputTokens: z.natural().default(768).description('Initial extraction output cap; truncation retries once up to 2048'),
  temperature: z.number().default(0).description('Sampling temperature, 0 keeps output stable'),
  timeoutMs: z.natural().default(20000).description('Request timeout in milliseconds'),
  injectBudgetChars: z.natural().default(3000).description('Characters of rules injected into the prompt each turn'),
  minPending: z.natural().default(3).description('Waiting signals required before one extraction call'),
  throttleMinutes: z.natural().default(10).description('Minutes between two extraction calls per session'),
  maxInputChars: z.natural().default(4000).description('Characters of pending text sent to the model'),
  maxRulesPerRun: z.natural().default(3).description('Rules accepted from one extraction call'),
})

export const name = 'taste'
export const inject = ['tools', 'systemPrompt', 'workingDirectory']

const MAX_PENDING = 20
/**
 * Verbatim capture keeps the user's raw words and has no model filtering, so it
 * waits for review. Model-distilled rules have already discarded one-offs, so
 * they enter force immediately: leaving them at 0.5 kept a learned preference
 * below the injection threshold for the whole session it was learned for.
 */
const AUTO_CONFIDENCE = 0.5
const DISTILLED_CONFIDENCE = 0.62
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
 * How a new rule starts. Deliberate writes and model-distilled rules are in
 * force at once; verbatim captures and proposals wait for review.
 * @param {string} kind - `tool` | `extracted` | `proposed` | a signal kind.
 * @param {number} [confidence] - caller-supplied score for the confident kinds.
 * @returns {{base: number, confident: boolean, status: 'active'|'pending'}} initial state.
 */
export function initialState(kind, confidence) {
  const trusted = kind === 'tool'
  const confident = trusted || kind === 'extracted'
  const base = confident ? (Number.isFinite(confidence) ? confidence : baseConfidence(kind)) : AUTO_CONFIDENCE
  return { base, confident, status: confident && base >= ACTIVE_THRESHOLD ? 'active' : 'pending' }
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
  const csrfToken = randomUUID()
  const stored = readSettings()
  const { config, warnings } = resolveConfig({ ...(rawConfig ?? {}), ...stored })
  if (warnings.length > 0) ctx.logger?.warn?.('taste: %s', warnings.join('; '))

  /**
   * One route for the settings card: read the effective values, write one field.
   * The card is a browser request, so the file it writes is settings.json, never
   * the profile patch.
   */
  const registerSettingsRoute = webServer => {
    if (!webServer || typeof webServer.register !== 'function') {
      ctx.logger?.warn?.('taste: webServer service is unavailable; the settings card cannot save')
      return
    }
    const send = (response, status, body) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      response.end(JSON.stringify(body))
    }
    const readBody = request =>
      new Promise((resolve, reject) => {
        let data = ''
        request.on('data', chunk => {
          data += chunk
          if (data.length > 65536) {
            reject(new Error('body too large'))
            request.destroy()
          }
        })
        request.on('end', () => resolve(data))
        request.on('error', reject)
      })
    const reapply = merged => {
      const next = resolveConfig({ ...(rawConfig ?? {}), ...merged }).config
      Object.assign(config, next)
    }
    ctx.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path: '/dsh-code-taste/config',
          handler: async (request, response) => {
            if (request.method === 'GET') {
              send(response, 200, { ...toPublicConfig(config), usage: summarize(), csrfToken })
              return
            }
            if (request.method !== 'POST') {
              response.writeHead(405, { allow: 'GET, POST' })
              response.end()
              return
            }
            const headers = request.headers ?? {}
            const expectedOrigin = `${request.socket?.encrypted ? 'https' : 'http'}://${headers.host}`
            if (headers['x-taste-csrf'] !== csrfToken ||
                !/^application\/json(?:\s*;|$)/i.test(headers['content-type'] ?? '') ||
                (headers.origin && headers.origin !== expectedOrigin) ||
                headers['sec-fetch-site'] === 'cross-site') {
              send(response, 403, { error: 'Same-origin JSON request with CSRF token required' })
              return
            }
            try {
              const body = JSON.parse(await readBody(request))
              const result = coerceField(body.field, body.value)
              if (!result.ok) {
                send(response, 400, { error: result.error })
                return
              }
              const merged = { ...readSettings(), [body.field]: result.value }
              writeSettings(merged)
              reapply(merged)
              send(response, 200, { ...toPublicConfig(config), usage: summarize(), csrfToken })
            } catch (error) {
              send(response, 400, { error: error instanceof Error ? error.message : String(error) })
            }
          },
        }),
      'taste: settings route',
    )
  }
  // `webServer` may mount after this plugin: wait for it instead of reading it once.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], scoped => {
      try {
        registerSettingsRoute(scoped.webServer)
      } catch (error) {
        reportBootError(ctx, error, 'settings-route')
      }
    })
  } else {
    try {
      registerSettingsRoute(ctx.get?.('webServer'))
    } catch (error) {
      reportBootError(ctx, error, 'settings-route')
    }
  }

  /**
   * Standing guidance: with a model route the agent records durable preferences
   * itself instead of waiting for `taste learn`. In `none` mode there is nothing
   * to be smart about, so the section renders empty and costs nothing.
   */
  const GUIDANCE = [
    '## Taste memory',
    'Keep this user\'s coding taste current without being asked:',
    '- When the user states a lasting preference or corrects your approach, use action `propose` to record one short candidate for review. Quoted material, pasted documents and tool output are not user preferences.',
    '- One rule per call. Skip anything that only applies to the current task, and never invent a preference the user did not express.',
    '- Use `add` or `approve` only when the user explicitly asks to save or approve that rule. Never approve automatically or treat an extraction/learn result as authorization.',
    '- Call `taste list` before writing code in an area you have not touched in this session.',
    '- Rules the `<taste-rules>` block lists as awaiting review are NOT in force: when one plainly matches the task, call `taste review` and say so, then `taste approve id:<id>` only with the user\'s agreement.',
  ].join('\n')

  const registerGuidance = () => {
    if (!ctx.systemPrompt || typeof ctx.systemPrompt.section !== 'function') return
    ctx.effect(
      () =>
        ctx.systemPrompt.section({
          name: 'taste-guidance',
          order: 910,
          // Always on. `taste add` is a deterministic write and needs no model, so
          // gating this section on canExtract() silenced the instruction exactly
          // when the regex path was the only thing running.
          text: () => GUIDANCE,
        }),
      'taste: guidance section',
    )
  }

  try {
    registerGuidance()
  } catch (error) {
    reportBootError(ctx, error, 'guidance-section')
  }

  const sessionIdOf = createSessionIdentity()
  /** session id -> unclaimed corrections */
  const pending = new Map()
  /** session id -> frozen merged rules */
  const snapshots = new Map()
  /** session id -> working directory the snapshot was built from */
  const cwds = new Map()
  const recent = new Map()
  const uncounted = new Map()
  const seenMessages = new Map()
  const mutate = action => withStoreLock(tasteDir('', 'global'), action)
  const queuePaths = new Map()
  const blockedQueues = new Set()
  const restorePending = (sessionId, cwd) => {
    if (queuePaths.has(sessionId)) return
    const path = join(tasteDir(cwd, 'project'), `pending-${contentId(sessionId)}.json`)
    queuePaths.set(sessionId, path)
    try {
      const saved = JSON.parse(readFileSync(path, 'utf8'))
      if (!Array.isArray(saved.pending) || !Array.isArray(saved.seen) ||
          !saved.pending.every(entry => entry && typeof entry.kind === 'string' && prefilter(entry.text).ok) ||
          !saved.seen.every(key => typeof key === 'string')) throw new Error('Invalid pending queue snapshot')
      pending.set(sessionId, saved.pending)
      seenMessages.set(sessionId, new Set(saved.seen))
    } catch (error) {
      if (error.code !== 'ENOENT') {
        blockedQueues.add(sessionId)
        ctx.logger?.warn?.('taste: pending queue could not be restored; capture paused to preserve the file: %o', error)
      }
    }
  }
  const persistPending = sessionId => blockedQueues.has(sessionId) ? Promise.resolve() : mutate(() => writeAtomic(queuePaths.get(sessionId), JSON.stringify({
    pending: pending.get(sessionId) ?? [], seen: [...(seenMessages.get(sessionId) ?? [])],
  }))).catch(error => ctx.logger?.warn?.('taste: pending queue write failed: %o', error))
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

  /** Global rules can affect every live workspace. */
  const refreshWorkspace = () => {
    for (const [sessionId, path] of cwds) {
      snapshots.set(sessionId, mergeFor(path))
    }
  }

  const renderFor = sessionId => {
    const cwd = cwds.get(sessionId)
    if (cwd) refresh(sessionId, cwd)
    const rules = snapshots.get(sessionId) ?? []
    // Candidates are listed, not merely counted: a bare number tells a reader that
    // something waits for review but not what, which is how a learned rule stayed
    // invisible to both the model and the user. Decayed actives count as candidates.
    const waiting = rules.filter(isCandidate)
    const injected = []
    const text = renderPrompt(rules, { candidates: waiting, budget: config.injectBudgetChars, onSelected: chosen => injected.push(...chosen) })
    // The host may assemble a prompt several times per turn, so keep the union:
    // usage accounting must not shrink to whichever render happened last.
    const previous = uncounted.get(sessionId) ?? []
    const union = [...previous, ...injected].filter((rule, index, all) => all.findIndex(item => item.id === rule.id && item.scope === rule.scope) === index)
    recent.set(sessionId, union)
    uncounted.set(sessionId, union)
    return text
  }

  const markUsed = (sessionId, rules) => {
    const cwd = cwds.get(sessionId)
    if (cwd === undefined) return
    // The same id can arrive from two scopes or from a repeated render; count each once.
    const chosen = [...new Map(rules.map(rule => [`${rule.scope}:${rule.id}`, rule])).values()]
    if (chosen.length === 0) return
    mutate(async () => {
      for (const scope of ['project', 'global']) {
        const selected = chosen.filter(rule => rule.scope === scope)
        if (!selected.length) continue
        const dir = tasteDir(cwd, scope)
        // Re-read inside the lock: a write that only carried its own snapshot is
        // how unrelated usage records disappeared from state.json.
        const state = await loadState(dir)
        for (const rule of selected) {
          const record = state[rule.id] ?? { created: new Date().toISOString() }
          state[rule.id] = {
            ...record,
            lastUsed: new Date().toISOString(),
            recalled: (record.recalled ?? 0) + 1,
          }
        }
        await saveState(dir, state)
      }
    }).catch(error => ctx.logger?.warn?.('taste: usage write failed: %o', error))
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

  const addRule = (cwd, input) => mutate(async () => {
    const filtered = prefilter(input.text)
    if (!filtered.ok || /[\r\n]/.test(input.text) || input.text.length > 200) throw new Error('Rule must be a single short sentence without secrets (max 200 characters)')
    input = { ...input, text: filtered.text }
    for (const key of ['category', 'glob']) {
      if (input[key] && /[\r\n\[\]]/.test(input[key])) throw new Error(`Invalid ${key}`)
    }
    const trusted = input.kind === 'tool'
    const { base, confident, status: initialStatus } = initialState(input.kind, input.confidence)
    const scope = input.scope === 'global' ? 'global' : 'project'
    const dir = tasteDir(cwd, scope)
    const rules = await loadScope(dir, scope)
    const state = await loadState(dir)
    const identity = identityOf(input.text)
    let existing = rules.find(rule => identityOf(rule.text) === identity && rule.glob === input.glob)
    if (!existing) {
      let best = 0
      for (const rule of rules) {
        if (!comparable(rule.text, input.text) || rule.glob !== input.glob) continue
        const score = similarity(rule.text, input.text)
        if (score > best) {
          best = score
          existing = rule
        }
      }
      if (best < SIMILARITY_MERGE) existing = undefined
    }
    if (existing && negationOf(existing.text) !== negationOf(input.text)) existing = undefined
    if (confident && base >= ACTIVE_THRESHOLD) {
      // Opposite polarity is a conflict, never a duplicate: "Do not use const"
      // reaches 1.0 similarity with "Use const", and merging would reinforce the
      // rule the user just reversed. Demote the contradicted rules instead.
      const conflicting = rules.filter(
        rule => rule.status !== 'archived' && comparable(rule.text, input.text) && rule.glob === input.glob && similarity(rule.text, input.text) >= SIMILARITY_MERGE && negationOf(rule.text) !== negationOf(input.text),
      )
      for (const old of conflicting) {
        // Withhold the conflict for review without destroying its confidence.
        old.status = 'pending'
        old.ineffective = (old.ineffective ?? 0) + 1
        await appendEvidence(dir, {
          id: old.id,
          at: new Date().toISOString(),
          kind: 'conflict',
          quote: `superseded by: ${input.text}`.slice(0, 200),
        })
      }
    }
    const now = new Date().toISOString()
    let rule
    let created = false
    if (existing) {
      if (confident) existing.confidence = Math.min(CONFIDENCE_CEILING, Math.max(base, existing.confidence + REINFORCE_STEP))
      existing.evidenceCount += 1
      // A second, agreeing distillation promotes a rule that was still on review.
      if (confident && base >= ACTIVE_THRESHOLD) existing.status = 'active'
      if (trusted && input.category) existing.category = input.category
      if (trusted && input.glob) existing.glob = input.glob
      if (confident) state[existing.id] = { ...state[existing.id], created: state[existing.id]?.created ?? now, lastSeen: now }
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
        status: initialStatus,
        pinned: input.pinned === true,
        ineffective: 0,
      }
      if (rules.some(old => old.id === rule.id)) rule.id = contentId(`${input.text} ${input.glob ?? ''}`, 32)
      if (rules.some(old => old.id === rule.id)) throw new Error('Rule id collision; no data was overwritten')
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
  })

  const reinforceRule = (cwd, id) => mutate(async () => {
    const found = await findRule(cwd, id)
    if (!found) return false
    const { dir, scope, rules, rule } = found
    if (rule.status !== 'active') return false
    rule.confidence = Math.min(CONFIDENCE_CEILING, rule.confidence + REINFORCE_STEP)
    rule.evidenceCount += 1
    rule.status = 'active'
    const state = await loadState(dir)
    state[id] = { ...state[id], created: state[id]?.created ?? new Date().toISOString(), lastSeen: new Date().toISOString() }
    await saveScope(dir, scope, rules)
    await saveState(dir, state)
    await appendEvidence(dir, { id, at: new Date().toISOString(), kind: 'positive', quote: 'positive feedback' })
    return true
  })

  const approveRule = (cwd, id) => mutate(async () => {
    const found = await findRule(cwd, id)
    if (!found) return false
    const { dir, scope, rules, rule } = found
    for (const old of rules) {
      if (old.id !== id && old.status !== 'archived' && old.glob === rule.glob && comparable(old.text, rule.text) &&
          similarity(old.text, rule.text) >= SIMILARITY_MERGE && negationOf(old.text) !== negationOf(rule.text)) {
        old.status = 'pending'
        await appendEvidence(dir, { id: old.id, at: new Date().toISOString(), kind: 'conflict', quote: `superseded by approved rule: ${rule.text}` })
      }
    }
    rule.status = 'active'
    rule.confidence = Math.min(CONFIDENCE_CEILING, Math.max(rule.confidence, 0.6) + APPROVE_STEP)
    const state = await loadState(dir)
    state[id] = { ...state[id], created: state[id]?.created ?? new Date().toISOString(), lastSeen: new Date().toISOString() }
    await saveScope(dir, scope, rules)
    await saveState(dir, state)
    await appendEvidence(dir, { id, at: new Date().toISOString(), kind: 'approved', quote: 'approved by user' })
    return true
  })

  const forgetRule = (cwd, id, requestedScope) => mutate(async () => {
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
  })

  const exportTaste = async (cwd, format) => {
    const exportDir = join(tasteDir(cwd, 'project'), 'export')
    // Export what is actually in force, not every `active` row: a decayed rule is
    // not injected, so writing it into AGENTS.taste.md would overstate the file.
    const rules = selectRules(mergeFor(cwd))
    if (rules.length === 0) {
      // No rules: remove stale exports rather than leave an old file claiming otherwise.
      for (const name of ['AGENTS.taste.md', 'CLAUDE.taste.md']) {
        rmSync(join(exportDir, name), { force: true })
      }
      return undefined
    }
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
      return prompt => complete({ ...config, model: { ...config.model, maxOutputTokens: prompt.maxOutputTokens ?? config.model.maxOutputTokens } }, prompt)
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
        maxOutputTokens: prompt.maxOutputTokens ?? config.model.maxOutputTokens,
        temperature: config.model.temperature,
      })
  }

  /** One small call per batch, throttled per session. Ordinary chat never queues anything. */
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
    const startedAt = Date.now()
    const route = config.model.source === 'host' ? 'host' : `${config.model.format}:${config.model.model}`
    runExtraction({ config, pending: batch, cwd, addRule, callModel, confidence: DISTILLED_CONFIDENCE })
      .then(result => {
        const stored = result?.stored ?? 0
        const consumed = batch.slice(0, result.consumed ?? 0)
        const rest = (pending.get(sessionId) ?? []).filter(entry => !consumed.includes(entry))
        pending.set(sessionId, rest)
        persistPending(sessionId)
        refreshWorkspace(cwd)
        recordUsage({
          source: config.model.source,
          model: route,
          ok: true,
          inputChars: result?.inputChars ?? 0,
          outputChars: result?.outputChars ?? 0,
          inputTokens: result?.usage?.inputTokens,
          outputTokens: result?.usage?.outputTokens,
          rules: stored,
          ms: Date.now() - startedAt,
        })
        if (stored > 0) ctx.logger?.info?.('taste: extracted %d rule(s) from %d signal(s)', stored, batch.length)
      })
      .catch(error => {
        recordUsage({
          source: config.model.source,
          model: route,
          ok: false,
          inputChars: 0,
          outputChars: 0,
          error: error instanceof Error ? error.message : String(error),
          ms: Date.now() - startedAt,
        })
        ctx.logger?.warn?.('taste: extraction failed: %o', error)
      })
      .finally(() => extracting.delete(sessionId))
  }

  ctx.on('agent/created', function (payload) {
    const session = payload?.agent?.session
    if (!session) return
    const sessionId = sessionIdOf(session)
    try {
      refresh(sessionId, cwdOf(session))
      restorePending(sessionId, cwdOf(session))
      registerContext(this, sessionId)
    } catch (error) {
      ctx.logger?.warn?.('taste: session initialisation failed: %o', error)
    }
  })

  ctx.on('agent/inbox/claimed', payload => {
    const session = payload?.agent?.session
    if (!session) return
    const filtered = prefilter(captureText(messageText(payload?.message)))
    if (!filtered.ok) return
    const signal = classify(filtered.text)
    if (signal === null) return
    const sessionId = sessionIdOf(session)
    const cwd = cwdOf(session)
    restorePending(sessionId, cwd)
    if (blockedQueues.has(sessionId)) return
    const seen = seenMessages.get(sessionId) ?? new Set()
    const messageKey = payload?.message?.id ?? contentId(filtered.text)
    if (seen.has(messageKey)) return
    seen.add(messageKey)
    seenMessages.set(sessionId, seen)
    persistPending(sessionId)

    if (signal.kind === 'positive') {
      const injected = recent.get(sessionId) ?? []
      const target = injected.length === 1 ? injected[0].id : undefined
      if (target !== undefined) {
        reinforceRule(cwd, target)
          .then(() => refreshWorkspace(cwd))
          .catch(error => ctx.logger?.warn?.('taste: reinforcement failed: %o', error))
      }
      return
    }

    const queue = pending.get(sessionId) ?? []
    const immediate = signal.kind === 'explicit' || signal.kind === 'guardrail' || !canExtract(config) || queue.length >= MAX_PENDING
    const entry = { text: filtered.text, kind: signal.kind, patterns: signal.patterns, at: new Date().toISOString() }
    queue.push(entry)
    pending.set(sessionId, queue)
    persistPending(sessionId)

    if (immediate) {
      // All automatic paths, including queue overflow, persist reviewable candidates.
      addRule(cwd, {
        text: toRuleText(filtered.text),
        kind: signal.kind,
        patterns: signal.patterns,
        confidence: AUTO_CONFIDENCE,
        source: signal.kind,
        quote: filtered.text,
      })
        .then(() => {
          pending.set(sessionId, (pending.get(sessionId) ?? []).filter(item => item !== entry))
          persistPending(sessionId)
          refreshWorkspace(cwd)
        })
        .catch(error => ctx.logger?.warn?.('taste: auto-learn failed: %o', error))
    }
  })

  ctx.on('agent/turn-stopping', payload => {
    const session = payload?.agent?.session
    if (!session) return
    const sessionId = sessionIdOf(session)
    markUsed(sessionId, uncounted.get(sessionId) ?? [])
    uncounted.delete(sessionId)
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
      usageText: () => describeUsage(),
      injectBudget: () => config.injectBudgetChars,
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
        return queue.map(entry => ({ ...entry }))
      },
    }),
  )
}

export { contentId, parseMarkdown, renderMarkdown, similarity }
