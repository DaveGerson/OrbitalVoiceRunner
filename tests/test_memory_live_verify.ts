/**
 * tests/test_memory_live_verify.ts — P0b live-verify harness (.2.8)
 *
 * Automated near-live coverage for the injection path. Three assertions:
 *   A1  synthesizeAsync returns source==="python" with a non-empty brief.text for a populated
 *       active pane when a real Python daemon is reachable.
 *   A2  Latest-wins predicate (I3): briefIsForActivePane matches same-pane and rejects stale.
 *   A3  Silent fallback: MemoryService WITHOUT a python client resolves to source==="fallback"
 *       and NEVER throws.
 *
 * Tests that require a Python interpreter SKIP cleanly when none is discoverable.
 * The one residual manual step is documented in docs/runbooks/p0b-live-verify.md.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import {
  MemoryService,
  briefIsForActivePane,
  createMemoryService,
  createPythonSynthClient,
  WorldModel,
  discoverPythonInterpreter,
  DEFAULT_MEMORY_CONFIG,
} from "../src/memory";
import type { MemoryTiers } from "../src/memory/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function haveInterpreter(): boolean {
  for (const c of discoverPythonInterpreter(process.env, process.platform)) {
    if (spawnSync(c.cmd, [...c.baseArgs, "--version"], { stdio: "ignore" }).status === 0) return true;
  }
  return false;
}

/** Busy-poll until the client is ready or the deadline passes. */
async function waitReady(client: { available(): boolean }, maxMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (!client.available() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  return client.available();
}

/** Minimal WorldModel stand-in: returns a static MemoryTiers with a populated active pane. */
function buildWm(): { getTiers: (activePaneId: string | null, now: number) => MemoryTiers } {
  const FRAME = { role: "Janus", gatePosture: "Auto", prefs: [] };
  const TIERS: MemoryTiers = {
    project: {
      projectId: "live-test-proj",
      name: "Janus Live Test",
      summary: "A real-world Gemini Live voice session orchestrator.",
      keyTerms: ["pane", "voice"],
      recentDecisions: [],
    },
    pane: {
      paneId: "pane-a",
      name: "shell-1",
      runtimeType: "bash",
      status: "Running",
      lastCommand: "npm test",
      recent: ["all tests pass"],
    },
    board: [{ paneId: "pane-a", name: "shell-1", status: "Running" }],
    frame: FRAME,
    breadcrumbs: [{ ts: Date.now() - 1000, paneId: "pane-a", text: "tests ran ok" }],
  };
  return { getTiers: () => TIERS };
}

// ---------------------------------------------------------------------------
// A1 — real Python daemon: synthesizeAsync returns source==="python"
// ---------------------------------------------------------------------------

test(
  "A1: real python daemon: synthesizeAsync returns source==='python' with non-empty brief",
  { skip: !haveInterpreter() && "no Python interpreter found — skipping daemon round-trip" },
  async () => {
    const client = createPythonSynthClient({
      moduleDir: process.cwd(),
      repoRoot: process.cwd(),
      // Generous timeouts: cold-start on a loaded Windows box can exceed 1 s.
      pingTimeoutMs: 10_000,
      requestExpiryMs: 10_000,
    });

    try {
      const ready = await waitReady(client, 12_000);
      assert.equal(ready, true, "python daemon must respond to the ping handshake within 12 s");

      const wm = buildWm() as any;
      const svc = new MemoryService(wm, DEFAULT_MEMORY_CONFIG, client, 10_000);
      const brief = await svc.synthesizeAsync("pane-a", Date.now());

      assert.equal(brief.source, "python", "source must be 'python' when the daemon is available");
      assert.ok(brief.text.length > 0, "brief.text must be non-empty");
      // The assembler always leads with the active pane section.
      assert.ok(
        brief.text.includes("ACTIVE PANE") || brief.text.includes("shell-1"),
        "brief.text must reference the active pane",
      );
      assert.ok(
        brief.text.length <= DEFAULT_MEMORY_CONFIG.totalBudgetChars,
        "brief must respect the total budget (I7)",
      );
    } finally {
      client.dispose();
    }
  },
);

// ---------------------------------------------------------------------------
// A2 — latest-wins predicate (I3): briefIsForActivePane
// ---------------------------------------------------------------------------

test("A2: briefIsForActivePane — latest-wins invariant (I3)", () => {
  // The brief was computed for pane-a and the active pane is still pane-a → injectable.
  assert.equal(
    briefIsForActivePane("pane-a", "pane-a"),
    true,
    "same pane: brief is injectable",
  );

  // User switched to pane-b mid-flight → brief is STALE and must NOT be injected.
  assert.equal(
    briefIsForActivePane("pane-a", "pane-b"),
    false,
    "pane switch mid-flight: brief must be discarded",
  );

  // Null/null: no active pane → still consistent.
  assert.equal(briefIsForActivePane(null, null), true);

  // Brief has a pane but focus has moved to null (all panes closed) → stale.
  assert.equal(briefIsForActivePane("pane-a", null), false);

  // No brief pane but focus arrived → stale.
  assert.equal(briefIsForActivePane(null, "pane-a"), false);
});

// ---------------------------------------------------------------------------
// A3 — silent fallback: MemoryService without a python client
// ---------------------------------------------------------------------------

test("A3: MemoryService without python client resolves to source==='fallback' and never throws", async () => {
  const wm = buildWm() as any;

  // Path 1: no pythonClient argument at all.
  const svc1 = new MemoryService(wm, DEFAULT_MEMORY_CONFIG);
  const b1 = await svc1.synthesizeAsync("pane-a", Date.now());
  assert.equal(b1.source, "fallback", "no-client path must resolve fallback");
  assert.ok(b1.text.length > 0, "fallback must produce a non-empty in-process brief");
  assert.equal(b1.activePaneId, "pane-a");

  // Path 2: pythonClient explicitly unavailable (available() returns false).
  let requestCalled = false;
  const unavailableClient = {
    available: () => false,
    synthesizerState: () => "fallback" as const,
    request: () => { requestCalled = true; return Promise.resolve({ ok: false as const }); },
    dispose: () => {},
  };
  const svc2 = new MemoryService(wm, DEFAULT_MEMORY_CONFIG, unavailableClient, 50);
  const b2 = await svc2.synthesizeAsync("pane-a", Date.now());
  assert.equal(b2.source, "fallback", "unavailable client must fall through to fallback");
  assert.equal(requestCalled, false, "request must NOT be called when client is unavailable");

  // Path 3: createMemoryService factory without a pythonClient.
  const created = createMemoryService(
    {
      manager: {
        activeId: "pane-a",
        terminals: {
          "pane-a": { name: "shell-1", runtimeType: "bash", status: "Running", lastCommand: "ls" },
        },
        ledger: { activeProjectId: null },
        settings: { globalPermissionsMode: "Auto" },
        listPanes: () => [],
      },
      store: { getProject: () => null, getProjectBriefing: () => null },
      redact: (s: string) => s,
    },
    DEFAULT_MEMORY_CONFIG,
    // no pythonClient
  );
  const b3 = await created.service.synthesizeAsync("pane-a", Date.now());
  assert.equal(b3.source, "fallback", "createMemoryService with no python client must fallback");

  // Path 4: getTiers itself throws — last-resort floor must absorb it and resolve.
  const throwingWm: any = { getTiers: () => { throw new Error("simulated world model failure"); } };
  const svc4 = new MemoryService(throwingWm, DEFAULT_MEMORY_CONFIG);
  const b4 = await svc4.synthesizeAsync("pane-a", Date.now());
  assert.equal(b4.source, "fallback", "floor brief must survive a throwing WorldModel");
  assert.equal(b4.activePaneId, "pane-a");
});
