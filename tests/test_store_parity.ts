// tests/test_store_parity.ts
// The remaining Ledger-surface parity the store author deferred (the "Part C"
// analysis): plans / watchRules as live, self-persisting arrays, and the
// archive aliases that match the legacy no-arg / paneId-only signatures the
// server calls. These let server.ts treat JanusStore as a drop-in `manager.ledger`.
import { test } from "node:test";
import assert from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { JanusStore } from "../src/store/sqliteStore";
import type { StoredPane } from "../src/store/types";

function mkPane(id: string, alive: boolean): StoredPane {
  return { pane_id:id, workspace_id:"p1", name:id, runtime_type:"shell",
    tool_preset:"Claude Code", permissions_mode:"Human-in-the-Loop", session_id:"",
    last_known_state: alive ? "Idle" : "Exited", is_busy:false, alive, context_size:0,
    last_status_change_at:null, last_command:null, scrollback_path:null, created_at:0, updated_at:0 };
}
function seed(): JanusStore {
  const s = new JanusStore(":memory:"); s.init();
  s.saveWorkspace({ id:"p1", name:"P1", directory:"", summary:"", key_terms:[], created_at:0, updated_at:0 });
  return s;
}

// ── watchRules / plans as live, self-persisting arrays ──────────────────────

test("watchRules and plans start as empty arrays", () => {
  const s = seed();
  assert.deepEqual(s.watchRules, []);
  assert.deepEqual(s.plans, []);
  s.close();
});

test("watchRules.push persists across a reopen (live-array mutation is durable)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-wr-"));
  const dbPath = path.join(dir, "janus.db");
  const s1 = new JanusStore(dbPath); s1.init();
  s1.watchRules.push({ id: "w1", pattern: "build failed" } as any);
  s1.watchRules.push({ id: "w2", pattern: "tests passed" } as any);
  s1.close();

  const s2 = new JanusStore(dbPath); s2.init();
  assert.equal(s2.watchRules.length, 2);
  assert.equal(s2.watchRules[0].id, "w1");
  s2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("plans.splice persists across a reopen", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-pl-"));
  const dbPath = path.join(dir, "janus.db");
  const s1 = new JanusStore(dbPath); s1.init();
  s1.plans.push({ id: "pl1" } as any, { id: "pl2" } as any);
  const idx = s1.plans.findIndex(p => p.id === "pl1");
  s1.plans.splice(idx, 1);
  s1.close();

  const s2 = new JanusStore(dbPath); s2.init();
  assert.equal(s2.plans.length, 1);
  assert.equal(s2.plans[0].id, "pl2");
  s2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("in-place field mutation on a plan persists (server edits plan.steps in place)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-pe-"));
  const dbPath = path.join(dir, "janus.db");
  const s1 = new JanusStore(dbPath); s1.init();
  s1.plans.push({ id: "pl1", status: "active" } as any);
  const plan = s1.plans.find(p => p.id === "pl1")! as any;
  plan.status = "done";
  s1.persistPlans();        // explicit flush for in-place field edits
  s1.close();

  const s2 = new JanusStore(dbPath); s2.init();
  assert.equal((s2.plans[0] as any).status, "done");
  s2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── archive aliases (legacy signatures the server calls) ────────────────────

test("archiveExitedPanes archives only non-alive panes and returns the count", () => {
  const s = seed();
  s.savePane(mkPane("alive1", true));
  s.savePane(mkPane("dead1", false));
  s.savePane(mkPane("dead2", false));
  const n = s.archiveExitedPanes("p1");
  assert.equal(n, 2);
  assert.equal(Object.keys(s.getPanes("p1")).length, 1);   // alive1 remains
  s.close();
});

test("listArchived() with no arg returns nested ArchivedPane shape across all projects", () => {
  const s = seed();
  s.savePane(mkPane("dead1", false));
  s.archiveExitedPanes();
  const archived = s.listArchived();
  assert.equal(archived.length, 1);
  // legacy nested shape: { pane, project_id, archived_at }
  assert.equal(archived[0].pane.pane_id, "dead1");
  assert.equal(archived[0].project_id, "p1");
  assert.ok(typeof archived[0].archived_at === "string");
  s.close();
});

test("restoreArchivedPane(paneId) brings a pane back without needing a workspaceId", () => {
  const s = seed();
  s.savePane(mkPane("dead1", false));
  s.archiveExitedPanes("p1");
  const entry = s.restoreArchivedPane("dead1");
  assert.ok(entry);
  assert.equal(entry!.pane.pane_id, "dead1");
  assert.equal(Object.keys(s.getPanes("p1")).length, 1);
  assert.equal(s.listArchived().length, 0);
  assert.equal(s.restoreArchivedPane("ghost"), null);
  s.close();
});

test("deleteArchivedPane(paneId) permanently removes and returns a boolean", () => {
  const s = seed();
  s.savePane(mkPane("dead1", false));
  s.archiveExitedPanes("p1");
  assert.equal(s.deleteArchivedPane("dead1"), true);
  assert.equal(s.listArchived().length, 0);
  assert.equal(s.deleteArchivedPane("dead1"), false);  // already gone
  s.close();
});

// ── addNote / addPaneNote: StoredNote-on-success, null-on-missing-target ──────
// The note is a first-class table entity, so success returns the created row
// (callers need its id); a missing project/pane returns null (falsy, so the
// server's `if (ok)` correctly reports "not found" instead of lying).

test("addNote returns the StoredNote on success and null when the project does not exist", () => {
  const s = seed();
  s.savePane(mkPane("t1", true));
  const note = s.addNote("p1", "a real decision");
  assert.ok(note);
  assert.ok(note!.id);                       // success carries the row id
  assert.equal(note!.text, "a real decision");
  assert.equal(s.getNotes({ projectId: "p1" }).length, 1);
  // missing project → null, and nothing written
  assert.equal(s.addNote("ghostproj", "orphan note"), null);
  assert.equal(s.getNotes({ projectId: "ghostproj" }).length, 0);
  s.close();
});

test("addPaneNote returns the StoredNote on success and null when the pane is missing", () => {
  const s = seed();
  s.savePane(mkPane("t1", true));
  const note = s.addPaneNote("p1", "t1", "pane decision");
  assert.ok(note);
  assert.equal(note!.pane_id, "t1");
  assert.equal(s.getNotes({ projectId: "p1", paneId: "t1" }).length, 1);
  // missing pane (project exists) → null; missing project → null
  assert.equal(s.addPaneNote("p1", "ghostpane", "orphan"), null);
  assert.equal(s.addPaneNote("ghostproj", "t1", "orphan"), null);
  assert.equal(s.getNotes({ projectId: "p1" }).filter(n => n.text === "orphan").length, 0);
  s.close();
});

// ── save() / updatePane() — Ledger-parity methods the manager calls ─────────

test("save() is a no-op the manager can call (store auto-persists per mutation)", () => {
  const s = seed();
  s.savePane(mkPane("t1", true));
  // Should not throw with either signature the manager uses.
  s.save(true);
  s.save(false);
  s.save();
  assert.equal(Object.keys(s.getPanes("p1")).length, 1);
  s.close();
});

test("updatePane writes a PaneMeta through to the panes table", () => {
  const s = seed();
  const meta = {
    pane_id: "t1", name: "renamed", alive: true, last_known_state: "Running",
    is_busy: true, session_id: "sess-9", context_size: 42,
    tool_preset: "Codex", permissions_mode: "Full Auto", runtime_type: "shell",
    notes: [], last_command: "npm run dev",
  } as any;
  s.updatePane("p1", meta, false);
  const p = s.getPanes("p1")["t1"];
  assert.ok(p, "pane should now exist");
  assert.equal(p.name, "renamed");
  assert.equal(p.is_busy, true);
  assert.equal(p.session_id, "sess-9");
  assert.equal(p.tool_preset, "Codex");
  s.close();
});

// bead 8sq (schema v4): per-pane capability-gate override round-trips through updatePane → getProject
// (was SILENTLY DROPPED before — the panes table had no capability_gates column / hydrate path).
test("updatePane persists per-pane capabilityGates and getProject hydrates it (durable across reopen)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-pg-"));
  const dbPath = path.join(dir, "janus.db");
  const s1 = new JanusStore(dbPath); s1.init();
  s1.saveWorkspace({ id: "p1", name: "P1", directory: "", summary: "", key_terms: [], created_at: 0, updated_at: 0 });
  const meta = {
    pane_id: "t1", name: "t1", alive: true, last_known_state: "Idle", is_busy: false,
    session_id: "", context_size: 0, tool_preset: "Custom", permissions_mode: "Full Auto",
    runtime_type: "shell", notes: [], capabilityGates: { write_to_pane: "Off", close_pane: "Ask" },
  } as any;
  s1.updatePane("p1", meta, false);
  s1.close();

  // Reopen: the override must hydrate from the persisted column.
  const s2 = new JanusStore(dbPath); s2.init();
  const pane = s2.getProject("p1")?.panes["t1"];
  assert.deepEqual(pane?.capabilityGates, { write_to_pane: "Off", close_pane: "Ask" }, "override hydrated after reopen");

  // Clearing the override (undefined) erases the column rather than leaving a stale value.
  s2.updatePane("p1", { ...meta, capabilityGates: undefined }, false);
  const cleared = s2.getProject("p1")?.panes["t1"];
  assert.strictEqual(cleared?.capabilityGates, undefined, "cleared override hydrates as undefined");
  s2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
