/**
 * The model-facing `taste` tool: read, review, add and remove rules.
 *
 * @module dsh-code-taste/tool
 */

import { renderPrompt } from './inject.js'

const ACTIONS = ['list', 'learn', 'add', 'review', 'approve', 'forget', 'why', 'profile', 'export']

/**
 * Build the tool definition.
 * @param {object} api - host callbacks supplied by index.js.
 * @returns {object} a tool definition for ctx.tools.register.
 */
export function createTasteTool(api) {
  return {
    name: 'taste',
    description:
      "The user's coding-taste rules for this workspace: confidence-scored conventions learned from their own corrections. " +
      'Call `list` before writing code in an unfamiliar area; call `learn` to review corrections captured in this session and distil the durable ones with `add`; ' +
      'call `review`/`approve` to promote unconfirmed candidates; call `why` when a rule looks wrong so you can quote its evidence; ' +
      'call `profile` for a one-paragraph summary; call `export` to write the rules into an AGENTS.md/CLAUDE.md fragment.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ACTIONS,
        description:
          'list | learn | add | review | approve | forget | why | profile | export.',
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
        description: 'For `why`/`approve`/`forget`: the rule id shown by `list`/`review`.',
      },
      confidence: {
        type: 'number',
        description: 'For `add`: 0..1; omit for 0.55 (distilled by the agent) — explicit instructions are captured automatically at 0.85+.',
      },
      glob: {
        type: 'string',
        description: 'For `add`: restrict the rule to matching paths, e.g. "src/ui/**".',
      },
      format: {
        type: 'string',
        enum: ['agents', 'claude'],
        description: 'For `export`: AGENTS.taste.md (default) or CLAUDE.taste.md.',
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
        if (rules.length === 0) return { text: 'No taste rules yet for this workspace.' }
        const lines = rules.map(rule => {
          const suffix = rule.status === 'active' ? '' : ` (${rule.status})`
          const glob = rule.glob ? ` → ${rule.glob}` : ''
          return `- ${rule.id} [${rule.scope}/${rule.category}] ${rule.text}${glob} — ${Math.round(rule.confidence * 100)}%${suffix}`
        })
        const injected = renderPrompt(rules).length > 0 ? 'yes' : 'no'
        return { text: `Taste rules:\n${lines.join('\n')}\n\nInjected into the prompt: ${injected}.` }
      }

      if (args.action === 'learn') {
        const pending = api.takePending(sessionId)
        if (pending.length === 0) return { text: 'No pending corrections in this session.' }
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
          kind: 'tool',
          source: 'tool',
          quote: `tool add: ${text}`,
        })
        const verb = stored.created ? 'Added' : 'Reinforced'
        return {
          text: `${verb} ${stored.rule.id} (${stored.rule.scope}): ${stored.rule.text} — ${Math.round(stored.rule.confidence * 100)}%`,
        }
      }

      if (args.action === 'review') {
        const rules = await api.readMerged(cwd)
        const waiting = rules.filter(rule => rule.status === 'pending')
        if (waiting.length === 0) return { text: 'Nothing is waiting for review.' }
        const lines = waiting.map(
          rule => `- ${rule.id} [${rule.category}] ${rule.text} — ${Math.round(rule.confidence * 100)}%, seen ${rule.evidenceCount}×`,
        )
        return {
          text: `Unconfirmed candidates (not injected yet):\n${lines.join('\n')}\n\nApprove with \`taste approve id:<id>\`, drop with \`taste forget\`.`,
        }
      }

      if (args.action === 'approve') {
        const id = typeof args.id === 'string' ? args.id.trim() : ''
        if (id.length === 0) return { text: '`id` is required.' }
        const ok = await api.approveRule(cwd, id)
        return { text: ok ? `Approved ${id}; it is injected from the next session.` : `No rule ${id}.` }
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

      if (args.action === 'profile') {
        const rules = await api.readMerged(cwd)
        const active = rules.filter(rule => rule.status === 'active')
        if (active.length === 0) return { text: 'No active taste rules yet.' }
        const byCategory = new Map()
        for (const rule of active) {
          byCategory.set(rule.category, (byCategory.get(rule.category) ?? 0) + 1)
        }
        const summary = [...byCategory.entries()].map(([category, count]) => `${category} ×${count}`).join(', ')
        const strongest = active.slice(0, 5).map(rule => `- ${rule.text}`)
        return {
          text: `This user's established taste (${active.length} active rules: ${summary}).\nStrongest signals:\n${strongest.join('\n')}`,
        }
      }

      if (args.action === 'export') {
        const path = await api.exportTaste(cwd, args.format === 'claude' ? 'claude' : 'agents')
        return { text: path === undefined ? 'Nothing to export: no active rules.' : `Wrote ${path}.` }
      }

      return { text: `Unknown action ${String(args.action)}.` }
    },
  }
}
