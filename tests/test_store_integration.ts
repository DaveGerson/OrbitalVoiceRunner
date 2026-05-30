import { test } from "node:test";
import assert from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { JanusStore } from "../src/store/sqliteStore";

test("pending approvals + resumption token survive a 'restart' (reopen same file)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-"));
  const dbPath = path.join(dir, "janus.db");
  const s1 = new JanusStore(dbPath); s1.init();
  s1.insertPendingApproval({ id:"a1", session_id:"s1", workspace_id:"p1", pane_id:"t1",
    command:"npm test", kind:"agent_instruction", rationale:null, claimed:false, timestamp:1, expires_at: 9_999_999_999_999 });
  s1.setKV("lastSessionResumptionToken", "tok-123");
  s1.close();
  const s2 = new JanusStore(dbPath); s2.init();
  assert.equal(s2.getPendingApprovals("s1").length, 1);
  assert.equal(s2.getKV("lastSessionResumptionToken"), "tok-123");
  s2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function freshStore(): { s: JanusStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-"));
  const s = new JanusStore(path.join(dir, "janus.db"));
  s.init();
  return { s, dir };
}

test("Ledger shim: activeProjectId getter/setter is kv-backed and survives reopen", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-"));
  const dbPath = path.join(dir, "janus.db");
  const s1 = new JanusStore(dbPath); s1.init();
  assert.equal(s1.activeProjectId, null);
  s1.activeProjectId = "p1";
  assert.equal(s1.activeProjectId, "p1");
  s1.close();
  const s2 = new JanusStore(dbPath); s2.init();
  assert.equal(s2.activeProjectId, "p1");
  s2.activeProjectId = null;
  assert.equal(s2.activeProjectId, null);
  s2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Ledger shim: switchContext only switches to existing projects", () => {
  const { s, dir } = freshStore();
  s.switchContext("ghost");                 // no such project -> no-op
  assert.equal(s.activeProjectId, null);
  s.addProject("p1", "/tmp/p1", "first", ["alpha"]);
  s.switchContext("p1");
  assert.equal(s.activeProjectId, "p1");
  s.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Ledger shim: getProjectBriefing returns exact legacy shape", () => {
  const { s, dir } = freshStore();
  s.addProject("p1", "/tmp/p1", "a summary", ["alpha", "beta"]);
  s.savePane({
    pane_id: "t1", workspace_id: "p1", name: "Pane One", runtime_type: "terminal",
    tool_preset: "Custom", permissions_mode: "Human-in-the-Loop", session_id: "sess1",
    last_known_state: "Running", is_busy: false, alive: true, context_size: 0,
    last_status_change_at: null, last_command: "ls", scrollback_path: null,
    created_at: Date.now(), updated_at: Date.now(),
  });
  s.addNote("p1", "project note");
  s.addPaneNote("p1", "t1", "pane note");

  const b = s.getProjectBriefing("p1")!;
  assert.deepEqual(Object.keys(b).sort(),
    ["directory", "key_codebase_terms", "notes", "panes", "project_id", "summary"]);
  assert.equal(b.project_id, "p1");
  assert.equal(b.summary, "a summary");
  assert.equal(b.directory, "/tmp/p1");
  assert.deepEqual(b.key_codebase_terms, ["alpha", "beta"]);
  // project-scoped notes only (pane notes excluded), as string[]
  assert.deepEqual(b.notes, ["project note"]);
  assert.equal(b.panes.length, 1);
  const pane = b.panes[0];
  assert.equal(pane.pane_id, "t1");
  assert.equal(pane.name, "Pane One");
  assert.equal(pane.alive, true);
  assert.deepEqual(pane.notes, ["pane note"]);   // legacy PaneMeta.notes: string[]
  assert.equal(s.getProjectBriefing("nope"), null);
  s.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Ledger shim: getProject / getActiveProject / workspaces legacy shape", () => {
  const { s, dir } = freshStore();
  assert.equal(s.getProject("p1"), null);
  s.addProject("p1", "/tmp/p1", "sum", ["k"]);
  s.addProject("p2", "/tmp/p2");
  const ws = s.getProject("p1")!;
  assert.deepEqual(Object.keys(ws).sort(),
    ["directory", "id", "keyTerms", "name", "notes", "panes", "summary"]);
  assert.equal(ws.id, "p1");
  assert.deepEqual(ws.notes, []);
  assert.deepEqual(ws.panes, {});
  assert.deepEqual(ws.keyTerms, ["k"]);
  assert.equal(s.getActiveProject(), null);
  s.switchContext("p2");
  assert.equal(s.getActiveProject()!.id, "p2");
  assert.deepEqual(Object.keys(s.workspaces).sort(), ["p1", "p2"]);
  s.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Ledger shim: addProject is idempotent, renameProject / renamePane mutate", () => {
  const { s, dir } = freshStore();
  s.addProject("p1", "/tmp/p1", "orig");
  s.addProject("p1", "/tmp/other", "should-not-overwrite");
  assert.equal(s.getProject("p1")!.directory, "/tmp/p1");
  assert.equal(s.getProject("p1")!.summary, "orig");
  s.renameProject("p1", "Renamed");
  assert.equal(s.getProject("p1")!.name, "Renamed");
  s.savePane({
    pane_id: "t1", workspace_id: "p1", name: "old", runtime_type: "terminal",
    tool_preset: "Custom", permissions_mode: "Human-in-the-Loop", session_id: "s",
    last_known_state: "Running", is_busy: false, alive: true, context_size: 0,
    last_status_change_at: null, last_command: null, scrollback_path: null,
    created_at: Date.now(), updated_at: Date.now(),
  });
  s.renamePane("p1", "t1", "new-name");
  assert.equal(s.getProject("p1")!.panes["t1"].name, "new-name");
  s.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
