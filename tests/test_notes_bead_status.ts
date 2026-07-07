/**
 * tests/test_notes_bead_status.ts — hwu.4 schema v11: the notes `bead_status` marker column and its
 * JanusStore accessors (setNoteBeadStatus / getNote), plus getNotes carrying the column through.
 */
import { test } from "node:test";
import assert from "node:assert";

import { JanusStore } from "../src/store/sqliteStore";
import { applyMigrations, SCHEMA_VERSION } from "../src/store/schema";
import Database from "better-sqlite3";

test("migration v11 adds notes.bead_status and reaches SCHEMA_VERSION", () => {
  const db = new Database(":memory:");
  applyMigrations(db);
  assert.ok(SCHEMA_VERSION >= 11, "SCHEMA_VERSION should be at least 11");
  assert.equal(db.pragma("user_version", { simple: true }), SCHEMA_VERSION);
  const cols = (db.prepare("PRAGMA table_info(notes)").all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(cols.includes("bead_status"), "notes table should have a bead_status column");
  db.close();
});

test("a fresh note has NULL bead_status; setNoteBeadStatus round-trips through getNote + getNotes", () => {
  const s = new JanusStore(":memory:"); s.init();
  s.addProject("p", ".", "proj");
  const note = s.addNote("p", "rotate the signing key before launch", { type: "todo" });
  assert.ok(note, "note should persist");
  const id = (note as { id: string }).id;

  // Default: no marker.
  assert.equal(s.getNote(id)?.bead_status ?? null, null, "a plain note carries no bead_status");
  assert.equal(s.getNotes({ projectId: "p" })[0].bead_status ?? null, null);

  // Proposed → created round-trips.
  s.setNoteBeadStatus(id, "proposed");
  assert.equal(s.getNote(id)?.bead_status, "proposed");
  assert.equal(s.getNotes({ projectId: "p" })[0].bead_status, "proposed", "getNotes carries the marker through");

  s.setNoteBeadStatus(id, "created");
  assert.equal(s.getNote(id)?.bead_status, "created");

  // Deny marker + clear.
  s.setNoteBeadStatus(id, "denied");
  assert.equal(s.getNote(id)?.bead_status, "denied");
  s.setNoteBeadStatus(id, null);
  assert.equal(s.getNote(id)?.bead_status ?? null, null);
  s.close();
});

test("setNoteBeadStatus does not corrupt FTS: the note is still searchable after marking", () => {
  const s = new JanusStore(":memory:"); s.init();
  s.addProject("p", ".", "proj");
  const note = s.addNote("p", "the retry policy needs a backoff cap", { type: "decision" });
  const id = (note as { id: string }).id;
  s.setNoteBeadStatus(id, "proposed");
  const hits = s.search("backoff", { source: "note" });
  assert.ok(hits.some((h) => h.id === id), "note is still found by FTS after the marker UPDATE");
  s.close();
});
