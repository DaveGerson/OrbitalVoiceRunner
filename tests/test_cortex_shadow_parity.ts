// tests/test_cortex_shadow_parity.ts — the PARITY lock for Inc 4 slice 1 (invariants I-P1..I-P3).
// The cortex SHADOW observer must be totally invisible: the injected brief (synthesizeAsync) is
// byte-identical whether the cortex is absent, returns a decision, throws, or is unavailable; and
// observeCortexShadow NEVER throws and NEVER blocks. synthesizeAsync is not modified by this slice,
// so parity holds by construction — these tests freeze that property against future regressions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryService, DEFAULT_MEMORY_CONFIG } from "../src/memory";
import type { PythonCortexClient, CortexResult } from "../src/memory/cortexClient";

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────
/** Build a counting cortex client. `count.n` increments on each `decide` call. */
function countingCortex(count: { n: number }): PythonCortexClient {
  return {
    available: () => true,
    decide: async (): Promise<CortexResult> => {
      count.n += 1;
      return {
        ok: true, decision: { keep: ["frame"], drop: [], rerank: [] },
        trace: { cortexVersion: "0.1.0", strategy: "baseline-identity", ruleFired: "baseline-identity",
          inputs: { activePaneId: "p1", sessionId: null, trigger: "brief-inject", tierKeys: ["frame"], tierChars: { frame: 1 } },
          output: { orderedKeep: ["frame"], dropped: [] }, ts: 0 },
      };
    },
  };
}

const TIERS: any = { project: null, pane: null, board: [], frame: { role: "Janus", gatePosture: "Auto", prefs: [] }, breadcrumbs: [] };
// A fake WorldModel: synthesizeAsync + observeCortexShadow both call this.wm.getTiers(activeId, now).
const fakeWm: any = { getTiers: () => TIERS };

function svc(cortex?: PythonCortexClient, quietWindowMs?: number): MemoryService {
  // no pythonClient ⇒ synthesizeAsync uses the deterministic in-process fallback (assembleBrief).
  return new MemoryService(fakeWm, DEFAULT_MEMORY_CONFIG, undefined, 150, cortex, quietWindowMs);
}

const cortexOk: PythonCortexClient = {
  available: () => true,
  decide: async (): Promise<CortexResult> => ({
    ok: true, decision: { keep: ["frame"], drop: [], rerank: [] },
    trace: { cortexVersion: "0.1.0", strategy: "baseline-identity", ruleFired: "baseline-identity",
      inputs: { activePaneId: "p1", sessionId: null, trigger: "brief-inject", tierKeys: ["frame"], tierChars: { frame: 1 } },
      output: { orderedKeep: ["frame"], dropped: [] }, ts: 0 },
  }),
};
const cortexThrows: any = { available: () => true, decide: () => { throw new Error("boom"); } };
const cortexRejects: any = { available: () => true, decide: () => Promise.reject(new Error("boom")) };
const cortexDown: any = { available: () => false, decide: () => { throw new Error("must not be called"); } };

test("I-P1: injected brief is identical with cortex present vs absent", async () => {
  const baseline = await svc().synthesizeAsync("p1", 0);
  const withCortex = await svc(cortexOk).synthesizeAsync("p1", 0);
  assert.deepEqual(withCortex, baseline);
});

test("I-P2: observeCortexShadow never throws (ok / throw / reject / unavailable)", () => {
  assert.doesNotThrow(() => svc(cortexOk).observeCortexShadow("p1", 0));
  assert.doesNotThrow(() => svc(cortexThrows).observeCortexShadow("p1", 0));
  assert.doesNotThrow(() => svc(cortexRejects).observeCortexShadow("p1", 0));
  assert.doesNotThrow(() => svc(cortexDown).observeCortexShadow("p1", 0));
  assert.doesNotThrow(() => svc().observeCortexShadow("p1", 0)); // no client at all
});

test("I-P3: a throwing/rejecting cortex does not perturb the brief", async () => {
  const baseline = await svc().synthesizeAsync("p1", 0);
  const s = svc(cortexThrows);
  s.observeCortexShadow("p1", 0);
  assert.deepEqual(await s.synthesizeAsync("p1", 0), baseline);
});

test("I-P2b: observeCortexShadow returns synchronously (void, non-blocking)", () => {
  const r = svc(cortexOk).observeCortexShadow("p1", 0);
  assert.equal(r, undefined);
});

// ── B-6 hysteresis tests ─────────────────────────────────────────────────────────────────────────

test("B-6: back-to-back identical snapshot within window calls decide exactly once", () => {
  // Use a large quietWindowMs so the second call is definitely within the window.
  const count = { n: 0 };
  const s = svc(countingCortex(count), 10_000);
  s.observeCortexShadow("p1", 0);   // first call: fires
  s.observeCortexShadow("p1", 100); // same tiers, 100 ms later, well within 10 s window → suppressed
  // Promises are micro-tasks; yield to let them settle before asserting.
  return new Promise<void>((resolve) => setImmediate(() => {
    assert.equal(count.n, 1, "decide must be called exactly once for back-to-back identical snapshots");
    resolve();
  }));
});

test("B-6: different snapshot within window fires a second decide call", () => {
  const count = { n: 0 };
  const TIERS2: any = { ...TIERS, frame: { role: "Janus", gatePosture: "Ask", prefs: [] } };
  const fakeWm2: any = {
    getTiers: (_id: unknown, _now: unknown) => count.n === 0 ? TIERS : TIERS2,
  };
  const s = new MemoryService(fakeWm2, DEFAULT_MEMORY_CONFIG, undefined, 150, countingCortex(count), 10_000);
  s.observeCortexShadow("p1", 0);   // fires → count = 1, hash of TIERS stored
  s.observeCortexShadow("p1", 100); // different snapshot → fires → count = 2
  return new Promise<void>((resolve) => setImmediate(() => {
    assert.equal(count.n, 2, "decide must fire again when the snapshot changes");
    resolve();
  }));
});

test("B-6: same hash after window expiry fires again", () => {
  // quietWindowMs = 200; second call at t=300 (300 > 200) → fires.
  const count = { n: 0 };
  const s = svc(countingCortex(count), 200);
  s.observeCortexShadow("p1", 0);   // fires (t=0)
  s.observeCortexShadow("p1", 300); // same hash, t=300, elapsed=300 > 200 ms → fires
  return new Promise<void>((resolve) => setImmediate(() => {
    assert.equal(count.n, 2, "decide must re-fire after the quiet window expires");
    resolve();
  }));
});
