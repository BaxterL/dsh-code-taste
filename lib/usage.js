/**
 * Token accounting for the plugin's own model calls.
 *
 * Every extraction appends one JSON line to `~/.dsh/taste/usage.jsonl`; nothing
 * else in the plugin spends tokens, so this file is the complete ledger.
 *
 * @module dsh-code-taste/usage
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHome } from './paths.js'

/** @returns {string} the ledger path. */
export function usagePath() {
  return join(dshHome(), 'taste', 'usage.jsonl')
}

/**
 * Append one call.
 * @param {{source: string, provider?: string, model?: string, inputChars: number, outputChars: number, inputTokens?: number, outputTokens?: number, rules?: number, ms?: number, ok: boolean, error?: string}} entry
 */
export function recordUsage(entry) {
  try {
    const path = usagePath()
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8')
  } catch {
    // bookkeeping must never break an extraction
  }
}

/** @returns {object[]} the newest `limit` records, oldest first among those. */
export function readUsage(limit = 500) {
  try {
    const text = readFileSync(usagePath(), 'utf8')
    const rows = []
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        rows.push(JSON.parse(line))
      } catch {
        // ignore a torn line
      }
    }
    return rows.slice(-limit)
  } catch {
    return []
  }
}

/** @returns {{calls: number, inputTokens: number, outputTokens: number, totalTokens: number, lastAt?: string}} totals. */
export function summarize(rows = readUsage()) {
  let inputTokens = 0
  let outputTokens = 0
  for (const row of rows) {
    inputTokens += Number(row.inputTokens) || 0
    outputTokens += Number(row.outputTokens) || 0
  }
  return {
    calls: rows.length,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    lastAt: rows.length > 0 ? rows[rows.length - 1].at : undefined,
  }
}

/** One-line human summary, used by the tool and the card. */
export function describeUsage(rows = readUsage()) {
  const totals = summarize(rows)
  if (totals.calls === 0) return 'No model calls recorded yet.'
  const last = rows.slice(-5).reverse().map(row =>
    `- ${row.at} · ${row.source}${row.model ? ` ${row.model}` : ''} · ${row.inputTokens ?? '?'}→${row.outputTokens ?? '?'} tok · ${row.rules ?? 0} rule(s)${row.ok === false ? ` · FAILED: ${row.error ?? ''}` : ''}`)
  return [
    `Calls: ${totals.calls} · tokens in ${totals.inputTokens} / out ${totals.outputTokens} · total ${totals.totalTokens}`,
    `Last call: ${totals.lastAt ?? '-'}`,
    'Recent:',
    ...last,
  ].join('\n')
}
