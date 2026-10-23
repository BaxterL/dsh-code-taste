# dsh-code-taste

[English](README.md) | [中文](README.zh.md)

![dsh-code-taste banner](https://baxterl.github.io/assets/dsh-code-taste/banner.png?v=2)

Teaches DeepSeek Harness **your** taste — coding style, aesthetic preferences and the
habits you keep correcting — the way
[Command Code's taste](https://commandcode.ai/docs/taste) works, and applies it to
every session.

Status: **v0.2.0**. Capture, storage, injection, review, export and the tool are
implemented and covered by the fake-context harness. The LLM extractor, diff signal
and path-glob selection are P1+; see [docs/ROADMAP.md](docs/ROADMAP.md).

## How it works

```
user message ─▶ signals.js ─▶ prefilter ─▶ pending queue ─▶ taste learn
                    │                                    │
                    └─ explicit/guardrail ─▶ auto add ────┤
                                                          ▼
        systemPrompt.context ◀─ inject.js ◀─ TASTE.md ◀─ merge / decay
```

- **Capture** — `agent/inbox/claimed` is filtered deterministically, then matched
  against named patterns (explicit / guardrail / positive / correction). Explicit and
  never-style guardrails are written at once (0.85–0.90); corrections wait for the
  model to distil them (`taste learn` → `taste add`).
- **Store** — human-editable markdown is the single source of truth, two layers:
  - project: `<workspace>/.dsh/taste/TASTE.md`
  - global: `${DSH_HOME:-~/.dsh}/taste/TASTE.md`
- **Inject** — merged rules become one `systemPrompt` section (order 920), frozen per
  session so the prompt prefix stays KV-cache stable, and framed as *reference data,
  not instructions*.
- **Explain** — every change appends to `evidence.jsonl`; `taste why <id>` shows it.

## Rule format

```markdown
## code-style
- [r_a1b2c3d4] 统一用 const，除非需要重新赋值 @0.85 src:explicit ev:2

## avoid
- [r_9x8y7z6w] 不引入 moment.js @0.72 src:correction ev:3 [pending] [glob:src/ui/**]
```

`- [id] text @confidence src:source ev:count [pending|archived] [pinned] [glob:…]`.
Anything else in the file is a comment, so you can annotate freely.

Rule ids are **content-addressed** (SHA-1 of the normalized text), so the same rule
learned twice resolves to the same id instead of forking.

## Tool

| action | purpose |
| --- | --- |
| `list` | rules in effect, with scope, category, confidence |
| `learn` | corrections captured in this session, for distillation |
| `add` | add or reinforce a rule (near-duplicates merge automatically) |
| `review` | unconfirmed candidates, withheld from the prompt |
| `approve` | promote one candidate |
| `forget` | drop a rule by id |
| `why` | evidence behind a rule |
| `profile` | one-paragraph summary of the user's taste |
| `export` | write `AGENTS.taste.md` / `CLAUDE.taste.md` under `.dsh/taste/export/` |

## Confidence and lifecycle

`active` rules are injected; `pending` (< 0.55) are not until a second piece of
evidence or an explicit `approve`. Repeated corrections add +0.10 and one evidence
record; positive feedback reinforces the strongest injected rule. Confidence decays
with a 60-day half-life from `last_used`/`last_seen`; `[pinned]` rules never decay.

## What this borrows, and from where

- **Named pattern tables + tool-rejection capture** — [claude-reflect](https://github.com/BayramAnnakov/claude-reflect)
  (correction / positive / explicit, confidence per pattern, queue then human review).
- **Stage-0 secret rejection, generalization, pending staging** — [komi-learn](https://github.com/kurikomi-labs/komi-learn)
  (credential/PII floor, canonical content ids, usage tracking, freeze-at-session-start).
- **Before/after evidence as the strongest signal** — [high-taste](https://github.com/alexdong/high-taste)
  (P1: diff learning).
- **Conventions inferred from the repo itself at low confidence** — [kronode](https://pypi.org/project/kronode/).
- **Category-keyed profile** — [hawk](https://pkg.go.dev/github.com/GrayCodeAI/hawk@v0.1.0).

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
