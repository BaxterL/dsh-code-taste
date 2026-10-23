# dsh-taste

Teaches DeepSeek Harness **your** coding taste — the way
[Command Code's taste](https://commandcode.ai/docs/taste) works — and applies it to
every session.

Status: **v0.1.0 / P0**. Capture, storage, injection and the tool are implemented and
covered by the fake-context harness. The LLM extractor, diff signal, path-glob
selection, decay review UI and settings panel are the next phases (see `docs/ROADMAP.md`).

## How it works

```
user message ──▶ signals.js ──▶ prefilter ──▶ pending queue ──▶ taste tool (`learn`)
                     │                                  │
                     └── explicit ──▶ auto add (0.85) ───┤
                                                        ▼
                     systemPrompt.context ◀── inject.js ◀── TASTE.md
```

- **Capture** — `agent/inbox/claimed` is filtered deterministically (secrets, questions,
  one-off instructions, length) and classified as explicit / corrective / positive.
  Explicit instructions are written immediately at 0.85; corrections wait for the model
  to distil them with `taste learn` → `taste add`.
- **Store** — human-editable markdown as the single source of truth, two layers:
  - project: `<workspace>/.dsh/taste/TASTE.md`
  - global: `${DSH_HOME:-~/.dsh}/taste/TASTE.md`
- **Inject** — merged rules become one `systemPrompt` section (order 920), frozen per
  session so the prompt prefix stays KV-cache stable.
- **Explain** — every change appends to `evidence.jsonl`; `taste why <id>` shows it.

## Rule format

```markdown
## code-style
- [r_a1b2c3d4] 统一用 const，除非需要重新赋值 @0.85 src:explicit ev:2

## avoid
- [r_9x8y7z6w] 不引入 moment.js @0.72 src:corrective ev:3 [pending]
```

`- [id] text @confidence src:source ev:count [pending|archived] [glob:src/ui/**]`.
Anything else in the file is a comment, so you can annotate freely.

## Tool

| action | purpose |
| --- | --- |
| `list` | rules in effect, with scope, category and confidence |
| `learn` | corrections captured in this session, for distillation |
| `add` | add or reinforce a rule (`text`, `category?`, `scope?`, `confidence?`, `glob?`) |
| `forget` | drop a rule by `id` |
| `why` | evidence behind a rule |

## Confidence

`active` rules are injected; `pending` (< 0.55) are not. Repeated corrections add
+0.10 and one evidence record; positive feedback reinforces the most recently injected
rule. Confidence decays with a 60-day half-life from `last_seen`.

## Install

```sh
dsh plugin --profile desktop add <path-or-git-url>
```

then restart DSH. The bundle inserts one row, `taste`.

## Development

```sh
node test/harness.mjs
```

The harness drives `apply(ctx)` with a fake context — no DSH process, no install.
