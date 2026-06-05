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
