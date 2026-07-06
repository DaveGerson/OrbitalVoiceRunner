// tests/test_cortex_shadow_parity.ts — Wave 4 D7: the FLOOR invariant, repurposed from the SHADOW
// slice's I-P1 (docs/superpowers/specs/2026-06-27-python-cortex-shadow-design.md). Now that primary
// mode is default-ON (docs/superpowers/specs/2026-07-02-cortex-cutover-design.md), the SHADOW slice's
// original guarantee — "the cortex can never perturb the brief" — no longer holds when it answers in
// time; what MUST still hold is the FLOOR: primary ON + the cortex dead / slow (past the race budget)
// / erroring / unavailable / ok:false ⇒ the injected brief is BYTE-IDENTICAL to the no-cortex control
// (MemoryService.synthesize, which never touches the cortex or the synth daemon at all). The cortex
// can only ever NARROW/reorder/cap a brief when it answers in time with a clean decision — any miss,
// of any shape, must fall all the way back to the full-tier floor.
//
// observeCortexShadow's own never-throws / non-blocking guarantees (I-P2/I-P2b) and the B-6 hysteresis
// suppression are retained unmodified below the FLOOR tests — those invariants are independent of the
// primary/floor split.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { MemoryService, DEFAULT_MEMORY_CONFIG } from "../src/memory";
import { setCortexPrimary, resetCortexFallbackStats } from "../src/memory/cortexShadow";
import type { PythonCortexClient, CortexResult } from "../src/memory/cortexClient";
import type { MemoryTiers } from "../src/memory/types";

// A non-trivial five-field tiers object — a truncated fixture (e.g. `{frame}` only) can't expose a
// FLOOR regression that drops/reorders one of the other four tiers.
const TIERS: MemoryTiers = {
  project: { projectId: "proj", name: "Janus", summary: "the orchestrator", keyTerms: ["pty"], recentDecisions: ["ship it"] },
  pane: { paneId: "p1", name: "main", runtimeType: "claude", status: "Running", lastCommand: "ls", recent: ["ok"] },
  board: [{ paneId: "p1", name: "main", status: "Running" }],
  frame: { role: "Janus", gatePosture: "Auto", prefs: ["terse"] },
  breadcrumbs: [{ ts: 0, paneId: "p1", text: "did a thing" }],
};
const fakeWm: any = { getTiers: () => TIERS };

function svc(cortex?: PythonCortexClient, quietWindowMs?: number): MemoryService {
  // no pythonClient ⇒ synthesizeAsync's non-primary fallback is the deterministic in-process floor.
  return new MemoryService(fakeWm, DEFAULT_MEMORY_CONFIG, undefined, 150, cortex, quietWindowMs);
}

const cortexOk: PythonCortexClient = {
  available: () => true,
  decide: async (): Promise<CortexResult> => ({
    ok: true, decision: { keep: ["frame"], drop: [], rerank: [] },
    trace: { cortexVersion: "0.1.0", strategy: "baseline-identity", ruleFired: "baseline-identity",
      inputs: { activePaneId: "p1", sessionId: null, trigger: "catch-up", tierKeys: ["frame"], tierChars: { frame: 1 } },
      output: { orderedKeep: ["frame"], dropped: [] }, ts: 0 },
  }),
};
const cortexThrows: any = { available: () => true, decide: () => { throw new Error("boom"); } };
const cortexRejects: any = { available: () => true, decide: () => Promise.reject(new Error("boom")) };
const cortexDown: any = { available: () => false, decide: () => { throw new Error("must not be called"); } };
const cortexHangs: PythonCortexClient = { available: () => true, decide: () => new Promise(() => {}) };
const cortexFails: PythonCortexClient = { available: () => true, decide: async () => ({ ok: false }) };

/** Build a counting cortex client for the B-6 hysteresis tests below. */
function countingCortex(count: { n: number }): PythonCortexClient {
  return {
    available: () => true,
    decide: async (): Promise<CortexResult> => {
      count.n += 1;
      return {
        ok: true, decision: { keep: ["frame"], drop: [], rerank: [] },
        trace: { cortexVersion: "0.1.0", strategy: "baseline-identity", ruleFired: "baseline-identity",
          inputs: { activePaneId: "p1", sessionId: null, trigger: "catch-up", tierKeys: ["frame"], tierChars: { frame: 1 } },
          output: { orderedKeep: ["frame"], dropped: [] }, ts: 0 },
      };
    },
  };
}

afterEach(() => { setCortexPrimary(false); resetCortexFallbackStats(); });

function assertFloorParity(
  brief: { text: string; perTierChars: Record<string, number>; activePaneId: string | null },
  control: { text: string; perTierChars: Record<string, number>; activePaneId: string | null },
): void {
  assert.equal(brief.text, control.text, "FLOOR invariant: brief text must be byte-identical (strict equality) to the no-cortex control");
  assert.deepEqual(brief.perTierChars, control.perTierChars);
  assert.equal(brief.activePaneId, control.activePaneId);
}

// ── FLOOR invariant (I-P1 repurposed): primary ON + every miss shape ⇒ byte-identical to control ────

test("FLOOR: primary ON, cortex unavailable ⇒ brief byte-identical to the no-cortex control", async () => {
  setCortexPrimary(true);
  const s = svc(cortexDown);
  const control = s.synthesize("p1", 0);
  const brief = await s.synthesizeAsync("p1", 0);
  assertFloorParity(brief, control);
  assert.notEqual(brief.source, "cortex-primary");
});

test("FLOOR: primary ON, cortex throws synchronously ⇒ brief byte-identical to the no-cortex control", async () => {
  setCortexPrimary(true);
  const s = svc(cortexThrows);
  const control = s.synthesize("p1", 0);
  const brief = await s.synthesizeAsync("p1", 0);
  assertFloorParity(brief, control);
});

test("FLOOR: primary ON, cortex rejects ⇒ brief byte-identical to the no-cortex control", async () => {
  setCortexPrimary(true);
  const s = svc(cortexRejects);
  const control = s.synthesize("p1", 0);
  const brief = await s.synthesizeAsync("p1", 0);
  assertFloorParity(brief, control);
});

test("FLOOR: primary ON, cortex ok:false ⇒ brief byte-identical to the no-cortex control", async () => {
  setCortexPrimary(true);
  const s = svc(cortexFails);
  const control = s.synthesize("p1", 0);
  const brief = await s.synthesizeAsync("p1", 0);
  assertFloorParity(brief, control);
});

test("FLOOR: primary ON, cortex slower than the race budget ⇒ brief byte-identical to the no-cortex control (no hang)", async () => {
  setCortexPrimary(true, 30); // 30ms budget — cortexHangs never resolves.
  const s = svc(cortexHangs);
  const control = s.synthesize("p1", 0);
  const t0 = Date.now();
  const brief = await s.synthesizeAsync("p1", 0);
  const dt = Date.now() - t0;
  assertFloorParity(brief, control);
  assert.ok(dt < 500, `must fall to the floor near the race budget, not hang (took ${dt}ms)`);
});

// ── observeCortexShadow: never-throws / non-blocking (I-P2/I-P2b) — unaffected by primary/floor ──────

test("I-P2: observeCortexShadow never throws (ok / throw / reject / unavailable) — flag OFF", () => {
  assert.doesNotThrow(() => svc(cortexOk).observeCortexShadow("p1", 0));
  assert.doesNotThrow(() => svc(cortexThrows).observeCortexShadow("p1", 0));
  assert.doesNotThrow(() => svc(cortexRejects).observeCortexShadow("p1", 0));
  assert.doesNotThrow(() => svc(cortexDown).observeCortexShadow("p1", 0));
  assert.doesNotThrow(() => svc().observeCortexShadow("p1", 0)); // no client at all
});

test("I-P2 (primary ON): observeCortexShadow still never throws, even though it's a no-op while primary", () => {
  setCortexPrimary(true);
  assert.doesNotThrow(() => svc(cortexOk).observeCortexShadow("p1", 0));
  assert.doesNotThrow(() => svc(cortexThrows).observeCortexShadow("p1", 0));
  assert.doesNotThrow(() => svc(cortexDown).observeCortexShadow("p1", 0));
});

test("I-P2b: observeCortexShadow returns synchronously (void, non-blocking)", () => {
  const r = svc(cortexOk).observeCortexShadow("p1", 0);
  assert.equal(r, undefined);
});

// ── B-6 hysteresis tests (flag OFF — unaffected by the primary/floor split) ─────────────────────────

test("B-6: back-to-back identical snapshot within window calls decide exactly once", () => {
  const count = { n: 0 };
  const s = svc(countingCortex(count), 10_000);
  s.observeCortexShadow("p1", 0);   // first call: fires
  s.observeCortexShadow("p1", 100); // same tiers, 100 ms later, well within 10 s window → suppressed
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
