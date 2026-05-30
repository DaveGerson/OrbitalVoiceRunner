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
