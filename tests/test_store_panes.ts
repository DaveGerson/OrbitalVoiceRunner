// tests/test_store_panes.ts
import { test } from "node:test";
import assert from "node:assert";
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
  return s;
}

test("savePane upserts and round-trips booleans", () => {
  const s = seed(); s.savePane(mkPane("t1"));
  const p = s.getPanes("p1")["t1"];
  assert.equal(p.alive, true); assert.equal(p.is_busy, false);
  s.close();
});

test("archivePane removes from live + adds to archive (+event); restorePane brings it back", () => {
  const s = seed(); s.savePane(mkPane("t1"));
  s.archivePane("t1","p1","cleared");
  assert.equal(Object.keys(s.getPanes("p1")).length, 0);
  assert.equal(s.listArchived("p1").length, 1);
  assert.equal(s.getEvents({ type:"pane_archived" }).length, 1);
  const restored = s.restorePane("t1","p1");
  assert.ok(restored);
  assert.equal(Object.keys(s.getPanes("p1")).length, 1);
  s.close();
});

// Phase 2 Track S — CARD 2S.3: the archive round-trip must keep the schema-v4 capability_gates
// column. PINS: better-sqlite3 silently ignores extra named params, so the v1-column-only INSERTs
// in archivePane/restorePane dropped `capability_gates` to NULL through the round-trip — an
// operator's per-pane "Off" override silently reverted to the global default on restore.
test("archive -> restore round-trips the per-pane capability_gates override (2S.3)", () => {
  const s = seed(); s.savePane(mkPane("t1"));
  // Set the override through the same durable path the manager uses (updatePane writes the column).
  s.updatePane("p1", {
    pane_id: "t1", name: "t1", runtime_type: "shell", tool_preset: "Claude Code",
    permissions_mode: "Human-in-the-Loop", session_id: "", last_known_state: "Idle",
    is_busy: false, alive: true, context_size: 0, notes: [],
    capabilityGates: { close_pane: "Off", write_to_pane: "Ask" },
  } as any);
  // Sanity: the LIVE row carries the override before archiving.
  assert.deepEqual(
    s.getProject("p1")!.panes["t1"].capabilityGates,
    { close_pane: "Off", write_to_pane: "Ask" },
    "live pane carries the override pre-archive",
  );

  s.archivePane("t1", "p1", "cleared");
  // The ARCHIVED row keeps the override (archivePane INSERT lists capability_gates).
  const archived = s.listArchived("p1");
  assert.equal(archived.length, 1);
  assert.deepEqual(
    (archived[0].pane as any).capabilityGates,
    { close_pane: "Off", write_to_pane: "Ask" },
    "archived pane keeps the capability_gates override",
  );

  const restored = s.restorePane("t1", "p1");
  assert.ok(restored);
  // The RESTORED live row keeps the override (restorePane INSERT lists capability_gates) —
  // the operator's per-pane "Off" must NOT silently revert on restore.
  assert.deepEqual(
    s.getProject("p1")!.panes["t1"].capabilityGates,
    { close_pane: "Off", write_to_pane: "Ask" },
    "restored pane keeps the capability_gates override",
  );
  s.close();
});

// Phase 2 (orchestrator follow-up to 2S.3): the v3 columns — draft, model_context, human_context —
// had NO panes_archive twins until schema v8, so the round-trip silently dropped an operator's
// unsent draft and both context lanes. PINS: v8 ALTERs exist + both INSERTs list the columns.
test("archive -> restore round-trips draft + model/human context (v8)", () => {
  const s = seed(); s.savePane(mkPane("t1"));
  assert.ok(s.setDraft("p1", "t1", "an unsent prompt", "operator"), "draft written");
  assert.ok(s.addModelContext("p1", "t1", "model lane survives", "test"), "model context written");
  assert.ok(s.addHumanContext("p1", "t1", "human lane survives"), "human context written");

  s.archivePane("t1", "p1", "cleared");
  const restored = s.restorePane("t1", "p1");
  assert.ok(restored, "pane restored");

  const draft = s.getDraft("p1", "t1");
  assert.ok(draft, "draft survives the archive round-trip");
  assert.equal(draft!.text, "an unsent prompt", "draft text intact");
  assert.equal(draft!.updatedBy, "operator", "draft author intact");

  const ctx = s.getPaneContext("p1", "t1");
  assert.equal(ctx.model.length, 1, "model context survives");
  assert.equal(ctx.model[0].text, "model lane survives");
  assert.equal(ctx.human.length, 1, "human context survives");
  assert.equal(ctx.human[0].text, "human lane survives");
  s.close();
});
