/**
 * Plugin configuration: defaults, validation, and the effective runtime shape.
 *
 * The public shape is FLAT (`source`, `baseURL`, `minPending`, …) because the
 * settings card writes one top-level field at a time. The runtime shape stays
 * nested for the rest of the plugin; old nested configs are still accepted.
 *
 * @module dsh-code-taste/config
 */

export const DEFAULTS = {
  /** none = no calls · host = the harness's current model · custom = own endpoint */
  source: 'host',
  format: 'openai',
  baseURL: '',
  modelId: '',
  apiKey: '',
  apiKeyEnv: '',
  maxOutputTokens: 256,
  temperature: 0,
  timeoutMs: 20000,
  injectBudgetChars: 3000,
  minPending: 3,
  throttleMinutes: 10,
  maxInputChars: 4000,
  maxRulesPerRun: 3,
}

const SOURCES = new Set(['none', 'host', 'custom'])
const FORMATS = new Set(['openai', 'anthropic'])

const asNumber = (value, fallback, min, max) => {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

const asString = (value, fallback) => (typeof value === 'string' ? value.trim() : fallback)

/** Flat key first, then the legacy nested location, then the default. */
const pick = (flat, key, nested, nestedKey, fallback) => {
  if (Object.hasOwn(flat, key)) return flat[key]
  if (nested && Object.hasOwn(nested, nestedKey)) return nested[nestedKey]
  return fallback
}

/**
 * Merge a row's config over defaults and validate it.
 * @param {unknown} raw - the row's `config` value, possibly undefined.
 * @returns {{config: object, warnings: string[]}} effective config plus non-fatal notes.
 */
export function resolveConfig(raw) {
  const flat = raw && typeof raw === 'object' ? raw : {}
  const nestedModel = flat.model && typeof flat.model === 'object' ? flat.model : undefined
  const nestedExtract = flat.extract && typeof flat.extract === 'object' ? flat.extract : undefined
  const warnings = []

  let source = asString(pick(flat, 'source', nestedModel, 'source', ''), '').toLowerCase()
  if (source.length === 0) {
    const mode = asString(flat.mode, '').toLowerCase() // v0.3 spelling
    // No config at all means the documented default (host). An explicit but
    // unknown legacy `mode` keeps the old, quieter behaviour: no model calls.
    if (mode === 'hybrid') source = 'custom'
    else if (mode.length > 0) source = 'none'
    else source = DEFAULTS.source
  }
  if (!SOURCES.has(source)) {
    warnings.push(`unknown source "${source}", falling back to none`)
    source = 'none'
  }

  const format = asString(pick(flat, 'format', nestedModel, 'format', DEFAULTS.format), DEFAULTS.format).toLowerCase()
  if (!FORMATS.has(format)) warnings.push(`unknown format "${format}", falling back to openai`)

  const config = {
    injectBudgetChars: Math.round(asNumber(flat.injectBudgetChars, DEFAULTS.injectBudgetChars, 400, 12000)),
    model: {
      source,
      format: FORMATS.has(format) ? format : 'openai',
      baseURL: asString(pick(flat, 'baseURL', nestedModel, 'baseURL', ''), '').replace(/\/+$/, ''),
      model: asString(pick(flat, 'modelId', nestedModel, 'model', ''), ''),
      apiKey: asString(pick(flat, 'apiKey', nestedModel, 'apiKey', ''), ''),
      apiKeyEnv: asString(pick(flat, 'apiKeyEnv', nestedModel, 'apiKeyEnv', ''), ''),
      maxOutputTokens: Math.round(asNumber(pick(flat, 'maxOutputTokens', nestedModel, 'maxOutputTokens', DEFAULTS.maxOutputTokens), DEFAULTS.maxOutputTokens, 32, 2048)),
      temperature: asNumber(pick(flat, 'temperature', nestedModel, 'temperature', DEFAULTS.temperature), DEFAULTS.temperature, 0, 1),
      timeoutMs: Math.round(asNumber(pick(flat, 'timeoutMs', nestedModel, 'timeoutMs', DEFAULTS.timeoutMs), DEFAULTS.timeoutMs, 1000, 120000)),
    },
    extract: {
      minPending: Math.round(asNumber(pick(flat, 'minPending', nestedExtract, 'minPending', DEFAULTS.minPending), DEFAULTS.minPending, 1, 50)),
      throttleMinutes: asNumber(pick(flat, 'throttleMinutes', nestedExtract, 'throttleMinutes', DEFAULTS.throttleMinutes), DEFAULTS.throttleMinutes, 0, 1440),
      maxInputChars: Math.round(asNumber(pick(flat, 'maxInputChars', nestedExtract, 'maxInputChars', DEFAULTS.maxInputChars), DEFAULTS.maxInputChars, 200, 20000)),
      maxRulesPerRun: Math.round(asNumber(pick(flat, 'maxRulesPerRun', nestedExtract, 'maxRulesPerRun', DEFAULTS.maxRulesPerRun), DEFAULTS.maxRulesPerRun, 1, 10)),
    },
  }

  if (config.model.source === 'custom') {
    if (config.model.baseURL.length === 0) warnings.push('custom source needs baseURL; extraction is disabled until it is set')
    if (config.model.model.length === 0) warnings.push('custom source needs modelId; extraction is disabled until it is set')
    if (config.model.apiKey.length === 0 && config.model.apiKeyEnv.length === 0) {
      warnings.push('no apiKey or apiKeyEnv; local endpoints usually need neither')
    }
  }
  return { config, warnings }
}

/** @returns {boolean} whether the resolved config can actually call a model. */
export function canExtract(config) {
  if (config.model.source === 'host') return true
  if (config.model.source !== 'custom') return false
  return config.model.baseURL.length > 0 && config.model.model.length > 0
}

/** A redacted view for `taste config` — never prints the key. */
export function describeConfig(config, warnings) {
  const { source, format, baseURL, model, apiKey, apiKeyEnv, maxOutputTokens, timeoutMs } = config.model
  const key = apiKey.length > 0 ? '(inline key set)' : apiKeyEnv.length > 0 ? `env:${apiKeyEnv}` : '(none)'
  const route = source === 'host'
    ? 'the harness\'s current model (no endpoint, no key)'
    : source === 'none'
      ? 'no model calls'
      : `${format} · ${baseURL || '(unset)'} · ${model || '(unset)'} · key ${key}`
  return [
    `source: ${source}`,
    `route: ${route}`,
    `inject budget: ${config.injectBudgetChars} chars`,
    `limits: maxOutputTokens=${maxOutputTokens}, timeout=${timeoutMs}ms`,
    `extract: minPending=${config.extract.minPending}, throttle=${config.extract.throttleMinutes}m, maxInputChars=${config.extract.maxInputChars}, maxRules=${config.extract.maxRulesPerRun}`,
    ...(warnings.length > 0 ? [`warnings: ${warnings.join('; ')}`] : []),
  ].join('\n')
}
