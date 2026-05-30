// tests/test_store_core.ts
import { test } from "node:test";
import assert from "node:assert";
import { EVENT_TYPES } from "../src/store/eventTypes";
import { JanusStore } from "../src/store/sqliteStore";

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
