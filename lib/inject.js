/**
 * Prompt-section rendering: which rules may be injected, and how much of them.
 *
 * @module dsh-taste/inject
 */

/** Rules below this confidence are pending and never injected. */
export const ACTIVE_THRESHOLD = 0.55

/** Hard character budget for the injected section (roughly 1500 tokens). */
export const PROMPT_BUDGET_CHARS = 6000

const HEADER = [
  '## Coding taste',
  'Conventions this user has established for this workspace. Follow them unless the current request explicitly overrides one; prefer their idiom over generic defaults.',
]

/**
 * Select injectable rules: active, confident enough, deduplicated by caller.
 * @param {object[]} rules - merged rules with effective confidence.
 * @returns {object[]} injectable rules, strongest first.
 */
export function selectRules(rules) {
  return rules
    .filter(rule => rule.status === 'active' && rule.confidence >= ACTIVE_THRESHOLD)
    .sort((a, b) => b.confidence - a.confidence)
}

/**
 * Render the section within budget, dropping weakest rules first.
 * @param {object[]} rules - merged rules.
 * @returns {string} the prompt section, or '' when nothing qualifies.
 */
export function renderPrompt(rules) {
  const selected = selectRules(rules)
  if (selected.length === 0) return ''
  const lines = [...HEADER]
  let used = HEADER.join('\n').length
  for (const rule of selected) {
    const label = rule.category && rule.category !== 'code-style' ? `[${rule.category}] ` : ''
    const glob = rule.glob ? ` (only ${rule.glob})` : ''
    const line = `- ${label}${rule.text}${glob}`
    if (used + line.length + 1 > PROMPT_BUDGET_CHARS) break
    lines.push(line)
    used += line.length + 1
  }
  if (lines.length === HEADER.length) return ''
  return lines.join('\n')
}
