/**
 * Structured, rotating log for the plugin itself.
 *
 * The host console is invisible to the person running the plugin, so a failure
 * that only writes there leaves no trail. Every diagnostic line therefore also
 * lands in `~/.dsh/taste/logs/taste.log` as one JSON object per line, which
 * `taste logs` reads back and a human can grep.
 *
 * Two rules hold everywhere: secrets never reach disk, and logging never throws
 * into a caller — a broken log file must not break capture.
 *
 * @module dsh-code-taste/log
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHome } from './paths.js'

/** Numeric severities; a line is written when its level is at or below the threshold. */
export const LEVELS = { error: 0, warn: 1, info: 2, debug: 3, none: -1 }

/** Recent entries kept in memory so `taste logs` answers without touching disk. */
const RING_SIZE = 300

/** Field values longer than this are truncated instead of bloating the file. */
const MAX_FIELD_CHARS = 800

/** Credential shapes that must never be written, mirroring the capture filter. */
const SECRETS = [
  /\b(sk|pk|rk)[-_](?:live|test|proj)?[-_]?[A-Za-z0-9]{16,120}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bASIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,80}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,120}\b/g,
  /\bgithub_pat_[A-Za-z0-9_-]{20,120}\b/g,
  /\bglpat-[A-Za-z0-9_-]{16,120}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,120}\b/g,
  /\bnpm_[A-Za-z0-9]{30,120}\b/g,
  /\bhf_[A-Za-z0-9]{20,120}\b/g,
  /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----/g,
  /\beyJ[A-Za-z0-9_-]{8,400}\.[A-Za-z0-9_-]{8,400}\.[A-Za-z0-9_-]{8,400}\b/g,
  /\b[a-z][a-z0-9+.-]{0,20}:\/\/[^\s:/@]{1,100}:[^\s:/@]{1,100}@[^\s]{1,200}/gi,
  /\b(password|passwd|secret|api[_-]?key|access[_-]?key|auth[_-]?token|access[_-]?token|bearer|client[_-]?secret)\b\s*[:=]\s*['"]?[^\s'"]{6,120}/gi,
]

/**
 * Remove credentials from any string about to be logged.
 * @param {string} text - candidate line.
 * @returns {string} the same line with every credential replaced by `[redacted]`.
 */
export function redact(text) {
  let out = String(text)
  for (const pattern of SECRETS) out = out.replace(pattern, '[redacted]')
  return out
}

/**
 * Turn an arbitrary value into something JSON-safe and bounded. Errors keep their
 * message and stack, which is the whole point of the file.
 * @param {unknown} value - any logged value.
 * @param {number} [depth] - recursion guard.
 * @returns {unknown} a bounded, redacted copy.
 */
function sanitize(value, depth = 0) {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string') return redact(value).slice(0, MAX_FIELD_CHARS)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (value instanceof Error) return { name: value.name, message: redact(value.message), stack: redact(String(value.stack ?? '')).slice(0, MAX_FIELD_CHARS) }
  if (depth > 3) return '[truncated]'
  if (Array.isArray(value)) return value.slice(0, 20).map(item => sanitize(item, depth + 1))
  if (typeof value === 'object') {
    const out = {}
    for (const [key, inner] of Object.entries(value).slice(0, 30)) out[key] = sanitize(inner, depth + 1)
    return out
  }
  return redact(String(value))
}

/** @returns {string} the log file path for the current DSH home. */
export function logPath() {
  return join(dshHome(), 'taste', 'logs', 'taste.log')
}

/** @returns {string[]} every log generation on disk, oldest first. */
export function logFiles() {
  const base = logPath()
  const files = []
  for (let index = 3; index >= 1; index -= 1) {
    const candidate = `${base}.${index}`
    if (existsSync(candidate)) files.push(candidate)
  }
  if (existsSync(base)) files.push(base)
  return files
}

/** Rotate the file once it passes `maxBytes`, keeping `keep` older generations. */
function rotate(path, maxBytes, keep) {
  try {
    if (statSync(path).size < maxBytes) return
  } catch {
    return
  }
  for (let index = keep; index >= 1; index -= 1) {
    const from = index === 1 ? path : `${path}.${index - 1}`
    const to = `${path}.${index}`
    if (!existsSync(from)) continue
    try {
      renameSync(from, to)
    } catch {
      // another process rotated first; not an error
    }
  }
}

/** The live logger; one instance per process is enough. */
let current

/**
 * Build (or reconfigure) the process-wide logger.
 * @param {{level?: string, maxBytes?: number, keep?: number}} [options] - verbosity and rotation.
 * @returns {object} the logger: `error/warn/info/debug`, `tail`, `path`.
 */
export function getLogger(options = {}) {
  if (current) {
    if (options.level !== undefined) current.level = LEVELS[options.level] ?? LEVELS.info
    if (options.maxBytes !== undefined) current.maxBytes = options.maxBytes
    if (options.keep !== undefined) current.keep = options.keep
    return current
  }
  const logger = {
    level: LEVELS[options.level] ?? LEVELS.info,
    maxBytes: options.maxBytes ?? 2_000_000,
    keep: options.keep ?? 3,
    path: logPath(),
    ring: [],
  }
  const write = (level, event, data) => {
    if (logger.level === LEVELS.none || LEVELS[level] > logger.level) return
    const entry = { at: new Date().toISOString(), level, event: redact(String(event)).slice(0, 200) }
    const payload = sanitize(data)
    if (payload !== undefined) entry.data = payload
    logger.ring.push(entry)
    if (logger.ring.length > RING_SIZE) logger.ring.shift()
    try {
      mkdirSync(dirname(logger.path), { recursive: true })
      rotate(logger.path, logger.maxBytes, logger.keep)
      appendFileSync(logger.path, `${JSON.stringify(entry)}\n`, 'utf8')
    } catch {
      // logging must never be the thing that fails
    }
  }
  logger.error = (event, data) => write('error', event, data)
  logger.warn = (event, data) => write('warn', event, data)
  logger.info = (event, data) => write('info', event, data)
  logger.debug = (event, data) => write('debug', event, data)
  /**
   * Recent entries, newest last, merges the in-memory ring with the file.
   * @param {{lines?: number, level?: string, event?: string}} [query] - filters.
   * @returns {object[]} matching entries.
   */
  logger.tail = (query = {}) => {
    const limit = Math.min(Math.max(query.lines ?? 30, 1), 300)
    const floor = LEVELS[query.level ?? 'debug'] ?? LEVELS.debug
    const match = entry => LEVELS[entry.level] <= floor && (query.event === undefined || entry.event.includes(query.event))
    const fromRing = logger.ring.filter(match)
    if (fromRing.length >= limit) return fromRing.slice(-limit)
    let onDisk = []
    try {
      onDisk = readFileSync(logger.path, 'utf8')
        .split(/\r?\n/)
        .filter(line => line.trim().length > 0)
        .map(line => {
          try {
            return JSON.parse(line)
          } catch {
            return undefined
          }
        })
        .filter(entry => entry && match(entry))
    } catch {
      onDisk = []
    }
    const seen = new Set(fromRing.map(entry => `${entry.at}|${entry.event}`))
    return [...onDisk.filter(entry => !seen.has(`${entry.at}|${entry.event}`)), ...fromRing].slice(-limit)
  }
  current = logger
  return logger
}

/** Reset the singleton; tests need a clean slate per temporary home. */
export function resetLogger() {
  current = undefined
}

/** Delete every log generation. */
export function clearLogs() {
  for (const file of logFiles()) {
    try {
      rmSync(file, { force: true })
    } catch {
      // a locked file is not worth failing over
    }
  }
  if (current) current.ring.length = 0
}

/**
 * Render entries for a human or a model.
 * @param {object[]} entries - log entries.
 * @returns {string} one line per entry.
 */
export function formatLogs(entries) {
  if (entries.length === 0) return 'No log entries yet.'
  return entries.map(entry => {
    const stamp = entry.at.slice(11, 19)
    const detail = entry.data === undefined ? '' : ` ${JSON.stringify(entry.data).slice(0, 300)}`
    return `${stamp} ${entry.level.toUpperCase().padEnd(5)} ${entry.event}${detail}`
  }).join('\n')
}
