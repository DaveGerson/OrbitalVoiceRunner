// tests/test_cortex_csw.ts — CSW (cortex shadow work) tests for wsm-e2e-pinned-csw bead.
//
// Three invariants verified here:
//   1. primary + cortex-hit  → decide() called EXACTLY ONCE (not by observeCortexShadow);
//      row has applied:true and the threaded injectId.
//   2. primary + cortex-miss → synthesizeAsync returns the in-process floor WITHOUT calling the
//      synth-daemon (the +150ms synth race is skipped).
//   3. flag OFF              → observeCortexShadow still records applied:false; synthesizeAsync
//      still races the synth daemon; brief byte-identical to no-cortex baseline.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { MemoryService, DEFAULT_MEMORY_CONFIG } from "../src/memory";
import type { CortexDecisionSinkRow } from "../src/memory";
import { assembleBrief } from "../src/memory/assembler";
import {
  setCortexPrimary,
  resetCortexFallbackStats,
} from "../src/memory/cortexShadow";
import type { PythonCortexClient, CortexResult } from "../src/memory/cortexClient";
import type { MemoryTiers } from "../src/memory/types";
import type { PythonSynthClient, SynthesizeResult } from "../src/memory/pythonClient";

// ── shared fixtures ────────────────────────────────────────────────────────────

const TIERS: MemoryTiers = {
  project: { projectId: "proj", name: "Janus", summary: "the orchestrator", keyTerms: ["pty"], recentDecisions: ["ship it"] },
  pane: { paneId: "p1", name: "main", runtimeType: "claude", status: "Running", lastCommand: "ls", recent: ["ok"] },
  board: [{ paneId: "p1", name: "main", status: "Running" }],
  frame: { role: "Janus", gatePosture: "Auto", prefs: ["terse"] },
  breadcrumbs: [{ ts: 0, paneId: "p1", text: "did a thing" }],
};
const fakeWm: any = { getTiers: () => TIERS };

/** Flush microtasks so fire-and-forget .then() callbacks settle before asserting. */
function flushMicrotasks(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/** A decisionSink spy that collects rows. */
function decisionSink(): { rows: CortexDecisionSinkRow[]; fn: (r: CortexDecisionSinkRow) => void } {
  const rows: CortexDecisionSinkRow[] = [];
  return { rows, fn: (r) => { rows.push(r); } };
}

/** cortex client that counts decide() calls and returns ok:true for the given keep list. */
function countingCortexKeeping(keep: string[], count: { n: number }): PythonCortexClient {
  return {
    available: () => true,
    decide: async (): Promise<CortexResult> => {
      count.n += 1;
      return {
        ok: true,
        decision: { keep, drop: [], rerank: [] },
        trace: {
          cortexVersion: "0.1.0",
          strategy: "baseline-identity",
          ruleFired: "baseline-identity",
          inputs: { activePaneId: "p1", sessionId: null, trigger: "brief-inject", tierKeys: keep, tierChars: {} },
          output: { orderedKeep: keep, dropped: [] },
          ts: 0,
        },
      };
    },
  };
}

/** cortex client that counts calls but always returns ok:false (miss). */
function countingCortexMiss(count: { n: number }): PythonCortexClient {
  return {
    available: () => true,
    decide: async (): Promise<CortexResult> => {
      count.n += 1;
      return { ok: false };
    },
  };
}

/** A synth daemon client that counts request() calls. */
function countingSynthClient(count: { n: number }): PythonSynthClient {
  return {
    available: () => true,
    synthesizerState: () => "python",
    request: async (): Promise<SynthesizeResult> => {
      count.n += 1;
      return { ok: true, brief: { text: "SYNTH", perTierChars: { frame: 5 }, activePaneId: "p1" } };
    },
    dispose: () => {},
  };
}

/** Build a MemoryService with the given clients and an optional decision sink. */
function svc(
  cortex?: PythonCortexClient,
  pythonClient?: PythonSynthClient,
  sink?: (r: CortexDecisionSinkRow) => void,
): MemoryService {
  // quietWindowMs=0 so hysteresis never suppresses (clean per-test isolation)
  return new MemoryService(fakeWm, DEFAULT_MEMORY_CONFIG, pythonClient, 150, cortex, 0, sink);
}

afterEach(() => {
  setCortexPrimary(false);
  resetCortexFallbackStats();
});

// ── Test 1: primary + cortex-hit: decide() called ONCE, applied:true with injectId ───────────────

test("CSW-1: primary + cortex-hit: decide() called exactly once; record has applied:true and injectId", async () => {
  setCortexPrimary(true);
  const cortexCallCount = { n: 0 };
  const sink = decisionSink();
  const cortex = countingCortexKeeping(["project", "frame"], cortexCallCount);
  const service = svc(cortex, undefined, sink.fn);

  const injectId = "inj-csw-test-1";
  // observeCortexShadow must be suppressed when primary (no double-decide)
  service.observeCortexShadow("p1", 0, "brief-inject", injectId);
  // synthesizeAsync drives the primary path (decide + record applied:true)
  const brief = await service.synthesizeAsync("p1", 0, injectId);

  // decide() must be called exactly once (by the primary path in synthesizeAsync only)
  assert.equal(cortexCallCount.n, 1, "decide() must be called exactly once across the inject");

  // The brief must come from cortex-primary
  assert.equal(brief.source, "cortex-primary");

  // Flush microtasks so the fire-and-forget in observeCortexShadow (if it ran) can settle
  await flushMicrotasks();

  // Exactly one record must be written (by the primary path, applied:true)
  assert.equal(sink.rows.length, 1, "exactly one decision row must be written");
  const row = sink.rows[0];
  assert.equal(row.applied, true, "primary path must write applied:true");
  assert.equal(row.injectId, injectId, "injectId must be threaded to the decision row");
});

// ── Test 2: primary + cortex-miss: synth daemon NOT called; brief = in-process floor ─────────────

test("CSW-2: primary + cortex-miss: synth daemon is NOT called; brief equals the in-process floor", async () => {
  setCortexPrimary(true);
  const cortexCallCount = { n: 0 };
  const synthCallCount = { n: 0 };
  const cortex = countingCortexMiss(cortexCallCount);
  const synthClient = countingSynthClient(synthCallCount);
  const service = svc(cortex, synthClient);

  const brief = await service.synthesizeAsync("p1", 0, "inj-csw-test-2");
  const floorBrief = assembleBrief(TIERS, DEFAULT_MEMORY_CONFIG, 0);

  // The synth daemon (which would add +150ms) must NOT be called on a primary+miss path
  assert.equal(synthCallCount.n, 0, "synth daemon client.request() must NOT be called on primary+miss");

  // The brief text must equal the in-process floor
  assert.equal(brief.text, floorBrief.text, "brief must be byte-equal to the in-process floor");
});

// ── Test 3: flag OFF: observeCortexShadow records applied:false; synth race runs; parity ─────────

test("CSW-3: flag OFF: observeCortexShadow records applied:false; synth race runs; brief byte-identical to baseline", async () => {
  // flag OFF (the default — setCortexPrimary(false) is redundant but explicit)
  setCortexPrimary(false);

  const cortexCallCount = { n: 0 };
  const synthCallCount = { n: 0 };
  const sink = decisionSink();
  const cortex = countingCortexKeeping(["frame"], cortexCallCount);
  const synthClient = countingSynthClient(synthCallCount);
  const service = svc(cortex, synthClient, sink.fn);

  const injectId = "inj-csw-test-3";
  service.observeCortexShadow("p1", 0, "brief-inject", injectId);
  await flushMicrotasks();

  // When OFF, observeCortexShadow must still run decide() and record applied:false
  assert.equal(sink.rows.length, 1, "observeCortexShadow must still record when flag is OFF");
  assert.equal(sink.rows[0].applied, false, "SHADOW row must be applied:false when flag is OFF");
  assert.equal(sink.rows[0].injectId, injectId);

  // synthesizeAsync must still race the synth daemon when flag is OFF
  const brief = await service.synthesizeAsync("p1", 0, injectId);
  assert.equal(synthCallCount.n, 1, "synth daemon must be called when flag is OFF");

  // Brief must be byte-identical to the no-cortex baseline
  const baseline = await new MemoryService(fakeWm, DEFAULT_MEMORY_CONFIG).synthesizeAsync("p1", 0);
  // source will differ (python vs fallback) since synthClient returns "SYNTH"; check that the
  // flag-OFF path doesn't filter tiers (parity with the pre-cortex path via text content matching
  // when no synth daemon is present)
  const floorBrief = assembleBrief(TIERS, DEFAULT_MEMORY_CONFIG, 0);
  // With synthClient returning "SYNTH", brief will be python source — that's expected.
  // The key invariant: the brief is NOT filtered by cortex (cortex flag is OFF).
  // Verify parity: a service with no cortex but same synth client returns identical brief.
  const synthCallCount2 = { n: 0 };
  const synthClient2 = countingSynthClient(synthCallCount2);
  const baselineWithSynth = await new MemoryService(fakeWm, DEFAULT_MEMORY_CONFIG, synthClient2, 150).synthesizeAsync("p1", 0);
  assert.deepEqual(brief, baselineWithSynth, "flag OFF brief must be identical to no-cortex baseline with same synth client");

  // Also verify that the no-synth-daemon baseline equals the in-process floor
  assert.deepEqual(baseline, floorBrief, "no-cortex/no-synth baseline must equal the in-process floor");
});
