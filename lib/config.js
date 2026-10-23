/**
 * Plugin configuration: defaults, validation, and the effective runtime shape.
 *
 * Deliberately dependency-free — the loader passes the row's `config` object
 * straight through, so this module owns the schema.
 *
 * @module dsh-code-taste/config
 */

/** Defaults chosen to spend as little as possible: no model calls at all. */
export const DEFAULTS = {
  /** Characters of rules injected into the prompt (~4 chars per token). */
  injectBudgetChars: 3000,
  /** How long a freshly injected snapshot may live, in turns. */
  model: {
    /**
     * `none`   — deterministic capture only, no calls
     * `host`   — the harness's own current model (no key, no endpoint)
     * `custom` — an OpenAI/Anthropic-compatible endpoint (third party or local)
     */
    source: 'none',
    /** `openai` covers OpenAI, Qwen/DashScope, Ollama, llama.cpp, LM Studio, vLLM. */
    format: 'openai',
    baseURL: '',
    model: '',
    /** Literal key, or leave empty and point `apiKeyEnv` at an environment variable. */
    apiKey: '',
    apiKeyEnv: '',
    maxOutputTokens: 256,
    temperature: 0,
    timeoutMs: 20000,
  },
  extract: {
    /** Only extract once this many signals are waiting. */
    minPending: 3,
    /** Minimum minutes between two extraction calls, per session. */
    throttleMinutes: 10,
    /** Characters of pending text sent to the model. */
    maxInputChars: 4000,
    /** Hard cap on rules accepted from one call. */
    maxRulesPerRun: 3,
  },
}

const SOURCES = new Set(['none', 'host', 'custom'])
const FORMATS = new Set(['openai', 'anthropic'])

const asNumber = (value, fallback, min, max) => {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

const asString = (value, fallback) => (typeof value === 'string' ? value.trim() : fallback)

/**
 * Merge a row's config over {@link DEFAULTS} and validate it.
 * @param {unknown} raw - the row's `config` value, possibly undefined.
 * @returns {{config: object, warnings: string[]}} effective config plus non-fatal notes.
 */
export function resolveConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const warnings = []
  const modelInput = input.model && typeof input.model === 'object' ? input.model : {}
  const extractInput = input.extract && typeof input.extract === 'object' ? input.extract : {}

  // `mode` is the v0.3 spelling kept for older configs; `model.source` is the current one.
  let source = asString(modelInput.source, '').toLowerCase()
  if (source.length === 0) {
    const mode = asString(input.mode, '').toLowerCase()
    source = mode === 'hybrid' ? 'custom' : 'none'
  }
  if (!SOURCES.has(source)) {
    warnings.push(`unknown model.source "${source}", falling back to none`)
    source = 'none'
  }

  const format = asString(modelInput.format, DEFAULTS.model.format).toLowerCase()
  if (!FORMATS.has(format)) warnings.push(`unknown model.format "${format}", falling back to openai`)

  const config = {
    injectBudgetChars: Math.round(asNumber(input.injectBudgetChars, DEFAULTS.injectBudgetChars, 400, 12000)),
    model: {
      source,
      format: FORMATS.has(format) ? format : 'openai',
      baseURL: asString(modelInput.baseURL, DEFAULTS.model.baseURL).replace(/\/+$/, ''),
      model: asString(modelInput.model, DEFAULTS.model.model),
      apiKey: asString(modelInput.apiKey, DEFAULTS.model.apiKey),
      apiKeyEnv: asString(modelInput.apiKeyEnv, DEFAULTS.model.apiKeyEnv),
      maxOutputTokens: Math.round(asNumber(modelInput.maxOutputTokens, DEFAULTS.model.maxOutputTokens, 32, 2048)),
      temperature: asNumber(modelInput.temperature, DEFAULTS.model.temperature, 0, 1),
      timeoutMs: Math.round(asNumber(modelInput.timeoutMs, DEFAULTS.model.timeoutMs, 1000, 120000)),
    },
    extract: {
      minPending: Math.round(asNumber(extractInput.minPending, DEFAULTS.extract.minPending, 1, 50)),
      throttleMinutes: asNumber(extractInput.throttleMinutes, DEFAULTS.extract.throttleMinutes, 0, 1440),
      maxInputChars: Math.round(asNumber(extractInput.maxInputChars, DEFAULTS.extract.maxInputChars, 200, 20000)),
      maxRulesPerRun: Math.round(asNumber(extractInput.maxRulesPerRun, DEFAULTS.extract.maxRulesPerRun, 1, 10)),
    },
  }
  if (config.model.source === 'custom') {
    if (config.model.baseURL.length === 0) warnings.push('custom model source needs model.baseURL; extraction is disabled until it is set')
    if (config.model.model.length === 0) warnings.push('custom model source needs model.model; extraction is disabled until it is set')
    if (config.model.apiKey.length === 0 && config.model.apiKeyEnv.length === 0) {
      warnings.push('no model.apiKey or model.apiKeyEnv; local endpoints usually need neither')
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
