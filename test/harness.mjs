/**
 * Fake-context harness: exercises apply() without a DSH process.
 *
 * Run with `node test/harness.mjs`.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'taste-home-'))
const work = mkdtempSync(join(tmpdir(), 'taste-work-'))
process.env.DSH_HOME = home

const { apply } = await import('../index.js')
const { similarity, decayed, contentId } = await import('../lib/store.js')
const { classify, prefilter } = await import('../lib/signals.js')
const { resolveConfig, canExtract } = await import('../lib/config.js')
const { buildRequest, parseResponse } = await import('../lib/llm.js')
const { parseRules } = await import('../lib/extract.js')

const handlers = new Map()
const contexts = []
const logs = []
let tool

const ctx = {
  logger: {
    info: message => logs.push(`info: ${message}`),
    warn: (...args) => logs.push(`warn: ${args.map(String).join(' ')}`),
  },
  on(name, listener) {
    if (!handlers.has(name)) handlers.set(name, [])
    handlers.get(name).push(listener)
  },
  tools: {
    register(definition) {
      tool = definition
    },
  },
  systemPrompt: {
    context(entry) {
      contexts.push(entry)
    },
  },
  workingDirectory: {
    get: () => work,
  },
}

const emit = (name, payload, scope = ctx) => {
  for (const listener of handlers.get(name) ?? []) listener.call(scope, payload)
}

let failures = 0
const check = (label, condition) => {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.error(`  FAIL ${label}`)
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const until = async (predicate, timeoutMs = 3000) => {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return true
    await sleep(20)
  }
  return false
}

const projectFile = join(work, '.dsh', 'taste', 'TASTE.md')
const readProject = () => readFileSync(projectFile, 'utf8')
const ruleIdOf = text => text.match(/^- \[(r_[a-z0-9]+)\]/m)?.[1]

const session = { id: 'sess-1' }
const exec = { agent: { session } }
const say = text => emit('agent/inbox/claimed', { agent: { session }, message: { content: [{ type: 'text', text }] } })

apply(ctx, {
  mode: 'hybrid',
  injectBudgetChars: 1200,
  model: {
    format: 'openai',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
  },
})
emit('agent/created', { agent: { session } })

console.log('\n# registration')
check('tool registered as taste', tool?.name === 'taste')
check('prompt section registered', contexts.length === 1 && contexts[0].name === 'taste')
check('empty workspace renders no section', contexts[0].text() === '')

console.log('\n# signal detection')
check('explicit wins over correction', classify('记住：以后都用 const，别用 let')?.kind === 'explicit')
check('guardrail detected', classify('永远不要用 any')?.kind === 'guardrail')
check('positive detected', classify('对，就这样')?.kind === 'positive')
check('correction detected', classify('不要用 any，改成 unknown')?.kind === 'correction')
check('secret is rejected', prefilter('sk-abcdefghijklmnopqrstuvwxyz123456').ok === false)
check('email is redacted', prefilter('以后都用 foo@example.com 通知我').text.includes('<email>'))
check('question is rejected', prefilter('为什么这里要用 const？').ok === false)

console.log('\n# explicit instruction is captured automatically')
say('记住：以后都用 const，别用 let')
check('store file written', await until(() => existsSync(projectFile)))
const first = readProject()
check('rule body strips the meta prefix', first.includes('以后都用 const'))
check('explicit starts active at 90%', first.includes('@0.90'))
check('id is content-addressed', ruleIdOf(first) === contentId('以后都用 const，别用 let'))
check('prompt frames rules as data, not instructions', contexts[0].text().includes('<taste-rules>') && contexts[0].text().includes('reference data'))
check('prompt now contains the rule', contexts[0].text().includes('以后都用 const'))

console.log('\n# repeating reinforces instead of duplicating')
say('记住：以后都用 const，别用 let')
check('confidence raised to 95%', await until(() => readProject().includes('@0.95')))
check('evidence count is 2', readProject().includes('ev:2'))
check('only one rule line', readProject().match(/^- \[/gm)?.length === 1)

console.log('\n# near-duplicates merge')
check('similarity detects the same intent', similarity('统一用 const，不要用 let', '统一用 const 别用 let') >= 0.8)
const beforeMerge = readProject().match(/^- \[/gm)?.length
await tool.execute({ action: 'add', text: '以后都用 const 不要用 let', confidence: 0.8 }, exec)
const afterMerge = readProject().match(/^- \[/gm)?.length
check('a near-duplicate does not create a second rule', afterMerge === beforeMerge)
check('near-duplicate reinforced the original', readProject().includes('ev:3'))

console.log('\n# corrections wait for distillation')
say('不要用 any，改成 unknown')
const learned = await tool.execute({ action: 'learn' }, exec)
check('learn surfaces the correction', learned.text.includes('不要用 any'))
check('learn drains the queue', !(await tool.execute({ action: 'learn' }, exec)).text.includes('不要用 any'))

console.log('\n# low-confidence rules stay pending, then promote')
const pendingAdd = await tool.execute({ action: 'add', text: '测试统一用 pytest', confidence: 0.4 }, exec)
check('pending rule added', pendingAdd.text.startsWith('Added'))
check('pending marker written', readProject().includes('[pending]'))
check('pending rule not injected', !contexts[0].text().includes('pytest'))
const review = await tool.execute({ action: 'review' }, exec)
check('review lists the candidate', review.text.includes('pytest'))
const pendingId = ruleIdOf(readProject().split('\n').filter(line => line.includes('pytest')).join('\n'))
const approved = await tool.execute({ action: 'approve', id: pendingId }, exec)
check('approve reports success', approved.text.startsWith('Approved'))
check('approved rule is injected', await until(() => contexts[0].text().includes('pytest')))

console.log('\n# explainability')
const why = await tool.execute({ action: 'why', id: pendingId }, exec)
check('why returns evidence', why.text.includes('tool add: 测试统一用 pytest'))

console.log('\n# listing and profile')
const list = await tool.execute({ action: 'list' }, exec)
check('list shows both rules', list.text.includes('const') && list.text.includes('pytest'))
check('list reports injection state', list.text.includes('Injected into the prompt: yes'))
const profile = await tool.execute({ action: 'profile' }, exec)
check('profile summarises categories', profile.text.includes('active rules'))

console.log('\n# export')
const exported = await tool.execute({ action: 'export', format: 'agents' }, exec)
const exportPath = join(work, '.dsh', 'taste', 'export', 'AGENTS.taste.md')
check('export writes a fragment', exported.text.includes('AGENTS.taste.md') && existsSync(exportPath))
check('fragment carries the rules', readFileSync(exportPath, 'utf8').includes('以后都用 const'))

console.log('\n# pinned rules never decay')
check('pinned bypasses decay', decayed({ confidence: 0.9, pinned: true, lastSeen: '2020-01-01T00:00:00Z' }) === 0.9)
check('unpinned decays', decayed({ confidence: 0.9, lastSeen: '2020-01-01T00:00:00Z' }) < 0.1)

console.log('\n# hand edits are tolerated')
writeFileSync(
  projectFile,
  [
    '<!-- my notes: this file is mine -->',
    '这里是随便写的说明，解析器应该忽略。',
    '',
    '## code-style',
    `- [${pendingId}] 测试统一用 pytest @0.9 src:explicit ev:5 [pinned]`,
    '',
  ].join('\n'),
  'utf8',
)
const afterEdit = await tool.execute({ action: 'list' }, exec)
check('hand-edited rule is read back', afterEdit.text.includes('测试统一用 pytest'))
check('confidence from the file is honoured', afterEdit.text.includes('90%'))
check('prose lines are ignored', !afterEdit.text.includes('随便写的说明'))

console.log('\n# forgetting')
const forgotten = await tool.execute({ action: 'forget', id: pendingId }, exec)
check('forget reports removal', forgotten.text.startsWith('Removed'))
check('rule gone from the file', !readProject().includes('pytest'))

console.log('\n# config')
const defaults = resolveConfig(undefined).config
check('default mode is regex (no model calls)', defaults.mode === 'regex')
check('default injection budget is 3000 chars', defaults.injectBudgetChars === 3000)
check('bad mode falls back with a warning', resolveConfig({ mode: 'magic' }).config.mode === 'regex')
check('hybrid without a route cannot extract', canExtract(resolveConfig({ mode: 'hybrid' }).config) === false)
check('hybrid with a route can extract', canExtract(resolveConfig({ mode: 'hybrid', model: { baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen2.5-coder:7b' } }).config) === true)
check('budget is clamped', resolveConfig({ injectBudgetChars: 1 }).config.injectBudgetChars === 400)
const shown = await tool.execute({ action: 'config' }, exec)
check('taste config reports the active mode', shown.text.includes('mode: hybrid') && shown.text.includes('qwen-plus'))
check('taste config never prints a key', !shown.text.includes('sk-'))

console.log('\n# request builders')
const openai = buildRequest(
  { model: { format: 'openai', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', apiKey: '', apiKeyEnv: 'DASHSCOPE_API_KEY', maxOutputTokens: 128, temperature: 0 } },
  { system: 'sys', user: 'usr' },
)
const openaiBody = JSON.parse(openai.init.body)
check('openai url ends in /chat/completions', openai.url.endsWith('/chat/completions'))
check('openai sends a system message first', openaiBody.messages[0].role === 'system' && openaiBody.messages[1].content === 'usr')
check('openai caps output tokens', openaiBody.max_tokens === 128)
const anthropic = buildRequest(
  { model: { format: 'anthropic', baseURL: 'https://api.anthropic.com', model: 'claude-sonnet-4-5', apiKey: 'test-key', apiKeyEnv: '', maxOutputTokens: 64, temperature: 0 } },
  { system: 'sys', user: 'usr' },
)
check('anthropic url ends in /v1/messages', anthropic.url.endsWith('/v1/messages'))
check('anthropic sets the version header', anthropic.init.headers['anthropic-version'] !== undefined)
check('anthropic passes the key in x-api-key', anthropic.init.headers['x-api-key'] === 'test-key')
check('anthropic parses text blocks', parseResponse('anthropic', { content: [{ type: 'text', text: 'hi' }] }) === 'hi')
check('openai parses choice content', parseResponse('openai', { choices: [{ message: { content: 'ok' } }] }) === 'ok')

console.log('\n# extraction parsing')
const parsedRules = parseRules('```json\n{"rules":[{"text":"Use const","category":"code-style"},{"text":"x","category":"nope"}]}\n```', 3)
check('fenced JSON is parsed', parsedRules.length === 1 && parsedRules[0].text === 'Use const')
check('too-short rules are dropped', parseRules('{"rules":[{"text":"x"}]}', 3).length === 0)
check('rule count is capped', parseRules('{"rules":[{"text":"aaaa"},{"text":"bbbb"},{"text":"cccc"}]}', 2).length === 2)
check('garbage returns nothing', parseRules('no json here', 3).length === 0)

rmSync(home, { recursive: true, force: true })
rmSync(work, { recursive: true, force: true })

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
