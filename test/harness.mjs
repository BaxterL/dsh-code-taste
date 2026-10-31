/**
 * Fake-context harness: exercises apply() without a DSH process.
 *
 * Run with `node test/harness.mjs`.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'

const home = mkdtempSync(join(tmpdir(), 'taste-home-'))
const work = mkdtempSync(join(tmpdir(), 'taste-work-'))
process.env.DSH_HOME = home

const { apply, initialState } = await import('../index.js')
const { similarity, decayed, contentId, parseMarkdown, renderMarkdown } = await import('../lib/store.js')
const { classify, prefilter, captureText } = await import('../lib/signals.js')
const { resolveConfig, canExtract } = await import('../lib/config.js')
const { buildRequest, parseResponse } = await import('../lib/llm.js')
const { parseRules, runExtraction } = await import('../lib/extract.js')
const { renderPrompt } = await import('../lib/inject.js')

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
let checks = 0
const check = (label, condition) => {
  checks += 1
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
check('explicit starts pending at 50%', first.includes('@0.50') && first.includes('[pending]'))
check('id is content-addressed', ruleIdOf(first) === contentId('以后都用 const，别用 let'))
check('prompt frames rules as data, not instructions', contexts[0].text().includes('<taste-rules>') && contexts[0].text().includes('reference data'))
check('prompt withholds automatic rule', !contexts[0].text().includes('- 以后都用 const'))

console.log('\n# replay is idempotent')
say('记住：以后都用 const，别用 let')
await sleep(100)
check('replay does not raise confidence', readProject().includes('@0.50'))
check('replay does not raise evidence count', readProject().includes('ev:1'))
check('only one rule line', readProject().match(/^- \[/gm)?.length === 1)

console.log('\n# near-duplicates merge')
check('similarity detects the same intent', similarity('统一用 const，不要用 let', '统一用 const 别用 let') >= 0.8)
const beforeMerge = readProject().match(/^- \[/gm)?.length
await tool.execute({ action: 'add', text: '以后都用 const 不要用 let', confidence: 0.8 }, exec)
const afterMerge = readProject().match(/^- \[/gm)?.length
check('a near-duplicate does not create a second rule', afterMerge === beforeMerge)
check('explicit add reinforced the original', readProject().includes('ev:2'))

console.log('\n# corrections wait for distillation')
say('不要用 any，改成 unknown')
const learned = await tool.execute({ action: 'learn' }, exec)
check('learn surfaces the correction', learned.text.includes('不要用 any'))
check('learn preserves the queue', (await tool.execute({ action: 'learn' }, exec)).text.includes('不要用 any'))

console.log('\n# low-confidence rules stay pending, then promote')
const pendingAdd = await tool.execute({ action: 'add', text: '测试统一用 pytest', confidence: 0.4 }, exec)
check('pending rule added', pendingAdd.text.startsWith('Added'))
check('pending marker written', readProject().includes('[pending]'))
check('pending rule not injected', !contexts[0].text().includes('- 测试统一用 pytest'))
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
check('list reports injection state', list.text.includes('Injected into the prompt: 2 of 2'))
const profile = await tool.execute({ action: 'profile' }, exec)
check('profile summarises categories', profile.text.includes('active rules'))

console.log('\n# export')
const exported = await tool.execute({ action: 'export', format: 'agents' }, exec)
const exportPath = join(work, '.dsh', 'taste', 'export', 'AGENTS.taste.md')
check('export writes a fragment', exported.text.includes('AGENTS.taste.md') && existsSync(exportPath))
check('fragment carries the rules', readFileSync(exportPath, 'utf8').includes('以后都用 const'))

console.log('\n# pinned rules never decay')
check('pinned bypasses decay', decayed({ confidence: 0.9, pinned: true, lastSeen: '2020-01-01T00:00:00Z' }) === 0.9)
check('unpinned decays to the floor', decayed({ confidence: 0.9, lastSeen: '2020-01-01T00:00:00Z' }) === 0.25)

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
check('rewrites preserve hand-written comments and prose', readProject().includes('my notes: this file is mine') && readProject().includes('随便写的说明'))

console.log('\n# decayed rules stay visible')
const staleText = '统一用 tab 缩进'
const staleId = contentId(staleText)
writeFileSync(projectFile, `## code-style\n- [${staleId}] ${staleText} @0.60 src:tool ev:1\n`, 'utf8')
writeFileSync(
  join(work, '.dsh', 'taste', 'state.json'),
  JSON.stringify({ [staleId]: { created: '2020-01-01T00:00:00Z', lastSeen: '2020-01-01T00:00:00Z', lastUsed: '2020-01-01T00:00:00Z' } }),
  'utf8',
)
const staleList = await tool.execute({ action: 'list' }, exec)
check('list flags the decayed rule', staleList.text.includes('(decayed)'))
check('list counts injected rules', staleList.text.includes('Injected into the prompt: 0 of 1'))
check('decayed rule is not injected', !contexts[0].text().includes(`- ${staleText}`))
const staleReview = await tool.execute({ action: 'review' }, exec)
check('review surfaces the decayed rule', staleReview.text.includes(staleText) && staleReview.text.includes('decayed out of injection'))
const staleProfile = await tool.execute({ action: 'profile' }, exec)
check('profile reports that nothing is injectable', staleProfile.text.includes('No injectable rules') && staleProfile.text.includes('decayed'))
const revived = await tool.execute({ action: 'approve', id: staleId }, exec)
check('approve revives a decayed rule', revived.text.includes('next prompt assembly'))
check('revived rule is injected again', await until(() => contexts[0].text().includes(staleText)))

console.log('\n# opposite rules never merge')
const posRule = 'Use tabs for indentation'
const negRule = 'Never use tabs for indentation'
writeFileSync(projectFile, `## code-style\n- [${contentId(posRule)}] ${posRule} @0.90 src:tool ev:1\n`, 'utf8')
await tool.execute({ action: 'add', text: negRule, confidence: 0.9 }, exec)
const conflictFile = readProject()
check('opposite rule is stored separately', conflictFile.match(/^- \[/gm)?.length === 2)
check('conflict goes to review without destroying confidence', conflictFile.includes(`${posRule} @0.90 src:tool ev:1 [pending]`))
check('the new rule keeps its own score', conflictFile.includes(`${negRule} @0.90 src:tool ev:1`))
check('the contradicted rule is no longer injected', !contexts[0].text().includes(`${posRule}\n`))
check('the new rule is injected instead', contexts[0].text().includes(negRule))
const conflictReview = await tool.execute({ action: 'review' }, exec)
check('the contradicted rule waits in review', conflictReview.text.includes(posRule))
const conflictWhy = await tool.execute({ action: 'why', id: contentId(posRule) }, exec)
check('the conflict is recorded as evidence', conflictWhy.text.includes('superseded by'))

console.log('\n# budget omissions are disclosed')
const many = Array.from({ length: 6 }, (_, index) => ({
  id: `r_budget${index}`,
  text: `规则编号 ${index}：` + '这是一条用来撑爆预算的比较长的规则文本'.repeat(3),
  category: 'code-style',
  status: 'active',
  confidence: 0.9,
  evidenceCount: 1,
}))
const roomy = renderPrompt(many, { budget: 12000 })
const tight = renderPrompt(many, { budget: 400 })
check('a roomy budget renders every rule', many.every(rule => roomy.includes(rule.text)))
check('a tight budget drops rules', !tight.includes(many[5].text))
check('a tight budget discloses the omissions', /more rule\(s\) did not fit the budget/.test(tight))

console.log('\n# pending candidates are named, not merely counted')
const waitingRule = { id: 'r_waiting1', text: '不要用翻页动画，观感差。', category: 'avoid', status: 'pending', confidence: 0.5, evidenceCount: 1, scope: 'project' }
const hinted = renderPrompt([waitingRule], { budget: 1200, candidates: [waitingRule] })
check('the hint names the candidate id', hinted.includes('r_waiting1'))
check('the hint says the candidate is not applied', hinted.includes('NOT applied'))
check('the candidate is not rendered as a rule line', !hinted.includes('- [avoid] 不要用翻页动画'))
const manyWaiting = Array.from({ length: 6 }, (_, index) => ({ ...waitingRule, id: `r_wait${index}`, text: `等待确认的规则 ${index}` }))
const countedOnly = renderPrompt([], { budget: 400, candidates: manyWaiting })
check('a tight budget falls back to an exact count', /6 rule\(s\) await review/.test(countedOnly) && !countedOnly.includes('r_wait0'))

console.log('\n# config')
const defaults = resolveConfig(undefined).config
check('default source is host (session model)', defaults.model.source === 'host')
check('default injection budget is 3000 chars', defaults.injectBudgetChars === 3000)
check('bad mode falls back with a warning', resolveConfig({ mode: 'magic' }).config.model.source === 'none')
check('hybrid without a route cannot extract', canExtract(resolveConfig({ mode: 'hybrid' }).config) === false)
check('hybrid with a route can extract', canExtract(resolveConfig({ mode: 'hybrid', model: { baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen2.5-coder:7b' } }).config) === true)
check('host source needs no route', canExtract(resolveConfig({ model: { source: 'host' } }).config) === true)
check('host source is described as the harness model', resolveConfig({ model: { source: 'host' } }).config.model.source === 'host')
check('budget is clamped', resolveConfig({ injectBudgetChars: 1 }).config.injectBudgetChars === 400)
const shown = await tool.execute({ action: 'config' }, exec)
check('taste config reports the active mode', shown.text.includes('source: custom') && shown.text.includes('qwen-plus'))
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

console.log('\n# capture boundaries and storage round trips')
check('long explicit paste is rejected instead of truncated', !prefilter('一律'.repeat(400)).ok)
check('quoted guardrails are not captured', captureText('> 永远不要用 any') === '')
check('fenced instructions are not captured', captureText('```text\n永远不要用 any\n```') === '')
check('inline quotation is not a preference', classify(captureText('文档写着“永远不要用 any”')) === null)
check('multiline lists are not captured', captureText('一律使用 const\n绝对不要用 any') === '')
const roundTrip = [{ id: 'r_roundtrip', text: 'Use const\r\nwithout reassignment src:example', category: 'code-style', confidence: 0.82, evidenceCount: 3, source: 'tool', status: 'pending', pinned: true, glob: 'src/**' }]
const restored = parseMarkdown(renderMarkdown(roundTrip), 'project')[0]
check('multiline serialization normalizes text without losing metadata', restored.text === 'Use const without reassignment src:example' && restored.confidence === 0.82 && restored.status === 'pending' && restored.glob === 'src/**' && restored.pinned)
const notes = '<!-- personal notes -->\nSome prose.\n## code-style\n- [r_note] Use const @0.82 src:tool ev:1\nTail note.\n'
check('parse-render preserves unknown lines in place', renderMarkdown(parseMarkdown(notes, 'project')) === notes)
let rejected = false
try { await tool.execute({ action: 'add', text: 'Use const\nNever use tabs' }, exec) } catch { rejected = true }
check('tool rejects multiline input', rejected)
rejected = false
try { await tool.execute({ action: 'add', text: 'Use api_key=abcdefghijklmnop' }, exec) } catch { rejected = true }
check('tool rejects secrets too', rejected)

console.log('\n# automatic proposals cannot change trusted rules')
const trustedText = 'Use semicolons consistently'
await tool.execute({ action: 'add', text: trustedText, confidence: 0.9 }, exec)
await tool.execute({ action: 'propose', text: 'Never use semicolons consistently', confidence: 0.99 }, exec)
await tool.execute({ action: 'propose', text: 'Never use semicolons consistently', confidence: 0.99 }, exec)
let rows = parseMarkdown(readProject(), 'project')
check('automatic conflict leaves trusted original active at 90%', rows.find(row => row.text === trustedText)?.status === 'active' && rows.find(row => row.text === trustedText)?.confidence === 0.9)
const proposal = rows.find(row => row.text.startsWith('Never use semicolons'))
check('repeated proposals stay pending at 50%', proposal?.status === 'pending' && proposal.confidence === 0.5)
await tool.execute({ action: 'approve', id: proposal.id }, exec)
rows = parseMarkdown(readProject(), 'project')
check('approving the opposite moves the original to review', rows.find(row => row.text === trustedText)?.status === 'pending')
check('default writes stay in the project', !existsSync(join(home, 'taste', 'TASTE.md')))

console.log('\n# concurrent transactions and actual usage')
const concurrent = ['Quartz alpha', 'Zircon beta', 'Topaz gamma', 'Opal delta', 'Ruby epsilon', 'Onyx zeta']
await Promise.all(concurrent.map(text => tool.execute({ action: 'add', text }, exec)))
rows = parseMarkdown(readProject(), 'project')
check('parallel adds do not lose rules', concurrent.every(text => rows.some(row => row.text === text)))
const usageRules = concurrent.map((text, index) => ({ id: contentId(text), text: `${text} ${String.fromCharCode(97 + index).repeat(170)}`, category: 'code-style', confidence: 0.9, evidenceCount: 1, source: 'tool', status: 'active' }))
writeFileSync(projectFile, renderMarkdown(usageRules))
writeFileSync(join(work, '.dsh', 'taste', 'state.json'), '{}')
const assembled = contexts[0].text()
check('prompt rendering does not write usage', readFileSync(join(work, '.dsh', 'taste', 'state.json'), 'utf8') === '{}')
check('full rendered section obeys the configured budget', assembled.length <= 1200)
const actuallyUsed = usageRules.filter(rule => assembled.includes(rule.text))
check('budget test drops some rules', actuallyUsed.length > 0 && actuallyUsed.length < usageRules.length)
const usageList = await tool.execute({ action: 'list' }, exec)
check('list counts only budget-selected rules', usageList.text.includes(`Injected into the prompt: ${actuallyUsed.length} of ${usageRules.length}`))
writeFileSync(join(work, '.dsh', 'taste', 'state.json'), JSON.stringify({ r_unrelated: { created: '2026-01-01T00:00:00Z', recalled: 7 } }))
emit('agent/turn-stopping', { agent: { session } })
check('usage is batched after the turn', await until(() => {
  const state = JSON.parse(readFileSync(join(work, '.dsh', 'taste', 'state.json'), 'utf8'))
  return actuallyUsed.every(rule => state[rule.id]?.recalled === 1) && usageRules.filter(rule => !actuallyUsed.includes(rule)).every(rule => !state[rule.id])
}))
check('usage writes merge with the records already on disk', await until(() => JSON.parse(readFileSync(join(work, '.dsh', 'taste', 'state.json'), 'utf8')).r_unrelated?.recalled === 7))
emit('agent/turn-stopping', { agent: { session } })
await sleep(50)
check('duplicate stop events do not double-count usage', actuallyUsed.every(rule => JSON.parse(readFileSync(join(work, '.dsh', 'taste', 'state.json'), 'utf8'))[rule.id]?.recalled === 1))
const beforeBrokenState = readProject()
writeFileSync(join(work, '.dsh', 'taste', 'state.json'), '{broken')
rejected = false
try { await tool.execute({ action: 'add', text: 'Sapphire theta' }, exec) } catch { rejected = true }
check('corrupt sidecar fails closed without overwriting rules or state', rejected && readProject() === beforeBrokenState && readFileSync(join(work, '.dsh', 'taste', 'state.json'), 'utf8') === '{broken')
writeFileSync(join(work, '.dsh', 'taste', 'state.json'), '{}')

console.log('\n# cross-process lock')
const lockModule = new URL('../lib/lock.js', import.meta.url).href
const counterPath = join(work, 'counter.json')
writeFileSync(counterPath, '0')
const worker = `import {withStoreLock} from ${JSON.stringify(lockModule)}; import {readFile,writeFile} from 'node:fs/promises'; for(let i=0;i<5;i++) await withStoreLock(${JSON.stringify(work)},async()=>{const n=Number(await readFile(${JSON.stringify(counterPath)},'utf8'));await new Promise(r=>setTimeout(r,5));await writeFile(${JSON.stringify(counterPath)},String(n+1));});`
await Promise.all(Array.from({ length: 3 }, () => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', worker], { stdio: 'inherit' })
  child.on('error', reject)
  child.on('exit', code => code === 0 ? resolve() : reject(new Error(`worker exit ${code}`)))
})))
check('separate processes cannot overwrite each other', readFileSync(counterPath, 'utf8') === '15')

console.log('\n# extraction failures, retries and input acknowledgements')
const extractionConfig = resolveConfig({ source: 'none', maxOutputTokens: 256, maxInputChars: 200 }).config
const signals = [{ text: 'Use const for bindings', kind: 'correction' }, { text: 'x'.repeat(180), kind: 'correction' }]
let calls = 0
const extracted = []
const extraction = await runExtraction({ config: extractionConfig, pending: signals, cwd: work, addRule: async (_cwd, input) => extracted.push(input), callModel: async prompt => {
  calls += 1
  if (calls === 1) return { text: '{"rules":[', finishReason: 'length', usage: { outputTokens: 256 } }
  check('truncation retry raises the token limit', prompt.maxOutputTokens === 1024)
  return { text: '{"rules":[{"text":"Use const for bindings"}]}' }
} })
check('only signals actually sent are acknowledged', extraction.consumed === 1 && extraction.inputChars <= 200)
check('the starting confidence comes from the host, not the model', extracted[0]?.confidence === 0.5 && extracted[0]?.kind === 'extracted')
const distilled = []
await runExtraction({
  config: extractionConfig,
  pending: [signals[0]],
  cwd: work,
  confidence: 0.62,
  addRule: async (_cwd, input) => { distilled.push(input) },
  callModel: async () => '{"rules":[{"text":"Use const for bindings","category":"code-style"}]}',
})
check('a distilled rule carries the host confidence', distilled[0]?.confidence === 0.62)
check('distilled rules start in force', initialState(distilled[0]?.kind, distilled[0]?.confidence).status === 'active')
check('verbatim captures still wait for review', initialState('explicit', 0.85).status === 'pending' && initialState('explicit', 0.85).base === 0.5)
check('a proposal waits regardless of the confidence offered', initialState('proposed', 0.99).status === 'pending')
rejected = false
try { await runExtraction({ config: extractionConfig, pending: signals, cwd: work, addRule: async () => {}, callModel: async () => 'broken JSON' }) } catch { rejected = true }
check('malformed extraction rejects rather than reporting zero-rule success', rejected)
rejected = false
try { await runExtraction({ config: extractionConfig, pending: signals, cwd: work, addRule: async () => {}, callModel: async () => ({ text: '{"rules":[]}', finishReason: 'length' }) }) } catch { rejected = true }
check('repeated truncation is an error', rejected)

console.log('\n# settings CSRF boundary and queue restart')
let route
let restartedTool
const restartedHandlers = new Map()
const secureCtx = {
  ...ctx,
  effect: run => run(),
  get: name => name === 'webServer' ? { register: entry => { route = entry.handler } } : undefined,
  on: (name, listener) => restartedHandlers.set(name, listener),
  tools: { register: definition => { restartedTool = definition } },
}
apply(secureCtx, { source: 'none' })
restartedHandlers.get('agent/created')({ agent: { session } })
check('pending signals survive plugin restart', (await restartedTool.execute({ action: 'learn' }, exec)).text.includes('不要用 any'))
const requestConfig = async (method, headers = {}, body = {}) => {
  const request = new EventEmitter()
  Object.assign(request, { method, headers: { host: 'localhost:1234', ...headers }, socket: {} })
  const response = { writeHead(status) { this.status = status }, end(text) { this.text = text } }
  const task = route(request, response)
  process.nextTick(() => { request.emit('data', JSON.stringify(body)); request.emit('end') })
  await task
  return response
}
const settings = JSON.parse((await requestConfig('GET')).text)
check('settings GET issues a CSRF token', typeof settings.csrfToken === 'string')
check('no-cors POST cannot modify settings', (await requestConfig('POST', { 'content-type': 'text/plain' }, { field: 'source', value: 'custom' })).status === 403)
const safeHeaders = { 'content-type': 'application/json', 'x-taste-csrf': settings.csrfToken, origin: 'http://localhost:1234' }
check('wrong origin is rejected even with token', (await requestConfig('POST', { ...safeHeaders, origin: 'https://attacker.invalid' }, { field: 'source', value: 'custom' })).status === 403)
check('same-origin token-bearing save works', (await requestConfig('POST', safeHeaders, { field: 'source', value: 'none' })).status === 200)
check('inline key cannot be persisted through settings', (await requestConfig('POST', safeHeaders, { field: 'apiKey', value: 'test-secret' })).status === 400)
check('no inline secret reaches disk', !readFileSync(join(home, 'taste', 'settings.json'), 'utf8').includes('test-secret'))

console.log('\n# none mode stays useful')
const home2 = mkdtempSync(join(tmpdir(), 'taste-home2-'))
const work2 = mkdtempSync(join(tmpdir(), 'taste-work2-'))
process.env.DSH_HOME = home2
const handlers2 = new Map()
const sections2 = []
const ctx2 = {
  logger: { info: () => {}, warn: () => {} },
  effect: run => run(),
  on(name, listener) {
    if (!handlers2.has(name)) handlers2.set(name, [])
    handlers2.get(name).push(listener)
  },
  tools: { register: () => {} },
  systemPrompt: {
    section(entry) {
      sections2.push(entry)
    },
    context: () => {},
  },
  workingDirectory: { get: () => work2 },
}
apply(ctx2, { source: 'none' })
const session2 = { id: 'sess-none' }
const emit2 = (name, payload) => {
  for (const listener of handlers2.get(name) ?? []) listener.call(ctx2, payload)
}
emit2('agent/created', { agent: { session: session2 } })
check('guidance is injected without a model route', sections2.some(entry => typeof entry.text === 'function' && entry.text().includes('Taste memory')))
emit2('agent/inbox/claimed', { agent: { session: session2 }, message: { content: [{ type: 'text', text: '不要用 any，改成 unknown' }] } })
await sleep(300)
const globalFile2 = join(work2, '.dsh', 'taste', 'TASTE.md')
const noneText = existsSync(globalFile2) ? readFileSync(globalFile2, 'utf8') : ''
check('correction becomes a pending rule instead of a dead queue entry', noneText.includes('[pending]'))
check('the correction text is kept', noneText.includes('不要用 any'))
check('regex mode writes no active rule', !/不要用 any @0\.(5[5-9]|[6-9])/.test(noneText))

rmSync(home, { recursive: true, force: true })
rmSync(work, { recursive: true, force: true })
rmSync(home2, { recursive: true, force: true })
rmSync(work2, { recursive: true, force: true })

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
