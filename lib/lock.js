import { mkdir, open, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'

const queues = new Map()

/** Serialize complete read/modify/write transactions, including across processes.
 * A crashed owner's lock is deliberately not stolen: timeout fails closed.
 */
export function withStoreLock(dir, action) {
  const previous = queues.get(dir) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(async () => {
    await mkdir(dir, { recursive: true })
    const path = join(dir, '.write.lock')
    const deadline = Date.now() + 10000
    let handle
    while (!handle) {
      try { handle = await open(path, 'wx') } catch (error) {
        if (error.code !== 'EEXIST') throw error
        if (Date.now() >= deadline) throw new Error(`taste store is locked: ${path}`)
        await setTimeout(25)
      }
    }
    try { return await action() } finally {
      await handle.close()
      await unlink(path)
    }
  })
  queues.set(dir, next)
  next.finally(() => { if (queues.get(dir) === next) queues.delete(dir) }).catch(() => {})
  return next
}
