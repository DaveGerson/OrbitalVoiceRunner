// tests/test_context_telemetry_store.ts
// Cortex context-injection telemetry — Phase A (telemetry core + persistence). Covers what is
// genuinely NEW per docs/superpowers/specs/2026-07-02-cortex-context-telemetry.md §18.5:
//   - schema v10 migration (fresh db + the v9->v10 user_version bump path)
//   - recordContextInjection / getContextInjections writer+reader round-trip (incl. since/
//     sessionId/limit filters)
//   - hashText/hashSnapshot/estimateTokens/mintContextInjectionEventId determinism
//   - writer fail-soft behavior (never throws into the caller)
// Neighbors already covered elsewhere (NOT duplicated here):
//   - v9 spine (cortex_decision / gemini_turn_usage) round-trip + inject_id join sanity
//       → tests/test_cortex_measurement.ts
//   - generic migration/idempotency shape (fresh db reaches SCHEMA_VERSION, table_info checks)
//       → tests/test_store_schema.ts, tests/test_action_log.ts, tests/test_action_log_interaction.ts
//   - per-pane draft persistence                     → tests/test_store_drafts.ts
//   - injectMemoryBrief instrumentation / dispositions at the live choke point → Phase B/C (not
//     this file; this file only exercises the store + type layer directly with synthetic rows).

import { test } from "node:test";
import assert from "node:assert";
import Database from "better-sqlite3";
import { applyMigrations, SCHEMA_VERSION } from "../src/store/schema";
import { JanusStore } from "../src/store/sqliteStore";
import {
  hashText,
  hashSnapshot,
  estimateTokens,
  mintContextInjectionEventId,
  type ContextInjectionEvent,
} from "../src/memory/contextTelemetry";

function seed(): JanusStore {
  const s = new JanusStore(":memory:");
  s.init();
  return s;
}

function mkEvent(overrides: Partial<ContextInjectionEvent> = {}): ContextInjectionEvent {
  return {
    id: mintContextInjectionEventId(),
    ts: 1_700_000_000_000,
    session_id: "sess-abc",
    interaction_id: "ixn-1",
    inject_id: "inj-001",
    trigger: "pane_switch",
    active_project_id: "proj-1",
    active_pane_id: "pane-b",
    brief_active_pane_id: "pane-b",
    source: "fallback",
    disposition: "injected",
    skipped_reason: null,
    source_snapshot_hash: "abc123",
    brief_hash: "def456",
    brief_chars: 400,
    estimated_tokens: 100,
    elapsed_ms: 12,
    error: null,
    ...overrides,
  };
}

// ── Migration v10 ─────────────────────────────────────────────────────────────

test("migration v10 creates context_injections + all five indexes on a fresh db", () => {
  const db = new Database(":memory:");
  applyMigrations(db);

  const tables = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table'"
  ).all() as any[]).map(r => r.name);
  assert.ok(tables.includes("context_injections"), "context_injections table should exist");
  assert.ok(SCHEMA_VERSION >= 10, "SCHEMA_VERSION should be at least 10");
  assert.equal(db.pragma("user_version", { simple: true }), SCHEMA_VERSION);

  const indexes = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index'"
  ).all() as any[]).map(r => r.name);
  for (const idx of [
    "idx_context_injections_ts",
    "idx_context_injections_session_ts",
    "idx_context_injections_inject_id",
    "idx_context_injections_active_pane_ts",
    "idx_context_injections_brief_hash",
  ]) {
    assert.ok(indexes.includes(idx), `${idx} should exist`);
  }
  db.close();
});

test("migration v10 applies on the v9->v10 user_version bump path", () => {
  // Simulate a db that has already reached v9 (user_version=9) WITHOUT running migrations 1-9's
  // table DDL: the v10 migration is additive and self-contained (no FK to earlier tables), so it
  // is safe to exercise the bump-path in isolation — the thing under test is "applyMigrations only
  // runs the NEW migration and bumps the version", not "the full v1..v9 schema is byte-identical"
  // (that full-chain fresh-db behavior is already covered by the "fresh db" test above and by
  // tests/test_store_schema.ts / tests/test_action_log*.ts).
  const db = new Database(":memory:");
  db.pragma("user_version = 9");

  applyMigrations(db);

  assert.equal(db.pragma("user_version", { simple: true }), SCHEMA_VERSION, "version should bump to SCHEMA_VERSION");
  const tables = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table'"
  ).all() as any[]).map(r => r.name);
  assert.ok(tables.includes("context_injections"), "the v10 migration should have run");
  db.close();
});

test("applyMigrations is idempotent for v10 — a re-run neither throws nor duplicates the table", () => {
  const db = new Database(":memory:");
  applyMigrations(db);
  const v = db.pragma("user_version", { simple: true });
  assert.doesNotThrow(() => applyMigrations(db));
  assert.equal(db.pragma("user_version", { simple: true }), v);
  db.close();
});

// ── recordContextInjection / getContextInjections round-trip ──────────────────

test("recordContextInjection stores and getContextInjections retrieves the row column-for-column", () => {
  const s = seed();
  const evt = mkEvent();
  s.recordContextInjection(evt);

  const rows = s.getContextInjections({ since: evt.ts - 1 });
  assert.strictEqual(rows.length, 1);
  const row = rows[0];
  assert.strictEqual(row.id, evt.id);
  assert.strictEqual(row.ts, evt.ts);
  assert.strictEqual(row.session_id, evt.session_id);
  assert.strictEqual(row.interaction_id, evt.interaction_id);
  assert.strictEqual(row.inject_id, evt.inject_id);
  assert.strictEqual(row.trigger, evt.trigger);
  assert.strictEqual(row.active_project_id, evt.active_project_id);
  assert.strictEqual(row.active_pane_id, evt.active_pane_id);
  assert.strictEqual(row.brief_active_pane_id, evt.brief_active_pane_id);
  assert.strictEqual(row.source, evt.source);
  assert.strictEqual(row.disposition, evt.disposition);
  assert.strictEqual(row.skipped_reason, evt.skipped_reason);
  assert.strictEqual(row.source_snapshot_hash, evt.source_snapshot_hash);
  assert.strictEqual(row.brief_hash, evt.brief_hash);
  assert.strictEqual(row.brief_chars, evt.brief_chars);
  assert.strictEqual(row.estimated_tokens, evt.estimated_tokens);
  assert.strictEqual(row.elapsed_ms, evt.elapsed_ms);
  assert.strictEqual(row.error, evt.error);
  s.close();
});

test("recordContextInjection accepts a skipped event with inject_id=null (pre-mint disposition)", () => {
  const s = seed();
  const evt = mkEvent({
    id: mintContextInjectionEventId(),
    inject_id: null,
    disposition: "skipped_no_session",
    source: "none",
    skipped_reason: "no active gemini session",
    brief_hash: null,
    source_snapshot_hash: null,
    brief_chars: 0,
    estimated_tokens: 0,
    elapsed_ms: null,
  });
  s.recordContextInjection(evt);
  const rows = s.getContextInjections();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].inject_id, null);
  assert.strictEqual(rows[0].disposition, "skipped_no_session");
  s.close();
});

test("getContextInjections filters by since (ts >= since)", () => {
  const s = seed();
  const T = 1_700_000_000_000;
  s.recordContextInjection(mkEvent({ id: "e-old", ts: T - 1000 }));
  s.recordContextInjection(mkEvent({ id: "e-new", ts: T + 1000 }));

  const rows = s.getContextInjections({ since: T });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].id, "e-new");
  s.close();
});

test("getContextInjections filters by sessionId", () => {
  const s = seed();
  s.recordContextInjection(mkEvent({ id: "e-a", session_id: "sess-a" }));
  s.recordContextInjection(mkEvent({ id: "e-b", session_id: "sess-b" }));

  const rows = s.getContextInjections({ sessionId: "sess-a" });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].id, "e-a");
  s.close();
});

// Review finding: `if (filter?.sessionId)` treated sessionId via truthiness, so an
// empty-string sessionId silently fell through to the unfiltered branch and leaked every
// session's rows instead of matching zero. Guard against regression with `!== undefined`.
test("getContextInjections with an empty-string sessionId returns zero rows, not every session's rows", () => {
  const s = seed();
  s.recordContextInjection(mkEvent({ id: "e-a", session_id: "sess-a" }));
  s.recordContextInjection(mkEvent({ id: "e-b", session_id: "sess-b" }));

  const rows = s.getContextInjections({ sessionId: "" });
  assert.deepStrictEqual(rows, [], "an empty-string sessionId should match no rows, not act as unfiltered");
  s.close();
});

// Review finding: ordering by `ts DESC` alone has no deterministic tiebreak for rows sharing
// a millisecond, and the event id itself (`ctxevt-<ts>-<seq>`, not zero-padded) is not safely
// sortable lexicographically once `seq` reaches two digits. `rowid DESC` (insertion order)
// gives a deterministic tiebreak instead.
test("getContextInjections breaks same-millisecond ties by insertion order (rowid), not lexicographic id", () => {
  const s = seed();
  const T = 1_700_000_000_000;
  // Same ts; ids chosen so naive lexicographic id DESC would misorder them ("...-9" > "...-10").
  s.recordContextInjection(mkEvent({ id: "ctxevt-1700000000000-9", ts: T }));
  s.recordContextInjection(mkEvent({ id: "ctxevt-1700000000000-10", ts: T }));

  const rows = s.getContextInjections();
  assert.deepStrictEqual(
    rows.map(r => r.id),
    ["ctxevt-1700000000000-10", "ctxevt-1700000000000-9"],
    "the most-recently-inserted row (seq 10) should sort first, matching insertion/rowid order"
  );
  s.close();
});

test("getContextInjections respects an explicit limit and defaults to 100, newest-first", () => {
  const s = seed();
  for (let i = 0; i < 5; i++) {
    s.recordContextInjection(mkEvent({ id: `e-${i}`, ts: 1_700_000_000_000 + i }));
  }
  const limited = s.getContextInjections({ limit: 2 });
  assert.strictEqual(limited.length, 2);
  assert.deepStrictEqual(limited.map(r => r.id), ["e-4", "e-3"]);
  assert.strictEqual(s.getContextInjections().length, 5);
  s.close();
});

// ── inject_id join with the v9 spine ───────────────────────────────────────────

test("inject_id ties a context_injections row to the v9 cortex_decision/gemini_turn_usage rows", () => {
  const s = seed();
  const T = Date.now();
  s.recordContextInjection(mkEvent({ id: "e-join", ts: T, inject_id: "inj-join-1" }));
  s.recordCortexDecision({
    ts: T, injectId: "inj-join-1", sessionId: "sess-abc", activePaneId: "pane-b",
    trigger: "brief-inject", ruleFired: "baseline-identity", applied: false, traceJson: "{}",
  });
  s.recordGeminiTurnUsage({
    ts: T + 100, sessionId: "sess-abc", injectId: "inj-join-1",
    promptTokens: 50, responseTokens: 10, totalTokens: 60,
  });

  const ctxRows = s.getContextInjections().filter(r => r.inject_id === "inj-join-1");
  const decisionRows = s.getCortexDecisions(0).filter(r => r.inject_id === "inj-join-1");
  const usageRows = s.getGeminiTurnUsages(0).filter(r => r.inject_id === "inj-join-1");
  assert.strictEqual(ctxRows.length, 1);
  assert.strictEqual(decisionRows.length, 1);
  assert.strictEqual(usageRows.length, 1);
  s.close();
});

// ── Fail-soft writer/reader ────────────────────────────────────────────────────

test("recordContextInjection is fail-soft — never throws into the caller", () => {
  const s = seed();
  s.close();
  assert.doesNotThrow(() => {
    s.recordContextInjection(mkEvent({ id: "e-after-close" }));
  }, "a writer failure must not propagate to the caller");
});

test("getContextInjections is fail-soft — returns [] instead of throwing", () => {
  const s = seed();
  s.close();
  let rows: unknown;
  assert.doesNotThrow(() => { rows = s.getContextInjections(); });
  assert.deepStrictEqual(rows, []);
});

// ── Hash + token helpers ────────────────────────────────────────────────────────

test("hashText is deterministic and 16 hex chars", () => {
  const a = hashText("hello world");
  const b = hashText("hello world");
  assert.strictEqual(a, b);
  assert.match(a, /^[0-9a-f]{16}$/);
});

test("hashText differs for different input", () => {
  assert.notStrictEqual(hashText("a"), hashText("b"));
});

test("hashSnapshot is deterministic for the same JSON-serializable value", () => {
  const snap = { activePaneId: "p1", tierKeys: ["project", "pane"] };
  assert.strictEqual(hashSnapshot(snap), hashSnapshot({ activePaneId: "p1", tierKeys: ["project", "pane"] }));
});

test("hashSnapshot differs when the snapshot differs", () => {
  assert.notStrictEqual(hashSnapshot({ a: 1 }), hashSnapshot({ a: 2 }));
});

test("estimateTokens ceils chars/4", () => {
  assert.strictEqual(estimateTokens(0), 0);
  assert.strictEqual(estimateTokens(1), 1);
  assert.strictEqual(estimateTokens(4), 1);
  assert.strictEqual(estimateTokens(5), 2);
  assert.strictEqual(estimateTokens(400), 100);
});

test("mintContextInjectionEventId returns a non-empty, monotonic, ctxevt-prefixed id", () => {
  const a = mintContextInjectionEventId();
  const b = mintContextInjectionEventId();
  assert.match(a, /^ctxevt-\d+-\d+$/);
  assert.notStrictEqual(a, b);
  const seqA = Number(a.split("-").pop());
  const seqB = Number(b.split("-").pop());
  assert.ok(seqB > seqA, `seq must strictly increase (${seqA} -> ${seqB})`);
});
