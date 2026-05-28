import assert from "assert";
import { OrchestratorManager } from "../src/terminal";
import fs from "fs";

async function runTests() {
  console.log("Running OrchestratorManager tests...");
  const manager = new OrchestratorManager();
  
  // 1. Test addition
  console.log("Testing terminal addition...");
  manager.addTerminal("test1", ".", "echo hello");
  assert.ok(manager.terminals["test1"], "Terminal test1 should have been added");
  
  // 2. Test ledger sync logic (Running to Idle transition)
  console.log("Testing ledger synchronization for Running -> Idle status change...");
  const term = manager.terminals["test1"];
  
  // Set terminal to Running first
  term.status = "Running";
  (manager as any).syncLedger();
  let defaultProject = manager.ledger.getProject(term.projectId || "default_project");
  let paneMeta = defaultProject?.panes["test1"];
  assert.strictEqual(paneMeta?.last_known_state, "Running active command", "Pane state should be 'Running active command'");
  assert.strictEqual(paneMeta?.is_busy, true, "Pane should be marked busy");

  // Change terminal status to Idle
  term.status = "Idle";
  (manager as any).syncLedger();
  defaultProject = manager.ledger.getProject(term.projectId || "default_project");
  paneMeta = defaultProject?.panes["test1"];
  assert.strictEqual(paneMeta?.last_known_state, "Idle", "Pane state should be 'Idle' after transition");
  assert.strictEqual(paneMeta?.is_busy, false, "Pane should not be marked busy when Idle");

  
  // 3. Test removing/stopping
  console.log("Testing terminal removal...");
  if (term) {
    term.stop();
    delete manager.terminals["test1"];
  }
  assert.ok(!manager.terminals["test1"], "Terminal test1 should have been removed");
  
  console.log("OrchestratorManager tests passed.");
}

runTests().catch(err => {
  console.error("Test failed", err);
  process.exit(1);
});
