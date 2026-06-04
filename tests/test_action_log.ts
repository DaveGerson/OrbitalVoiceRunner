// tests/test_action_log.ts
// PLM2 store layer: the action_log table + recordAction/getActionLog read/write API (schema v6).
import { test } from "node:test";
import assert from "node:assert";
import Database from "better-sqlite3";
import { applyMigrations, SCHEMA_VERSION } from "../src/store/schema";
import { JanusStore } from "../src/store/sqliteStore";

test("migration v6 creates action_log and bumps user_version", () => {
  const db = new Database(":memory:");
  applyMigrations(db);
  const names = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table'"
  ).all() as any[]).map(r => r.name);
  assert.ok(names.includes("action_log"), "action_log table should exist");
  assert.ok(SCHEMA_VERSION >= 6, "SCHEMA_VERSION should be at least 6");
  assert.equal(db.pragma("user_version", { simple: true }), SCHEMA_VERSION);

  // The idempotency_key index (PLM4 replay-detection seam) must be present.
  const indexes = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index'"
  ).all() as any[]).map(r => r.name);
  assert.ok(indexes.includes("idx_action_log_idempotency_key"), "idempotency_key should be indexed");
  db.close();
});

test("recordAction inserts a row, store-stamping ts; getActionLog reads it back", () => {
  const s = new JanusStore(":memory:"); s.init();
  const before = Date.now();
  s.recordAction({ name: "create_pane", capability: "spawn_pane", result_kind: "ok", ms: 12 });
  const after = Date.now();

  const rows = s.getActionLog();
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.name, "create_pane");
  assert.equal(r.capability, "spawn_pane");
  assert.equal(r.result_kind, "ok");
  assert.equal(r.ms, 12);
  assert.ok(typeof r.id === "number" && r.id > 0, "id should be an autoincrement PK");
  assert.ok(r.ts >= before && r.ts <= after, "ts should be store-stamped at insert");
  // Optional columns default to null.
  assert.equal(r.args_redacted, null);
  assert.equal(r.surface, null);
  assert.equal(r.idempotency_key, null);
  s.close();
});

test("recordAction persists the optional args_redacted / surface / idempotency_key columns", () => {
  const s = new JanusStore(":memory:"); s.init();
  s.recordAction({
    name: "send_input",
    capability: "send_pane_input",
    result_kind: "deferred",
    ms: 3,
    args_redacted: JSON.stringify({ text: "[REDACTED]" }),
    surface: "voice",
    idempotency_key: "idem-123",
  });
  const r = s.getActionLog()[0];
  assert.equal(r.args_redacted, JSON.stringify({ text: "[REDACTED]" }));
  assert.equal(r.surface, "voice");
  assert.equal(r.idempotency_key, "idem-123");
  s.close();
});

test("getActionLog returns rows newest-first", () => {
  const s = new JanusStore(":memory:"); s.init();
  s.recordAction({ name: "a", capability: "cap_a", result_kind: "ok", ms: 1 });
  s.recordAction({ name: "b", capability: "cap_b", result_kind: "ok", ms: 1 });
  s.recordAction({ name: "c", capability: "cap_c", result_kind: "ok", ms: 1 });

  const rows = s.getActionLog();
  assert.equal(rows.length, 3);
  // Most-recent-first: insertion order a,b,c → read order c,b,a (deterministic via id DESC).
  assert.deepEqual(rows.map(r => r.name), ["c", "b", "a"]);
  s.close();
});

test("getActionLog filters by name", () => {
  const s = new JanusStore(":memory:"); s.init();
  s.recordAction({ name: "create_pane", capability: "spawn_pane", result_kind: "ok", ms: 1 });
  s.recordAction({ name: "send_input", capability: "send_pane_input", result_kind: "ok", ms: 1 });
  s.recordAction({ name: "create_pane", capability: "spawn_pane", result_kind: "error", ms: 1 });

  const rows = s.getActionLog({ name: "create_pane" });
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => r.name === "create_pane"));
  // Still newest-first within the filter.
  assert.deepEqual(rows.map(r => r.result_kind), ["error", "ok"]);
  s.close();
});

test("getActionLog filters by since (ts >= since)", () => {
  const s = new JanusStore(":memory:"); s.init();
  s.recordAction({ name: "old", capability: "c", result_kind: "ok", ms: 1 });
  const cutoff = Date.now() + 1;
  // Force a strictly-later ts on the post-cutoff rows by stamping after the cutoff boundary.
  const rowOld = s.getActionLog({ name: "old" })[0];

  // Backdate the existing row so the `since` filter has a row to exclude regardless of clock resolution.
  s.db.prepare("UPDATE action_log SET ts=? WHERE id=?").run(cutoff - 100, rowOld.id);
  s.recordAction({ name: "new1", capability: "c", result_kind: "ok", ms: 1 });
  s.recordAction({ name: "new2", capability: "c", result_kind: "ok", ms: 1 });
  // Ensure the two new rows are >= cutoff.
  s.db.prepare("UPDATE action_log SET ts=? WHERE name IN ('new1','new2')").run(cutoff + 50);

  const rows = s.getActionLog({ since: cutoff });
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => r.ts >= cutoff));
  assert.ok(rows.every(r => r.name !== "old"));
  s.close();
});

test("getActionLog respects an explicit limit (and defaults to 100)", () => {
  const s = new JanusStore(":memory:"); s.init();
  for (let i = 0; i < 5; i++) {
    s.recordAction({ name: `n${i}`, capability: "c", result_kind: "ok", ms: i });
  }
  const limited = s.getActionLog({ limit: 2 });
  assert.equal(limited.length, 2);
  // Newest-first: n4, n3.
  assert.deepEqual(limited.map(r => r.name), ["n4", "n3"]);
  // No limit → all 5 (well under the default 100).
  assert.equal(s.getActionLog().length, 5);
  s.close();
});
