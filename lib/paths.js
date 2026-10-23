import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdir, rename, writeFile } from 'node:fs/promises'

/** @returns {string} the harness home that owns global taste. */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : join(homedir(), '.dsh')
}

/**
 * Resolve the directory that owns one scope's files.
 * @param {string} cwd - the session working directory.
 * @param {'project'|'global'} scope - which layer.
 * @returns {string} absolute directory.
 */
export function tasteDir(cwd, scope) {
  return scope === 'global' ? join(dshHome(), 'taste') : join(cwd, '.dsh', 'taste')
}

/** Write UTF-8 text atomically so a crash cannot truncate the taste file. */
export async function writeAtomic(path, text) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, text, 'utf8')
  await rename(temporary, path)
}
