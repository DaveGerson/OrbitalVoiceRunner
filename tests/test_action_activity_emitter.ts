// tests/test_action_activity_emitter.ts
//
// hwu.7: the action_activity emitter that re-keys the ActionPanel on a completed voice tool call.
// Invariants under test:
//   1. ONE frame per completed call, shaped { type, name, callId, ts, payload }.
//   2. The payload is redactDeep'd — a planted secret in the tool output never rides the wire.
//   3. Oversized output is size-capped with a `truncated` flag (never balloons the frame).
//   4. Emission is NON-THROWING — a broadcast that throws is swallowed so the tool-response path
//      back to Gemini can never break.
//
// The emitter is imported from ../src/voice (src/voice/index.ts) — the same barrel the cortex
// measurement spine test imports mintInjectId/captureTurnUsage from.
//
// Runner: npx tsx --test --test-force-exit tests/test_action_activity_emitter.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildActionActivityFrame, emitActionActivity } from "../src/voice";
import { redactSecrets } from "../src/terminal";
import type { ActionResult } from "../src/actions/types";

const SECRET = "ghp_" + "a".repeat(36); // a GitHub token → redactSecrets replaces with a marker

test("buildActionActivityFrame shapes { type, name, callId, ts, payload } for an ok result", () => {
  const result: ActionResult = { kind: "ok", output: "all quiet" };
  const f = buildActionActivityFrame("get_status_summary", "call-9", result, 1234, redactSecrets);
  assert.equal(f.type, "action_activity");
  assert.equal(f.name, "get_status_summary");
  assert.equal(f.callId, "call-9");
  assert.equal(f.ts, 1234);
  assert.equal(f.payload.kind, "ok");
  assert.equal(f.payload.output, "all quiet");
});

test("payload is redactDeep'd — a planted secret is absent from the wire frame", () => {
  const result: ActionResult = {
    kind: "ok",
    output: { notes: [{ id: "n1", text: `token is ${SECRET} keep it safe` }] },
  };
  const f = buildActionActivityFrame("get_project_notes", "c1", result, 1, redactSecrets);
  const serialized = JSON.stringify(f);
  assert.ok(!serialized.includes(SECRET), "the raw secret must not appear anywhere in the frame");
  assert.match(serialized, /REDACTED/, "the redaction marker should be present in its place");
});

test("pending result projects to a pending payload carrying the summary (not a result)", () => {
  const result: ActionResult = { kind: "pending", messageId: "m1", summary: "run migration" };
  const f = buildActionActivityFrame("propose_command", "c2", result, 1, redactSecrets);
  assert.equal(f.payload.kind, "pending");
  assert.equal(f.payload.summary, "run migration");
  assert.equal(f.payload.output, undefined);
});

test("blocked result projects to a blocked payload carrying the reason", () => {
  const result: ActionResult = { kind: "blocked", reason: "gate Off" };
  const f = buildActionActivityFrame("delete_note", "c3", result, 1, redactSecrets);
  assert.equal(f.payload.kind, "blocked");
  assert.equal(f.payload.reason, "gate Off");
});

test("oversized output is size-capped with a truncated flag", () => {
  const huge = "x".repeat(20000);
  const result: ActionResult = { kind: "ok", output: huge };
  const f = buildActionActivityFrame("search_notes", "c4", result, 1, redactSecrets, 8192);
  assert.equal(f.payload.truncated, true);
  assert.ok(JSON.stringify(f.payload).length <= 8192, "capped payload must fit under the cap");
  assert.notEqual(f.payload.output, huge, "the huge output must have been replaced");
});

test("emitActionActivity broadcasts exactly ONE frame per completed call", () => {
  const sent: any[] = [];
  const broadcast = (m: any) => sent.push(m);
  emitActionActivity(broadcast, "get_status_summary", "c5", { kind: "ok", output: "ok" }, redactSecrets, 7);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "action_activity");
  assert.equal(sent[0].callId, "c5");
});

test("emitActionActivity swallows a broadcast throw — the tool-response path is never broken", () => {
  const boom = () => { throw new Error("socket dead"); };
  assert.doesNotThrow(() =>
    emitActionActivity(boom, "get_status_summary", "c6", { kind: "ok", output: "ok" }, redactSecrets, 1),
  );
});
