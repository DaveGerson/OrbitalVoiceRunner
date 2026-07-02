// tests/test_policy_client.ts — src/voice/policyClient.ts (scaffold-owned). Pins the FALLBACK
// CONTRACT (D2, binding): resolveFocus/rankSitrep resolve null on ANY miss (ok:false, schema reject,
// timeout) and NEVER reject. Also pins the ping-handshake QUIRK (risk #8): the policies daemon reuses
// PingResponseSchema, so the literal wire key is `synthVersion` — a well-meaning rename to
// `policiesVersion` breaks the handshake silently (permanent fallback). This file exercises the
// FACADE over a fake core (no real process spawn); python/policies/tests/test_dispatch.py exercises
// the Python side of the SAME contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createPythonPolicyClient,
  POLICY_OP_TIMEOUT_MS,
  type FocusCandidate,
  type SitrepPayload,
} from "../src/voice/policyClient";
import { WIRE_VERSION, PingResponseSchema } from "../src/memory/types";
import type { PythonModuleClient, ModuleResponse } from "../src/memory/pythonClient";

/** A minimal fake PythonModuleClient core: request() resolves whatever the test queues, or hangs
 *  forever when no response is queued (to exercise the race timeout). */
function makeFakeCore(opts: {
  available?: boolean;
  onRequest?: (op: string, payload: Record<string, unknown>) => ModuleResponse | "hang";
}): PythonModuleClient & { calls: Array<{ op: string; payload: Record<string, unknown> }> } {
  const calls: Array<{ op: string; payload: Record<string, unknown> }> = [];
  return {
    calls,
    available() { return opts.available ?? true; },
    state() { return (opts.available ?? true) ? "python" : "fallback"; },
    request(op, payload) {
      calls.push({ op, payload });
      const resp = opts.onRequest ? opts.onRequest(op, payload) : null;
      if (resp === "hang") return new Promise(() => { /* never settles within the test's window */ });
      return Promise.resolve(resp);
    },
    dispose() { /* no-op fake */ },
  };
}

const CANDIDATES: FocusCandidate[] = [
  {
    paneId: "p1", paneName: "build", projectId: "proj1", projectName: "Proj",
    presetLabel: "claudeCode", ordinal: 1, state: "Running", isBusy: true,
    lastActiveAt: 1000, isActive: true,
  },
];

const SITREP_PAYLOAD: SitrepPayload = {
  now: 1000,
  panes: [],
  approvals: [],
  attention: [],
  plans: [],
};

test("POLICY_OP_TIMEOUT_MS is the D2 300ms bound", () => {
  assert.equal(POLICY_OP_TIMEOUT_MS, 300);
});

test("resolveFocus: a valid ok:true response returns the resolution", async () => {
  const core = makeFakeCore({
    onRequest: (op, payload) => {
      assert.equal(op, "focus.resolve");
      assert.equal(payload.reference, "the build pane");
      assert.deepEqual(payload.candidates, CANDIDATES);
      return {
        id: "r1", v: WIRE_VERSION, ok: true,
        resolution: { paneId: "p1", confidence: 1, alternatives: [] },
      };
    },
  });
  const client = createPythonPolicyClient(core);
  const res = await client.resolveFocus("the build pane", CANDIDATES);
  assert.deepEqual(res, { paneId: "p1", confidence: 1, alternatives: [] });
});

test("resolveFocus: ok:false resolves null (never rejects)", async () => {
  const core = makeFakeCore({
    onRequest: () => ({ id: "r2", v: WIRE_VERSION, ok: false, error: { code: "FOCUS_FAILED", message: "boom" } }),
  });
  const client = createPythonPolicyClient(core);
  const res = await client.resolveFocus("x", []);
  assert.equal(res, null);
});

test("resolveFocus: a schema-invalid response resolves null", async () => {
  const core = makeFakeCore({
    onRequest: () => ({ id: "r3", v: WIRE_VERSION, ok: true, resolution: { paneId: 42 } } as unknown as ModuleResponse),
  });
  const client = createPythonPolicyClient(core);
  const res = await client.resolveFocus("x", []);
  assert.equal(res, null);
});

test("resolveFocus: no response at all (daemon down) resolves null", async () => {
  const core = makeFakeCore({ onRequest: () => null });
  const client = createPythonPolicyClient(core);
  const res = await client.resolveFocus("x", []);
  assert.equal(res, null);
});

test("resolveFocus: a hung daemon resolves null once the race timer fires (never rejects)", async () => {
  const core = makeFakeCore({ onRequest: () => "hang" });
  const client = createPythonPolicyClient(core, { timeoutMs: 10 });
  const res = await client.resolveFocus("x", []);
  assert.equal(res, null);
});

test("rankSitrep: a valid ok:true response returns the ranking", async () => {
  const core = makeFakeCore({
    onRequest: (op, payload) => {
      assert.equal(op, "sitrep.rank");
      assert.deepEqual(payload.payload, SITREP_PAYLOAD);
      return {
        id: "s1", v: WIRE_VERSION, ok: true,
        ranking: { sections: [{ key: "approvals", itemIds: ["a1"] }] },
      };
    },
  });
  const client = createPythonPolicyClient(core);
  const res = await client.rankSitrep(SITREP_PAYLOAD);
  assert.deepEqual(res, { sections: [{ key: "approvals", itemIds: ["a1"] }] });
});

test("rankSitrep: ok:false resolves null (never rejects)", async () => {
  const core = makeFakeCore({
    onRequest: () => ({ id: "s2", v: WIRE_VERSION, ok: false, error: { code: "SITREP_FAILED", message: "boom" } }),
  });
  const client = createPythonPolicyClient(core);
  const res = await client.rankSitrep(SITREP_PAYLOAD);
  assert.equal(res, null);
});

test("rankSitrep: an invalid section key resolves null (schema reject)", async () => {
  const core = makeFakeCore({
    onRequest: () => ({
      id: "s3", v: WIRE_VERSION, ok: true,
      ranking: { sections: [{ key: "not-a-real-section", itemIds: [] }] },
    } as unknown as ModuleResponse),
  });
  const client = createPythonPolicyClient(core);
  const res = await client.rankSitrep(SITREP_PAYLOAD);
  assert.equal(res, null);
});

test("available()/dispose() delegate to the shared core", () => {
  let disposed = false;
  const core = makeFakeCore({ available: true });
  core.dispose = () => { disposed = true; };
  const client = createPythonPolicyClient(core);
  assert.equal(client.available(), true);
  client.dispose();
  assert.equal(disposed, true);
});

// The ping-handshake QUIRK (risk #8): pin that the CORE's ping response — which this facade never
// issues itself (the core owns the handshake) — is validated by the SAME PingResponseSchema the synth
// daemon uses, and that schema's literal key is `synthVersion`. A policies-daemon pong that renamed
// the key to `policiesVersion` would fail PingResponseSchema.safeParse and the core would never mark
// `ready` (permanent fallback) — see python/policies/dispatch.py's docstring + test_dispatch.py.
test("the shared ping-response schema requires the literal key 'synthVersion'", () => {
  const validPong = { id: "__ping__", v: WIRE_VERSION, ok: true, pong: true, synthVersion: "policies-1" };
  assert.equal(PingResponseSchema.safeParse(validPong).success, true);
  const renamedPong = { id: "__ping__", v: WIRE_VERSION, ok: true, pong: true, policiesVersion: "policies-1" };
  assert.equal(PingResponseSchema.safeParse(renamedPong).success, false);
});
