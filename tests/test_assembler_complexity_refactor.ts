// Pins CURRENT observable behavior of assembleBrief before/after the CC<=10
// extraction refactor. Every tier branch + truncation + ternary edge is exercised
// so the refactor is provably behavior-preserving.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleBrief } from "../src/memory/assembler";
import { DEFAULT_MEMORY_CONFIG, type MemoryTiers, type MemoryConfig } from "../src/memory/types";

function fullTiers(): MemoryTiers {
  return {
    project: {
      projectId: "proj",
      name: "Janus",
      summary: "voice orchestrator",
      keyTerms: ["pty", "gemini"],
      recentDecisions: ["chose stdio seam", "d2", "d3", "d4"],
    },
    pane: {
      paneId: "p1",
      name: "p1",
      runtimeType: "interactive_cli",
      status: "Running",
      lastCommand: "npm test",
      recent: ["r1", "r2", "r3", "r4", "r5"],
    },
    board: [
      { paneId: "p1", name: "p1", status: "Running" },
      { paneId: "p2", name: "p2", status: "Idle" },
    ],
    frame: { role: "Janus orchestrator", gatePosture: "Human-in-the-Loop", prefs: ["dark mode", "terse"] },
    breadcrumbs: [
      { ts: 1, paneId: "p2", text: "was on p2: ran build" },
      { ts: 2, paneId: "p1", text: "switched to p1" },
    ],
  };
}

function emptyTiers(): MemoryTiers {
  return {
    project: null,
    pane: null,
    board: [],
    frame: { role: "solo", gatePosture: "Auto", prefs: [] },
    breadcrumbs: [],
  };
}

const big: MemoryConfig = { ...DEFAULT_MEMORY_CONFIG, totalBudgetChars: 100000 };

test("full tiers: exact text golden (every block present, ordered)", () => {
  const a = assembleBrief(fullTiers(), big, 1000);
  const expected = [
    "PROJECT Janus: voice orchestrator | terms: pty, gemini | decisions: chose stdio seam; d2; d3",
    "ACTIVE PANE p1 (Running, interactive_cli) last: npm test | recent: r1; r2; r3; r4",
    "RECENTLY: was on p2: ran build · switched to p1",
    "BOARD: p1=Running, p2=Idle",
    "FRAME Janus orchestrator | gates: Human-in-the-Loop | prefs: dark mode; terse",
  ].join("\n");
  assert.equal(a.text, expected);
  assert.equal(a.activePaneId, "p1");
  assert.equal(a.source, "fallback");
  assert.deepEqual(a.perTierChars, {
    project: 92,
    pane: 81,
    breadcrumbs: 47,
    board: 26,
    frame: 77,
  });
});

test("decisions capped at 3 and recent capped at 4", () => {
  const a = assembleBrief(fullTiers(), big, 0);
  assert.match(a.text, /decisions: chose stdio seam; d2; d3$/m);
  assert.doesNotMatch(a.text, /d4/);
  assert.match(a.text, /recent: r1; r2; r3; r4$/m);
  assert.doesNotMatch(a.text, /r5/);
});

test("project block: empty keyTerms and empty decisions omit those segments", () => {
  const t = fullTiers();
  t.project!.keyTerms = [];
  t.project!.recentDecisions = [];
  const a = assembleBrief(t, big, 0);
  assert.match(a.text, /^PROJECT Janus: voice orchestrator$/m);
  assert.doesNotMatch(a.text, /terms:/);
  assert.doesNotMatch(a.text, /decisions:/);
});

test("pane block: null lastCommand and empty recent omit those segments", () => {
  const t = fullTiers();
  t.pane!.lastCommand = null;
  t.pane!.recent = [];
  const a = assembleBrief(t, big, 0);
  assert.match(a.text, /^ACTIVE PANE p1 \(Running, interactive_cli\)$/m);
  assert.doesNotMatch(a.text, /last:/);
  assert.doesNotMatch(a.text, /pane.*recent:/);
});

test("frame block: empty prefs omits prefs segment", () => {
  const a = assembleBrief(emptyTiers(), big, 0);
  assert.equal(a.text, "FRAME solo | gates: Auto");
  assert.doesNotMatch(a.text, /prefs:/);
});

test("empty tiers: only FRAME block, perTierChars only frame, activePaneId null", () => {
  const a = assembleBrief(emptyTiers(), big, 0);
  assert.equal(a.text, "FRAME solo | gates: Auto");
  assert.equal(a.activePaneId, null);
  assert.equal(a.source, "fallback");
  assert.deepEqual(a.perTierChars, { frame: "FRAME solo | gates: Auto".length });
});

test("only project present", () => {
  const t = emptyTiers();
  t.project = { projectId: "x", name: "N", summary: "S", keyTerms: [], recentDecisions: [] };
  const a = assembleBrief(t, big, 0);
  assert.equal(a.text, "PROJECT N: S\nFRAME solo | gates: Auto");
});

test("only breadcrumbs + board present (no project/pane)", () => {
  const t = emptyTiers();
  t.breadcrumbs = [{ ts: 1, paneId: null, text: "hello" }];
  t.board = [{ paneId: "p1", name: "p1", status: "Idle" }];
  const a = assembleBrief(t, big, 0);
  assert.equal(a.text, "RECENTLY: hello\nBOARD: p1=Idle\nFRAME solo | gates: Auto");
});

test("truncation: project slice capped, ellipsis appended", () => {
  const t = fullTiers();
  t.project!.summary = "x".repeat(10000);
  const cfg: MemoryConfig = { ...DEFAULT_MEMORY_CONFIG, totalBudgetChars: 400 };
  const a = assembleBrief(t, cfg, 1000);
  const slice = Math.floor(400 * cfg.weights.project); // 160
  assert.equal(a.perTierChars.project, slice);
  const projectLine = a.text.split("\n")[0];
  assert.equal(projectLine.length, slice);
  assert.ok(projectLine.endsWith("…"));
});

test("cap is exact-length passthrough when within budget", () => {
  // FRAME block with generous budget is untouched (no ellipsis)
  const a = assembleBrief(emptyTiers(), big, 0);
  assert.ok(!a.text.includes("…"));
});

test("activePaneId mirrors active pane id when pane present", () => {
  const t = fullTiers();
  t.pane!.paneId = "zzz";
  const a = assembleBrief(t, big, 0);
  assert.equal(a.activePaneId, "zzz");
});

test("deterministic across calls and ignores _now arg", () => {
  const a = assembleBrief(fullTiers(), big, 1);
  const b = assembleBrief(fullTiers(), big, 999999);
  assert.equal(a.text, b.text);
  assert.deepEqual(a.perTierChars, b.perTierChars);
});
