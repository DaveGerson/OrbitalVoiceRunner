// Phase 4 Track E — Card 4E.4: the broadcast projection (`workspaces` getter) in one pass.
//
// FINDING (verified): the getter did getProject per id → getPanes per project → getNotes
// per pane (N+1 sync queries) and broadcastLedgerUpdate calls it on ~40 mutation sites.
//
// GOLDEN: this suite is written against the CURRENT per-call implementation first — the
// expected value is assembled exactly the way the old getter did (getProject per id,
// which itself stays the per-call code path). The new batched getter must stay
// deepStrictEqual to it (byte-identical output, including undefined-valued keys), while
// issuing at most THREE queries (projects, panes, notes).

import { test } from "node:test";
import assert from "node:assert";
import { JanusStore } from "../src/store/sqliteStore";
import type { StoredPane } from "../src/store/types";

function mkPane(id: string, ws: string, over: Partial<StoredPane> = {}): StoredPane {
  return {
    pane_id: id, workspace_id: ws, name: `pane ${id}`, runtime_type: "shell",
    tool_preset: "Custom", permissions_mode: "Human-in-the-Loop", session_id: `sess-${id}`,
    last_known_state: "Idle", is_busy: false, alive: true, context_size: 42,
    last_status_change_at: null, last_command: `cmd-${id}`, scrollback_path: null,
    created_at: 0, updated_at: 0, ...over,
  };
}

/** Seed a multi-project / multi-pane / multi-note store with DISTINCT note timestamps. */
function seed(): JanusStore {
  const s = new JanusStore(":memory:"); s.init();
  s.saveWorkspace({ id: "p1", name: "Project One", directory: "/one", summary: "first", key_terms: ["alpha", "beta"], created_at: 1000, updated_at: 1000 });
  s.saveWorkspace({ id: "p2", name: "Project Two", directory: "/two", summary: "", key_terms: [], created_at: 2000, updated_at: 2000 });
  s.saveWorkspace({ id: "p3", name: "Empty", directory: "/three", summary: "no panes", key_terms: [], created_at: 3000, updated_at: 3000 });

  s.savePane(mkPane("t1", "p1"));
  s.savePane(mkPane("t2", "p1", { alive: false, last_known_state: "Exited", is_busy: false }));
  s.savePane(mkPane("t3", "p2", { is_busy: true, last_known_state: "Running" }));

  // Per-pane capability-gate override + draft + layered context ride updatePane.
  s.updatePane("p1", {
    pane_id: "t1", name: "pane t1", alive: true, last_known_state: "Idle", is_busy: false,
    session_id: "sess-t1", context_size: 42, last_command: "cmd-t1", runtime_type: "shell",
    tool_preset: "Custom", permissions_mode: "Human-in-the-Loop",
    capabilityGates: { send_keys: "Off" },
  } as any, false);

  // Notes with explicit, distinct created_at so the legacy ORDER BY created_at DESC is
  // unambiguous (raw inserts mirror addNote's row shape; notes_fts triggers keep up).
  const note = s.db.prepare(
    "INSERT INTO notes(id,project_id,pane_id,text,type,author,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)"
  );
  note.run("n1", "p1", null, "project note one", "note", "user", 10_000, 10_000);
  note.run("n2", "p1", null, "project note two", "note", "janus", 20_000, 20_000);
  note.run("n3", "p1", "t1", "pane t1 note one", "note", "user", 30_000, 30_000);
  note.run("n4", "p1", "t1", "pane t1 note two", "note", "user", 40_000, 40_000);
  note.run("n5", "p1", "t2", "pane t2 note", "note", "user", 50_000, 50_000);
  note.run("n6", "p2", "t3", "pane t3 note", "note", "user", 60_000, 60_000);
  note.run("n7", "p2", null, "p2 project note", "note", "user", 70_000, 70_000);
  // Orphan note (pane gone): legacy projection silently ignores it for panes and
  // excludes it from project notes (it has a pane_id). Must stay invisible.
  note.run("n8", "p1", "gone-pane", "orphan", "note", "user", 80_000, 80_000);
  return s;
}

/** EXACTLY the legacy getter: getProject per id, in projects.created_at order. */
function legacyAssemble(s: JanusStore): Record<string, any> {
  const out: Record<string, any> = {};
  const ids = (s.db.prepare("SELECT id FROM projects ORDER BY created_at").all() as any[]).map(r => r.id);
  for (const id of ids) {
    const ws = s.getProject(id);
    if (ws) out[id] = ws;
  }
  return out;
}

test("golden: workspaces projection deepEquals the legacy per-call assembly", () => {
  const s = seed();
  const expected = legacyAssemble(s);
  const actual = s.workspaces;
  assert.deepStrictEqual(actual, expected, "the batched projection must be byte-identical to the per-call result");
  // Key ORDER matters to consumers serializing the snapshot — pin it explicitly.
  assert.deepStrictEqual(Object.keys(actual), Object.keys(expected));
  assert.deepStrictEqual(Object.keys(actual.p1.panes), Object.keys(expected.p1.panes));
  // Spot-check the interesting shapes survived: note ordering (ASC), gates, empty cases.
  assert.deepStrictEqual(actual.p1.notes, ["project note one", "project note two"]);
  assert.deepStrictEqual(actual.p1.panes.t1.notes, ["pane t1 note one", "pane t1 note two"]);
  assert.deepStrictEqual(actual.p1.panes.t1.capabilityGates, { send_keys: "Off" });
  assert.deepStrictEqual(actual.p3.panes, {});
  assert.deepStrictEqual(actual.p3.notes, []);
  assert.deepStrictEqual(actual.p1.keyTerms, ["alpha", "beta"]);
  s.close();
});

test("workspaces projection issues at most 3 queries (projects, panes, notes)", () => {
  const s = seed();
  const orig = s.db.prepare.bind(s.db);
  let prepares = 0;
  (s.db as any).prepare = (...args: any[]) => { prepares++; return (orig as any)(...args); };
  try {
    void s.workspaces;
  } finally {
    delete (s.db as any).prepare; // restore the prototype method
  }
  assert.ok(prepares <= 3, `broadcast projection must be at most 3 queries, saw ${prepares}`);
  s.close();
});

test("empty store projects to an empty record", () => {
  const s = new JanusStore(":memory:"); s.init();
  assert.deepStrictEqual(s.workspaces, {});
  s.close();
});
