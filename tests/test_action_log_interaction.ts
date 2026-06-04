// tests/test_action_log_interaction.ts — schema v7: action_log gains interaction_id, the join key that
// ties a runAction row back to the operator TURN that caused it (the SQLite half of the correlated
// interaction log; the JSONL half is src/interactionLog.ts).
//
// Runner: npx tsx --test --test-force-exit tests/test_action_log_interaction.ts

import { test } from "node:test";
import assert from "node:assert";
import Database from "better-sqlite3";
import { applyMigrations, SCHEMA_VERSION } from "../src/store/schema";
import { JanusStore } from "../src/store/sqliteStore";

test("schema reaches v7; action_log has an interaction_id column + index", () => {
  const db = new Database(":memory:");
  applyMigrations(db);
  assert.ok(SCHEMA_VERSION >= 7, "SCHEMA_VERSION should be at least 7");
  assert.equal(db.pragma("user_version", { simple: true }), SCHEMA_VERSION);

  const cols = (db.prepare("PRAGMA table_info(action_log)").all() as any[]).map((c) => c.name);
  assert.ok(cols.includes("interaction_id"), "action_log.interaction_id column should exist");

  const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as any[]).map((r) => r.name);
  assert.ok(idx.includes("idx_action_log_interaction_id"), "interaction_id should be indexed");
  db.close();
});

test("recordAction stores interaction_id; getActionLog returns it", () => {
  const s = new JanusStore(":memory:");
  s.init();
  s.recordAction({ name: "propose_command", capability: "write_to_pane", result_kind: "ok", ms: 3, interaction_id: "ixn_42" });
  assert.equal(s.getActionLog()[0].interaction_id, "ixn_42");
  s.close();
});

test("interaction_id defaults to null when omitted (back-compat with existing callers)", () => {
  const s = new JanusStore(":memory:");
  s.init();
  s.recordAction({ name: "list_panes", capability: "read_pane", result_kind: "ok", ms: 1 });
  assert.equal(s.getActionLog()[0].interaction_id, null);
  s.close();
});

test("applyMigrations is idempotent — a re-run neither throws nor re-applies", () => {
  const db = new Database(":memory:");
  applyMigrations(db);
  const v = db.pragma("user_version", { simple: true });
  applyMigrations(db);
  assert.equal(db.pragma("user_version", { simple: true }), v);
  db.close();
});
