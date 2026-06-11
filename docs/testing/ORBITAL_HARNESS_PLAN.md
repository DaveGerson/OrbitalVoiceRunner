# Orbital Harness — Context-Management User-Story Test Set (tracking)

Implements the 6-epic / 31-story context-management test plan as a user-story-level
integration suite layered on the existing `installMockLive` / `teardownServerSuite` /
`Ledger` harness. Story IDs are `US-<epic>.<n>`. P0 = release-blocking, P1 = fast-follow,
P2 = characterization.

## Decisions (resolved with the operator up front)

The spec's 4 open questions were investigated in-code and resolved as UX calls:

- **Q1 — recent-activity feed fairness → FIX.** The breadcrumb ring was one global,
  recency-only buffer (`src/memory/breadcrumbs.ts`), so a noisy pane could evict quiet
  panes' events. Decision: give each pane a protected slot so a chatty pane can't erase
  the others. US-5.4 asserts the fixed behavior.
- **Q2 — history at rest → REDACT ON WRITE.** `.janus_history.json` stored raw
  (ANSI-stripped, unredacted) output. Decision: redact secrets on the history write path
  so no credential sits on disk. US-6.3 / US-1.5(neg) assert it.
- **Q3 — situational briefing → COMPREHENSIVE, flip-friendly.** The brief has 5 tiers
  (project / pane / board=`listPanes` / frame=gate posture / breadcrumbs). US-2.4 verifies
  the full briefing swaps to the new project AND that A→B→A flipping cheaply restores the
  prior project's durable content (rapid repo/project flipping stays coherent).
- **Q4 — reconnect → SERVER IS SOURCE OF TRUTH.** Server retains approvals / drafts /
  attention / pane-state across a WS drop (server-held, not session-held) and
  re-contextualizes the new Gemini Live session via the survivors digest + working brief.
  US-4.3 asserts that.

## P2 / scored stories → vignette scoring harness

US-2.5, US-3.5, US-5.4(scored legs), US-3.4(name-resolution), US-4.2("what was I doing")
are driven by a vignette runner: scripted plausible-operator dialogues through the
mock-Live connector, reconstructed from `.janus_interaction_log.jsonl` by `interaction_id`,
scored against regression thresholds (e.g. mis-attribution rate) rather than hard pass/fail.

## Production changes (TDD, keep existing suites green)

- `src/memory/breadcrumbs.ts` — per-pane fairness in `recent()` (Q1). Guard: existing
  `tests/test_memory_breadcrumbs.ts` must still pass.
- history write path (`server.ts` HistoryManager / `src/observe/index.ts` onOutput) —
  redact secrets before persisting command + output (Q2). Guard: `tests/test_history_flush.ts`,
  `tests/test_secrets_at_rest.ts`.

## Test files (one new file per epic + vignette harness)

| File | Stories |
|---|---|
| `tests/test_us_epic01_monitoring.ts`     | US-1.1 .. 1.5 |
| `tests/test_us_epic02_switching.ts`      | US-2.1 .. 2.4 (2.5 → vignette) |
| `tests/test_us_epic03_pingpong.ts`       | US-3.1 .. 3.4 (3.5 → vignette) |
| `tests/test_us_epic04_awayback.ts`       | US-4.1 .. 4.5 |
| `tests/test_us_epic05_orchestration.ts`  | US-5.1 .. 5.5 |
| `tests/test_us_epic06_durability.ts`     | US-6.1 .. 6.6 |
| `tests/helpers/vignettes.ts` + `tests/test_us_vignettes.ts` | US-2.5, 3.4, 3.5, 4.2, 5.4 scored |

## Status

- [ ] Production: Q1 breadcrumb fairness
- [ ] Production: Q2 history redaction-at-rest
- [ ] E01 monitoring
- [ ] E02 switching
- [ ] E03 ping-pong
- [ ] E04 away/back
- [ ] E05 orchestration
- [ ] E06 durability
- [ ] Vignette scoring harness
- [ ] Full suite green (`npm run typecheck` + `npm test`)
- [ ] Commit + push to `claude/orbital-harness-test-plan-jo30jw`
