// tests/test_cortex_measurement.ts
// B-3 Task 4: round-trip tests for the cortex measurement spine writers.
// Verifies recordCortexDecision + recordGeminiTurnUsage store and retrieve their
// payloads correctly from an in-memory JanusStore.

import { test } from "node:test";
import assert from "node:assert";
import { JanusStore } from "../src/store/sqliteStore";

function seed(): JanusStore {
  const s = new JanusStore(":memory:");
  s.init();
  return s;
}

// ── cortex_decision round-trip ───────────────────────────────────────────────

test("recordCortexDecision stores and getCortexDecisions retrieves the row", () => {
  const s = seed();
  const ts = 1_700_000_000_000;
  const traceJson = JSON.stringify({ ruleFired: "exited-pane", orderedKeep: [], dropped: ["pane"] });

  s.recordCortexDecision({
    ts,
    injectId: "inj-001",
    sessionId: "sess-abc",
    activePaneId: "pane-1",
    trigger: "brief-inject",
    ruleFired: "exited-pane",
    applied: false,
    traceJson,
  });

  const rows = s.getCortexDecisions(ts - 1);
  assert.strictEqual(rows.length, 1, "one row should be stored");
  const row = rows[0];
  assert.strictEqual(row.inject_id, "inj-001");
  assert.strictEqual(row.session_id, "sess-abc");
  assert.strictEqual(row.active_pane_id, "pane-1");
  assert.strictEqual(row.trigger, "brief-inject");
  assert.strictEqual(row.rule_fired, "exited-pane");
  assert.strictEqual(row.applied, 0, "applied=false must land as SqlBool 0");
  assert.strictEqual(row.trace_json, traceJson);
  s.close();
});

test("recordCortexDecision with applied=true stores applied=1", () => {
  const s = seed();
  s.recordCortexDecision({
    ts: Date.now(), injectId: null, sessionId: null, activePaneId: null,
    trigger: "flip", ruleFired: "baseline-identity", applied: true, traceJson: "{}",
  });
  const rows = s.getCortexDecisions(0);
  assert.strictEqual(rows[0].applied, 1);
  s.close();
});

test("getCortexDecisions filters by sinceTs correctly", () => {
  const s = seed();
  const T = 1_700_000_000_000;
  s.recordCortexDecision({ ts: T - 1000, injectId: "old", sessionId: null, activePaneId: null, trigger: "t", ruleFired: "r", applied: false, traceJson: "{}" });
  s.recordCortexDecision({ ts: T + 1000, injectId: "new", sessionId: null, activePaneId: null, trigger: "t", ruleFired: "r", applied: false, traceJson: "{}" });

  const rows = s.getCortexDecisions(T);
  assert.strictEqual(rows.length, 1, "only the row at T+1000 survives the filter");
  assert.strictEqual(rows[0].inject_id, "new");
  s.close();
});

test("recordCortexDecision is fail-soft — never throws into caller", () => {
  // Pass intentionally malformed data to trigger a SQLite constraint violation
  // by closing the store before writing (forces SQLITE_MISUSE).
  const s = seed();
  s.close();
  assert.doesNotThrow(() => {
    s.recordCortexDecision({ ts: 1, injectId: null, sessionId: null, activePaneId: null, trigger: "t", ruleFired: "r", applied: false, traceJson: "{}" });
  }, "a writer failure must not propagate to the caller");
});

// ── gemini_turn_usage round-trip ─────────────────────────────────────────────

test("recordGeminiTurnUsage stores and getGeminiTurnUsages retrieves the row", () => {
  const s = seed();
  const ts = 1_700_000_001_000;

  s.recordGeminiTurnUsage({
    ts,
    sessionId: "sess-abc",
    injectId: "inj-001",
    promptTokens: 120,
    responseTokens: 45,
    totalTokens: 165,
  });

  const rows = s.getGeminiTurnUsages(ts - 1);
  assert.strictEqual(rows.length, 1);
  const row = rows[0];
  assert.strictEqual(row.session_id, "sess-abc");
  assert.strictEqual(row.inject_id, "inj-001");
  assert.strictEqual(row.prompt_tokens, 120);
  assert.strictEqual(row.response_tokens, 45);
  assert.strictEqual(row.total_tokens, 165);
  s.close();
});

test("recordGeminiTurnUsage accepts null token counts (field absent in payload)", () => {
  const s = seed();
  s.recordGeminiTurnUsage({ ts: Date.now(), sessionId: null, injectId: null, promptTokens: null, responseTokens: null, totalTokens: null });
  const rows = s.getGeminiTurnUsages(0);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].total_tokens, null);
  s.close();
});

test("recordGeminiTurnUsage is fail-soft — never throws into caller", () => {
  const s = seed();
  s.close();
  assert.doesNotThrow(() => {
    s.recordGeminiTurnUsage({ ts: 1, sessionId: null, injectId: null, promptTokens: null, responseTokens: null, totalTokens: null });
  }, "a writer failure must not propagate to the caller");
});

// ── inject_id correlation join ───────────────────────────────────────────────

test("inject_id ties a cortex decision to a gemini turn (join sanity)", () => {
  const s = seed();
  const T = Date.now();
  s.recordCortexDecision({ ts: T, injectId: "inj-42", sessionId: "s1", activePaneId: "p1", trigger: "brief-inject", ruleFired: "baseline-identity", applied: false, traceJson: "{}" });
  s.recordGeminiTurnUsage({ ts: T + 500, sessionId: "s1", injectId: "inj-42", promptTokens: 200, responseTokens: 80, totalTokens: 280 });

  const decisions = s.getCortexDecisions(0).filter(r => r.inject_id === "inj-42");
  const usages = s.getGeminiTurnUsages(0).filter(r => r.inject_id === "inj-42");
  assert.strictEqual(decisions.length, 1, "one decision for inj-42");
  assert.strictEqual(usages.length, 1, "one usage for inj-42");
  assert.strictEqual(usages[0].total_tokens, 280);
  s.close();
});
