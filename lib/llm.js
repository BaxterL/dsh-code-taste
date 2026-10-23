/**
 * Minimal model client: OpenAI-compatible and Anthropic Messages, no SDK.
 *
 * OpenAI-compatible covers Qwen/DashScope, Moonshot, DeepSeek, Ollama,
 * llama.cpp, LM Studio, vLLM and anything else that speaks `/chat/completions`.
 *
 * @module dsh-code-taste/llm
 */

const ANTHROPIC_VERSION = '2023-06-01'

/** @returns {string} the API key from config, falling back to the named env var. */
export function resolveKey(config) {
  if (config.model.apiKey.length > 0) return config.model.apiKey
  if (config.model.apiKeyEnv.length > 0) {
    const fromEnv = process.env[config.model.apiKeyEnv]
    if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  }
  return ''
}

/**
 * Build the HTTP request for one completion. Pure, so tests can inspect it.
 * @param {object} config - resolved plugin config.
 * @param {{system: string, user: string}} prompt - the two prompt halves.
 * @returns {{url: string, init: {method: string, headers: Record<string,string>, body: string}}} request parts.
 */
export function buildRequest(config, prompt) {
  const { format, baseURL, model, maxOutputTokens, temperature } = config.model
  const key = resolveKey(config)
  const headers = { 'content-type': 'application/json' }
  let url
  let body
  if (format === 'anthropic') {
    url = `${baseURL}/v1/messages`
    if (key.length > 0) headers['x-api-key'] = key
    headers['anthropic-version'] = ANTHROPIC_VERSION
    body = {
      model,
      max_tokens: maxOutputTokens,
      temperature,
      system: prompt.system,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt.user }] }],
    }
  } else {
    url = `${baseURL}/chat/completions`
    if (key.length > 0) headers.authorization = `Bearer ${key}`
    body = {
      model,
      max_tokens: maxOutputTokens,
      temperature,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
    }
  }
  return { url, init: { method: 'POST', headers, body: JSON.stringify(body) } }
}

/**
 * Extract the assistant text from a provider response.
 * @param {'openai'|'anthropic'} format - which shape to read.
 * @param {unknown} json - parsed response body.
 * @returns {string} the text, or '' when the shape is unexpected.
 */
export function parseResponse(format, json) {
  if (format === 'anthropic') {
    const blocks = json?.content
    if (!Array.isArray(blocks)) return ''
    return blocks
      .filter(block => block?.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('')
  }
  const content = json?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(part => (typeof part?.text === 'string' ? part.text : '')).join('')
  return ''
}

/**
 * One completion through the harness's own model route (no endpoint, no key).
 * @param {object} llm - the host `llm` service.
 * @param {{provider: string, model: string}} selection - the harness's current model.
 * @param {{system: string, user: string, signal?: AbortSignal}} prompt - prompts.
 * @param {{maxOutputTokens?: number, temperature?: number}} [options] - call controls.
 * @returns {Promise<string>} the response text.
 */
export async function completeWithHost(llm, selection, prompt, options = {}) {
  let text = ''
  let usage
  try {
    const stream = llm.stream({
      provider: selection.provider,
      model: selection.model,
      system: prompt.system,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt.user }] }],
      maxTokens: options.maxOutputTokens,
      temperature: options.temperature,
      signal: prompt.signal,
    })
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      if (chunk?.type === 'usage' && chunk.usage) {
        usage = {
          inputTokens: chunk.usage.inputTokens,
          outputTokens: chunk.usage.outputTokens,
          totalTokens: chunk.usage.totalTokens,
        }
      }
      if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') {
        throw new Error(chunk.reason.failure?.message ?? 'host model call failed')
      }
    }
  } catch (error) {
    throw new Error(`taste: host model call failed (${selection.provider}/${selection.model}): ${error instanceof Error ? error.message : String(error)}`)
  }
  return { text, usage }
}

/**
 * One completion. Never throws on a missing key: the caller decides whether the
 * route is local (no key) or misconfigured.
 * @param {object} config - resolved plugin config.
 * @param {{system: string, user: string, signal?: AbortSignal}} prompt - prompts and cancellation.
 * @returns {Promise<string>} the response text.
 */
export async function complete(config, prompt) {
  const { url, init } = buildRequest(config, prompt)
  const timeout = AbortSignal.timeout(config.model.timeoutMs)
  const signal = prompt.signal === undefined ? timeout : AbortSignal.any([prompt.signal, timeout])
  let response
  try {
    response = await fetch(url, { ...init, signal })
  } catch (error) {
    throw new Error(`taste: model request failed (${config.model.baseURL}): ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`taste: model responded ${response.status}: ${body.slice(0, 300)}`)
  }
  const json = await response.json()
  const raw = json?.usage ?? {}
  const usage = {
    inputTokens: raw.prompt_tokens ?? raw.input_tokens,
    outputTokens: raw.completion_tokens ?? raw.output_tokens,
    totalTokens: raw.total_tokens,
  }
  return { text: parseResponse(config.model.format, json), usage }
}
