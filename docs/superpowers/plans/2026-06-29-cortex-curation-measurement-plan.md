# Cortex Curation + Measurement Spine (B-3 v0.2.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship minimal cortex curation rules (`exited-pane` drop + identity baseline) plus a measurement spine that joins every cortex decision and each Gemini turn's token cost to the injection that caused them.

**Architecture:** Python `cortex.decide` gains a tiny rule ladder (bump `CORTEX_VERSION` → `0.2.0`). TS rides the existing SHADOW tap (`observeCortexShadow`) to persist each decision-trace to the durable store, keyed by a per-injection `injectId` minted at `injectMemoryBrief`; the Gemini turn-complete handler captures `usageMetadata` under the same key. All SHADOW-safe — `synthesizeAsync` and the rendered brief are never touched.

**Tech Stack:** Python 3 (stdlib), TypeScript, better-sqlite3 (`src/store/`), node:test, Python unittest.

**Spec:** `docs/superpowers/specs/2026-06-29-cortex-curation-measurement-design.md`

---

## File Structure

| File | Create/Modify | Responsibility |
|---|---|---|
| `python/synthesizer/cortex.py` | Modify | `_apply_rules` + `exited-pane` rule; `CORTEX_VERSION = "0.2.0"` |
| `python/synthesizer/tests/test_cortex.py` | Modify | rule unit tests |
| `tests/fixtures/cortex_decide_golden.json` | Regenerate | B-5 golden for 0.2.0 traces |
| `tests/test_cortex_decide_golden_parity.ts` | Modify (maybe) | expected values for 0.2.0 |
| `src/store/schema.ts` | Modify | new migration: `cortex_decision` + `gemini_turn_usage` tables |
| `src/store/types.ts` | Modify | `CortexDecisionRow`, `GeminiTurnUsageRow` |
| `src/store/index.ts` (JanusStore) | Modify | `recordCortexDecision()`, `recordGeminiTurnUsage()` writers |
| `src/memory/index.ts` | Modify | `observeCortexShadow` persists the trace (store + `injectId`) |
| `src/voice/index.ts` | Modify | mint `injectId` in `injectMemoryBrief`; capture `usageMetadata` at turn-complete |
| `tests/test_cortex_measurement.ts` | Create | TS spine tests (persistence + correlation + token capture) |

**Note on the store writer:** `JanusStore` is the better-sqlite3 wrapper. Find the existing `action_log` insert (a prepared `INSERT INTO action_log ...` statement) and mirror its shape for the two new writers. The store is reached in the voice layer via the same handle that already serves `getActionLog`.

---

## Part A — Python curation rules (independent of Part B; can run first/parallel)

### Task 1: `exited-pane` rule + CORTEX_VERSION 0.2.0

**Files:**
- Modify: `python/synthesizer/cortex.py` (`decide`, add `_apply_rules`; `CORTEX_VERSION`)
- Test: `python/synthesizer/tests/test_cortex.py`

- [ ] **Step 1: Failing tests.** Add to `test_cortex.py`:

```python
def test_exited_pane_drops_pane_tier(self):
    tiers = dict(TIERS)
    tiers["pane"] = {"paneId": "p1", "name": "main", "runtimeType": "claude",
                     "status": "Exited", "lastCommand": "ls", "recent": ["done"]}
    out = cortex.decide(tiers, CTX, 0)
    self.assertNotIn("pane", out["decision"]["keep"])
    self.assertIn("pane", out["decision"]["drop"])
    self.assertEqual(out["trace"]["ruleFired"], "exited-pane")

def test_idle_pane_is_kept(self):
    tiers = dict(TIERS)
    tiers["pane"] = {"paneId": "p1", "name": "main", "runtimeType": "claude",
                     "status": "Idle", "lastCommand": "ls", "recent": ["ok"]}
    out = cortex.decide(tiers, CTX, 0)
    self.assertIn("pane", out["decision"]["keep"])      # idle ≈ just-finished ≈ relevant
    self.assertEqual(out["trace"]["ruleFired"], "baseline-identity")

def test_cortex_version_is_0_2_0(self):
    self.assertEqual(cortex.CORTEX_VERSION, "0.2.0")
```

- [ ] **Step 2: Run → fail.** `set PYTHONIOENCODING=utf-8 & py -3 -m unittest python.synthesizer.tests.test_cortex -v` (Windows: `$env:PYTHONIOENCODING='utf-8'`). Expect FAIL.

- [ ] **Step 3: Implement.** In `cortex.py`: set `CORTEX_VERSION = "0.2.0"`. Add a pure helper and call it from `decide` (keep `decide` under CC 10):

```python
def _apply_rules(tiers, kept):
    """Return (keep, drop, rule). v0.2.0 ladder: exited-pane, else identity.
    `kept` is the present-tier list in canonical order (from decide)."""
    pane = (tiers or {}).get("pane")
    if pane and str(pane.get("status", "")).lower() == "exited" and "pane" in kept:
        keep = [k for k in kept if k != "pane"]
        return keep, ["pane"], "exited-pane"
    return list(kept), [], "baseline-identity"
```

In `decide`, after computing `kept`, replace the identity decision/strategy with:

```python
keep, drop, rule = _apply_rules(tiers, kept)
decision = {"keep": keep, "drop": drop, "rerank": []}
# ... trace: strategy=rule, ruleFired=rule, output.orderedKeep=keep, output.dropped=drop
```

Update the trace dict so `strategy` and `ruleFired` are `rule`, and `output` is `{"orderedKeep": keep, "dropped": drop}`. Keep `shadowBudget` logic unchanged.

- [ ] **Step 4: Run → pass.** Same command. Expect PASS. Also run the full module: all existing `test_cortex.py` cases stay green (identity still holds when no signal).

- [ ] **Step 5: Commit.** `git add python/synthesizer/cortex.py python/synthesizer/tests/test_cortex.py && git commit -m "feat(cortex): B-3 exited-pane rule + CORTEX_VERSION 0.2.0"`

### Task 2: Regenerate the B-5 golden + parity battery

**Files:**
- Regenerate: `tests/fixtures/cortex_decide_golden.json`
- Modify (if needed): `tests/test_cortex_decide_golden_parity.ts`, `python/synthesizer/tests/test_cortex.py::test_dispatch_golden_parity`

- [ ] **Step 1:** Add one golden vector with an Exited pane to the fixture's request set (so the `exited-pane` branch is frozen), alongside the existing identity vectors.
- [ ] **Step 2: Regenerate** the frozen responses by running `dispatch.handle` over each request (the fixture is generated from the live daemon — see the generator note in `test_cortex.py::test_dispatch_golden_parity`). Write the new responses (now carrying `cortexVersion: "0.2.0"` and the `exited-pane` trace) into the JSON.
- [ ] **Step 3:** Update `CortexTraceSchema`/expected values in `tests/test_cortex_decide_golden_parity.ts` only if a *shape* changed (it should not — only values). Run `npx tsx --test --test-force-exit tests/test_cortex_decide_golden_parity.ts` → PASS. Run the Python `test_dispatch_golden_parity` → PASS.
- [ ] **Step 4: Drift check.** Mutate a `strategy` value in the JSON → both tests go red; restore → green.
- [ ] **Step 5: Commit.** `git add tests/fixtures/cortex_decide_golden.json tests/test_cortex_decide_golden_parity.ts && git commit -m "test(cortex): regenerate B-5 golden for 0.2.0 (exited-pane)"`

---

## Part B — The measurement spine (TS)

### Task 3: Store migration — `cortex_decision` + `gemini_turn_usage`

**Files:** Modify `src/store/schema.ts` (append a new migration version at the end of the migration array), `src/store/types.ts`.

- [ ] **Step 1:** Append a migration (mirrors the `action_log` DDL at `schema.ts:238`):

```ts
(db) => {
  db.exec(`
    CREATE TABLE cortex_decision (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      inject_id TEXT,
      session_id TEXT,
      active_pane_id TEXT,
      trigger TEXT,
      rule_fired TEXT,
      applied INTEGER NOT NULL DEFAULT 0,   -- 0 = SHADOW (counterfactual), 1 = applied (post-flip)
      trace_json TEXT NOT NULL
    );
    CREATE INDEX idx_cortex_decision_ts        ON cortex_decision(ts);
    CREATE INDEX idx_cortex_decision_inject_id ON cortex_decision(inject_id);

    CREATE TABLE gemini_turn_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      session_id TEXT,
      inject_id TEXT,                        -- nearest preceding injection, by time
      prompt_tokens INTEGER,
      response_tokens INTEGER,
      total_tokens INTEGER
    );
    CREATE INDEX idx_gemini_turn_usage_ts        ON gemini_turn_usage(ts);
    CREATE INDEX idx_gemini_turn_usage_inject_id ON gemini_turn_usage(inject_id);
  `);
},
```

Add `CortexDecisionRow` and `GeminiTurnUsageRow` interfaces to `src/store/types.ts` (column-for-column, per the file's own convention note at `types.ts:84`).

- [ ] **Step 2:** Add retention sweeps for both tables in `src/store/retention.ts` (mirror the `action_log` TTL step at `retention.ts:137`).
- [ ] **Step 3:** Run `npm run lint` → green (schema/types compile). A fresh DB boots through the new migration (existing migration test covers this; run `npm test -- ` for the store suite or `npx tsx --test --test-force-exit tests/test_store_sweep.ts`).
- [ ] **Step 4: Commit.** `git add src/store/schema.ts src/store/types.ts src/store/retention.ts && git commit -m "feat(store): cortex_decision + gemini_turn_usage tables (B-3 spine)"`

### Task 4: Store writers — `recordCortexDecision`, `recordGeminiTurnUsage`

**Files:** Modify `src/store/index.ts` (JanusStore). Test: `tests/test_cortex_measurement.ts` (create).

- [ ] **Step 1: Failing test** (create `tests/test_cortex_measurement.ts`): open an in-memory/temp `JanusStore`, call `recordCortexDecision({...})` and `recordGeminiTurnUsage({...})`, then read the rows back (a `getCortexDecisions(sinceTs)` helper or a raw select) and assert the round-trip (inject_id, rule_fired, total_tokens preserved).
- [ ] **Step 2: Run → fail** (methods undefined). `npx tsx --test --test-force-exit tests/test_cortex_measurement.ts`.
- [ ] **Step 3: Implement** the two writers on JanusStore, each a prepared `INSERT` mirroring the existing `action_log` writer (find it in `src/store/index.ts`). Signatures:

```ts
recordCortexDecision(row: { ts: number; injectId: string | null; sessionId: string | null;
  activePaneId: string | null; trigger: string; ruleFired: string; applied: boolean; traceJson: string }): void
recordGeminiTurnUsage(row: { ts: number; sessionId: string | null; injectId: string | null;
  promptTokens: number | null; responseTokens: number | null; totalTokens: number | null }): void
```

Both must be **fail-soft**: wrap the prepared `.run(...)` in try/catch, swallow + `console.error` (measurement must never throw into the caller).

- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit.** `git add src/store/index.ts tests/test_cortex_measurement.ts && git commit -m "feat(store): cortex measurement writers (fail-soft)"`

### Task 5: Persist the decision in `observeCortexShadow`

**Files:** Modify `src/memory/index.ts` (`MemoryService`). Test: extend `tests/test_cortex_measurement.ts`.

- [ ] **Step 1: Failing test.** Construct a `MemoryService` with a fake cortex client (echoing an `exited-pane` decision) + a fake store recorder; call `observeCortexShadow(activeId, now, "brief-inject", injectId="inj-1")`; assert (after a microtask flush) the store received one `recordCortexDecision` with `injectId="inj-1"`, `ruleFired`, `applied=false`, and the `trace_json`.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement.** Add an optional `decisionSink?: (row) => void` (or pass the store) to the `MemoryService` constructor. Change `observeCortexShadow` signature to `observeCortexShadow(activePaneId, now, trigger = "brief-inject", injectId: string | null = null)`. In the `.then(res => ...)` arm, **replace the `console.error`** with: if `res.ok`, call the sink with `{ ts: now, injectId, sessionId: ctx.sessionId, activePaneId, trigger, ruleFired: res.trace.ruleFired, applied: false, traceJson: JSON.stringify(res.trace) }`. Keep it fully inside the existing fire-and-forget `.then` (still never awaited, never throws). The B-6 hysteresis guard and I-P1..I-P3 are unchanged.
- [ ] **Step 4: Run → pass.** Also run `tests/test_cortex_shadow_parity.ts` → parity invariants still green; `npm run complexity` → `observeCortexShadow` still CC ≤ 10 (extract a `_recordDecision` helper if needed).
- [ ] **Step 5: Commit.** `git add src/memory/index.ts tests/test_cortex_measurement.ts && git commit -m "feat(memory): persist cortex decision-trace via the SHADOW tap (B-3 spine)"`

### Task 6: Mint `injectId` and thread it from `injectMemoryBrief`

**Files:** Modify `src/voice/index.ts` (`injectMemoryBrief`, ~line 545). Test: extend `tests/test_cortex_measurement.ts` (or a voice-harness test if one exists).

- [ ] **Step 1: Failing test.** Drive `injectMemoryBrief` (or the unit it factors into) and assert `observeCortexShadow` is called with a non-null `injectId`, and the same `injectId` is available for the turn-usage join (e.g., stored on `state.lastInjectId`).
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement.** In `injectMemoryBrief`, mint `const injectId = \`inj-${Date.now()}-${++injectSeq}\`` (module/closure counter), pass it: `memory.service.observeCortexShadow(activeId, Date.now(), "brief-inject", injectId)`, and stash it on the session state (`state.lastInjectId = injectId`) so the turn-usage capture (Task 7) can read the nearest preceding injection. Wire the `decisionSink`/store into the `MemoryService` construction site (search where `new MemoryService(`/`createMemorySubsystem(` is built in `server.ts`) to pass the store's `recordCortexDecision`.
- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit.** `git add src/voice/index.ts server.ts tests/test_cortex_measurement.ts && git commit -m "feat(voice): mint per-injection injectId for the cortex measurement join"`

### Task 7: Capture Gemini `usageMetadata` at turn-complete

**Files:** Modify `src/voice/index.ts` (`relayInterruptAndTurnState`, ~line 1122). Test: extend `tests/test_cortex_measurement.ts`.

- [ ] **Step 1: Failing test.** Feed a fake `message` with `serverContent.turnComplete = true` and `usageMetadata = { promptTokenCount: 10, responseTokenCount: 5, totalTokenCount: 15 }`; assert `recordGeminiTurnUsage` is called once with those counts + `injectId = state.lastInjectId` + `sessionId`.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement.** In `relayInterruptAndTurnState`, inside the `turnComplete || generationComplete` branch, read `const u = (message as any).usageMetadata`; if present, call `store.recordGeminiTurnUsage({ ts: Date.now(), sessionId, injectId: state.lastInjectId ?? null, promptTokens: u.promptTokenCount ?? null, responseTokens: u.responseTokenCount ?? null, totalTokens: u.totalTokenCount ?? null })`. Guard the whole thing (fail-soft); a turn without `usageMetadata` is a no-op. (Field names per `@google/genai` `LiveServerMessage.usageMetadata` — verify against the installed types.)
- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit.** `git add src/voice/index.ts tests/test_cortex_measurement.ts && git commit -m "feat(voice): capture per-turn Gemini token usage under the injection key (B-3 spine)"`

### Task 8: Full gates + integration sweep

- [ ] **Step 1:** `npm run lint` → green.
- [ ] **Step 2:** `npm run complexity` → green (CC ≤ 10 on every touched function).
- [ ] **Step 3:** `npm test` → full unit suite green (parity invariants, store, measurement, golden).
- [ ] **Step 4:** `$env:PYTHONIOENCODING='utf-8'; py -3 -m unittest discover -s python/synthesizer/tests` → green.
- [ ] **Step 5: Commit** any final fixups; the branch is ready for adversarial review + PR.

---

## Self-Review (coverage vs. spec)

- Part 1 minimal rules → Tasks 1–2 ✅ (exited-pane + identity, 0.2.0, golden).
- Part 2 measurement spine: correlation key → Task 6; persist decision → Tasks 3–5; capture token cost → Tasks 3,4,7 ✅.
- Part 3 SHADOW/FLIP semantics → `applied` column (Task 3) distinguishes counterfactual vs realized ✅.
- Part 4 seam fit → rides `observeCortexShadow` (Task 5), reuses `interaction_id`-style correlation + `action_log` store pattern (Tasks 3,4) ✅.
- Error handling → fail-soft writers (Task 4) + fire-and-forget persistence (Task 5) + guarded capture (Task 7) ✅.
- Out-of-scope (post-approval-focus, idle-recency, analytics tooling) → not in any task ✅ (correctly excluded).
