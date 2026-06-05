import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createPythonSynthClient, discoverPythonInterpreter } from "../src/memory/pythonClient";
import { DEFAULT_MEMORY_CONFIG, type MemoryTiers } from "../src/memory/types";

function haveInterpreter(): boolean {
  for (const c of discoverPythonInterpreter(process.env, process.platform)) {
    if (spawnSync(c.cmd, [...c.baseArgs, "--version"], { stdio: "ignore" }).status === 0) return true;
  }
  return false;
}

const FRAME = { role: "Janus", gatePosture: "Human-in-the-Loop", prefs: ["terse"] };
const TIERS: MemoryTiers = {
  project: { projectId: "x", name: "Janus", summary: "A voice orchestrator. It runs panes.", keyTerms: ["pane"], recentDecisions: [] },
  pane: { paneId: "p1", name: "build", runtimeType: "claude", status: "Running", lastCommand: "npm test", recent: ["ok"] },
  board: [{ paneId: "p1", name: "build", status: "Running" }], frame: FRAME, breadcrumbs: [{ ts: 1, paneId: "p1", text: "ran tests" }],
};

function delay(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

test("real python daemon: ping + one synthesize round-trip → python brief, budget respected", { skip: !haveInterpreter() && "no Python interpreter found" }, async () => {
  const client = createPythonSynthClient({ moduleDir: process.cwd(), repoRoot: process.cwd() });
  // wait for the eager ping handshake to land
  for (let i = 0; i < 50 && !client.available(); i++) await delay(20);
  assert.equal(client.available(), true, "daemon should be available after the ping handshake");

  const res = await client.request(TIERS, DEFAULT_MEMORY_CONFIG, 1733443200000);
  assert.equal(res.ok, true, "synthesize round-trip should succeed");
  if (res.ok) {
    assert.ok(res.brief.text.includes("ACTIVE PANE build"));
    assert.ok(res.brief.text.length <= DEFAULT_MEMORY_CONFIG.totalBudgetChars, "budget respected (I7)");
    assert.equal(res.brief.activePaneId, "p1");
  }
  client.dispose();
});
