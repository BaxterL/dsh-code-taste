/**
 * The model-facing `taste` tool: read, review, add and remove rules.
 *
 * @module dsh-taste/tool
 */

import { renderPrompt } from './inject.js'

/**
 * Build the tool definition.
 * @param {object} api - host callbacks supplied by index.js.
 * @param {function} api.cwdOf - session -> working directory.
 * @param {function} api.sessionIdOf - session -> stable id.
 * @param {function} api.readMerged - cwd -> merged rules with effective confidence.
 * @param {function} api.addRule - cwd -> rule input (async) -> stored rule.
 * @param {function} api.forgetRule - cwd -> id (async) -> removed count.
 * @param {function} api.evidenceFor - cwd -> id (async) -> evidence records.
 * @param {function} api.takePending - session id -> pending signal list.
 * @returns {object} a tool definition for ctx.tools.register.
 */
export function createTasteTool(api) {
  return {
    name: 'taste',
    description:
      "The user's coding-taste rules for this workspace: confidence-scored conventions learned from their own corrections. " +
      'Call `list` before writing code in an unfamiliar area; call `learn` to review corrections captured in this session and distil the durable ones with `add`; ' +
      'call `why` when a rule looks wrong so you can quote its evidence to the user; call `forget` to drop a rule they no longer want.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'learn', 'add', 'forget', 'why'],
        description:
          'list (rules in effect) | learn (pending corrections) | add (one rule or reinforce an existing one) | forget (drop by id) | why (evidence behind a rule).',
      },
      text: {
        type: 'string',
        description: 'For `add`: the rule as one short imperative sentence, e.g. "Use const unless reassignment is required".',
      },
      category: {
        type: 'string',
        description: 'For `add`: code-style | design | stack | workflow | project-detail | communication | avoid.',
      },
      scope: {
        type: 'string',
        enum: ['project', 'global'],
        description: 'For `add`/`forget`: project (default, this workspace) | global (every workspace).',
      },
      id: {
        type: 'string',
        description: 'For `why`/`forget`: the rule id shown by `list`.',
      },
      confidence: {
        type: 'number',
        description: 'For `add`: 0..1; omit for 0.5, or 0.85 when the user stated it explicitly.',
      },
      glob: {
        type: 'string',
        description: 'For `add`: restrict the rule to matching paths, e.g. "src/ui/**".',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    presentCall: args => ({
      card: 'generic',
      title: `Code taste: ${args.action}`,
      kind: 'other',
      rawInput: args,
    }),
    async execute(args, exec) {
      const session = exec?.agent?.session
      const cwd = api.cwdOf(session)
      const sessionId = api.sessionIdOf(session)

      if (args.action === 'list') {
        const rules = await api.readMerged(cwd)
        if (rules.length === 0) {
          return { text: 'No taste rules yet for this workspace.' }
        }
        const lines = rules.map(rule => {
          const state = rule.status === 'active' ? '' : ` (${rule.status})`
          const glob = rule.glob ? ` → ${rule.glob}` : ''
          return `- ${rule.id} [${rule.scope}/${rule.category}] ${rule.text}${glob} — ${Math.round(rule.confidence * 100)}%${state}`
        })
        const injectable = renderPrompt(rules).length
        return {
          text: `Taste rules:\n${lines.join('\n')}\n\nInjected into the prompt: ${injectable > 0 ? 'yes' : 'no'}.`,
        }
      }

      if (args.action === 'learn') {
        const pending = api.takePending(sessionId)
        if (pending.length === 0) {
          return { text: 'No pending corrections in this session.' }
        }
        const lines = pending.map((entry, index) => `${index + 1}. (${entry.kind}) ${entry.text}`)
        return {
          text:
            'Corrections captured in this session. Distil only durable, generalizable ones into short imperative rules, then call `taste` with action `add` for each one (skip task-specific instructions):\n' +
            lines.join('\n'),
        }
      }

      if (args.action === 'add') {
        const text = typeof args.text === 'string' ? args.text.trim() : ''
        if (text.length === 0) return { text: 'Nothing added: `text` is required.' }
        const stored = await api.addRule(cwd, {
          text,
          category: args.category,
          scope: args.scope,
          confidence: args.confidence,
          glob: args.glob,
          source: 'explicit',
          kind: 'tool',
          quote: `tool add: ${text}`,
        })
        const verb = stored.created ? 'Added' : 'Reinforced'
        return {
          text: `${verb} ${stored.rule.id} (${stored.rule.scope}): ${stored.rule.text} — ${Math.round(stored.rule.confidence * 100)}%`,
        }
      }

      if (args.action === 'forget') {
        const id = typeof args.id === 'string' ? args.id.trim() : ''
        if (id.length === 0) return { text: 'Nothing removed: `id` is required.' }
        const removed = await api.forgetRule(cwd, id, args.scope)
        return { text: removed > 0 ? `Removed ${id}.` : `No rule ${id} found.` }
      }

      if (args.action === 'why') {
        const id = typeof args.id === 'string' ? args.id.trim() : ''
        if (id.length === 0) return { text: '`id` is required.' }
        const records = await api.evidenceFor(cwd, id)
        if (records.length === 0) return { text: `No evidence recorded for ${id}.` }
        const lines = records.slice(-8).map(record => `- ${record.at} (${record.kind}) ${record.quote}`)
        return { text: `Evidence for ${id}:\n${lines.join('\n')}` }
      }

      return { text: `Unknown action ${String(args.action)}.` }
    },
  }
}
