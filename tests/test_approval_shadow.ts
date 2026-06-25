// tests/test_approval_shadow.ts — the TS-side units for the approval SHADOW seam (seam task 1.6):
//   1. createPythonApprovalClient — the typed facade over a (fake) shared core: parsed-out on ok,
//      null on every miss (core-null / error response / schema reject).
//   2. createApprovalShadowRecorder — match / mismatch / missing counting, key-order canonicalization
//      (no false mismatch), and the "never throws into the caller" guarantee.
//   3. parseApprovalIntentShadowed — authoritative passthrough (identical to parseApprovalIntent),
//      with and without a recorder installed; the recorder sees (utterance, authoritative result).
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { PythonModuleClient, ModuleResponse } from "../src/memory/pythonClient";
import { createPythonApprovalClient } from "../src/memory/approvalClient";
import {
  createApprovalShadowRecorder,
  installApprovalShadow,
  getApprovalShadow,
  parseApprovalIntentShadowed,
} from "../src/approvalShadow";
import { parseApprovalIntent } from "../src/approvalIntent";

const tick = () => new Promise((r) => setImmediate(r));

/** A fake shared core whose request() returns a scripted response (or null) for "approval.parse". */
function fakeCore(respond: (op: string, payload: Record<string, unknown>) => ModuleResponse): PythonModuleClient {
  return {
    request: (op, payload) => Promise.resolve(respond(op, payload)),
    available: () => true,
    state: () => "python",
    dispose: () => {},
  };
}

describe("createPythonApprovalClient (typed facade over shared core)", () => {
  it("returns the parsed result on an ok response", async () => {
    const core = fakeCore((op, p) => {
      assert.equal(op, "approval.parse");
      assert.equal(p.transcript, "approve the second one");
      return { id: "r1", v: 1, ok: true, parsed: { intent: "approve", targetHint: { ordinal: 2 } } };
    });
    const client = createPythonApprovalClient(core);
    assert.deepEqual(await client.parse("approve the second one"), { intent: "approve", targetHint: { ordinal: 2 } });
  });

  it("returns null when the core misses (null)", async () => {
    const client = createPythonApprovalClient(fakeCore(() => null));
    assert.equal(await client.parse("approve"), null);
  });

  it("returns null on a daemon error response", async () => {
    const client = createPythonApprovalClient(fakeCore(() => ({ id: "r1", v: 1, ok: false, error: { code: "PARSE_FAILED", message: "boom" } })));
    assert.equal(await client.parse("approve"), null);
  });

  it("returns null on a schema-violating response", async () => {
    const client = createPythonApprovalClient(fakeCore(() => ({ id: "r1", v: 1, ok: true, parsed: { intent: "frobnicate" } })));
    assert.equal(await client.parse("approve"), null);
  });
});

describe("createApprovalShadowRecorder", () => {
  it("counts a match when Python agrees", async () => {
    const rec = createApprovalShadowRecorder({ parse: async () => ({ intent: "approve" }) });
    rec.record("approve", { intent: "approve" });
    await tick();
    assert.deepEqual(rec.stats(), { compared: 1, match: 1, mismatch: 0, missing: 0 });
  });

  it("does NOT false-mismatch on targetHint key order (canonicalized compare)", async () => {
    // TS sets ordinal-then-fragment; the wire/zod side validates fragment-then-ordinal.
    const ts = { intent: "approve" as const, targetHint: { ordinal: 2, fragment: "npm install" } };
    const py = { intent: "approve" as const, targetHint: { fragment: "npm install", ordinal: 2 } };
    const rec = createApprovalShadowRecorder({ parse: async () => py });
    rec.record("approve the npm install second one", ts);
    await tick();
    assert.deepEqual(rec.stats(), { compared: 1, match: 1, mismatch: 0, missing: 0 });
  });

  it("counts + logs a mismatch when Python disagrees", async () => {
    const logs: string[] = [];
    const rec = createApprovalShadowRecorder({ parse: async () => ({ intent: "reject" }), log: (l) => logs.push(l) });
    rec.record("approve", { intent: "approve" });
    await tick();
    assert.deepEqual(rec.stats(), { compared: 1, match: 0, mismatch: 1, missing: 0 });
    assert.equal(logs.length, 1);
    assert.match(logs[0], /MISMATCH/);
  });

  it("redacts the logged mismatch payload", async () => {
    const logs: string[] = [];
    const rec = createApprovalShadowRecorder({
      parse: async () => ({ intent: "reject" }),
      log: (l) => logs.push(l),
      redact: (s) => s.replace(/sk-secret/g, "***"),
    });
    rec.record("approve sk-secret", { intent: "approve" });
    await tick();
    assert.match(logs[0], /\*\*\*/);
    assert.doesNotMatch(logs[0], /sk-secret/);
  });

  it("counts a miss when Python returns null", async () => {
    const rec = createApprovalShadowRecorder({ parse: async () => null });
    rec.record("approve", { intent: "approve" });
    await tick();
    assert.deepEqual(rec.stats(), { compared: 0, match: 0, mismatch: 0, missing: 1 });
  });

  it("never throws into the caller, even if parse rejects (counts a miss)", async () => {
    const rec = createApprovalShadowRecorder({ parse: async () => { throw new Error("daemon exploded"); } });
    assert.doesNotThrow(() => rec.record("approve", { intent: "approve" }));
    await tick();
    assert.equal(rec.stats().missing, 1);
  });
});

describe("parseApprovalIntentShadowed (authoritative passthrough)", () => {
  afterEach(() => installApprovalShadow(null));

  it("with no recorder installed, returns exactly parseApprovalIntent", () => {
    for (const u of ["approve the second one", "skip that for now", "dont run", "", "approve but reject"]) {
      assert.deepEqual(parseApprovalIntentShadowed(u), parseApprovalIntent(u));
    }
  });

  it("with a recorder installed, returns the authoritative result AND feeds the recorder", async () => {
    const seen: Array<{ u: string; r: unknown }> = [];
    const rec = createApprovalShadowRecorder({ parse: async () => ({ intent: "approve" }) });
    // wrap record to observe the call without changing behavior
    const wrapped = { record: (u: string, r: any) => { seen.push({ u, r }); rec.record(u, r); }, stats: rec.stats };
    installApprovalShadow(wrapped);
    assert.equal(getApprovalShadow(), wrapped);

    const got = parseApprovalIntentShadowed("approve the second one");
    assert.deepEqual(got, parseApprovalIntent("approve the second one"));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].u, "approve the second one");
    assert.deepEqual(seen[0].r, { intent: "approve", targetHint: { ordinal: 2 } });
    await tick();
  });

  it("a throwing recorder cannot break the authoritative answer", () => {
    installApprovalShadow({ record: () => { throw new Error("recorder bug"); }, stats: () => ({ compared: 0, match: 0, mismatch: 0, missing: 0 }) });
    assert.doesNotThrow(() => {
      const got = parseApprovalIntentShadowed("approve");
      assert.deepEqual(got, parseApprovalIntent("approve"));
    });
  });
});
