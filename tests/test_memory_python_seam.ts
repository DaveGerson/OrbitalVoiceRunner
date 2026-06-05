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
  // Generous timeouts: this is a REAL process spawn that runs amid the full parallel test suite,
  // where a loaded Windows box can take >1s for python cold-start + handshake. The pingTimeout is
  // raised so the candidate-iteration logic doesn't prematurely advance off a slow-but-healthy
  // daemon, and requestExpiry so a busy round-trip still resolves. None of this changes prod
  // behavior (prod uses the defaults via the server wiring) — it only de-flakes the integration test.
  const client = createPythonSynthClient({
    moduleDir: process.cwd(), repoRoot: process.cwd(),
    pingTimeoutMs: 10_000, requestExpiryMs: 10_000,
  });
  // wait for the eager ping handshake to land (up to ~6s under suite load)
  for (let i = 0; i < 300 && !client.available(); i++) await delay(20);
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
