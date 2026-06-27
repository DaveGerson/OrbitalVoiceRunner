// tests/test_cortex_client.ts — the cortex typed facade (Inc 4 slice 1). Locks the fail-closed
// contract: ANY miss (unavailable / null / error response / schema reject / rejected request) resolves
// to { ok: false } and the facade NEVER rejects. A healthy response parses to { ok, decision, trace }.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPythonCortexClient } from "../src/memory/cortexClient";
import { WIRE_VERSION } from "../src/memory/types";
import type { PythonModuleClient, ModuleResponse } from "../src/memory/pythonClient";

function fakeCore(opts: {
  available?: boolean;
  respond?: (op: string, payload: Record<string, unknown>) => ModuleResponse | Promise<ModuleResponse>;
  reject?: boolean;
}): PythonModuleClient {
  const avail = opts.available ?? true;
  return {
    available: () => avail,
    state: () => (avail ? "python" : "fallback"),
    dispose: () => {},
    request: (op, payload) =>
      opts.reject ? Promise.reject(new Error("boom")) : Promise.resolve(opts.respond ? opts.respond(op, payload) : null),
  };
}

const TIERS: any = { project: null, pane: null, board: [], frame: { role: "Janus", gatePosture: "Auto", prefs: [] }, breadcrumbs: [] };
const CTX = { activePaneId: "p1", sessionId: null, trigger: "brief-inject" };

function okResponse() {
  return {
    id: "r1", v: WIRE_VERSION, ok: true,
    decision: { keep: ["frame"], drop: [], rerank: [] },
    trace: {
      cortexVersion: "0.1.0", strategy: "baseline-identity", ruleFired: "baseline-identity",
      inputs: { activePaneId: "p1", sessionId: null, trigger: "brief-inject", tierKeys: ["frame"], tierChars: { frame: 10 } },
      output: { orderedKeep: ["frame"], dropped: [] }, ts: 1,
    },
  };
}

test("cortex facade: unavailable core ⇒ available() false", () => {
  assert.equal(createPythonCortexClient(fakeCore({ available: false })).available(), false);
});

test("cortex facade: request null ⇒ { ok: false }", async () => {
  const r = await createPythonCortexClient(fakeCore({ respond: () => null })).decide(TIERS, CTX, 1);
  assert.equal(r.ok, false);
});

test("cortex facade: healthy response ⇒ { ok, decision, trace }", async () => {
  const c = createPythonCortexClient(fakeCore({ respond: (op) => { assert.equal(op, "cortex.decide"); return okResponse(); } }));
  const r = await c.decide(TIERS, CTX, 1);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.decision.keep, ["frame"]);
    assert.equal(r.trace.strategy, "baseline-identity");
    assert.deepEqual(r.trace.output.orderedKeep, ["frame"]);
  }
});

test("cortex facade: ok:false error response ⇒ { ok: false }", async () => {
  const c = createPythonCortexClient(fakeCore({ respond: () => ({ id: "r1", v: WIRE_VERSION, ok: false, error: { code: "CORTEX_FAILED", message: "x" } }) }));
  assert.equal((await c.decide(TIERS, CTX, 1)).ok, false);
});

test("cortex facade: schema-invalid object ⇒ { ok: false }", async () => {
  const c = createPythonCortexClient(fakeCore({ respond: () => ({ id: "r1", v: WIRE_VERSION, ok: true, decision: { keep: "nope" } } as any) }));
  assert.equal((await c.decide(TIERS, CTX, 1)).ok, false);
});

test("cortex facade: rejecting core ⇒ { ok: false } (never rejects)", async () => {
  const c = createPythonCortexClient(fakeCore({ reject: true }));
  assert.equal((await c.decide(TIERS, CTX, 1)).ok, false);
});
