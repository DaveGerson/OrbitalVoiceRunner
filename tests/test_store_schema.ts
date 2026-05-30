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
