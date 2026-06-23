// tests/test_store_drafts.ts
// Parity coverage for the prompt-composer refactor's per-pane Workbench drafts
// and layered pane context, reproduced on JanusStore so server.ts can switch
// `manager.ledger` to the durable store without behavior change.
// Semantics mirror src/ledger.ts exactly (getDraft/setDraft/appendDraft/listDrafts,
// addModelContext/addHumanContext/getPaneContext).
import { test } from "node:test";
import assert from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { JanusStore } from "../src/store/sqliteStore";
import type { StoredPane } from "../src/store/types";

function mkPane(id: string): StoredPane {
  return { pane_id:id, workspace_id:"p1", name:id, runtime_type:"shell",
    tool_preset:"Claude Code", permissions_mode:"Human-in-the-Loop", session_id:"",
    last_known_state:"Idle", is_busy:false, alive:true, context_size:0,
    last_status_change_at:null, last_command:null, scrollback_path:null, created_at:0, updated_at:0 };
}
function seed(): JanusStore {
  const s = new JanusStore(":memory:"); s.init();
  s.saveWorkspace({ id:"p1", name:"P1", directory:"", summary:"", key_terms:[], created_at:0, updated_at:0 });
  s.savePane(mkPane("t1"));
  return s;
}

// ── Drafts (the Workbench) ──────────────────────────────────────────────────

test("getDraft returns null for a pane with no draft", () => {
  const s = seed();
  assert.equal(s.getDraft("p1", "t1"), null);
  s.close();
});

test("setDraft replaces text and round-trips PaneDraft shape; updatedBy is preserved", () => {
  const s = seed();
  assert.equal(s.setDraft("p1", "t1", "first cut", "operator"), true);
  const d = s.getDraft("p1", "t1");
  assert.ok(d);
  assert.equal(d!.text, "first cut");
  assert.equal(d!.updatedBy, "operator");
  // l1c: updatedAt is a real, parseable timestamp — assert it parses to a valid Date, not merely
  // that it is a non-empty string (a bogus "x" would pass length>0 but is not a timestamp).
  assert.ok(typeof d!.updatedAt === "string", "updatedAt is a string");
  assert.ok(!Number.isNaN(Date.parse(d!.updatedAt)), `updatedAt must parse as a date, got ${JSON.stringify(d!.updatedAt)}`);
  // replace, not append
  s.setDraft("p1", "t1", "second cut", "janus");
  assert.equal(s.getDraft("p1", "t1")!.text, "second cut");
  assert.equal(s.getDraft("p1", "t1")!.updatedBy, "janus");
  s.close();
});

test("appendDraft newline-joins onto existing text, or seeds when empty", () => {
  const s = seed();
  assert.equal(s.appendDraft("p1", "t1", "line one", "janus"), true);
  assert.equal(s.getDraft("p1", "t1")!.text, "line one");
  s.appendDraft("p1", "t1", "line two", "janus");
  assert.equal(s.getDraft("p1", "t1")!.text, "line one\nline two");
  s.close();
});

test("setDraft / appendDraft return false when the pane does not exist", () => {
  const s = seed();
  assert.equal(s.setDraft("p1", "ghost", "x"), false);
  assert.equal(s.appendDraft("p1", "ghost", "x"), false);
  assert.equal(s.setDraft("ghostproj", "t1", "x"), false);
  s.close();
});

test("listDrafts returns only panes with a non-empty trimmed draft", () => {
  const s = seed();
  s.savePane({ ...mkPane("t2"), pane_id: "t2" });
  s.savePane({ ...mkPane("t3"), pane_id: "t3" });
  s.setDraft("p1", "t1", "real work", "operator");
  s.setDraft("p1", "t2", "   ", "operator");   // whitespace-only → excluded
  // t3 has no draft at all → excluded
  const list = s.listDrafts("p1");
  assert.equal(list.length, 1);
  assert.equal(list[0].paneId, "t1");
  assert.equal(list[0].draft.text, "real work");
  s.close();
});

test("drafts survive a reopen of the same DB file (durability)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-draft-"));
  const dbPath = path.join(dir, "janus.db");
  const s1 = new JanusStore(dbPath); s1.init();
  s1.saveWorkspace({ id:"p1", name:"P1", directory:"", summary:"", key_terms:[], created_at:0, updated_at:0 });
  s1.savePane(mkPane("t1"));
  s1.setDraft("p1", "t1", "persist me", "operator");
  s1.close();

  const s2 = new JanusStore(dbPath); s2.init();
  assert.equal(s2.getDraft("p1", "t1")!.text, "persist me");
  s2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Layered pane context (prompt-composer refactor §4) ──────────────────────

test("getPaneContext returns empty layers for a fresh pane, null for a missing one", () => {
  const s = seed();
  const ctx = s.getPaneContext("p1", "t1");
  assert.ok(ctx);
  assert.deepEqual(ctx!.model, []);
  assert.deepEqual(ctx!.human, []);
  assert.deepEqual(ctx!.legacy, []);
  assert.equal(s.getPaneContext("p1", "ghost"), null);
  s.close();
});

test("addModelContext appends timestamped entries with an optional source", () => {
  const s = seed();
  assert.equal(s.addModelContext("p1", "t1", "orientation A", "synthesizer"), true);
  assert.equal(s.addModelContext("p1", "t1", "orientation B"), true);
  const ctx = s.getPaneContext("p1", "t1")!;
  assert.equal(ctx.model.length, 2);
  assert.equal(ctx.model[0].text, "orientation A");
  assert.equal(ctx.model[0].source, "synthesizer");
  // l1c: the `at` field is a real parseable timestamp, not just any non-empty string.
  assert.ok(typeof ctx.model[0].at === "string", "model[0].at is a string");
  assert.ok(!Number.isNaN(Date.parse(ctx.model[0].at)), `model[0].at must parse as a date, got ${JSON.stringify(ctx.model[0].at)}`);
  assert.equal(ctx.model[1].text, "orientation B");
  assert.equal(ctx.model[1].source, undefined);
  // human layer untouched
  assert.deepEqual(ctx.human, []);
  s.close();
});

test("addHumanContext appends to the human layer only", () => {
  const s = seed();
  assert.equal(s.addHumanContext("p1", "t1", "operator steering"), true);
  const ctx = s.getPaneContext("p1", "t1")!;
  assert.equal(ctx.human.length, 1);
  assert.equal(ctx.human[0].text, "operator steering");
  assert.deepEqual(ctx.model, []);
  s.close();
});

test("addModelContext / addHumanContext return false when the pane is missing", () => {
  const s = seed();
  assert.equal(s.addModelContext("p1", "ghost", "x"), false);
  assert.equal(s.addHumanContext("ghostproj", "t1", "x"), false);
  s.close();
});

test("getPaneContext.legacy surfaces the pane's flat notes (nothing lost on migration)", () => {
  const s = seed();
  s.addPaneNote("p1", "t1", "old flat note");
  const ctx = s.getPaneContext("p1", "t1")!;
  assert.ok(ctx.legacy.includes("old flat note"));
  s.close();
});

test("context survives a reopen of the same DB file (durability)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-ctx-"));
  const dbPath = path.join(dir, "janus.db");
  const s1 = new JanusStore(dbPath); s1.init();
  s1.saveWorkspace({ id:"p1", name:"P1", directory:"", summary:"", key_terms:[], created_at:0, updated_at:0 });
  s1.savePane(mkPane("t1"));
  s1.addModelContext("p1", "t1", "remembered", "handoff");
  s1.close();

  const s2 = new JanusStore(dbPath); s2.init();
  const ctx = s2.getPaneContext("p1", "t1")!;
  assert.equal(ctx.model[0].text, "remembered");
  assert.equal(ctx.model[0].source, "handoff");
  s2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
