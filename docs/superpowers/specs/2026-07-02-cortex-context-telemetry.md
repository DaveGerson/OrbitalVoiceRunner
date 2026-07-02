# Codex Handoff: Cortex Context Management Validation & Telemetry

**Repository:** `DaveGerson/OrbitalVoiceRunner`  
**Recommended branch:** `feat/cortex-context-telemetry-validation`  
**Primary objective:** establish a reliable test and telemetry baseline for Cortex active context management before implementing deeper optimization or mission-graph features.  
**Audience:** Codex / agentic coding instance implementing the first PR.

---

## 1. Pasteable Codex kickoff prompt

```text
You are working in DaveGerson/OrbitalVoiceRunner.

Goal: implement the first PR for Cortex context-management validation and telemetry.

Scope this PR to Phase 0 / P0 only:
1. Add durable or JSONL-backed context-injection telemetry for active context refresh events.
2. Add deterministic unit tests and smoke tests for key usage patterns:
   - project switch
   - pane switch
   - A -> B -> A pane flip
   - per-pane draft persistence
   - observe-only connection produces no voice-session injection
   - wrong-pane write guard
   - approval exactly-once race
   - stop-all write blocking
3. Add a deterministic report script that summarizes context-management metrics from test output/logs.
4. Do not enable Cortex primary by default.
5. Do not change safety gating behavior.
6. Do not require a live Gemini API key; use existing fake/mock live-session seams.
7. Preserve redaction invariants and do not log secrets.

Start by reading:
- README.md
- src/memory/types.ts
- src/memory/index.ts
- src/memory/worldModel.ts
- src/memory/assembler.ts
- src/memory/breadcrumbs.ts
- src/voice/index.ts
- src/store/schema.ts
- src/store/sqliteStore.ts
- src/gating/index.ts
- src/actions/*
- tests around live harness, store, approvals, memory, and voice.

Use these search commands:
rg "injectMemoryBrief|observeCortexShadow|synthesizeAsync|briefIsForActivePane|captureTurnUsage|recordGeminiTurnUsage|activePaneId|setActivePane" .
rg "PendingApproval|claimApproval|pendingActions|stopAll|isPaneActiveForWrite|draft" src tests

Required validation commands before final response:
npm run typecheck
npm test
npm run build
npm run complexity

Deliverables:
- implementation code
- unit tests
- smoke tests or deterministic simulation scripts
- a generated JSON or Markdown context-metrics report
- short PR summary with behavior changes, non-goals, and test output
```

---

## 2. Why this is the right first PR

The product question to answer first is not “can Cortex become autonomous?” It is:

> Can the system prove, with logs and metrics, what context was active, why it refreshed, whether it duplicated durable state, what it injected, and what that cost approximately?

The current implementation already refreshes context on active-pane changes and reconnects. That is correct for safety and freshness, but it needs measurement before optimization. This PR should therefore establish **observability and tests first**, then leave dedupe/optimization behind a later feature flag.

---

## 3. Current behavior to preserve

### 3.1 Durable pane state is not duplicated by pane switching

A pane switch should change focus and refresh the active context brief. It must not create a second durable pane record for the same pane ID.

### 3.2 Context refresh is freshness-biased

When the active pane changes, the live brief is intentionally re-focused on the new pane. This may resend similar prompt text to the model, but it should not mutate the durable store incorrectly.

### 3.3 Safety gates remain authoritative

Cortex can observe, curate, recommend, or prepare context. It must not bypass capability gates, permission modes, approval claims, active-pane guards, or stop-all freeze state.

### 3.4 Python/Cortex remains optional and fail-closed

The TypeScript fallback assembler remains the authoritative floor. Python synth/Cortex failures should never break a live session or test path.

### 3.5 No live Gemini dependency for tests

Use existing fake live-session seams. The test suite must run without a Gemini API key.

---

## 4. Source map for Codex

| Concern | Files to inspect first | Why |
|---|---|---|
| Memory contracts | `src/memory/types.ts` | `MemoryTiers`, `SynthesizedBrief`, `CortexCtx`, schemas |
| Memory behavior | `src/memory/index.ts` | `MemoryService`, `synthesizeAsync`, shadow Cortex, primary curation path |
| Current live truth | `src/memory/worldModel.ts` | How project/pane/board/frame/breadcrumb tiers are assembled |
| Brief rendering | `src/memory/assembler.ts`, `python/synthesizer/synth.py` | Current TS and Python brief renderers |
| Short-term memory | `src/memory/breadcrumbs.ts` | Bounded, pane-fair breadcrumb logic |
| Voice lifecycle | `src/voice/index.ts` | Active pane changes, injection, live fake seams, usage capture |
| Store schema | `src/store/schema.ts` | Add migration for context telemetry if durable table is chosen |
| Store API | `src/store/sqliteStore.ts` | Add writer/readers for telemetry rows if durable table is chosen |
| Gating | `src/gating/index.ts`, `src/pendingApprovals.ts` | Exactly-once approval and safety gating |
| Actions | `src/actions/*` | Registry action dispatch, REST/voice convergence, audit seam |
| Tests | `tests/*.ts` | Existing patterns for fake server, store, memory, approvals, voice |

---

## 5. Recommended first-PR scope

### In scope

1. **Context injection telemetry model**
   - Capture every attempted context injection.
   - Include trigger, active pane/project, brief hash, source snapshot hash, disposition, estimated tokens, and optional `inject_id`.

2. **Minimal store or JSONL persistence**
   - Preferred: SQLite table because the repo already uses `JanusStore` for durable observability.
   - Acceptable first pass: structured JSONL if table migration creates too much blast radius, but tests should still parse it deterministically.

3. **Unit tests for micro-activities**
   - Switch project.
   - Switch pane.
   - Flip A -> B -> A.
   - Draft structured prompt and preserve draft per pane.
   - Wrong-pane write refusal.
   - Approval exactly-once race.
   - Stop-all freeze blocks writes.

4. **Smoke journeys**
   - Deterministic 15-minute equivalent.
   - Deterministic 30-minute equivalent.
   - Deterministic 1-2 hour equivalent.
   - These should not actually sleep; simulate elapsed time/events.

5. **Metrics/report script**
   - Emit summary JSON and optionally Markdown.
   - Include estimated token/cost metrics.
   - Include focus correctness and duplicate durable pane count.

### Out of scope for first PR

- Mission graph schema.
- Resource locks.
- Context artifact store.
- Full cockpit UI.
- Cortex primary promotion.
- Automatic dedupe behavior, except optionally as a disabled/experimental metric-only calculation.
- Live Gemini integration tests.

---

## 6. Proposed telemetry contract

### 6.1 Context injection event shape

Add a shared type, preferably in `src/memory/types.ts` or a new `src/memory/contextTelemetry.ts`.

```ts
export type ContextInjectionTrigger =
  | "session_start"
  | "pane_switch"
  | "project_switch"
  | "reconnect"
  | "catch_me_up"
  | "pane_signal"
  | "approval_event"
  | "handoff"
  | "manual_refresh"
  | "test";

export type ContextInjectionDisposition =
  | "injected"
  | "skipped_no_session"
  | "skipped_no_active_pane"
  | "skipped_stale_brief"
  | "skipped_dedupe_candidate"
  | "failed";

export interface ContextInjectionEvent {
  id: string;
  ts: number;
  session_id: string | null;
  interaction_id: string | null;
  inject_id: string | null;
  trigger: ContextInjectionTrigger;
  active_project_id: string | null;
  active_pane_id: string | null;
  brief_active_pane_id: string | null;
  source: "fallback" | "python" | "cortex-primary" | "none";
  disposition: ContextInjectionDisposition;
  skipped_reason: string | null;
  source_snapshot_hash: string | null;
  brief_hash: string | null;
  brief_chars: number;
  estimated_tokens: number;
  elapsed_ms: number | null;
  error: string | null;
}
```

### 6.2 Hashing guidance

Use stable deterministic hashing. Keep it cheap.

```ts
sha256(JSON.stringify(stableSnapshot)).slice(0, 16)
sha256(brief.text).slice(0, 16)
```

If there is not yet a canonical stable stringifier, implement a tiny deterministic helper or keep the first PR limited to `brief_hash` from rendered text.

### 6.3 Token estimate

Initial estimate:

```ts
estimated_tokens = Math.ceil(brief_chars / 4)
```

Do not overfit token estimation in the first PR. The purpose is trend/cost comparison, not exact billing.

### 6.4 Cost estimate

Use a configurable price table rather than hard-coding provider assumptions deep in logic.

```ts
export interface ContextCostConfig {
  textInputUsdPer1M: number;
  audioInputUsdPerMinute?: number;
  audioOutputUsdPerMinute?: number;
}
```

Default can be conservative and documented. Allow override via env or report script options.

---

## 7. Preferred SQLite migration

If using SQLite, add schema v10 in `src/store/schema.ts`.

```sql
CREATE TABLE context_injections (
  id TEXT PRIMARY KEY NOT NULL,
  ts INTEGER NOT NULL,
  session_id TEXT,
  interaction_id TEXT,
  inject_id TEXT,
  trigger TEXT NOT NULL,
  active_project_id TEXT,
  active_pane_id TEXT,
  brief_active_pane_id TEXT,
  source TEXT NOT NULL,
  disposition TEXT NOT NULL,
  skipped_reason TEXT,
  source_snapshot_hash TEXT,
  brief_hash TEXT,
  brief_chars INTEGER NOT NULL DEFAULT 0,
  estimated_tokens INTEGER NOT NULL DEFAULT 0,
  elapsed_ms INTEGER,
  error TEXT
);
CREATE INDEX idx_context_injections_ts ON context_injections(ts);
CREATE INDEX idx_context_injections_session_ts ON context_injections(session_id, ts);
CREATE INDEX idx_context_injections_inject_id ON context_injections(inject_id);
CREATE INDEX idx_context_injections_active_pane_ts ON context_injections(active_pane_id, ts);
CREATE INDEX idx_context_injections_brief_hash ON context_injections(brief_hash);
```

Add to `src/store/sqliteStore.ts`:

```ts
recordContextInjection(row: ContextInjectionEvent): void
getContextInjections(filter?: { since?: number; sessionId?: string; limit?: number }): ContextInjectionEvent[]
```

Writers must be fail-soft. Telemetry failure must never break voice/session execution.

---

## 8. Where to instrument

Find the live brief injection function in `src/voice/index.ts` by searching:

```bash
rg "injectMemoryBrief" src/voice/index.ts src
```

Instrument at the narrowest choke point where all context injections pass through.

Recommended event lifecycle:

1. Mint `event_id`.
2. Capture `start = Date.now()`.
3. Capture runtime focus: active project and active pane.
4. Generate/synthesize the brief.
5. Compute `brief_hash`, `brief_chars`, `estimated_tokens`.
6. Check `briefIsForActivePane` before injecting.
7. Mint or reuse `inject_id` only for actual injection.
8. Send context to session if valid.
9. Record telemetry row with disposition.
10. On error, record disposition `failed`, redacted error summary, and do not throw unless existing behavior threw.

Do not record raw brief text in telemetry. Store only hashes, counts, source, and IDs.

---

## 9. Unit test plan

### 9.1 Memory and brief correctness

| Test ID | Scenario | Assertion |
|---|---|---|
| `UT-MEM-001` | Build tiers with active pane A | `tiers.pane.paneId === "pane-a"` |
| `UT-MEM-002` | Build tiers after active pane B | `tiers.pane.paneId === "pane-b"` |
| `UT-MEM-003` | `briefIsForActivePane("pane-a", "pane-b")` | false |
| `UT-MEM-004` | `briefIsForActivePane("pane-a", "pane-a")` | true |
| `UT-MEM-005` | Breadcrumb ring with many panes | bounded length and pane fairness preserved |

### 9.2 Pane switching and durable state

| Test ID | Scenario | Assertion |
|---|---|---|
| `UT-FOCUS-001` | A -> B switch | active pane B; one injection event with trigger `pane_switch` |
| `UT-FOCUS-002` | A -> B -> A | pane A exists exactly once in durable project; telemetry may show repeat brief hash |
| `UT-FOCUS-003` | A -> B -> A unchanged | report `brief_hash_repeat_rate > 0` in baseline; no dedupe required yet |
| `UT-FOCUS-004` | A -> B, write attempted to A while active B | wrong-pane guard refuses or stages; no PTY write |

### 9.3 Drafts

| Test ID | Scenario | Assertion |
|---|---|---|
| `UT-DRAFT-001` | Create draft in pane A, switch B, return A | A draft unchanged |
| `UT-DRAFT-002` | Dictation while active B | B draft changes; A draft unchanged |
| `UT-DRAFT-003` | Send draft | PTY write recorded; draft cleared; history row exists |

### 9.4 Gating, approval, and stop-all

| Test ID | Scenario | Assertion |
|---|---|---|
| `UT-GATE-001` | Gate Ask | pending approval created, no write yet |
| `UT-GATE-002` | Gate Off | blocked, no write |
| `UT-APP-001` | Resolve same approval via two paths | exactly one claim/write |
| `UT-STOP-001` | Frozen state true | write blocked |
| `UT-STOP-002` | Release freeze | normal gate behavior resumes |

### 9.5 Observe-only

| Test ID | Scenario | Assertion |
|---|---|---|
| `UT-OBS-001` | Connect observe-only socket | no Gemini live session created |
| `UT-OBS-002` | Observe-only switches active pane | UI state may update, but no context injection to live model |

---

## 10. Smoke journey plan

Implement deterministic smoke journeys as either `tsx` scripts or tests. They should simulate time, not actually wait.

### 10.1 15-minute coding session smoke

**Scenario:** quick bug fix with two panes.

Steps:

1. Start fake server/session.
2. Create project `bugfix-auth`.
3. Create pane A: Claude Code.
4. Create pane B: test shell.
5. Focus A and inject context.
6. Draft structured prompt in A.
7. Switch to B and run tests.
8. Switch A -> B -> A.
9. Approve one proposed command.
10. Ask catch-me-up.
11. Emit report.

Acceptance:

- no duplicate pane records;
- active pane correctness 100%;
- at least one context injection event;
- draft persists;
- approval exactly once;
- estimated context cost included.

### 10.2 30-minute debugging session smoke

**Scenario:** three panes: implementation, tests, notes/research.

Add:

- human context note;
- failure signature in test pane output;
- switch project once;
- verify no cross-project note bleed;
- observe-only cockpit attaches and detaches.

Acceptance:

- project tier changes correctly;
- no voice injection from observe-only;
- context report shows injection count by trigger;
- catch-me-up uses current project/pane evidence.

### 10.3 1-2 hour orchestration smoke

**Scenario:** long session compressed into deterministic events.

Add:

- three or more panes;
- multiple approvals;
- one stop-all and release;
- one handoff lifecycle if current APIs support it;
- multiple repeated pane flips;
- reconnect event;
- final report.

Acceptance:

- no unbounded context event growth for same unchanged pane beyond expected baseline;
- repeated brief hashes visible in metrics;
- usage/cost estimate generated;
- all joins include session ID where available;
- safety gates remain authoritative.

---

## 11. Metrics report script

Add a script such as:

```text
scripts/context-metrics-report.ts
```

Input options:

```bash
tsx scripts/context-metrics-report.ts --db .janus.db --since-ms 3600000 --out reports/context-metrics.json
```

Output shape:

```json
{
  "sessions": 1,
  "contextInjectionCount": 12,
  "injectionsByTrigger": { "pane_switch": 8, "reconnect": 1, "catch_me_up": 3 },
  "skippedCount": 0,
  "briefHashRepeatRate": 0.42,
  "estimatedInputTokens": 14320,
  "estimatedTextInputCostUsd": 0.0107,
  "focusCorrectnessRate": 1,
  "durableDuplicatePaneCount": 0,
  "wrongPaneRefusals": 1,
  "approvalExactlyOnceSuccessRate": 1,
  "notes": [
    "Dedupe is metric-only in this PR; repeated hashes are expected baseline observations."
  ]
}
```

Keep the report deterministic for tests.

---

## 12. Best-practice metric anchors

Use these benchmark ideas as design inspiration:

| Area | Metric pattern to emulate | Cortex adaptation |
|---|---|---|
| OpenTelemetry | traces + metrics + logs + propagated context | `session_id`, `interaction_id`, `inject_id`, `brief_hash` across logs and store rows |
| GenAI telemetry | input/output token accounting, model operation attributes | estimated input tokens per injected brief and per smoke journey |
| RAG evaluation | context precision and faithfulness | future artifact relevance and catch-me-up answer support checks |
| Agent/tool evaluation | tool-call accuracy, goal accuracy, tool-call F1 | smoke journey expected tool/action sequences |
| SWE-bench-style coding eval | resolved rate, steps-to-goal, cost-to-resolve | journey completion, steps, estimated cost, safety violations |
| Long-context reuse eval | cost efficiency and time efficiency | repeated pane flips, context reuse, skipped/injected counts |

The first PR should not attempt full RAGAS or SWE-bench integration. Use the metric names and report fields now so deeper evaluators can plug in later.

---

## 13. Acceptance criteria for first PR

### Functional

- [ ] Context injection attempts are recorded with trigger, active pane/project, disposition, hash, chars, estimated tokens, and timing.
- [ ] A -> B -> A pane switching does not duplicate pane records.
- [ ] Wrong-pane writes are refused or staged according to existing guardrails.
- [ ] Per-pane drafts persist across switches.
- [ ] Observe-only connection does not create a Gemini live session and does not inject model context.
- [ ] Approval race resolves exactly once.
- [ ] Stop-all blocks writes and release restores normal gating.

### Telemetry

- [ ] Report script outputs deterministic JSON.
- [ ] Report includes injection count, repeated hash rate, estimated tokens, estimated text-input cost, focus correctness, duplicate pane count, and safety counts.
- [ ] Telemetry never stores raw brief text or secrets.
- [ ] Telemetry failure does not break the live path.

### Quality gates

- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes.
- [ ] `npm run build` passes.
- [ ] `npm run complexity` passes.
- [ ] New code keeps functions small and consistent with existing complexity constraints.

---

## 14. Suggested implementation sequence

1. **Reconnaissance**
   - Run the `rg` commands from the kickoff prompt.
   - Identify the single context-injection choke point.
   - Identify existing fake live-session tests and store test helpers.

2. **Telemetry type + utility helpers**
   - Add type definitions.
   - Add hash helper.
   - Add token estimate helper.
   - Add cost estimate helper in script/report layer.

3. **Persistence**
   - Add SQLite migration v10 or JSONL sink.
   - Add fail-soft writer and reader.
   - Unit-test writer/reader.

4. **Instrumentation**
   - Instrument injection choke point.
   - Ensure all errors are swallowed/logged consistently.
   - Do not change actual injection behavior.

5. **Unit tests**
   - Add focused tests before smoke journeys.
   - Use fake store/session where possible.

6. **Smoke journeys**
   - Implement deterministic scripts/tests.
   - Generate report fixture.

7. **Report script**
   - Implement metrics aggregation.
   - Add one test that asserts report shape and key metrics.

8. **Final validation**
   - Run typecheck/test/build/complexity.
   - Summarize behavior and non-goals.

---

## 15. PR summary template

```md
## Summary
Implemented P0 Cortex context-management telemetry and validation suite.

## What changed
- Added context injection telemetry events with brief hashes and estimated tokens.
- Added tests for pane switching, A->B->A, drafts, observe-only mode, wrong-pane guard, approvals, and stop-all.
- Added context metrics report script.

## What did not change
- Cortex primary remains disabled by default.
- No live Gemini dependency added to tests.
- No safety gate behavior was loosened.
- No raw brief text or secrets are persisted in telemetry.

## Validation
- npm run typecheck: PASS
- npm test: PASS
- npm run build: PASS
- npm run complexity: PASS

## Metrics sample
Attach or paste context metrics report output.
```

---

## 16. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Telemetry code changes live behavior | Put telemetry behind fail-soft writer and do not affect control flow. |
| Raw context or secrets leak into logs | Store only hashes/counts/IDs; apply existing redaction before any error text. |
| Tests require live Gemini | Use fake session seams only. |
| Schema migration breaks legacy store path | Keep migration additive; add store unit tests; keep legacy fallback unaffected. |
| Complexity gate fails | Use small helpers and table-driven test cases. |
| Dedupe accidentally hides fresh context | Do not implement behavioral dedupe in first PR; measure repeat hashes only. |

---

## 17. Follow-up PRs after this one

1. **Feature-flagged brief dedupe**
   - Skip full injection only when same session/project/pane/snapshot/brief hash occurs within quiet window.

2. **WorldModel enrichment**
   - Populate `recentDecisions` and `PaneTier.recent` from notes/events/history.

3. **Context artifacts v1**
   - Normalize source-backed artifacts with provenance and retention.

4. **Cockpit context panel**
   - Surface injection timeline, active context, brief hashes, and cost estimates.

5. **Mission graph and resource locks**
   - Promote Cortex from context seam to orchestration blackboard.



---

# 18. ARCHITECT DELTAS (2026-07-02, binding — override the sections above where they conflict)

The handoff above was written externally without full sight of this repo. Reconnaissance
(2026-07-02, this branch) found an existing measurement substrate the doc only hints at. These
deltas are the implementation authority:

## 18.1 The v9 measurement spine ALREADY EXISTS — join it, don't parallel it

Schema v9 (`src/store/schema.ts`, SCHEMA_VERSION = 9) already ships two append-only tables:
`cortex_decision` and `gemini_turn_usage`, BOTH keyed by `inject_id` — a per-injection id minted
ONCE per `injectMemoryBrief` call (`mintInjectId()`, src/voice/index.ts ~594) and stamped on the
shadow cortex decision trace and on subsequent Gemini turn-usage rows (`captureTurnUsage`,
src/voice/index.ts ~80, via `state.lastInjectId` which is set ONLY after an actual injection).

Therefore, for the new `context_injections` table (schema v10):
- `inject_id` is NOT "optional/mint-on-injection" as §8 suggests. Record the ALREADY-minted
  injectId on EVERY event that reaches the mint (it keys the shadow decision row regardless of
  final disposition). It is null only for dispositions recorded BEFORE the mint
  (`skipped_no_session`). This preserves a three-way join:
  context_injections ⟕ cortex_decision ⟕ gemini_turn_usage ON inject_id.
- Do NOT rename or re-mint anything in the existing spine. Do NOT change when
  `state.lastInjectId` is assigned (that placement is a reviewed race fix — finding-1, PR #116).
- SCHEMA_VERSION goes 9 → 10; migration is purely additive (v9's comment discipline applies).
  Mirror v9's column style (snake_case, INTEGER ts) — use §7's SQL with these corrections:
  keep `inject_id` indexed (it is the join key, not an afterthought).

## 18.2 Trigger taxonomy comes from the REAL call sites

`injectMemoryBrief(sess, activeId)` gains a third parameter `trigger: ContextInjectionTrigger`.
The four call sites and their triggers (verified against src/voice/index.ts on this branch):
1. `setActivePane` ctx hook (~line 870, voice-tool pane switch)   → `"pane_switch"`
2. `ctx.injectMemoryBrief` hook (~line 874; orient.ts calls it from switch_context /
   catch-me-up after its live ledger sync) → the CALLER knows which: thread a trigger through
   the ctx hook signature; orient.ts passes `"project_switch"` for switch_context and
   `"catch_me_up"` for the catch-me-up path. If threading through ctx is too invasive for one
   PR, `"catch_me_up"` for the whole hook is an acceptable first pass — document the coarseness.
3. Post-connect injection (~line 1399, inside the connect closure that also serves reconnects)
   → `"session_start"` on first connect, `"reconnect"` when arriving via the PLM4 reconnect
   scheduler. The closure has reconnect-attempt state in scope — verify and use it; if the two
   genuinely cannot be distinguished where the call lives, use `"session_start"` and note it.
4. `handleSetActivePaneFrame` (~line 1595, UI WS frame) → `"pane_switch"`.
Drop taxonomy values with no call site today (`"pane_signal"`, `"approval_event"`, `"handoff"`,
`"manual_refresh"`) from the emitting code but KEEP them in the type union — they are future
call sites, and the report script must not choke on unknown triggers.
NOTE: `observeCortexShadow` already takes its own trigger string ("brief-inject") — that is a
DIFFERENT, pre-existing channel. Do not conflate or unify them in this PR.

## 18.3 Disposition mapping for the existing guards

The choke point already has every skip path the doc wants measured. Map them exactly:
- `!sess` early return                          → `skipped_no_session` (before mint; inject_id null)
- `briefIsForActivePane(...)` false             → `skipped_stale_brief`
- `brief.text.trim()` empty                     → `skipped_no_active_pane` is WRONG here; use a
  dedicated `skipped_empty_brief` value (add it to the union — the doc's taxonomy missed this path).
- catch block                                   → `failed` (redact the error string via the
  existing `redactSecrets` before storing; store message only, never a stack).
- successful sendClientContent                  → `injected`.
`skipped_dedupe_candidate` stays in the union but is NEVER emitted this PR (dedupe is metric-only).

## 18.4 Fail-soft + legacy-backend rules

- The store conduit is the same `JanusStore | null` already threaded to `captureTurnUsage`.
  `store === null` (JANUS_LEDGER_BACKEND=legacy) → skip recording entirely; do NOT build a JSONL
  fallback sink (doc §5.2's JSONL option is REJECTED — SQLite is the default backend and the v9
  precedent). Telemetry must never throw into the live loop: mirror captureTurnUsage's
  try/catch-and-console.error shape.
- Recording happens at every disposition exit of injectMemoryBrief. Keep injectMemoryBrief's
  complexity under the CC≤10 gate by extracting a small `recordContextInjection`-shaped helper
  (event assembly + write in one place), not by inlining ten try/catches.

## 18.5 Tests: inventory-then-gap-fill (do NOT duplicate existing suites)

Much of §9's matrix ALREADY EXISTS in tests/ (non-exhaustive mapping):
- Approval exactly-once race    → test_approval_dupsend.ts, test_pendingApprovals_durable.ts,
                                  test_store_approvals.ts
- Stop-all freeze/release       → test_stop_all_two_stage.ts, test_stop_all_narration.ts
- Per-pane drafts               → test_store_drafts.ts, test_composer_draft_pending.ts
- Wrong-pane/stale-brief guard  → test_memory_injector_guard.ts, test_memory_refocus.ts
- Pane-switch brief refocus     → test_memory_refocus.ts, test_memory_switch_context_inject.ts
- Breadcrumb bounds/fairness    → test_memory_breadcrumbs.ts
- v9 spine (decisions + usage)  → test_cortex_measurement.ts
- Observe-only socket           → test_observe_socket.ts
The NEW tests must cover only what is genuinely new: telemetry rows per trigger/disposition,
inject_id join integrity (context_injections ⟷ cortex_decision ⟷ gemini_turn_usage),
A→B→A durable no-dup + brief-hash repeat visibility, focus-correctness metric, migration v10,
writer/reader round-trip, report shape. Start each new test file with a header comment mapping
the doc's UT-IDs it covers and naming the existing file that already covers the neighbors —
the reviewer will check this mapping for honesty.

## 18.6 Smoke journeys follow the test_voice_journeys.ts idiom

Deterministic node:test files (no wall-clock sleeps; simulated time/events), using the existing
fake live-session seams (`mockLive` connector) and `startServer` on port 0 with vite disabled —
exactly how tests/test_voice_journeys.ts already boots. They run inside `npm test` (no separate
runner). Each journey ends by running the report AGGREGATION FUNCTION (exported from the report
module) against its own temp DB and asserting the §11 shape + key invariants. The CLI in
scripts/context-metrics-report.ts is a thin wrapper over that exported function (tsx precedent:
scripts/verify-live-voice.ts).

## 18.7 Validation commands (repo truth)

`npm run typecheck` AND `npm run lint` both exist (both tsc --noEmit). The battery for this PR:
npm run lint · npm test · npm run build · npm run complexity (CC≤10 + cognitive≤15, ZERO
suppressions — hard gate) · npm run test:e2e (mock) · npm run test:e2e:live. e2e lanes must not
regress even though this PR should not touch UI.

## 18.8 Out of scope (unchanged from §5, restated as hard NOs)

No cortex-primary default change; no gating/approval behavior change; no dedupe behavior (metric
only); no live-key tests; no mission graph; no UI. The brief INJECTION BEHAVIOR ITSELF must be
byte-identical — telemetry observes, never steers.
