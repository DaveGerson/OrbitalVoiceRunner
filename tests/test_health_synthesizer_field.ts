import { test } from "node:test";
import assert from "node:assert/strict";
import { OBSERVABILITY_ACTIONS } from "../src/actions/defs/observability";

const getHealth = OBSERVABILITY_ACTIONS.find((a) => a.name === "get_health")!;

function baseCtx(extra: Record<string, unknown> = {}): any {
  return {
    manager: { terminals: {} },
    session: null,
    pendingApprovals: { forSession: () => [] },
    isFrozen: () => false,
    store: null,
    ...extra,
  };
}

test("get_health reports synthesizer=python when the getter says so", () => {
  const res: any = getHealth.handler({}, baseCtx({ memorySynthesizerState: () => "python" }));
  assert.equal(res.kind, "ok");
  assert.equal(res.output.memory.synthesizer, "python");
});

test("get_health defaults synthesizer=fallback when the getter is absent (voice/test path)", () => {
  const res: any = getHealth.handler({}, baseCtx());
  assert.equal(res.output.memory.synthesizer, "fallback");
});

// ── Inc 2 task 2.2: the additive `shadow` health block ──────────────────────────────────────────────

test("get_health surfaces the shadow stats with a derived match_rate (additive)", () => {
  const res: any = getHealth.handler({}, baseCtx({
    approvalShadowStats: () => ({ compared: 8, match: 6, mismatch: 2, missing: 1 }),
  }));
  assert.deepEqual(res.output.memory.shadow, {
    compared: 8, match: 6, mismatch: 2, missing: 1, match_rate: 0.75, // 6/8; missing excluded from the denominator
  });
  // additivity proof: surfacing shadow must NOT perturb the existing synthesizer field
  assert.equal(res.output.memory.synthesizer, "fallback");
});

test("get_health shadow match_rate is 0 when compared===0 (no divide-by-zero)", () => {
  const res: any = getHealth.handler({}, baseCtx({
    approvalShadowStats: () => ({ compared: 0, match: 0, mismatch: 0, missing: 3 }),
  }));
  assert.equal(res.output.memory.shadow.match_rate, 0);
});

test("get_health shadow match_rate is 1 on a perfect-parity window (upper boundary)", () => {
  // The "happy parity" read the operator most wants before deciding the flip.
  const res: any = getHealth.handler({}, baseCtx({
    approvalShadowStats: () => ({ compared: 5, match: 5, mismatch: 0, missing: 0 }),
  }));
  assert.equal(res.output.memory.shadow.match_rate, 1);
});

test("get_health shadow is null when the getter is absent (default-safe)", () => {
  const res: any = getHealth.handler({}, baseCtx());
  assert.equal(res.output.memory.shadow, null);
});
