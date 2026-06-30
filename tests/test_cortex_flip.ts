// tests/test_cortex_flip.ts — B-1: THE CORTEX FLIP. synthesizeAsync goes cortex-PRIMARY (the cortex
// curates which tiers survive) behind setCortexPrimary (default OFF). The full-tier synth/assembler
// path is the fail-closed floor. These are the load-bearing locks the flip-PR merge gate signs off on:
//   • OFF (default): synthesizeAsync is BYTE-IDENTICAL to today — the parity guarantee (test a).
//   • ON happy path: the brief is filtered to the cortex's `keep` list; source === "cortex-primary".
//   • FAIL-CLOSED: on cortex miss / timeout / ok:false / unavailable, the FULL-tier floor is used.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { MemoryService, DEFAULT_MEMORY_CONFIG } from "../src/memory";
import { assembleBrief } from "../src/memory/assembler";
import {
  setCortexPrimary,
  isCortexPrimary,
  resolveWithCortex,
  getCortexFallbackStats,
  resetCortexFallbackStats,
} from "../src/memory/cortexShadow";
import type { PythonCortexClient, CortexResult } from "../src/memory/cortexClient";
import type { MemoryTiers } from "../src/memory/types";

// A non-trivial five-field tiers object so keep-list filtering is OBSERVABLE in the rendered brief.
const TIERS: MemoryTiers = {
  project: { projectId: "proj", name: "Janus", summary: "the orchestrator", keyTerms: ["pty"], recentDecisions: ["ship it"] },
  pane: { paneId: "p1", name: "main", runtimeType: "claude", status: "Running", lastCommand: "ls", recent: ["ok"] },
  board: [{ paneId: "p1", name: "main", status: "Running" }],
  frame: { role: "Janus", gatePosture: "Auto", prefs: ["terse"] },
  breadcrumbs: [{ ts: 0, paneId: "p1", text: "did a thing" }],
};
const fakeWm: any = { getTiers: () => TIERS };

function svc(cortex?: PythonCortexClient, pythonClient?: any): MemoryService {
  return new MemoryService(fakeWm, DEFAULT_MEMORY_CONFIG, pythonClient, 150, cortex);
}

function cortexKeeping(keep: string[]): PythonCortexClient {
  return {
    available: () => true,
    decide: async (): Promise<CortexResult> => ({
      ok: true,
      decision: { keep, drop: [], rerank: [] },
      trace: { cortexVersion: "0.1.0", strategy: "baseline-identity", ruleFired: "baseline-identity",
        inputs: { activePaneId: "p1", sessionId: null, trigger: "brief-inject", tierKeys: keep, tierChars: {} },
        output: { orderedKeep: keep, dropped: [] }, ts: 0 },
    }),
  };
}
const cortexHangs: PythonCortexClient = { available: () => true, decide: () => new Promise(() => {}) };
const cortexFails: PythonCortexClient = { available: () => true, decide: async () => ({ ok: false }) };
const cortexDown: PythonCortexClient = { available: () => false, decide: async () => { throw new Error("must not be called"); } };

// Reset the process-wide module state after every test so the flag/counters never bleed across cases.
afterEach(() => { setCortexPrimary(false); resetCortexFallbackStats(); });

// ── (a) THE PARITY GUARANTEE: flag OFF ⇒ byte-identical to today ────────────────────────────────────
test("(a) flag OFF: synthesizeAsync is byte-identical to the full-tier floor (parity)", async () => {
  // Cortex present but flag OFF: the cortex branch must NOT fire. Output equals the no-cortex baseline.
  const baseline = await svc().synthesizeAsync("p1", 0);
  const withCortexOff = await svc(cortexKeeping(["frame"])).synthesizeAsync("p1", 0);
  assert.deepEqual(withCortexOff, baseline);
  // And equal to the raw assembler over the FULL tiers (the literal "today" path).
  assert.deepEqual(baseline, assembleBrief(TIERS, DEFAULT_MEMORY_CONFIG, 0));
});

// ── (b) ON happy path: keep-list filters the brief ──────────────────────────────────────────────────
test("(b) flag ON, keep=[project,frame] ⇒ brief contains ONLY those blocks", async () => {
  setCortexPrimary(true);
  const brief = await svc(cortexKeeping(["project", "frame"])).synthesizeAsync("p1", 0);
  assert.equal(brief.source, "cortex-primary");
  // PROJECT + FRAME present; PANE / BOARD / RECENTLY (breadcrumbs) dropped.
  assert.ok(brief.text.includes("PROJECT Janus"), "project kept");
  assert.ok(brief.text.includes("FRAME Janus"), "frame kept");
  assert.ok(!brief.text.includes("ACTIVE PANE"), "pane dropped");
  assert.ok(!brief.text.includes("BOARD"), "board dropped");
  assert.ok(!brief.text.includes("RECENTLY"), "breadcrumbs dropped");
  assert.deepEqual(Object.keys(brief.perTierChars).sort(), ["frame", "project"]);
});

test("(e) source === 'cortex-primary' on the happy path", async () => {
  setCortexPrimary(true);
  const brief = await svc(cortexKeeping(["frame"])).synthesizeAsync("p1", 0);
  assert.equal(brief.source, "cortex-primary");
});

// ── (c) cortex timeout ⇒ full-tier floor ────────────────────────────────────────────────────────────
test("(c) flag ON, cortex times out ⇒ full-tier synthesis floor (no hang, source NOT cortex-primary)", async () => {
  setCortexPrimary(true, 30); // 30ms budget
  const t0 = Date.now();
  const brief = await svc(cortexHangs).synthesizeAsync("p1", 0);
  const dt = Date.now() - t0;
  assert.notEqual(brief.source, "cortex-primary");
  // Full-tier floor: identical text to the no-cortex baseline (every block present).
  assert.deepEqual(brief.text, (await svc().synthesizeAsync("p1", 0)).text);
  assert.ok(dt < 500, `must fall to the floor near the 30ms budget, not hang (took ${dt}ms)`);
});

// ── (d) cortex primary + synth daemon also down ⇒ TS assembleBrief floor ────────────────────────────
test("(d) flag ON, cortex ok:false AND no synth daemon ⇒ TS assembleBrief floor", async () => {
  setCortexPrimary(true);
  const brief = await svc(cortexFails).synthesizeAsync("p1", 0);
  assert.equal(brief.source, "fallback");
  assert.deepEqual(brief, assembleBrief(TIERS, DEFAULT_MEMORY_CONFIG, 0));
});

test("(f) flag ON, cortex ok:false ⇒ floor (full tiers), source fallback", async () => {
  setCortexPrimary(true);
  const brief = await svc(cortexFails).synthesizeAsync("p1", 0);
  assert.notEqual(brief.source, "cortex-primary");
  assert.deepEqual(brief.text, assembleBrief(TIERS, DEFAULT_MEMORY_CONFIG, 0).text);
});

test("flag ON but cortex unavailable ⇒ existing path (no cortex branch), full tiers", async () => {
  setCortexPrimary(true);
  const brief = await svc(cortexDown).synthesizeAsync("p1", 0);
  assert.notEqual(brief.source, "cortex-primary");
  assert.deepEqual(brief.text, assembleBrief(TIERS, DEFAULT_MEMORY_CONFIG, 0).text);
});

// ── (g) frame is structurally always kept ───────────────────────────────────────────────────────────
test("(g) keep WITHOUT frame ⇒ frame still rendered (structural, never dropped)", async () => {
  setCortexPrimary(true);
  const brief = await svc(cortexKeeping(["project"])).synthesizeAsync("p1", 0);
  assert.equal(brief.source, "cortex-primary");
  assert.ok(brief.text.includes("FRAME Janus"), "frame is structural — always kept regardless of keep list");
  assert.ok(brief.text.includes("PROJECT Janus"), "project kept");
  assert.ok(!brief.text.includes("ACTIVE PANE"), "pane dropped");
});

// ── (h) flag setter / getter round-trips ────────────────────────────────────────────────────────────
test("(h) isCortexPrimary reflects the flag (and resetting works)", () => {
  setCortexPrimary(true);
  assert.equal(isCortexPrimary(), true);
  setCortexPrimary(false);
  assert.equal(isCortexPrimary(), false);
});

// ── resolveWithCortex helper: direct unit coverage of the race + filter ─────────────────────────────
test("resolveWithCortex: ok ⇒ filtered MemoryTiers (kept tiers retain value, dropped nulled)", async () => {
  const filtered = await resolveWithCortex(TIERS, { activePaneId: "p1", sessionId: null, trigger: "brief-inject" }, 0, cortexKeeping(["project"]), 100);
  assert.ok(filtered);
  assert.equal(filtered!.project, TIERS.project);
  assert.equal(filtered!.pane, null);
  assert.deepEqual(filtered!.board, []);
  assert.deepEqual(filtered!.breadcrumbs, []);
  assert.equal(filtered!.frame, TIERS.frame); // structural — always kept
});

test("resolveWithCortex: timeout ⇒ null (caller uses full-tier floor)", async () => {
  const filtered = await resolveWithCortex(TIERS, { activePaneId: "p1", sessionId: null, trigger: "x" }, 0, cortexHangs, 20);
  assert.equal(filtered, null);
});

test("resolveWithCortex: ok:false ⇒ null", async () => {
  const filtered = await resolveWithCortex(TIERS, { activePaneId: "p1", sessionId: null, trigger: "x" }, 0, cortexFails, 100);
  assert.equal(filtered, null);
});

// ── B-4 sub-task: cortexFallbackRate counter (warm-up-immune) ────────────────────────────────────────
test("B-4 counter: a happy-path decide ⇒ fallbackRate 0; a post-up miss ⇒ rate climbs", async () => {
  const ctx = { activePaneId: "p1", sessionId: null, trigger: "brief-inject" };
  // First a SUCCESS (firstUp). fallbackRate stays 0.
  await resolveWithCortex(TIERS, ctx, 0, cortexKeeping(["frame"]), 100);
  assert.equal(getCortexFallbackStats().fallbackRate, 0);
  // Now a miss AFTER first-up ⇒ counts toward the rate.
  await resolveWithCortex(TIERS, ctx, 0, cortexFails, 100);
  assert.ok(getCortexFallbackStats().fallbackRate > 0, "post-first-up miss must count toward fallbackRate");
});

test("B-4 counter: a miss BEFORE the first success is warm-up (not counted)", async () => {
  const ctx = { activePaneId: "p1", sessionId: null, trigger: "brief-inject" };
  // Cold-start miss: no successful decide yet ⇒ warm-up ⇒ rate stays 0 (mirrors daemonStateTracker firstUp).
  await resolveWithCortex(TIERS, ctx, 0, cortexFails, 100);
  assert.equal(getCortexFallbackStats().fallbackRate, 0, "pre-first-up miss is warm-up, not a regression");
});
