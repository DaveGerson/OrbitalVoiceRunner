import { test } from "node:test";
import assert from "node:assert";
import Database from "better-sqlite3";

test("better-sqlite3 loads and FTS5 is available", () => {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.exec("CREATE VIRTUAL TABLE t USING fts5(x);");
  db.prepare("INSERT INTO t(x) VALUES (?)").run("hello world");
  const row = db.prepare("SELECT x FROM t WHERE t MATCH ?").get("hello") as any;
  assert.equal(row.x, "hello world");
  db.close();
});

import { applyMigrations, SCHEMA_VERSION } from "../src/store/schema";

test("applyMigrations creates all tables, FTS, and sets user_version", () => {
  const db = new Database(":memory:");
  applyMigrations(db);
  const names = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type IN ('table','view')"
  ).all() as any[]).map(r => r.name);
  for (const t of ["events","projects","panes","panes_archive","notes",
                   "pending_approvals","attention","settings_kv","kv",
                   "events_fts","notes_fts"]) {
    assert.ok(names.includes(t), `missing table ${t}`);
  }
  const v = db.pragma("user_version", { simple: true });
  assert.equal(v, SCHEMA_VERSION);
  db.close();
});
