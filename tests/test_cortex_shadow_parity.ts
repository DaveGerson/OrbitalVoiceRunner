// tests/test_cortex_shadow_parity.ts — the PARITY lock for Inc 4 slice 1 (invariants I-P1..I-P3).
// The cortex SHADOW observer must be totally invisible: the injected brief (synthesizeAsync) is
// byte-identical whether the cortex is absent, returns a decision, throws, or is unavailable; and
// observeCortexShadow NEVER throws and NEVER blocks. synthesizeAsync is not modified by this slice,
// so parity holds by construction — these tests freeze that property against future regressions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryService, DEFAULT_MEMORY_CONFIG } from "../src/memory";
import type { PythonCortexClient, CortexResult } from "../src/memory/cortexClient";

const TIERS: any = { project: null, pane: null, board: [], frame: { role: "Janus", gatePosture: "Auto", prefs: [] }, breadcrumbs: [] };
// A fake WorldModel: synthesizeAsync + observeCortexShadow both call this.wm.getTiers(activeId, now).
const fakeWm: any = { getTiers: () => TIERS };

function svc(cortex?: PythonCortexClient): MemoryService {
  // no pythonClient ⇒ synthesizeAsync uses the deterministic in-process fallback (assembleBrief).
  return new MemoryService(fakeWm, DEFAULT_MEMORY_CONFIG, undefined, 150, cortex);
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
