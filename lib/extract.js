/**
 * Turn a batch of captured corrections into durable rules with one small model
 * call. The model proposes; this module decides — text is sanitized, categories
 * are whitelisted, and confidence is computed here, never taken from the reply.
 *
 * @module dsh-code-taste/extract
 */

import { complete } from './llm.js'

export const CATEGORIES = new Set([
  'code-style',
  'design',
  'stack',
  'workflow',
  'project-detail',
  'communication',
  'avoid',
])

const SYSTEM = [
  'You distil durable coding preferences from a user\'s corrections to an AI coding agent.',
  'Return JSON only: {"rules":[{"text":"...","category":"..."}]}.',
  'A rule must still be true in a month; drop task-specific instructions, questions, and anything about the current file.',
  'Write each rule as one short imperative sentence in the user\'s language, at most 20 words.',
  'Categories: code-style, design, stack, workflow, project-detail, communication, avoid.',
].join(' ')

/**
 * Build the user half of the extraction prompt within the character budget.
 * @param {{text: string, kind: string}[]} pending - captured signals.
 * @param {number} maxChars - budget for the whole user message.
 * @returns {string} the prompt body.
 */
export function buildUserPrompt(pending, maxChars) {
  const lines = []
  let used = 0
  for (const entry of pending) {
    const line = `- (${entry.kind}) ${entry.text}`.slice(0, 300)
    if (used + line.length + 1 > maxChars) break
    lines.push(line)
    used += line.length + 1
  }
  return `Corrections captured from the user:\n${lines.join('\n')}\n\nReturn at most ${Math.max(1, lines.length)} rules.`
}

/**
 * Parse a model reply into validated rules.
 * @param {string} raw - the model text, possibly wrapped in a code fence.
 * @param {number} maxRules - hard cap.
 * @returns {{text: string, category: string}[]} accepted rules.
 */
export function parseRules(raw, maxRules) {
  const text = typeof raw === 'string' ? raw : ''
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return []
  let parsed
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }
  const list = Array.isArray(parsed?.rules) ? parsed.rules : []
  const seen = new Set()
  const rules = []
  for (const entry of list) {
    const body = typeof entry?.text === 'string' ? entry.text.trim().replace(/\s+/g, ' ') : ''
    if (body.length < 4 || body.length > 200) continue
    const key = body.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const category = CATEGORIES.has(entry?.category) ? entry.category : 'code-style'
    rules.push({ text: body, category })
    if (rules.length >= maxRules) break
  }
  return rules
}

/**
 * Run one extraction over a batch.
 * @param {object} options - extraction inputs.
 * @param {object} options.config - resolved config.
 * @param {{text: string, kind: string}[]} options.pending - the batch.
 * @param {function} options.addRule - host callback.
 * @param {string} options.cwd - workspace directory.
 * @param {AbortSignal} [options.signal] - cancellation.
 * @returns {Promise<number>} how many rules were stored.
 */
export async function runExtraction({ config, pending, addRule, cwd, signal }) {
  if (pending.length === 0) return 0
  const user = buildUserPrompt(pending, config.extract.maxInputChars)
  const reply = await complete(config, { system: SYSTEM, user, signal })
  const rules = parseRules(reply, config.extract.maxRulesPerRun)
  let stored = 0
  for (const rule of rules) {
    const evidence = pending.length
    await addRule(cwd, {
      text: rule.text,
      category: rule.category,
      // More independent signals in the batch means more right to be active.
      confidence: evidence >= 3 ? 0.55 : 0.5,
      kind: 'extracted',
      source: 'extracted',
      quote: `model extraction from ${evidence} signal(s): ${rule.text}`,
    })
    stored += 1
  }
  return stored
}
