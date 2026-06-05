import { test } from "node:test";
import assert from "node:assert/strict";
import { WIRE_VERSION, PingResponseSchema, SynthesizeResponseSchema } from "../src/memory/types";

test("WIRE_VERSION is 1", () => {
  assert.equal(WIRE_VERSION, 1);
});

test("PingResponseSchema accepts a valid pong", () => {
  const r = PingResponseSchema.safeParse({ id: "u1", v: 1, ok: true, pong: true, synthVersion: "1.0.0" });
  assert.equal(r.success, true);
});

test("PingResponseSchema rejects a wrong wire version", () => {
  const r = PingResponseSchema.safeParse({ id: "u1", v: 2, ok: true, pong: true, synthVersion: "1.0.0" });
  assert.equal(r.success, false);
});

test("SynthesizeResponseSchema accepts a valid brief", () => {
  const r = SynthesizeResponseSchema.safeParse({
    id: "u2", v: 1, ok: true,
    brief: { text: "PROJECT x", perTierChars: { project: 9 }, activePaneId: "p1" },
    meta: { strategy: "adaptive-extractive", synthVersion: "1.0.0" },
  });
  assert.equal(r.success, true);
});

test("SynthesizeResponseSchema rejects a brief missing text", () => {
  const r = SynthesizeResponseSchema.safeParse({
    id: "u2", v: 1, ok: true, brief: { perTierChars: {}, activePaneId: null },
  });
  assert.equal(r.success, false);
});

test("SynthesizeResponseSchema accepts an error response", () => {
  const r = SynthesizeResponseSchema.safeParse({
    id: "u2", v: 1, ok: false, error: { code: "SYNTH_FAILED", message: "boom" },
  });
  assert.equal(r.success, true);
});
