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
const ruleId = text => {
  const match = text.match(/^- \[(r_[a-z0-9]+)\]/m)
  return match?.[1]
}

const session = { id: 'sess-1' }
const exec = { agent: { session } }

apply(ctx)
emit('agent/created', { agent: { session } })

console.log('\n# registration')
check('tool registered as taste', tool?.name === 'taste')
check('prompt section registered', contexts.length === 1 && contexts[0].name === 'taste')
check('empty workspace renders no section', contexts[0].text() === '')

console.log('\n# explicit instruction is captured automatically')
emit('agent/inbox/claimed', {
  agent: { session },
  message: { content: [{ type: 'text', text: '记住：以后都用 const，别用 let' }] },
})
check('store file written', await until(() => existsSync(projectFile)))
const first = readProject()
check('rule body strips the meta prefix', first.includes('以后都用 const'))
check('rule starts active at 85%', first.includes('@0.85'))
check('prompt now contains the rule', contexts[0].text().includes('以后都用 const'))

console.log('\n# repeating the same instruction reinforces instead of duplicating')
emit('agent/inbox/claimed', {
  agent: { session },
  message: { content: [{ type: 'text', text: '记住：以后都用 const，别用 let' }] },
})
check('confidence raised to 95%', await until(() => readProject().includes('@0.95')))
check('evidence count is 2', readProject().includes('ev:2'))
check('only one rule line', readProject().match(/^- \[/gm)?.length === 1)

console.log('\n# corrections wait for distillation')
emit('agent/inbox/claimed', {
  agent: { session },
  message: { content: [{ type: 'text', text: '不要用 any，改成 unknown' }] },
})
const learned = await tool.execute({ action: 'learn' }, exec)
check('learn surfaces the correction', learned.text.includes('不要用 any'))
const learnedAgain = await tool.execute({ action: 'learn' }, exec)
check('learn drains the queue', !learnedAgain.text.includes('不要用 any'))

console.log('\n# low-confidence rules stay pending and out of the prompt')
const pending = await tool.execute({ action: 'add', text: '测试统一用 pytest', confidence: 0.4 }, exec)
check('pending rule added', pending.text.startsWith('Added'))
const withPending = readProject()
check('pending marker written', withPending.includes('[pending]'))
check('pending rule not injected', !contexts[0].text().includes('pytest'))

const pendingId = ruleId(withPending.split('\n').filter(line => line.includes('pytest')).join('\n'))
const why = await tool.execute({ action: 'why', id: pendingId }, exec)
check('why returns evidence', why.text.includes('tool add: 测试统一用 pytest'))

console.log('\n# listing')
const list = await tool.execute({ action: 'list' }, exec)
check('list shows both rules', list.text.includes('const') && list.text.includes('pytest'))
check('list reports injection state', list.text.includes('Injected into the prompt: yes'))

console.log('\n# hand edits are tolerated')
writeFileSync(
  projectFile,
  [
    '<!-- my notes: this file is mine -->',
    '这里是随便写的说明，解析器应该忽略。',
    '',
    '## code-style',
    `- [${pendingId}] 测试统一用 pytest @0.9 src:explicit ev:5`,
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

rmSync(home, { recursive: true, force: true })
rmSync(work, { recursive: true, force: true })

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
