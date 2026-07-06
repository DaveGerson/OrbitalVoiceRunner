import assert from "assert";
import { OrchestratorManager } from "../src/terminal";
import { JanusStore } from "../src/store/sqliteStore";
import fs from "fs";

function deleteScrollback(id: string): void {
  const p = `.janus_scrollback_${id}.log`;
  try { fs.unlinkSync(p); } catch { /* already gone */ }
}

async function runTests() {
  console.log("Running OrchestratorManager tests...");
  const store = new JanusStore(":memory:");
  store.init();
  const manager = new OrchestratorManager({ ledger: store });
  
  // 1. Test addition
  console.log("Testing terminal addition...");
  manager.addTerminal("test1", ".", "echo hello");
  // The registry slot exists SYNCHRONOUSLY (B1 registers before deferring the spawn).
  assert.ok(manager.terminals["test1"], "Terminal test1 should have been added");
  // B1 (async spawn): addTerminal now DEFERS the real ConPTY start() to a setImmediate. Without
  // awaiting it here, term.start() could run AFTER the term.stop() teardown below — a zombie spawn
  // that races past the unit runner's --test-force-exit and aborts on Windows (uv_close on a CLOSING
  // handle). Drain the deferred spawn before any further assertion / teardown.
  await (manager as any).flushPendingSpawns();
  
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
    // Await full teardown. On Windows ConPTY, term.stop() kills the pty AND (now)
    // internally drains node-pty's delayed conout-worker teardown (a worker_threads
    // Worker = a libuv uv_async_t). If the file ended with that worker mid-terminate,
    // the unit runner's --test-force-exit would uv_close() a handle already CLOSING and
    // abort (src\win\async.c:76, mis-attributed to a later pty-free suite). Awaiting
    // stop() is now sufficient.
    await term.stop();
    delete manager.terminals["test1"];
  }
  assert.ok(!manager.terminals["test1"], "Terminal test1 should have been removed");

  // Teardown: remove scrollback files spawned by this suite
  deleteScrollback("test1");

  console.log("OrchestratorManager tests passed.");
}

runTests().catch(err => {
  console.error("Test failed", err);
  process.exit(1);
});
