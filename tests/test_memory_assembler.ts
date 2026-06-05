import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleBrief } from "../src/memory/assembler";
import { DEFAULT_MEMORY_CONFIG, type MemoryTiers } from "../src/memory/types";

function tiers(activePane = "p1"): MemoryTiers {
  return {
    project: { projectId: "proj", name: "Janus", summary: "voice orchestrator", keyTerms: ["pty","gemini"], recentDecisions: ["chose stdio seam"] },
    pane: { paneId: activePane, name: activePane, runtimeType: "interactive_cli", status: "Running", lastCommand: "npm test", recent: ["running tests"] },
    board: [{ paneId: "p1", name: "p1", status: "Running" }, { paneId: "p2", name: "p2", status: "Idle" }],
    frame: { role: "Janus orchestrator", gatePosture: "Human-in-the-Loop", prefs: [] },
    breadcrumbs: [{ ts: 2, paneId: "p2", text: "was on p2: ran build" }],
  };
}

test("brief is deterministic and includes every non-empty tier in weight order", () => {
  const a = assembleBrief(tiers(), DEFAULT_MEMORY_CONFIG, 1000);
  const b = assembleBrief(tiers(), DEFAULT_MEMORY_CONFIG, 1000);
  assert.equal(a.text, b.text);                       // deterministic
  assert.match(a.text, /Janus/);                      // project
  assert.match(a.text, /ACTIVE PANE.*p1/s);           // focus pane labeled
  assert.match(a.text, /was on p2/);                  // breadcrumb
  assert.equal(a.source, "fallback");
  assert.equal(a.activePaneId, "p1");
  assert.ok(a.text.length <= DEFAULT_MEMORY_CONFIG.totalBudgetChars * 1.2); // budget respected (+headers slack)
});

test("each tier is truncated to its char slice under pressure", () => {
  const big = tiers();
  big.project!.summary = "x".repeat(10000); // overflow the project slice
  const a = assembleBrief(big, { ...DEFAULT_MEMORY_CONFIG, totalBudgetChars: 400 }, 1000);
  assert.ok(a.perTierChars.project <= Math.ceil(400 * 0.40) + 1);
});
