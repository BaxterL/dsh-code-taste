# Roadmap

## P0 — capture, store, inject (v0.1.0)

- [x] markdown source of truth, two scopes, tolerant parser
- [x] explicit instruction → auto rule at 0.85+
- [x] corrective message → pending queue → `taste learn` / `taste add`
- [x] content-addressed ids, near-duplicate merge (containment similarity + paraphrase folding)
- [x] pending rules (< 0.55) withheld until a second evidence or `taste approve`
- [x] positive feedback reinforces the strongest injected rule
- [x] per-session prompt section, frozen at session start, framed as reference data
- [x] `taste list | learn | add | review | approve | forget | why | profile | export`
- [x] evidence log, usage tracking, `[pinned]` opt-out of decay
- [x] secret floor (credentials rejected, emails redacted)
- [x] fake-context harness

## P1 — behavioural signals and the extractor

### Signals

- [ ] **Edit** — files the agent wrote, compared with the file afterwards
      (`fs/write-intent` records the target; `fs/observed` and a turn-end read give the diff)
- [ ] **Reject** — a tool decision that ends in deny (`tools/pre-execute`), and a change that is
      reverted (the workspace diff returning to the pre-write content)
- [ ] **Accept** — an agent-written file that survives N turns without an edit; reinforces the
      rule behind the change by a small step instead of adding a rule
- [ ] **Choice** — the option chosen in a question (`userQuestions`), and the approach picked
      repeatedly across turns

### Extractor (v0.3.0)

- [x] `lib/config.js`: `mode: regex | hybrid`, injection budget, model route, extract limits
- [x] `lib/llm.js`: OpenAI-compatible and Anthropic Messages clients, local endpoints included
- [x] `lib/extract.js`: one call per batch, throttled; reply parsed, categories whitelisted
- [x] confidence computed in code (0.55 with ≥3 signals, else 0.5 / pending), never taken from the model
- [ ] conflict resolution when a new rule contradicts an old one (new wins, old loses 0.25)
- [ ] `op: reinforce | weaken | replace` — today the model can only propose new rules

## P2 — scope and explanation

- [ ] `glob` matching against paths touched this turn
- [ ] relevance ranking (keyword first, embeddings later)
- [ ] `/taste` command: `list | rm | edit | pause | why | profile | export | review`
- [ ] `export` to an AGENTS.md or CLAUDE.md fragment under `taste/export/`
- [ ] conflict warning when project overrides global

## P3 — surfaces

- [ ] settings panel: grouped by category, confidence bars, pending review, `why` modal
- [ ] history backfill over past sessions
- [ ] periodic consolidation (10 loose rules → 3 principles)
- [ ] profile summary (one paragraph describing the user's taste)
