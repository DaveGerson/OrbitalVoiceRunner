// tests/test_store_core.ts
import { test } from "node:test";
import assert from "node:assert";
import { EVENT_TYPES } from "../src/store/eventTypes";
import { JanusStore } from "../src/store/sqliteStore";
import type { StoredWorkspace } from "../src/store/types";

test("recordActivity appends an event and applies state mutation atomically", () => {
  const s = new JanusStore(":memory:"); s.init();
  s.recordActivity(
    { type: EVENT_TYPES.PROJECT_CREATED, project_id: "p1", summary: "created p1" },
    (db) => db.prepare(
      "INSERT INTO projects(id,name,directory,summary,key_terms,created_at,updated_at) VALUES(?,?,?,?,?,?,?)"
    ).run("p1","P1","/tmp","",JSON.stringify([]),1,1)
  );
  const ev = s.getEvents({ projectId: "p1" });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, "project_created");
  const proj = s.getWorkspaces()["p1"];
  assert.equal(proj.name, "P1");
  s.close();
});

test("recordActivity rolls back the event if the mutation throws", () => {
  const s = new JanusStore(":memory:"); s.init();
  assert.throws(() => s.recordActivity(
    { type: EVENT_TYPES.PROJECT_CREATED, project_id: "p2", summary: "x" },
    () => { throw new Error("boom"); }
  ));
  assert.equal(s.getEvents({ projectId: "p2" }).length, 0);
  s.close();
});

test("event vocabulary is frozen and complete", () => {
  assert.ok(Object.isFrozen(EVENT_TYPES));
  for (const t of ["command_dispatched","command_outcome","approval_decided",
                   "status_transition","note_added","handoff","permission_changed",
                   "pane_created","pane_archived","pane_restored","project_created","plan_step"]) {
    assert.ok(Object.values(EVENT_TYPES).includes(t as any), `missing event type ${t}`);
  }
});

test("saveWorkspace upserts; addNote writes a normalized row + note_added event", () => {
  const s = new JanusStore(":memory:"); s.init();
  const ws: StoredWorkspace = { id:"p1", name:"P1", directory:"/tmp", summary:"s", key_terms:["a"], created_at:0, updated_at:0 };
  s.saveWorkspace(ws);
  assert.equal(s.getWorkspaces()["p1"].key_terms[0], "a");

  const note = s.addNote("p1", "we chose CJS", { type: "decision", author: "user" });
  const notes = s.getNotes({ projectId: "p1" });
  assert.equal(notes.length, 1);
  assert.equal(notes[0].type, "decision");
  assert.equal(notes[0].id, note.id);
  assert.equal(s.getEvents({ type: "note_added" }).length, 1);
  s.close();
});

test("amendNote and deleteNote keep FTS consistent", () => {
  const s = new JanusStore(":memory:"); s.init();
  s.saveWorkspace({ id:"p1", name:"P1", directory:"", summary:"", key_terms:[], created_at:0, updated_at:0 });
  const n = s.addNote("p1", "rate limiting via token bucket", {});
  s.amendNote(n.id, "rate limiting via leaky bucket");
  assert.equal(s.getNotes({ projectId:"p1" })[0].text, "rate limiting via leaky bucket");
  s.deleteNote(n.id);
  assert.equal(s.getNotes({ projectId:"p1" }).length, 0);
  s.close();
});

test("settings_kv and kv round-trip and upsert", () => {
  const s = new JanusStore(":memory:"); s.init();
  s.saveSettings("voiceAi.voice", "Charon");
  assert.equal(s.getSettings("voiceAi.voice"), "Charon");
  s.saveSettings("voiceAi.voice", "Puck");
  assert.equal(s.getSettings("voiceAi.voice"), "Puck");
  s.setKV("activeProjectId", "p1");
  assert.equal(s.getKV("activeProjectId"), "p1");
  s.deleteKV("activeProjectId");
  assert.equal(s.getKV("activeProjectId"), null);
  s.close();
});
