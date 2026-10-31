/** Regression cases found in the second-pass review. No live host or network. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, after } from 'node:test'
import { apply } from '../index.js'
import { contentId, mergeScopes, parseMarkdown } from '../lib/store.js'
import { captureText } from '../lib/signals.js'
import { renderPrompt } from '../lib/inject.js'
import { createTasteTool } from '../lib/tool.js'
import { coerceField, readSettings, writeSettings } from '../lib/settings.js'
import { runExtraction } from '../lib/extract.js'
import { resolveConfig } from '../lib/config.js'

const root = mkdtempSync(join(tmpdir(), 'taste-review-'))
process.env.DSH_HOME = join(root, 'home')
after(() => rmSync(root, { recursive: true, force: true }))
const row = (text, extra = {}) => ({ id: contentId(text), text, category: 'code-style', status: 'active', confidence: 0.9, source: 'tool', evidenceCount: 1, ...extra })

function host(cwd) {
  let tool
  const handlers = new Map()
  const session = { id: 'review-session' }
  const ctx = {
    logger: { warn() {}, info() {} },
    on: (name, fn) => handlers.set(name, fn),
    tools: { register: value => { tool = value } },
    systemPrompt: { context() {} },
    workingDirectory: { get: () => cwd },
  }
  apply(ctx, { source: 'none' })
  handlers.get('agent/created')({ agent: { session } })
  return { run: args => tool.execute(args, { agent: { session } }), say: text => handlers.get('agent/inbox/claimed')({ agent: { session }, message: { id: 'message-1', content: text } }) }
}

test('pending project evidence cannot suppress a confirmed global rule', () => {
  const text = 'Use const for bindings'
  const merged = mergeScopes([row(text, { scope: 'project', status: 'pending', confidence: 0.5 })], [row(text, { scope: 'global' })])
  assert(merged.some(rule => rule.scope === 'global' && rule.status === 'active'))
  assert(merged.some(rule => rule.scope === 'project' && rule.status === 'pending'))
})

test('merge preserves different glob restrictions', () => {
  const text = 'Use tabs for indentation'
  assert.equal(mergeScopes([row(text, { glob: 'src/**' }), row(text, { glob: 'test/**' })], []).length, 2)
})

test('explicit add of an existing candidate reviews its active opposite', async () => {
  const cwd = join(root, 'conflict')
  const app = host(cwd)
  await app.run({ action: 'add', text: 'Use tabs for indentation' })
  await app.run({ action: 'propose', text: 'Never use tabs for indentation' })
  await app.run({ action: 'add', text: 'Never use tabs for indentation' })
  const rules = parseMarkdown(readFileSync(join(cwd, '.dsh/taste/TASTE.md'), 'utf8'), 'project')
  assert.equal(rules.find(rule => rule.text === 'Use tabs for indentation').status, 'pending')
  assert.equal(rules.find(rule => rule.text === 'Never use tabs for indentation').status, 'active')
})

test('quote isolation does not manufacture an incomplete preference', () => {
  assert.equal(captureText('永远不要使用“moment.js”'), '')
  assert.equal(captureText('文档说：‘永远不要用 any’'), '')
  assert.equal(captureText('文档说：`never use any`'), '')
})

test('list reserves exactly the same pending footer budget as injection', async () => {
  const pendingRow = row('Review this proposal', { status: 'pending', confidence: 0.5 })
  const rules = [row('Use const ' + 'x'.repeat(95)), pendingRow]
  let actual = 0
  renderPrompt(rules, { budget: 400, candidates: [pendingRow], onSelected: selected => { actual = selected.length } })
  const tool = createTasteTool({ cwdOf: () => root, sessionIdOf: () => 'list', readMerged: async () => rules, injectBudget: () => 400 })
  const result = await tool.execute({ action: 'list' })
  assert(result.text.includes(`Injected into the prompt: ${actual} of 2`))
})

test('stored default overrides remain effective after a restart', () => {
  writeSettings({ source: 'host', maxOutputTokens: 768 })
  const config = resolveConfig({ source: 'custom', maxOutputTokens: 64, ...readSettings() }).config
  assert.equal(config.model.source, 'host')
  assert.equal(config.model.maxOutputTokens, 768)
  writeSettings({})
})

test('settings reject inherited property names', () => {
  assert.equal(coerceField('__proto__', 'x').ok, false)
  assert.equal(coerceField('constructor', 'x').ok, false)
})

test('extraction rejects excess rules instead of silently acknowledging them', async () => {
  const config = resolveConfig({ maxRulesPerRun: 1 }).config
  let writes = 0
  await assert.rejects(runExtraction({ config, cwd: root, pending: [{ kind: 'correction', text: 'Prefer explicit types' }], addRule: async () => { writes++ }, callModel: async () => '{"rules":[{"text":"Use const"},{"text":"Use tabs"}]}' }))
  assert.equal(writes, 0)
})

test('an unreadable pending snapshot is not overwritten by new capture', async () => {
  const cwd = join(root, 'broken-queue')
  const dir = join(cwd, '.dsh/taste')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `pending-${contentId('review-session')}.json`)
  writeFileSync(path, '{broken')
  const app = host(cwd)
  app.say('记住：一律使用显式类型')
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(readFileSync(path, 'utf8'), '{broken')
})
