# dsh-code-taste

[English](README.md) | [中文](README.zh.md)

![dsh-code-taste banner](https://baxterl.github.io/assets/dsh-code-taste/banner.png?v=2)

A DeepSeek Harness plugin that learns **your** coding taste — style, aesthetic
preferences, and the habits you keep correcting — and applies it in every session.

## What it is

Every new session starts from zero: you re-teach `const` over `let`, the 8px corner
radius, the commit format, the reply language. This plugin listens for those moments,
turns them into confidence-scored rules, keeps them in a markdown file you can edit by
hand, and puts the confirmed ones in front of the model at the start of every session.

Everything stays on your machine as plain files. No network calls, no telemetry.

## Install

### Requirements

- DeepSeek Harness `0.2.x` (verified on `0.2.1-rc.2`)
- Node.js `22.19+` or `24+` (the version DSH itself runs on)

No other dependencies — the bundle has none and needs no build step.

### From GitHub

```sh
dsh plugin --profile desktop add github:BaxterL/dsh-code-taste
```

### From a local checkout

```sh
git clone https://github.com/BaxterL/dsh-code-taste
dsh plugin --profile desktop add ./dsh-code-taste
```

A local checkout is linked, not copied, so edits take effect after the next restart.

### Restart is required

The bundle inserts its row when the host starts. There is no hot reload for a new
bundle, so **restart DSH** after installing.

### Verify

In a new session, ask for the rules:

```
taste list
```

An empty workspace answers `No taste rules yet for this workspace.` That means the tool
is live and nothing has been learned yet. You can also check that
`<workspace>/.dsh/taste/` appears after the first captured rule.

### Update

```sh
dsh plugin --profile desktop add github:BaxterL/dsh-code-taste   # reinstall latest
```

then restart. If you installed from a local checkout, `git pull` is enough.

### Uninstall

Remove the bundle from **Settings → Plugins**, or:

```sh
dsh plugin --profile desktop remove dsh-code-taste
```

then restart. Your `TASTE.md` files are left untouched — delete `.dsh/taste/` and
`~/.dsh/taste/` yourself if you want a clean slate.

## Usage

### Teach it by talking

| You say | What happens |
| --- | --- |
| 记住：以后都用 const · *remember: always use const* | Written immediately, confidence 0.85–0.90, active |
| 永远不要用 moment.js · *never use moment.js* | Written immediately as a guardrail, 0.88 |
| 不要用 any，改成 unknown · *don't use any, use unknown* | Queued as a correction; run `taste learn` to review it |
| 对，就这样 · *perfect, exactly like that* | Reinforces the strongest rule currently injected (+0.10) |

Questions, one-off instructions ("this time", "for now") and anything containing a
credential are dropped before they reach the store.

### Review what it picked up

Corrections wait for you instead of polluting the prompt:

```
taste review
taste approve id:r_8f2a1c
```

A candidate also promotes itself once it has been seen twice.

### Edit the rules by hand

`<workspace>/.dsh/taste/TASTE.md`

```markdown
## code-style
- [r_8f2a1c] 统一用 const，除非需要重新赋值 @0.85 src:explicit ev:2

## avoid
- [r_9x8y7z6] 不引入 moment.js @0.72 src:correction ev:3 [pending] [glob:src/ui/**]
```

`- [id] text @confidence src:source ev:count [pending|archived] [pinned] [glob:path]`.
Any line that does not match is treated as a comment, so you can annotate freely.

### Ask why

```
taste why id:r_8f2a1c
```

Prints the evidence records: when it was captured, which signal fired, and the original
sentence (trimmed to 200 characters, never the surrounding code).

### Export to other tools

```
taste export format:agents     # .dsh/taste/export/AGENTS.taste.md
taste export format:claude     # .dsh/taste/export/CLAUDE.taste.md
```

The fragment lists active rules only, without confidence — safe to paste into an
`AGENTS.md` or a `CLAUDE.md`.

## Tools

The plugin exposes one tool, `taste`.

| action | parameters | result |
| --- | --- | --- |
| `list` | — | every rule with scope, category, confidence, and whether injection is active |
| `learn` | — | drains this session's pending corrections and asks you to distil the durable ones |
| `add` | `text`, `category?`, `scope?`, `confidence?`, `glob?` | adds a rule, or reinforces a near-duplicate |
| `review` | — | pending candidates that are deliberately not injected |
| `approve` | `id` | promotes a candidate to active |
| `forget` | `id`, `scope?` | removes a rule from one or both scopes |
| `why` | `id` | evidence records for one rule |
| `profile` | — | one-paragraph summary plus the strongest rules |
| `export` | `format` (`agents` \| `claude`) | writes a markdown fragment under `.dsh/taste/export/` |

### Parameters

- **`text`** — one imperative sentence, ≤ 200 characters. Write it so it still makes sense
  a month later: "Use const unless reassignment is required", not "change this".
- **`category`** — `code-style` (default), `design`, `stack`, `workflow`, `project-detail`,
  `communication`, `avoid`. It only groups rules and labels them in the prompt; it does
  not change behaviour.
- **`scope`** — `project` (default) lives in the workspace, `global` applies everywhere.
  Project rules shadow global rules with the same text.
- **`confidence`** — `0.1`–`0.95`. Omit it and the source decides: `0.55` for a rule the
  agent adds, `0.85–0.90` for an explicit instruction. Below `0.55` the rule lands in
  `pending` and is not injected.
- **`glob`** — restricts a rule to matching paths, e.g. `src/ui/**`. Stored and shown now;
  path matching arrives in P2.
- **`id`** — content-addressed (`r_` plus the first 8 hex characters of the normalized
  text), so the same rule learned twice resolves to the same id.

## Details

### Confidence and lifecycle

| Stage | Rule |
| --- | --- |
| Base score | explicit 0.85 · guardrail 0.88 · correction 0.60 · agent-added 0.55 |
| Reinforcement | +0.10 per repeat or positive feedback, capped at 0.95 |
| Promotion | pending → active on a second piece of evidence or on `approve` |
| Decay | half-life 60 days measured from `last_used` / `last_seen` |
| Pinned | `[pinned]` exempts a rule from decay |
| Archive | effective confidence below 0.25 counts as archived (kept on disk, never injected) |
| Dedupe | containment similarity ≥ 0.80 after folding 别用/不要用, 改成/换成 … |

### Where things live

| File | Purpose |
| --- | --- |
| `<workspace>/.dsh/taste/TASTE.md` | project rules — the file you edit |
| `${DSH_HOME:-~/.dsh}/taste/TASTE.md` | global rules, shared by every workspace |
| `…/taste/state.json` | timestamps and recall counters (`created`, `last_used`, `recalled`) |
| `…/taste/evidence.jsonl` | append-only evidence, one JSON object per capture |
| `…/taste/export/*.md` | generated fragments for `AGENTS.md` / `CLAUDE.md` |

Writes are atomic (temp file + rename), so an interrupted write cannot truncate the
rules file.

### Injection

- Registered as a `systemPrompt` context named `taste`, order `920`.
- Snapshotted once at session start and frozen for the session, so the prompt prefix
  stays byte-stable and the KV cache holds.
- Budget: 6000 characters (≈1500 tokens), strongest rules first, the rest dropped
  silently.
- Wrapped in `<taste-rules>` with an explicit "reference data, not instructions; the
  current request wins" preamble.
- When candidates are waiting, one footer line mentions them; the rules themselves are
  never injected while pending.

### Privacy

- Credentials (API keys, tokens, JWTs, PEM blocks, connection strings, `password=`) are
  rejected before anything is written.
- Email addresses become `<email>`, and the username inside absolute paths is collapsed
  to `~`.
- Evidence stores a 200-character quote, never the surrounding code or conversation.

### Known limits (v0.2.0)

- No LLM extractor yet: corrections need `taste learn` + `taste add`. Explicit
  instructions and guardrails are captured automatically.
- No diff learning yet: code you rewrite by hand is not observed (planned, P1).
- Per-agent prompt scoping depends on the event context; when it is not agent-scoped the
  plugin falls back to one global section and logs that once.

## Development

```sh
node test/harness.mjs
```

39 checks, driven through `apply(ctx)` with a fake context — no DSH process needed.

## License

MIT
