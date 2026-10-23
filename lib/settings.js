/**
 * Settings that the plugin's card writes at runtime.
 *
 * They live in `~/.dsh/taste/settings.json` rather than in the profile patch:
 * the card is a browser request, and rewriting YAML from a web request is a
 * needless way to corrupt a profile. Precedence at load: this file, then the
 * row's `config`, then defaults.
 *
 * @module dsh-code-taste/settings
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHome } from './paths.js'
import { DEFAULTS } from './config.js'

/** Fields the card may write, with the type each one accepts. */
export const FIELDS = {
  source: 'string',
  format: 'string',
  baseURL: 'string',
  modelId: 'string',
  apiKey: 'string',
  apiKeyEnv: 'string',
  maxOutputTokens: 'number',
  temperature: 'number',
  timeoutMs: 'number',
  injectBudgetChars: 'number',
  minPending: 'number',
  throttleMinutes: 'number',
  maxInputChars: 'number',
  maxRulesPerRun: 'number',
}

const SOURCES = new Set(['none', 'host', 'custom'])
const FORMATS = new Set(['openai', 'anthropic'])

/** @returns {string} the settings file path. */
export function settingsPath() {
  return join(dshHome(), 'taste', 'settings.json')
}

/** @returns {Record<string, unknown>} stored settings; a missing or broken file is empty. */
export function readSettings() {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath(), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Persist settings. Values equal to the built-in default are dropped, so a fresh
 * install leaves no file at all and the plugin stays native until the user
 * actually changes something.
 */
export function writeSettings(settings) {
  const pruned = {}
  for (const [key, value] of Object.entries(settings)) {
    if (FIELDS[key] === undefined) continue
    if (value === DEFAULTS[key]) continue
    pruned[key] = value
  }
  const path = settingsPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(pruned, null, 2)}\n`, 'utf8')
}

/**
 * Validate one field from the browser.
 * @param {string} key - field name.
 * @param {unknown} value - raw value from the request.
 * @returns {{ok: true, value: string|number} | {ok: false, error: string}} a coerced value or a reason.
 */
export function coerceField(key, value) {
  const type = FIELDS[key]
  if (type === undefined) return { ok: false, error: `unknown field ${key}` }
  if (type === 'number') {
    const parsed = typeof value === 'number' ? value : Number.parseFloat(value)
    if (!Number.isFinite(parsed)) return { ok: false, error: `${key} must be a number` }
    return { ok: true, value: parsed }
  }
  if (typeof value !== 'string') return { ok: false, error: `${key} must be a string` }
  const text = value.trim()
  if (key === 'source' && !SOURCES.has(text)) return { ok: false, error: `unknown source ${text}` }
  if (key === 'format' && !FORMATS.has(text)) return { ok: false, error: `unknown format ${text}` }
  return { ok: true, value: text }
}

/**
 * Flatten the resolved runtime config back into the card's field names.
 * The key itself is never returned, only whether one is set.
 */
export function toPublicConfig(config) {
  return {
    source: config.model.source,
    format: config.model.format,
    baseURL: config.model.baseURL,
    modelId: config.model.model,
    apiKeyEnv: config.model.apiKeyEnv,
    hasApiKey: config.model.apiKey.length > 0,
    maxOutputTokens: config.model.maxOutputTokens,
    temperature: config.model.temperature,
    timeoutMs: config.model.timeoutMs,
    injectBudgetChars: config.injectBudgetChars,
    minPending: config.extract.minPending,
    throttleMinutes: config.extract.throttleMinutes,
    maxInputChars: config.extract.maxInputChars,
    maxRulesPerRun: config.extract.maxRulesPerRun,
  }
}
