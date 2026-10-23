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

## P1 — the extractor

- [ ] `lib/extract.js`: one LLM call per turn boundary, only when a signal exists
- [ ] strict JSON output `{op: add|reinforce|weaken|replace, text, category, scope, glob?, evidence_kind, evidence_quote}`
- [ ] confidence computed in code, never taken from the model
- [ ] merge: conflict resolution (new wins, old loses 0.25)
- [ ] diff signal: files the agent wrote, then the user edited (`fs/write-intent` + `fs/observed`)
- [ ] tool-rejection signal: `tools/pre-execute` decisions that end in deny
- [ ] throttling: one extraction per 10 minutes per session, three rules per turn

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
