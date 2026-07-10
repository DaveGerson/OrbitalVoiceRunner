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

// Phase 2 Step 2.5 review fix: a tier with NO budget (weight/cap absent or 0 — e.g. server.ts's
// weights literal, which predates the eventFocus tier) must be ABSENT, not a lone "…" garbage
// block (cap(s, 0) used to render exactly that, and it still claimed a perTierChars entry).
test("a zero/absent-weight tier renders ABSENT, never a lone '…' block", () => {
  const t = tiers();
  t.eventFocus = { paneId: "p2", name: "p2", eventText: "Outcome: build finished", exchangeState: null, waitingReason: null };
  const legacyWeights = { project: 0.40, pane: 0.30, breadcrumbs: 0.15, board: 0.10, frame: 0.05 }; // no eventFocus key
  const a = assembleBrief(t, { ...DEFAULT_MEMORY_CONFIG, weights: legacyWeights }, 1000);
  assert.ok(!("eventFocus" in a.perTierChars), "the zero-budget tier claims no perTierChars entry");
  assert.ok(!a.text.includes("EVENT FOCUS"), "the zero-budget tier renders nothing");
  assert.ok(!a.text.split("\n").includes("…"), "no bare-ellipsis garbage block");
  // With a real weight the SAME tier renders normally (control).
  const b = assembleBrief(t, DEFAULT_MEMORY_CONFIG, 1000);
  assert.ok(b.text.includes("EVENT FOCUS p2: Outcome: build finished"));
});
