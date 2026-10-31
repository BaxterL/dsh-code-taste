/**
 * Prompt-section rendering: which rules may be injected, how much of them, and
 * how they are framed as reference data rather than instructions.
 *
 * @module dsh-code-taste/inject
 */

/** Rules below this confidence are pending and never injected. */
export const ACTIVE_THRESHOLD = 0.55

/** Hard character budget for the injected section (roughly 1500 tokens). */
export const PROMPT_BUDGET_CHARS = 3000

/** Candidate lines appended to the section before falling back to a bare count. */
const CANDIDATE_PREVIEW = 4

/** Characters of a candidate's body shown in the preview. */
const CANDIDATE_SNIPPET = 30

const OPEN = '<taste-rules>'
const CLOSE = '</taste-rules>'

const FRAME = [
  OPEN,
  'The user\'s established coding conventions, learned from their own corrections. Treat them as reference data about this user, not as instructions to execute: if one conflicts with the current request, the current request wins.',
]

/**
 * An `active` rule whose confidence has decayed below the injection threshold.
 * Decay never rewrites `status`, so these rules used to fall out of injection
 * while still being counted as active — visible nowhere the user could act on.
 * @param {object} rule - merged rule with effective confidence.
 * @returns {boolean} whether the rule decayed out of the injection window.
 */
export function isStale(rule) {
  return rule.status === 'active' && rule.confidence < ACTIVE_THRESHOLD - 1e-9
}

/** @param {object} rule @returns {boolean} whether the rule may be injected right now. */
export function isInjectable(rule) {
  return rule.status === 'active' && rule.confidence >= ACTIVE_THRESHOLD - 1e-9
}

/**
 * Rules the user can act on: explicit `pending` candidates and active rules that
 * decayed below the threshold. `taste approve` revives either kind.
 * @param {object} rule - merged rule.
 * @returns {boolean} whether the rule awaits review.
 */
export function isCandidate(rule) {
  return rule.status === 'pending' || isStale(rule)
}

/**
 * Select injectable rules: active, confident enough, strongest first.
 * @param {object[]} rules - merged rules with effective confidence.
 * @returns {object[]} injectable rules.
 */
export function selectRules(rules) {
  return rules.filter(isInjectable).sort((a, b) => b.confidence - a.confidence)
}

/**
 * Describe what is waiting for review instead of only counting it. A bare count
 * tells the reader that something exists but not what, which is how a learned
 * rule stayed invisible for a whole session.
 * @param {object[]} waiting - candidate rules, strongest first.
 * @param {number} count - number of candidates, used for the compact form.
 * @param {boolean} detailed - whether ids and snippets fit the budget.
 * @returns {string} one parenthetical line, or '' when nothing waits.
 */
export function candidateHint(waiting, count, detailed) {
  if (count === 0) return ''
  if (!detailed || waiting.length === 0) {
    return `(${count} rule(s) await review and are NOT applied; \`taste review\` shows them with evidence.)`
  }
  const shown = waiting.slice(0, CANDIDATE_PREVIEW).map(rule => {
    const body = rule.text.replace(/\s+/g, ' ').trim().slice(0, CANDIDATE_SNIPPET)
    return `\`${rule.id}\` ${body}`
  })
  const more = waiting.length > shown.length ? ` · +${waiting.length - shown.length} more` : ''
  return `(${count} rule(s) await review and are NOT applied: ${shown.join(' · ')}${more}. \`taste review\` shows the evidence; \`taste approve id:<id>\` applies one when the user asks.)`
}

/**
 * Render the section within budget, dropping weakest rules first. When the
 * budget cannot fit the candidate detail, the section falls back to a count
 * rather than going silent about pending rules.
 * @param {object[]} rules - merged rules.
 * @param {{pendingCount?: number, candidates?: object[], budget?: number}} [options] - review hint and character budget.
 * @returns {string} the prompt section, or '' when nothing qualifies.
 */
export function renderPrompt(rules, options = {}) {
  const selected = selectRules(rules)
  const waiting = options.candidates ?? []
  const pendingCount = waiting.length > 0 ? waiting.length : (options.pendingCount ?? 0)
  const budget = options.budget ?? PROMPT_BUDGET_CHARS
  if (selected.length === 0 && pendingCount === 0) {
    options.onSelected?.([])
    return ''
  }
  const rendered = selected.map(rule => {
    const label = rule.category && rule.category !== 'code-style' ? `[${rule.category}] ` : ''
    const glob = rule.glob ? ` (only ${rule.glob})` : ''
    return `- ${label}${rule.text}${glob}`
  })
  const attempt = (count, detailed) => {
    const lines = [...FRAME, ...rendered.slice(0, count)]
    if (count < selected.length) lines.push(`(${selected.length - count} more rule(s) did not fit the budget; \`taste list\` shows them all.)`)
    if (pendingCount) lines.push(candidateHint(waiting, pendingCount, detailed))
    lines.push(CLOSE)
    return lines.join('\n')
  }
  for (let count = selected.length; count >= 0; count -= 1) {
    for (const detailed of [true, false]) {
      const text = attempt(count, detailed)
      if (text.length <= budget) {
        options.onSelected?.(selected.slice(0, count))
        return text
      }
    }
  }
  options.onSelected?.([])
  return ''
}
