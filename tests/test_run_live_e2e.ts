// tests/test_run_live_e2e.ts — validates the pure kill-tree + exit-code decisions that make the
// E2E lane wrappers self-cleaning (BEAD wsm-e2e-pinned-rwnq).
//
// These are the load-bearing platform branches: getting the Windows/POSIX split wrong silently
// leaks the webServer child (Windows needs `taskkill /T`; POSIX needs a process-group signal). We
// test them as PURE functions so no real process is ever spawned — mirrors run-unit's decision-table
// style.
//
// Runner: npx tsx --test --test-force-exit tests/test_run_live_e2e.ts

import { test } from "node:test";
import assert from "node:assert";

import { buildKillTreeCommand } from "../scripts/run-live-e2e.mjs";
import { resolveExitCode } from "../scripts/e2eLaneRunner.mjs";

test("buildKillTreeCommand(win32): taskkill with /T tree + /F force semantics", () => {
  const plan = buildKillTreeCommand(1234, "win32");
  assert.deepEqual(plan, { cmd: "taskkill", args: ["/pid", "1234", "/T", "/F"] });
});

test("buildKillTreeCommand(POSIX): null => caller uses process-group signal (process.kill(-pid))", () => {
  assert.equal(buildKillTreeCommand(1234, "linux"), null);
  assert.equal(buildKillTreeCommand(1234, "darwin"), null);
});

test("resolveExitCode: a numeric exit code passes through (including 0)", () => {
  assert.equal(resolveExitCode(0, null), 0);
  assert.equal(resolveExitCode(2, null), 2);
});

test("resolveExitCode: a signal-kill (code null) is NON-ZERO — never a false green", () => {
  // Node reports code:null, signal:'SIGTERM' when the child is killed by the watchdog/external
  // kill. That MUST surface as non-zero so CI cannot read a killed run as passing.
  assert.notEqual(resolveExitCode(null, "SIGTERM"), 0);
  assert.notEqual(resolveExitCode(null, "SIGKILL"), 0);
  assert.notEqual(resolveExitCode(null, null), 0);
});
