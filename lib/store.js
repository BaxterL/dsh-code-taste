/**
 * Human-editable markdown as the single source of truth.
 *
 * Each rule is one line:
 *   - [id] text @0.72 src:corrective ev:3 [pending] [glob:src/ui/**]
 *
 * Anything that does not match is treated as a comment, so the file can hold
 * prose. Parsing is tolerant by design: a broken line never breaks the file.
 *
 * @module dsh-code-taste/store
 */

import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { writeAtomic } from './paths.js'

export const FILE_NAME = 'TASTE.md'
export const EVIDENCE_NAME = 'evidence.jsonl'

/** Section headings we render; unknown categories still round-trip. */
export const CATEGORY_ORDER = [
  'code-style',
  'design',
  'stack',
  'workflow',
  'project-detail',
  'communication',
  'avoid',
  'other',
]

const DEFAULT_CATEGORY = 'code-style'
const CONFIDENCE_FLOOR = 0.25
const DECAY_HALF_LIFE_DAYS = 60

/** @param {string} text @returns {string} lowercased, punctuation-and-space-collapsed identity. */
export function identityOf(text) {
  return text
    .toLowerCase()
    .replace(/[`'"]/g, '')
    .replace(/[\s\p{P}]+/gu, ' ')
    .trim()
}

/**
 * Content-addressed rule id: the same rule text yields the same id everywhere,
 * so two machines that learn the same convention dedupe instead of forking.
 * @param {string} text - rule body.
 * @returns {string} `r_` plus eight hex characters.
 */
export function contentId(text) {
  return `r_${createHash('sha1').update(identityOf(text)).digest('hex').slice(0, 8)}`
}

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/g

/**
 * Fold common Chinese paraphrase variants before tokenizing, so "别用" and
 * "不要用", "改成" and "换成" compare as the same token. This is the cheap
 * stand-in for komi-learn's LLM generalization rewrite.
 */
const SYNONYMS = [
  [/(?<!不)使用|(?<!不)采用|(?<!不)要用/g, '用'],
  [/别用|不要用|不准用|勿用|不允许用|禁止用/g, '不要用'],
  [/改成|换成|改为|换到/g, '换'],
  [/一律|通通|全都/g, '统一'],
]

/** @returns {string} text with paraphrase variants folded. */
export function canonicalize(text) {
  let result = text.toLowerCase()
  for (const [pattern, replacement] of SYNONYMS) result = result.replace(pattern, replacement)
  return result
}

/**
 * Tokenize for similarity: CJK character bigrams plus lowercased latin words.
 * @param {string} text - any rule text.
 * @returns {Set<string>} distinct tokens.
 */
function tokenSet(text) {
  const tokens = new Set()
  const normalized = canonicalize(text)
  for (const match of normalized.matchAll(/[a-z0-9_$.-]{2,}/g)) tokens.add(match[0])
  const cjk = normalized.match(CJK_RE)?.join('') ?? ''
  for (let index = 0; index + 1 < cjk.length; index += 1) tokens.add(cjk.slice(index, index + 2))
  return tokens
}

/**
 * Token-set similarity, used to merge near-duplicate rules.
 *
 * Containment rather than Jaccard: a short paraphrase ("别用 let") is usually a
 * subset of the longer rule it restates, and Jaccard would under-score exactly
 * that case. Symmetric: the larger of the two containment directions wins.
 * @param {string} a - first text.
 * @param {string} b - second text.
 * @returns {number} 0..1.
 */
export function similarity(a, b) {
  const left = tokenSet(a)
  const right = tokenSet(b)
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  return Math.max(shared / left.size, shared / right.size)
}

/** Apply time decay to one rule's confidence without mutating it. */
export function decayed(rule, now = Date.now()) {
  if (rule.pinned) return rule.confidence
  const last = Date.parse(rule.lastUsed ?? rule.lastSeen ?? rule.created ?? '')
  if (!Number.isFinite(last)) return rule.confidence
  const days = Math.max(0, (now - last) / 86_400_000)
  // No penalty inside the first half day: a rule about to be checked must not be
  // shaved just below the injection threshold by a few seconds of age.
  if (days < 0.5) return rule.confidence
  // The floor keeps a rule reviewable forever: decay never erases it, and
  // `taste approve` can always lift it back over the injection threshold.
  return Math.max(CONFIDENCE_FLOOR, rule.confidence * Math.pow(0.5, days / DECAY_HALF_LIFE_DAYS))
}

/**
 * Parse one markdown file into rules.
 * @param {string} text - file contents.
 * @param {'project'|'global'} scope - owning layer.
 * @returns {object[]} parsed rules in file order.
 */
export function parseMarkdown(text, scope) {
  const rules = []
  let category = DEFAULT_CATEGORY
  for (const raw of text.split(/\r?\n/)) {
    const heading = raw.match(/^##\s+(.+?)\s*$/)
    if (heading) {
      category = heading[1].trim().toLowerCase()
      continue
    }
    const line = raw.match(/^-\s*\[([^\]]+)\]\s+(.*)$/)
    if (!line) continue
    const id = line[1].trim()
    let rest = line[2]
    let confidence = 0.5
    let source = 'explicit'
    let evidenceCount = 1
    let pending = false
    let archived = false
    let pinned = false
    let glob
    for (let index = 0; index < 8; index += 1) {
      const before = rest
      const globMatch = rest.match(/\s*\[glob:([^\]]+)\]\s*$/)
      if (globMatch) {
        glob = globMatch[1].trim()
        rest = rest.slice(0, globMatch.index)
      }
      if (/\s*\[pinned\]\s*$/.test(rest)) {
        pinned = true
        rest = rest.replace(/\s*\[pinned\]\s*$/, '')
      }
      if (/\s*\[archived\]\s*$/.test(rest)) {
        archived = true
        rest = rest.replace(/\s*\[archived\]\s*$/, '')
      }
      if (/\s*\[pending\]\s*$/.test(rest)) {
        pending = true
        rest = rest.replace(/\s*\[pending\]\s*$/, '')
      }
      const evMatch = rest.match(/\s+ev:(\d+)\s*$/)
      if (evMatch) {
        evidenceCount = Number.parseInt(evMatch[1], 10)
        rest = rest.slice(0, evMatch.index)
      }
      const srcMatch = rest.match(/\s+src:([a-z-]+)\s*$/)
      if (srcMatch) {
        source = srcMatch[1]
        rest = rest.slice(0, srcMatch.index)
      }
      const confMatch = rest.match(/\s+@([0-9.]+)\s*$/)
      if (confMatch) {
        const parsed = Number.parseFloat(confMatch[1])
        if (Number.isFinite(parsed)) confidence = parsed
        rest = rest.slice(0, confMatch.index)
      }
      if (rest === before) break
    }
    const body = rest.trim()
    if (body.length === 0) continue
    rules.push({
      id,
      text: body,
      category: category === 'archived' ? DEFAULT_CATEGORY : category,
      scope,
      glob,
      confidence,
      evidenceCount,
      source,
      status: archived ? 'archived' : pending ? 'pending' : 'active',
      pinned,
      created: undefined,
      lastSeen: undefined,
      ineffective: 0,
    })
  }
  return rules
}

/**
 * Render rules back into the markdown grammar, grouped by category.
 * @param {object[]} rules - rules to serialize.
 * @returns {string} the file contents (always ends with a newline).
 */
export function renderMarkdown(rules) {
  const grouped = new Map()
  for (const rule of rules) {
    const category = rule.category || DEFAULT_CATEGORY
    const list = grouped.get(category) ?? []
    list.push(rule)
    grouped.set(category, list)
  }
  const ordered = [...grouped.keys()].sort((a, b) => {
    const ai = CATEGORY_ORDER.indexOf(a)
    const bi = CATEGORY_ORDER.indexOf(b)
    return (ai === -1 ? CATEGORY_ORDER.length : ai) - (bi === -1 ? CATEGORY_ORDER.length : bi)
  })
  const lines = [
    '<!-- dsh-code-taste: one rule per line, `- [id] text @confidence src:source ev:count`.',
    '     Edit freely: unparsed lines are comments. Decay and merges rewrite this file. -->',
    '',
  ]
  for (const category of ordered) {
    lines.push(`## ${category}`)
    for (const rule of grouped.get(category)) {
      const parts = [`- [${rule.id}] ${rule.text}`, `@${rule.confidence.toFixed(2)}`, `src:${rule.source}`, `ev:${rule.evidenceCount}`]
      if (rule.status === 'pending') parts.push('[pending]')
      if (rule.status === 'archived') parts.push('[archived]')
      if (rule.pinned) parts.push('[pinned]')
      if (rule.glob) parts.push(`[glob:${rule.glob}]`)
      lines.push(parts.join(' '))
    }
    lines.push('')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

/** Read one scope's rules synchronously; missing or broken files yield nothing. */
export function loadScopeSync(dir, scope) {
  try {
    return parseMarkdown(readFileSync(join(dir, FILE_NAME), 'utf8'), scope)
  } catch {
    return []
  }
}

/** Read one scope's rules. */
export async function loadScope(dir, scope) {
  try {
    return parseMarkdown(await readFile(join(dir, FILE_NAME), 'utf8'), scope)
  } catch {
    return []
  }
}

/**
 * Persist one scope's rules exactly as given.
 *
 * Confidence is stored raw; decay is applied on read so repeatedly saving a
 * file can never compound the same elapsed-time penalty.
 */
export async function saveScope(dir, scope, rules) {
  await writeAtomic(join(dir, FILE_NAME), renderMarkdown(rules))
  return rules
}

const STATE_NAME = 'state.json'

/** Read one scope's timestamp sidecar synchronously. */
export function loadStateSync(dir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, STATE_NAME), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** Read one scope's timestamp sidecar. */
export async function loadState(dir) {
  try {
    const parsed = JSON.parse(await readFile(join(dir, STATE_NAME), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** Persist the id -> {created, lastSeen} sidecar that markdown cannot carry. */
export async function saveState(dir, state) {
  await writeAtomic(join(dir, STATE_NAME), `${JSON.stringify(state, null, 2)}\n`)
}

/** Append one evidence record; evidence is audit data, never injected. */
export async function appendEvidence(dir, record) {
  const path = join(dir, EVIDENCE_NAME)
  const line = `${JSON.stringify(record)}\n`
  let existing = ''
  try {
    existing = readFileSync(path, 'utf8')
  } catch {
    existing = ''
  }
  await writeAtomic(path, existing + line)
}

/** Read evidence records, optionally filtered to one rule id. */
export async function readEvidence(dir, id) {
  try {
    const text = await readFile(join(dir, EVIDENCE_NAME), 'utf8')
    const records = []
    for (const line of text.split(/\r?\n/)) {
      if (line.trim().length === 0) continue
      try {
        const record = JSON.parse(line)
        if (id === undefined || record.id === id) records.push(record)
      } catch {
        // ignore a torn line
      }
    }
    return records
  } catch {
    return []
  }
}

/**
 * Merge layers with project-over-global precedence, deduplicated by identity.
 * @param {object[]} project - project rules.
 * @param {object[]} global - global rules.
 * @returns {object[]} merged rules sorted by effective confidence.
 */
export function mergeScopes(project, global, now = Date.now()) {
  const seen = new Set()
  const merged = []
  for (const rule of [...project, ...global]) {
    const key = identityOf(rule.text)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push({ ...rule, confidence: decayed(rule, now) })
  }
  return merged.sort((a, b) => b.confidence - a.confidence)
}
