# Python ⇄ TS Seam — Completion Plan

- **Date:** 2026-06-27
- **Status:** Execution-ready
- **ADR:** `docs/design/2026-06-19-python-ts-seam.md` (2026-06-25 amendment)
- **Design spec:** `docs/superpowers/specs/2026-06-25-python-ts-seam-migration-design.md`
- **Cortex design:** `docs/superpowers/specs/2026-06-27-python-cortex-shadow-design.md`
- **Migration plan:** `docs/superpowers/plans/2026-06-25-python-ts-seam-migration-plan.md`

---

## 1 · BLUF — the whole seam in one paragraph

The Python ⇄ TS seam is a `SHADOW → FLIP → RETIRE` migration pattern, proven on **two** independent decision domains: (A) **voice-approval parsing** (`parseApprovalIntent`) and (B) **context curation** (the cortex). In SHADOW, Python computes alongside the authoritative TS and logs diffs — TS is the answer, Python is the observer, user risk is zero. At FLIP, Python becomes primary and the retained TS twin becomes the fail-closed floor; every transition is logged, counted, and surfaced in `GET /api/health`. At RETIRE, the TS twin is deleted only after the prod fallback-rate counter reaches ~0 over an operator-confirmed window. The seam is considered **complete** when both decisions have reached RETIRE and their TS twins are deleted; everything beyond that is new brain capability, not seam work.

---

## 2 · Status table — every increment / slice

| ID | Name | Status | Gate type |
|---|---|---|---|
| **Inc 1** | Prove the seam (multiplexed daemon, generic core, typed facades, `approval.parse` SHADOW, golden sweep) | **DONE — on main** | — |
| **Inc 2.1** | Flip mechanism (`JANUS_APPROVAL_PYTHON_PRIMARY`, `resolveApprovalIntent`, fail-closed floor) | **DONE — on main** | — |
| **Inc 2.2/2.3** | WS `daemon_state` broadcast, structured transition log, warm-up-immune `daemonStateTracker`, `health.memory.daemon`, `approvalShadowStats`, `daemonStateStats` | **DONE — on main** | — |
| **Inc 2.4 (F7)** | `advanceDiscoveryAndShouldSpend` (discovery ≠ breaker budget) | **DONE — on main** | — |
| **Inc 2 smoke** | `scripts/smoke-python-daemon.ts` + `tests/test_smoke_python_daemon.ts` | **DONE — on main** | — |
| **Inc 4.1** | Cortex slice 1: `cortex.decide` IDENTITY baseline, `createPythonCortexClient`, `observeCortexShadow` fire-and-forget | **DONE — on main** | — |
| **Inc 4.2** | Cortex slice 2: `cortex.synthesize_shadow` byte-for-byte parity vs `synth.py` (18-fixture battery), `shadowBudget` in trace | **DONE — on main** | — |
| **A-1** | Frontend degradation badge + Windows CI smoke job | **REMAINING** | AUTONOMOUS (badge + CI) + OPERATOR-GATED (prod activation) |
| **A-2** | Inc 3.1 — Retire TS approval twin (`src/approvalIntent.ts` deleted) | **REMAINING** | METRICS-GATED |
| **A-3** | Inc 3.2 — Breaker reducer + 3 char tests (F5, opportunistic) | **REMAINING** | AUTONOMOUS when triggered |
| **A-4** | Inc 3.3 — Full schema contract test in CI (F6, opportunistic) | **REMAINING** | AUTONOMOUS when triggered |
| **A-5** | Inc 3.4 — Latency-class daemon partition (F-HOL, opportunistic) | **REMAINING** | AUTONOMOUS when triggered |
| **B-1** | Cortex FLIP + trust-gate (`JANUS_CORTEX_PRIMARY`) | **REMAINING** | DECISION-GATED |
| **B-2** | Outcome-triggers + inject-gate (`command_outcome` as 4th trigger, diff-gated) | **REMAINING** | DECISION-GATED |
| **B-3** | Real curation rules (frozen-posture, inactive-pane, post-approval-focus) | **REMAINING** | DECISION-GATED (operator approves the rule ladder — the deferred curation policy) |
| **B-4** | Cortex RETIRE (delete `synth.py`, retire `PythonSynthClient`) | **REMAINING** | METRICS-GATED |
| **B-5** | Cross-language golden for decision-trace (`cortex_decide_golden.json`) | **REMAINING** | AUTONOMOUS |
| **B-6** | Decision-memory / hysteresis callable | **REMAINING** | DECISION-GATED (one value: `quietWindowMs`) |
| **B-7** | Session / connection-management logic | **REMAINING** | DECISION-GATED (3 decisions) |

---

## 3 · Part A — Approval-parsing migration (completion tasks)

### A-1 — Inc 2 ACTIVATION + Observability (frontend badge + Windows CI + prod flip)

**Goal.** Deliver the remaining observable-degradation surface and turn the flip ON in prod.

**Approach.**
- **A-1a (badge, AUTONOMOUS):** In `src/` React, subscribe to `daemon_state` WS frames (type already emitted by `server.ts:~1148`). When `state === "fallback"` and `isApprovalPythonPrimary()`, render a subtle badge in the header/status bar. No earcon, no narration (spec §8). Badge disappears when `state === "python"` or flag is off.
- **A-1b (Windows CI, AUTONOMOUS):** Add a `windows` job to `.github/workflows/ci.yml` on `windows-latest`: checkout → `actions/setup-node@v4` node 22 → `npm ci` → `actions/setup-python@v5` Python 3.11 → `npm run smoke:daemon` (exit 2 = SKIP via `continue-on-error: true`; exit 1 = red).
- **A-1c (prod activation, OPERATOR-GATED):** Set `JANUS_APPROVAL_PYTHON_PRIMARY=1` (and optionally `JANUS_APPROVAL_PRIMARY_TIMEOUT_MS`) in the prod environment; confirm `GET /api/health → memory.daemon.transitions` stays near 0 and `memory.shadow.match_rate ≈ 1`.

**File touchpoints.**
- `src/App.tsx` or `src/orbital/OrbitalApp.tsx` / `src/useOrbitalData.ts` — add `daemon_state` WS frame handler, surface badge state
- `src/components/DaemonStateBadge.tsx` — NEW badge component
- `.github/workflows/ci.yml` — add `windows` job

**Test plan.**
- `tests/test_smoke_python_daemon.ts` — already green (3-way exit contract pinned).
- `src/components/DaemonStateBadge.test.tsx` — NEW: renders when `{type:"daemon_state", state:"fallback"}` + `isPrimary=true`; hidden on `state:"python"` or `isPrimary=false`.
- Windows CI job: passes exit 0 (healthy), SKIP (no interpreter), fails exit 1 (broken daemon).
- Manual: `GET /api/health` shows `memory.daemon.currentlyFallback: false` + `memory.shadow.match_rate ≈ 1` with flag live.

**Gate type.** AUTONOMOUS for A-1a + A-1b. METRICS-GATED + OPERATOR-GATED for A-1c (requires clean Inc 1 shadow window; shadow counter already populating on every voice approval utterance).

**Dependencies.** A-1a and A-1b: none, buildable now. A-1c: clean shadow window from Inc 1 (already on main).

**DoD.** Badge appears/disappears correctly. Windows CI job passes or skips gracefully. Prod has `JANUS_APPROVAL_PYTHON_PRIMARY=1` with `health.memory.daemon.transitions` near 0 and `match_rate ≈ 1`.

---

### A-2 — Inc 3.1 — Retire the TS approval twin

**Goal.** Delete `src/approvalIntent.ts` once metrics prove Python is the effective sole parser.

**Approach.**
When `health.memory.daemon.transitions ≈ 0` and `health.memory.shadow.match_rate ≈ 1` over the operator-confirmed window:
1. Remove `src/approvalIntent.ts` and the `parseApprovalIntent` import from `src/approvalShadow.ts`; fold the synchronous TS parse into `resolveApprovalIntent` as a static fail-closed factory OR remove it entirely once Python is the sole parser.
2. Remove `parseApprovalIntentShadowed` (shadow recorder's `record()` call moves into `resolveApprovalIntent`).
3. Delete `tests/test_approval_golden_parity.ts` (its oracle is gone; the Python parity battery is the surviving oracle).
4. Remove any test importing `parseApprovalIntent` directly — update or delete.

**File touchpoints.**
- `src/approvalIntent.ts` — DELETE
- `src/approvalShadow.ts` — remove `parseApprovalIntent` import
- `src/voice/index.ts` — verify the `resolveApprovalIntent` call site (~line 1049) is unaffected; remove dead `parseApprovalIntentShadowed` call if still present
- `tests/test_approval_golden_parity.ts` — DELETE

**Test plan.**
- `npm run lint` (tsc `--noEmit`) — must pass with file deleted (no stray import).
- `npm test` — fully green; any test importing the deleted file removed or updated.
- `npm run test:e2e` with `JANUS_APPROVAL_PYTHON_PRIMARY=1` — approval round-trip produces correct intent.
- `GET /api/health` — `memory.daemon.currentlyFallback: false`; shadow counters unchanged from before deletion.

**Gate type.** METRICS-GATED. Hard gate: `health.memory.daemon.transitions ≈ 0` AND `health.memory.shadow.match_rate ≈ 1` over operator-confirmed window. Do not merge before the window closes.

**Dependencies.** A-1c (flip live in prod) + the metrics window closing.

**DoD.** `src/approvalIntent.ts` deleted from repo; `tsc --noEmit` passes; `npm test` passes; `npm run test:e2e` passes with flip live; no parity regression in `health.memory.shadow` post-retire.

---

### A-3 — Inc 3.2 — Breaker reducer + characterization tests (opportunistic, F5)

**Goal.** Extract `breakerStep(state, event, now) → {state, action}` as a pure function; add 3 characterization tests.

**Approach.** Extract the inline breaker state machine from `src/memory/pythonClient.ts` into a named pure function `breakerStep`. Add tests for: (a) probe-recovery cycle, (b) in-flight-crash settle, (c) window-reset/decay. **Trigger: a 2nd hot consumer appears OR flapping fallback metrics demand it.**

**File touchpoints.**
- `src/memory/pythonClient.ts` — extract `breakerStep`
- `tests/test_python_breaker_reducer.ts` — NEW (3 tests)

**Test plan.** 3 new node:test unit tests in `tests/test_python_breaker_reducer.ts`. `npm run complexity` gate (CC ≤ 10 on the refactored machine).

**Gate type.** AUTONOMOUS when triggered; gated on "2nd hot consumer or flapping metrics" trigger.

**Dependencies.** No blockers except the trigger condition.

**DoD.** `breakerStep` exported and pure; 3 characterization tests pass; `npm run complexity` passes.

---

### A-4 — Inc 3.3 — Full schema contract test in CI (opportunistic, F6)

**Goal.** In CI, boot the real daemon and assert each op's response parses against its Zod schema.

**Approach.** Add a CI job (or extend the Windows job from A-1b) that boots `python -u python/synthesizer/__main__.py`, sends ping + `synthesize` + `approval.parse`, and asserts each response passes its Zod schema. **Trigger: a 3rd op is added OR payload-drift risk materializes.**

**File touchpoints.**
- `.github/workflows/ci.yml` — add `schema-contract` job
- `tests/test_schema_contract_live.ts` — NEW

**Test plan.** CI job boots real daemon; all op schemas validate; green on both ubuntu and windows runners.

**Gate type.** AUTONOMOUS when triggered; gated on "2nd op added or drift risk" trigger.

**Dependencies.** A-1b (Windows CI job) already running, or a 2nd op landing.

**DoD.** CI job boots real daemon; all op schemas validate.

---

### A-5 — Inc 3.4 — Latency-class daemon partition (opportunistic, F-HOL)

**Goal.** Ensure a slow `synthesize` cannot queue-block an incoming `approval.parse`.

**Approach.** Spawn a second daemon child for approval requests OR add a priority queue to the existing `createPythonModuleClient`. **Trigger: real same-daemon contention observed in prod latency metrics (fallback-rate rising, not daemon-down).**

**File touchpoints.**
- `src/memory/pythonClient.ts` — add priority-queue or second-client factory
- `server.ts` — wire separate `approvalCore` from `synthCore`

**Test plan.** Contention test: a slow `synthesize` promise does NOT delay a concurrent `approval.parse` resolve.

**Gate type.** AUTONOMOUS when triggered; gated on real contention evidence.

**Dependencies.** A-2 (twin retired, architecture cleaner) + real contention evidence.

**DoD.** Contention test proves isolation; `health.memory.daemon.transitions` unaffected.

---

## 4 · Part B — Cortex migration (completion tasks)

### B-5 — Cross-language golden for the decision-trace (AUTONOMOUS, do first)

**Goal.** Make a Python trace-shape change fail RED in the TS test suite via a frozen fixture battery.

**Approach.**
Create `tests/fixtures/cortex_decide_golden.json` — a frozen array of `{request, response}` pairs (≥5 vectors: identity-baseline with all tiers, empty tiers, partial tiers, `shadowBudget`-absent variant, `ok:false` CORTEX_FAILED). Create `tests/test_cortex_decide_golden_parity.ts`:
- Loads the fixture.
- Runs each `response` through `CortexDecideResponseSchema.safeParse()` (already at `src/memory/types.ts:177`).
- Asserts `.success === true` for `ok:true` cases; correct error shape for `ok:false`.
- Asserts `decision.keep` / `trace.strategy` / `trace.shadowBudget` shape exactly against frozen expected values.

Optionally add a Python companion in `python/synthesizer/tests/test_cortex.py` that runs `dispatch.handle` over the request fixtures and asserts responses match the frozen golden responses.

**File touchpoints.**
- `tests/fixtures/cortex_decide_golden.json` — NEW
- `tests/test_cortex_decide_golden_parity.ts` — NEW
- `python/synthesizer/tests/test_cortex.py` — ADD `test_dispatch_golden_parity`
- `src/memory/types.ts` — READ ONLY

**Test plan.**
- `npm test` runs the TS tripwire, must pass green.
- Deliberately break `CortexTraceSchema` (rename a required key) → test goes red. Restore → green.
- Python `test_dispatch_golden_parity` — break a `strategy` value in the JSON → Python test goes red.
- All pre-existing `test_cortex_client.ts` and `test_cortex_shadow_parity.ts` tests stay green.

**Gate type.** AUTONOMOUS — buildable now; schema already locked in `src/memory/types.ts:177-191`.

**Dependencies.** Inc 4 slices 1 and 2 (both on main). No other pending tasks.

**DoD.** `cortex_decide_golden.json` exists with ≥5 vectors. `tests/test_cortex_decide_golden_parity.ts` added; `npm test` green. Python `test_dispatch_golden_parity` added; `python -m unittest` green. Deliberate schema mutation confirmed to fail red.

---

### B-3 — Real curation rules in `cortex.decide`

**Goal.** Replace the `baseline-identity` strategy with real keep/drop/rerank rules driven by live state.

**Approach.**
Implement a four-rule ladder in `python/synthesizer/cortex.py`'s `decide()`:

1. **frozen-posture:** `gatePosture == "Off"` → `keep=["project","frame"]`, `drop=["pane","board","breadcrumbs"]`.
2. **inactive-pane:** `pane.status` in `{"Idle","Exited"}` or `pane` absent → `keep=["project","breadcrumbs","board","frame"]`, `drop=["pane"]`.
3. **post-approval-focus:** `lastApprovalTs` present and `now - lastApprovalTs < 30_000` → rerank active pane to front.
4. **baseline-identity:** default (current behavior, no signals).

Add `lastApprovalTs?: number` and `gatePosture?: string` to `CortexCtx` in `src/memory/types.ts` and thread through `observeCortexShadow`. Extract `_apply_rules(tiers, ctx, now)` as a pure helper. Bump `CORTEX_VERSION` to `"0.2.0"`. The curation rules run in SHADOW and are observed, never applied, until the flip (B-1).

**File touchpoints.**
- `python/synthesizer/cortex.py` — replace `decide` body; add `_apply_rules`; bump `CORTEX_VERSION` to `"0.2.0"`
- `python/synthesizer/tests/test_cortex.py` — ADD 4-6 new test cases (one per rule branch)
- `src/memory/types.ts` (`CortexCtx`) — add `lastApprovalTs?: number`, `gatePosture?: string`
- `src/memory/index.ts` (`observeCortexShadow`) — thread `gatePosture` from `tiers.frame.gatePosture` and `lastApprovalTs` into `ctx`
- `tests/test_cortex_client.ts` — ADD test for new optional fields round-tripping correctly
- `python/synthesizer/tests/test_cortex_parity.py` — no new fixtures needed; existing 18-fixture battery stays green

**Test plan.**
- Python: `test_cortex.py` extensions: (a) `gatePosture="Off"` → `keep=["project","frame"]`; (b) `pane.status="Idle"` → `keep` excludes `pane`; (c) `lastApprovalTs` within 30 s → active pane first in `keep`; (d) no signals → identity baseline unchanged.
- TS: `tests/test_cortex_shadow_parity.ts` green (parity invariants I-P1..I-P3 hold; `synthesizeAsync` untouched).
- Integration: run `observeCortexShadow` with each signal variant; assert `trace.ruleFired` matches expectation (unit test with fake cortex client echoing the request).
- `npm run lint && npm run complexity && npm test` full gate.

**Gate type.** DECISION-GATED — the rule ladder above is a *proposal*. It is mechanically buildable from existing `tiers`/`ctx` signals, but *which* curation rules ship is a product/design call the operator explicitly deferred ("leave curation for now"). Needs operator approval of the ladder before implementing.

**Dependencies.** Inc 4 slices 1 and 2 (both on main). No dependency on B-1 (flip) or B-2 (outcome-triggers).

**DoD.** `cortex.decide` with no signals returns identity (no regression). Each of the three live-state signals fires the correct rule; observable in `trace.ruleFired`. `CORTEX_VERSION` bumped to `"0.2.0"`. All Python + TS tests green. `shadowBudget` still present in traces (slice 2 test pinned).

---

### B-2 — Outcome-triggers + inject-gate

**Goal.** Wire `command_outcome` events as the fourth cortex trigger; add a deterministic diff-gated inject guard.

**Approach.**
**Decision needed first:** operator must confirm diff-gated strategy (recommended) vs debounce vs significance.

On confirmation:
- Add `OutcomeTierDigest` (`{paneId, status, lastCommand, boardSize, projectId}`) to `MemoryService`. Store `lastDigest` per `activePaneId` on each injection.
- In `src/observe/index.ts` `onQuiescing` (~line 350): after the breadcrumb drop, call `onOutcome?.(terminalId)` via a new optional callback in `ObserveOptions`. The voice layer wires it to the digest-gated inject.
- In `src/voice/index.ts` (~line 815-824): add `onOutcome: (paneId) => { if (memory.service.digestChanged(paneId, Date.now())) injectMemoryBrief(...); }`.
- The trigger label passed to `observeCortexShadow` becomes `"command-outcome"`.

**File touchpoints.**
- `src/memory/index.ts` (`MemoryService`) — add `lastDigest: Map<string, OutcomeTierDigest>`; `digestChanged(activePaneId, now): boolean`
- `src/observe/index.ts` (`onQuiescing`, ~line 350) — add `onOutcome?.(terminalId)` optional callback
- `src/voice/index.ts` (~line 815-824) — wire `onOutcome` callback
- `src/memory/types.ts` — add `OutcomeTierDigest` interface
- `tests/test_outcome_inject_gate.ts` — NEW

**Test plan.**
- `tests/test_outcome_inject_gate.ts`: (a) first outcome always injects; (b) identical snapshot → no inject; (c) `lastCommand` changed → inject; (d) `status` changed → inject; (e) board size changed → inject; (f) `observeCortexShadow` receives `trigger="command-outcome"` on fired path.
- Existing parity invariants I-P1..I-P3 unaffected.
- `npm run lint && npm run complexity && npm test` full gate.

**Gate type.** DECISION-GATED on gate strategy (operator must confirm diff-gated vs alternatives). Implementation buildable immediately after confirmation.

**Dependencies.** Slice 1 SHADOW scaffold (on main). No dependency on B-1 (flip) or B-3 (curation rules).

**DoD.** Quiescing event fires `injectMemoryBrief` iff tier digest changed. `observeCortexShadow` receives `trigger="command-outcome"`. Identical snapshot → no spurious re-inject. `npm run lint && npm run complexity && npm test` green.

---

### B-6 — Decision-memory / hysteresis callable

**Goal.** Implement oscillation-damping so back-to-back identical snapshots do not double-fire the cortex.

**Approach.**
**Decision needed first:** operator must set `quietWindowMs` default (suggested: 500 ms).

On confirmation:
- `python/synthesizer/hysteresis.py` — NEW: `HysteresisGuard(window_ms, min_char_delta)` with `should_fire(snapshot_hash, now_ms) → bool`. Pure-stateful; no I/O. Not wired to dispatch (callable by future pure-Python cortex callers; the TS side uses the inline guard, not a seam call — the round-trip cost would defeat the purpose).
- `src/memory/index.ts:MemoryService` — ADD `_lastSnapshotHash: string | null` and `_lastCortexFiredAt: number`. In `observeCortexShadow`: compute `sha256(JSON.stringify(tiers)).slice(0,16)`; skip the `decide` call if hash matches AND `now - _lastCortexFiredAt < quietWindowMs`.
- `src/memory/types.ts` — ADD `CortexHysteresisConfig { quietWindowMs: number }` if operator wants it injectable; else inline defaults.

**File touchpoints.**
- `python/synthesizer/hysteresis.py` — NEW
- `python/synthesizer/tests/test_hysteresis.py` — NEW (≥4 tests)
- `src/memory/index.ts:MemoryService` — ADD 2 private fields + inline guard (~10 lines)
- `tests/test_cortex_shadow_parity.ts` — ADD back-to-back same-snapshot test (call-count mock)

**Test plan.**
- Python: `test_hysteresis.py` — (a) same hash within window → `False`; (b) different hash → `True`; (c) same hash after window expires → `True`; (d) first call always `True`.
- TS: existing `test_cortex_shadow_parity.ts` tests stay green; new test: back-to-back with identical tiers calls `decide` exactly once.
- Invariants I-P1/I-P2/I-P3 remain green.
- `npm run lint` + `npm run complexity` green (inline guard must not push any file over CC 10).

**Gate type.** DECISION-GATED on one value: `quietWindowMs` default. Otherwise autonomous.

**Dependencies.** Slices 1 and 2 on main. Independent of B-1, B-2, B-3.

**DoD.** `HysteresisGuard` exists with ≥4 Python unit tests green. `MemoryService.observeCortexShadow` skips `decide` on hash match within window. Back-to-back TS test asserts `decide` called once. All I-P1/I-P2/I-P3 green. `npm run complexity` green.

---

### B-1 — Cortex FLIP + trust-gate

**Goal.** Env-gate (`JANUS_CORTEX_PRIMARY=1`) the cortex as the primary context-curation authority; `synth.py` / `synthesizeAsync` stays as the fail-closed floor.

**Approach.**
**Decision needed first:** operator must set the bounded-divergence trust threshold (`|Δ textLen| / textLen < N%` over a window length; suggested ≤5% over the same shadow window pattern as approval flip).

On confirmation:
- New `src/memory/cortexShadow.ts`: `setCortexPrimary(enabled, timeoutMs)`, `isCortexPrimary()`, `resolveWithCortex(tiers, ctx, now, client, timeoutMs)` — mirrors `approvalShadow.ts`.
- `src/memory/index.ts` `synthesizeAsync`: when primary, call `cortexClient.decide(tiers, ctx, now)` first (raced against `primaryTimeoutMs`, default 300 ms). On success, filter `tiers` to cortex's `keep` list before passing to the renderer. On miss/timeout/unavailable, call `synthesizeAsync` with full tiers (existing floor).
- `server.ts` (~line 709-714): read `JANUS_CORTEX_PRIMARY` env flag, call `setCortexPrimary(on, timeoutMs)`.
- `src/memory/types.ts`: add `source: "cortex-primary"` variant to `SynthesizedBrief.source`.

**File touchpoints.**
- `src/memory/cortexShadow.ts` — NEW
- `src/memory/index.ts` — branch on `isCortexPrimary()`
- `server.ts` (~line 709-714) — env flag read + `setCortexPrimary(on)` call
- `src/memory/types.ts` — add `source: "cortex-primary"` variant
- `tests/test_cortex_flip.ts` — NEW

**Test plan.**
- `tests/test_cortex_flip.ts`: (a) `JANUS_CORTEX_PRIMARY=0` → byte-identical to current `synthesizeAsync` path; (b) cortex returns `keep=["project","frame"]` → brief contains only those blocks; (c) cortex timeout → falls through to full-tier synthesis; (d) cortex primary + synth daemon also down → TS `assembleBrief` floor; (e) `source === "cortex-primary"` on happy path.
- Existing `test_cortex_shadow_parity.ts` and `test_cortex.py` green (no behavior change while flag off).
- `npm run lint && npm test` full gate.

**Gate type.** DECISION-GATED — operator must set the bounded-divergence trust threshold before the FLIP bead is claimed. Implementation buildable now; activation requires the threshold decision.

**Dependencies.** B-3 (real curation rules) makes the flip meaningful, but the mechanism is independent — the identity baseline is a valid (safe) first primary. B-5 (golden) is independent and should land first.

**DoD.** `JANUS_CORTEX_PRIMARY=0` → zero behavior change (all existing tests green). `JANUS_CORTEX_PRIMARY=1` → brief filtered to cortex's `keep` list; `source === "cortex-primary"`; cortex unavailable → fallback `source === "fallback"`. `npm run lint && npm run complexity && npm test` green. Operator has documented the bounded-divergence trust threshold.

---

### B-4 — Cortex RETIRE (delete `synth.py`)

**Goal.** Delete `python/synthesizer/synth.py` and the TS synthesizer client path once the cortex-primary fallback-rate is ≈ 0.

**Approach.**
This is the RETIRE step for the synthesis path. Prerequisites: B-1 (flip activated in prod), B-3 (real curation rules shipped), AND a cortex-primary fallback-rate counter (a sub-task: add `health.memory.daemon.cortexFallbackRate` mirroring the approval flip counter from Inc 2.3) showing ≈ 0 over an operator-agreed window.

Steps:
1. Rename `synthesize_shadow` → `synthesize` in `cortex.py`; update internal `_shadow_budget` call.
2. Update `dispatch.py` `synthesize` op handler to call `cortex.synthesize`.
3. Delete `python/synthesizer/synth.py`.
4. Delete `python/synthesizer/tests/test_synth.py` (parity battery `test_cortex_parity.py` is the surviving oracle).
5. Update `dispatch.py:13` import (`from synth import synthesize` → `from cortex import synthesize`).
6. Remove `createPythonSynthClient` / `synthFacadeOverCore` / `PythonSynthClient` from `src/memory/pythonClient.ts` if dead after B-1.
7. Clean up `src/memory/types.ts`: remove `PythonBriefSchema`, `SynthesizeResponseSchema`, `SynthesizeResponse` if unused.
8. Update `dispatch.py:30` ping response (remove `synthVersion` or re-source it from `cortex.CORTEX_VERSION`). Check `PingResponseSchema` consumers.
9. Bump `CORTEX_VERSION` to `"1.0.0"`.

**File touchpoints.**
- `python/synthesizer/cortex.py` — rename `synthesize_shadow` → `synthesize`; bump `CORTEX_VERSION` to `"1.0.0"`
- `python/synthesizer/dispatch.py` — update import + synthesize op handler + ping response
- `python/synthesizer/synth.py` — DELETE
- `python/synthesizer/tests/test_synth.py` — DELETE
- `python/synthesizer/tests/test_cortex_parity.py` — update oracle call from `synth.synthesize` to `cortex.synthesize`; optionally rename to `test_synthesizer.py`
- `src/memory/pythonClient.ts` — remove dead `createPythonSynthClient` / `synthFacadeOverCore` / `PythonSynthClient`
- `src/memory/index.ts` — remove `pythonClient` field if fully superseded
- `src/memory/types.ts` — remove `PythonBriefSchema`, `SynthesizeResponseSchema`, `SynthesizeResponse` if unused
- `tests/test_wire_version_parity.ts` — update any `synthVersion` assertions

**Test plan.**
- `test_cortex_parity.py` (or renamed `test_synthesizer.py`) — all 18 fixtures pass with `cortex.synthesize` as oracle.
- `test_cortex.py` — update any fixture importing `synth` directly.
- `test_dispatch.py` — `synthesize` op returns valid brief; `ping` still returns a version field.
- `npm run lint` (tsc `--noEmit`) — primary dead-code gate; any stray reference surfaces immediately.
- `npm test` full gate.
- Manual smoke: boot daemon, send `synthesize` op, confirm response schema intact.

**Gate type.** METRICS-GATED. All of these must be true before claiming: B-1 (cortex flip) shipped + activated in prod; B-3 (real curation rules) shipped; `health.memory.daemon.cortexFallbackRate ≈ 0` over operator-agreed window; `synthesize_shadow` / `synth.py` parity battery continuously green in shadow logs.

**Dependencies.** Hard: B-1 (flip activated) + B-3 (real curation) + observability counter for cortex-primary fallback rate (sub-task within B-4).

**DoD.** `synth.py` deleted; no import remaining (tsc + grep confirm). `dispatch.py` routes `synthesize` through `cortex.synthesize`. All Python + TS tests green. `npm run lint && npm run complexity && npm test` green. Retire documented in `bd close` note with observed fallback-rate window.

---

### B-7 — Session / connection-management logic

**Goal.** Implement hot/hot uptime and per-project warm-agent support; Python owns lifecycle/failover policy decisions (SHADOW only); TS retains all socket I/O and the fail-closed floor.

**Approach.**
**Three decisions needed first:**
- (a) TTL / recency-window values for `decide_lifecycle` (suggested: warm-window = 5 min, evict-TTL = 30 min).
- (b) `restartOnExit` on by default or opt-in (suggested: opt-in — the existing breaker-on-next-request contract is behavioral; proactive restart is an expansion).
- (c) Scope: SHADOW-only (log advice, apply nothing) or include the apply/flip path (suggested: SHADOW-only; the apply is a separate gate).

On confirmation:
- `python/synthesizer/session_policy.py` — NEW: `decide_lifecycle(health_snapshot, now_ms) → {action, targetSessionId, reason}`. Pure, deterministic, no I/O.
- `python/synthesizer/dispatch.py` — ADD `session.lifecycle` op branch.
- `src/memory/types.ts` — ADD `SessionLifecycleResponseSchema`, `LifecycleAdvice`, `SessionHealthSnapshot`.
- `src/memory/sessionManager.ts` — NEW thin facade (~30 lines): `createSessionManager(core)`. `advise(healthSnapshot, now): Promise<LifecycleAdvice | null>` — null on any miss (fail-closed).
- `src/memory/pythonClient.ts` — ADD `restartOnExit?: boolean` option; proactive child restart on exit event (if opted in) without bypassing the breaker state machine.
- `src/memory/index.ts:MemoryService` — ADD optional `sessionManager?: SessionManager`; pass real `sessionId` in `CortexCtx` (currently null at ~line 39); fire `void sessionManager.advise(healthSnapshot, now)` fire-and-forget in `observeCortexShadow` (SHADOW, log only).

**File touchpoints.**
- `python/synthesizer/session_policy.py` — NEW
- `python/synthesizer/tests/test_session_policy.py` — NEW
- `python/synthesizer/dispatch.py` — ADD `session.lifecycle` op
- `src/memory/types.ts` — ADD 3 types
- `src/memory/sessionManager.ts` — NEW
- `src/memory/pythonClient.ts` — ADD `restartOnExit?` option + child exit handler
- `src/memory/index.ts` — ADD `sessionManager?` param; propagate real `sessionId`
- `tests/test_session_manager.ts` — NEW

**Test plan.**
- Python `test_session_policy.py`: (a) recent session → `warm`; (b) idle beyond TTL → `evict`; (c) healthy → `noop`; (d) empty list → `noop`; (e) determinism.
- Python dispatch: `session.lifecycle` routed; bad input → error; daemon survives.
- TS `test_session_manager.ts`: null core → `null`; valid response → `LifecycleAdvice`; schema-invalid → `null`; no reject.
- `pythonClient` restart behavior: mock child emitting `exit` event; assert `available()` recovers without manual request trigger.
- All I-P1/I-P2/I-P3 invariants green.
- `npm run lint && npm run complexity && npm test` green.

**Gate type.** DECISION-GATED on the three decisions above before implementation starts.

**Dependencies.** B-5 (golden) and B-6 (hysteresis) independent; can land first. `createPythonModuleClient` in `src/memory/pythonClient.ts` must be read carefully before adding `restartOnExit` — the breaker state machine owns restart eligibility and must not be bypassed.

**DoD.** `session.lifecycle` routed in `dispatch.py`; Python unit tests green. `createSessionManager` TS facade wired; `test_session_manager.ts` green. `observeCortexShadow` passes real `sessionId` (non-null when active); advice is logged, not applied. `restartOnExit` implemented + tested (off by default). Operator sign-off on three decisions. Full battery green.

---

## 5 · Dependency + gate graph

```
AUTONOMOUS NOW (no gate, no decision call needed):
  A-1a  (badge)
  A-1b  (Windows CI job)
  B-5   (cortex golden)          ─────┐
  B-3   (real curation rules)         │  can all be
  A-3   (breaker reducer)*            │  claimed in
  A-4   (schema contract)*            │  parallel
                                      │
DECISION-GATED (operator must decide first):
  B-2   → operator confirms diff-gated strategy  →  buildable
  B-6   → operator sets quietWindowMs             →  buildable
  B-1   → operator sets bounded-divergence
           trust threshold                        →  buildable
  B-7   → operator answers 3 decisions            →  buildable

METRICS-GATED + OPERATOR-GATED (requires prod data):
  A-1c  → shadow match_rate ≈ 1 over window      →  then prod flip
    └──▶ A-2  (retire approval twin)              →  then fallback ≈ 0

  B-1 (flip in prod) + B-3 (curation rules) +
  cortexFallbackRate ≈ 0 over window              →  then B-4 (retire synth.py)

Dependency order (strict sequencing where it matters):
  B-5 → can land before B-1, B-3 (golden is the tripwire for all future B work)
  B-3 → ideally before B-1 flip (makes the flip meaningful; not a hard blocker)
  B-1 + B-3 + fallback-rate window → B-4
  A-1c (prod flip) + shadow window → A-2

* A-3, A-4, A-5 are triggered by external conditions (2nd consumer, contention), not by
  other tasks completing. They are independently claimable once their trigger fires.
```

---

## 6 · Definition of done / end state

The seam is **COMPLETE** when ALL of the following are true:

**Approval (Part A):**
- (a) `JANUS_APPROVAL_PYTHON_PRIMARY=1` is active in prod.
- (b) `health.memory.daemon.transitions ≈ 0` and `health.memory.shadow.match_rate ≈ 1` over the operator-confirmed window (A-1c).
- (c) `src/approvalIntent.ts` is deleted from the repo; `tsc --noEmit` and `npm test` pass (A-2).
- (d) `health.memory.daemon.currentlyFallback: false`; no parity regression post-retire.

**Cortex (Part B):**
- (e) `JANUS_CORTEX_PRIMARY=1` is active in prod; real curation rules are shipped (B-1 + B-3).
- (f) `health.memory.daemon.cortexFallbackRate ≈ 0` over the operator-confirmed window.
- (g) `python/synthesizer/synth.py` is deleted from the repo; `tsc --noEmit` and `npm test` and `python -m unittest` pass (B-4).
- (h) No `synthVersion` dangling reference; `dispatch.py` routes `synthesize` through `cortex.synthesize`.

**Everything past that is new brain capability, not "the seam."**

The opportunistic hardening items (A-3/A-4/A-5 — breaker reducer, schema contract, latency partition) and the session/connection management work (B-7) are improvements ON TOP of a complete seam, gated on their own trigger conditions. They do not block the seam completion declaration.

---

## 7 · What is buildable RIGHT NOW vs what needs the operator

### Buildable right now (no gate, no design call):

| Task | What to build |
|---|---|
| **A-1a** | Frontend `DaemonStateBadge` component consuming `daemon_state` WS frames |
| **A-1b** | Windows CI job in `.github/workflows/ci.yml` running `npm run smoke:daemon` |
| **B-5** | `tests/fixtures/cortex_decide_golden.json` + `tests/test_cortex_decide_golden_parity.ts` + Python `test_dispatch_golden_parity` |

### Needs one operator decision before building:

| Task | Decision needed |
|---|---|
| **B-3** | Approve the curation rule ladder (frozen-posture / inactive-pane / post-approval-focus) — the deferred curation policy |
| **B-2** | Confirm diff-gated strategy (vs debounce vs significance) for outcome-triggers inject gate |
| **B-6** | Set `quietWindowMs` default (suggested: 500 ms) |
| **B-1** | Set bounded-divergence trust threshold (suggested: `|Δ textLen| / textLen < 5%` over same window length as approval) |
| **B-7** | Answer 3 decisions: TTL values, `restartOnExit` opt-in vs default, SHADOW-only vs include-apply scope |

### Needs prod metrics (cannot start without data):

| Task | Gate condition |
|---|---|
| **A-1c** | `memory.shadow.match_rate ≈ 1` over operator-set window (shadow already running on main) |
| **A-2** | A-1c confirmed + `fallback-rate ≈ 0` over window |
| **B-4** | B-1 + B-3 in prod + `cortexFallbackRate ≈ 0` over window |

### Opportunistic (wait for trigger condition):

| Task | Trigger |
|---|---|
| **A-3** | 2nd hot consumer appears OR flapping fallback metrics |
| **A-4** | 3rd op added OR payload-drift risk materializes |
| **A-5** | Real same-daemon contention observed in prod latency metrics |
