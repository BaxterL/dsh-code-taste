# Local hardening changes

This checkout changes the trust boundary without migrating existing user profiles.

## Behaviour

- Regex capture and `propose` create **pending** project candidates at 0.50; repetition cannot activate them or demote existing trusted rules. Model-distilled extraction rules start at 0.62 and are in force immediately: the extraction prompt already drops task-specific instructions, and leaving them at 0.50 kept a learned preference below the 0.55 injection threshold for the very session it was learned for. `add` and `approve` are reserved for explicit user requests; guidance no longer instructs the agent to silently call `add`.
- The prompt footer names up to four waiting candidates by id and opening words (which decayed or pending rules they are), falling back to an exact count when the budget cannot fit the detail; it used to print a bare number that could under-report what was withheld. Usage accounting accumulates across the several prompt assemblies one turn may perform and merges with the state already on disk instead of overwriting it.
- Capture rejects messages over 400 characters, skips ambiguous inline quotes/backticks rather than removing sentence objects, strips block quotes/fences, and rejects remaining multiline/list input. Rules must be single-line and at most 200 characters. Secret filtering also applies to tool and extraction inputs.
- Conflict matching requires comparable short text in the same scope/glob. Explicitly replacing/approving a conflicting rule moves its opposite to review without destroying confidence.
- Markdown writes preserve unparsed comments/prose. Serialization collapses whitespace; existing IDs remain compatible, with a longer fallback if a new ID collides.
- Rule/state read-modify-write operations use a shared process queue and an exclusive file lock under the DSH taste home. Evidence uses append rather than full-file rewrites. Usage is written once per scope after a turn, only for budget-selected rules.
- `learn` returns a copy. Pending signals and replay keys are persisted per session. Failed extraction keeps signals; successful extraction acknowledges only entries actually sent within the input budget. Overflow is saved as pending rules rather than silently dropping old signals.
- Extraction defaults to 768 output tokens, retries truncation once up to 2048, and rejects malformed JSON/schema instead of reporting a zero-rule success.
- Prompt assembly rereads the store, so hand edits and other sessions' updates are visible on the next assembly. No filesystem watcher is required. This still involves synchronous reads.
- Settings POST requires a CSRF token and JSON content type, checks Origin when supplied, and rejects cross-site fetch metadata. New inline keys cannot be saved; use `apiKeyEnv`. Legacy keys still work with a warning and must be migrated/removed before saving settings.
- Host model labels now accurately say **global default model**, not the session override.

## Verification

Run `npm test` (or `node test/harness.mjs`) on Node 22+. Tests use temporary homes/workspaces, fake host contexts and model responses. They cover trust, round trips, concurrency, cross-process locking, budget/usage consistency, queue recovery, extraction failure/truncation and settings CSRF. No live profile or real model endpoint is needed.

## Boundaries and follow-ups

- `add/approve` remain model-facing tools. The host does not supply an authenticated user-approval capability here; their explicit-user-only restriction is a tool/guidance contract, **not** an independent human-confirmation security boundary.
- Existing active rules and already-corrupted multiline files are not automatically migrated. Review those separately before adopting this checkout.
- Locks serialize cooperating plugin processes sharing the same DSH home, not arbitrary editors or processes using different homes. They do not make the separate markdown/state/evidence files a crash-atomic database transaction.
- A process crash can leave `.write.lock`; subsequent writes time out after 10 seconds instead of stealing a possibly live lock. Remove it only after confirming no writer is running.
- Queue persistence is per stable session ID. Concurrent hosts running the *same* session may still overwrite queue snapshots; synthesized IDs cannot guarantee recovery across restarts. Message text is the conservative dedupe fallback when no message ID exists.
- Evidence and queue/dedupe files do not yet have retention/rotation policies. `glob` remains a displayed restriction rather than enforced path filtering.
- Real DSH model streaming and settings UI integration still need a host smoke test; the regression harness is not that test. This work neither installs the checkout into a profile nor restarts DSH.

## Second-pass review

Nine regression cases in `test/review.mjs` failed before the fixes and pass afterwards:

| Severity | Location | Finding and fix |
| --- | --- | --- |
| High | `lib/store.js: mergeScopes` | Pending project evidence shadowed active global rules. Deduplicate by text, glob and status so candidates cannot suppress trusted rules. |
| Medium | `lib/store.js: mergeScopes` | Identical text with different glob restrictions was collapsed. Preserve distinct restrictions. |
| High | `index.js: addRule` | Adding an already-existing candidate bypassed opposite-rule review. Scan conflicts independently of the duplicate match, only when the incoming rule is being activated. |
| Medium | `lib/signals.js: captureText` | Removing inline quotes could manufacture an incomplete preference. Skip ambiguous quoted messages instead. |
| Medium | `lib/tool.js: list` | The pending footer was missing from the budget calculation. Use the same pending count as prompt assembly. |
| Medium | `lib/settings.js: writeSettings` | Dropping default-valued overrides restored nondefault profile values after restart. Persist explicit defaults; replace settings atomically. |
| Medium | `lib/settings.js: coerceField` | Inherited keys such as `constructor` passed the field whitelist. Require own properties. |
| High | `lib/extract.js: parseRules` | Excess model rules were silently truncated while their signals were acknowledged. Strict extraction now rejects excess output and retains the batch. |
| High | `index.js: restorePending` | Invalid queue snapshots were treated as empty and overwritten. Validate snapshots and pause capture for the affected session, preserving the original file. |

`npm test` runs both suites: 121 original harness checks plus nine second-pass cases. Remaining limitations above still apply; passing regression tests does not establish a host-enforced approval boundary.
