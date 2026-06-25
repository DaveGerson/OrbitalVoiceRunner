// tests/test_ack_gate_in_process.ts — seam Inc 1, task 1.9: the in-process regression lock for the
// voice ack gate. The ack decision ("speak over the operator NOW?") is correct ONLY if computed
// synchronously, in-process, against a `now` that reflects the instant of decision — an NDJSON
// round-trip to the Python daemon would stale the 1500ms barge-in window. This test pins two
// invariants so a future "port everything to Python" sweep cannot quietly break it:
//   1. STRUCTURAL: voiceAckGate.ts imports nothing from the Python seam (no daemon client / shadow).
//   2. BEHAVIORAL: the decision functions return a plain value SYNCHRONOUSLY (never a Promise), and
//      the OPERATOR_HOLD_MS boundary resolves on the in-process clock exactly as specified.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { shouldSpeakOpeningAck, shouldSpeakReadyAck, OPERATOR_HOLD_MS } from "../src/voiceAckGate";

const here = path.dirname(fileURLToPath(import.meta.url));
const ACK_GATE_SRC = path.join(here, "..", "src", "voiceAckGate.ts");

describe("voice ack gate stays in-process (never crosses the Python seam)", () => {
  it("voiceAckGate.ts imports nothing from the daemon seam", () => {
    const src = fs.readFileSync(ACK_GATE_SRC, "utf-8");
    // Any import of the daemon client / approval facade / shadow would mean the decision could cross
    // the NDJSON boundary. Match only ACTUAL import statements (the SEAM NOTE prose may name them).
    const importLines = src.split("\n").filter((l) => /^\s*import\b/.test(l));
    for (const seam of ["pythonClient", "approvalClient", "approvalShadow", "memory/types", "child_process"]) {
      assert.ok(
        !importLines.some((l) => l.includes(seam)),
        `voiceAckGate must not import "${seam}" — the ack decision must stay in-process`,
      );
    }
  });

  it("returns a synchronous value, not a thenable (no awaiting a daemon)", () => {
    const opening = shouldSpeakOpeningAck({ lastOperatorSpeechAt: 0, interrupted: false, now: 10_000 });
    const ready = shouldSpeakReadyAck({ lastOperatorSpeechAt: 0, interrupted: false, now: 10_000 });
    assert.equal(typeof opening, "string");
    assert.equal(typeof ready, "string");
    // A Promise would have a `.then`; a synchronous string does not.
    assert.equal((opening as unknown as { then?: unknown }).then, undefined);
    assert.equal((ready as unknown as { then?: unknown }).then, undefined);
  });

  it("resolves the OPERATOR_HOLD_MS boundary on the in-process clock (< window, not <=)", () => {
    const base = { interrupted: false, lastOperatorSpeechAt: 0 };
    // delta exactly == hold window: NOT within (strict <) -> the operator's turn is over -> speak.
    assert.equal(shouldSpeakOpeningAck({ ...base, now: OPERATOR_HOLD_MS }), "speak");
    assert.equal(shouldSpeakReadyAck({ ...base, now: OPERATOR_HOLD_MS }), "speak");
    // delta one ms inside the window: still the operator's turn.
    assert.equal(shouldSpeakOpeningAck({ ...base, now: OPERATOR_HOLD_MS - 1 }), "suppress");
    assert.equal(shouldSpeakReadyAck({ ...base, now: OPERATOR_HOLD_MS - 1 }), "defer");
    // explicit barge-in always wins, regardless of timing.
    assert.equal(shouldSpeakOpeningAck({ ...base, interrupted: true, now: 10 * OPERATOR_HOLD_MS }), "suppress");
    assert.equal(shouldSpeakReadyAck({ ...base, interrupted: true, now: 10 * OPERATOR_HOLD_MS }), "suppress");
  });
});
