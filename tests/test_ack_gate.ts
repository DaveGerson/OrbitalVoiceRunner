// tests/test_ack_gate.ts — B1 turn-aware two-phase ack GATE (pure, zero async).
//
// LOCKS the barge-in-safe policy the B1 spec forbids violating: Janus speaks an ack ONLY when it
// will not interrupt the operator. The gate is a pure function of the turn state derived from the
// REAL Gemini Live signals (onOperatorSpeech recency + serverContent.interrupted), so it is unit-
// testable without a server/session. Director-resolved trichotomy:
//   - phase-1 "opening": speak | suppress (no defer — a stale "opening" is noise; the model
//     confirms naturally on its next turn and phase-2 catches up).
//   - phase-2 "ready":   speak | defer | suppress. Barge-in => suppress; mid-utterance => defer.
//
// Also pins formatPaneSignal's new "created" verb (the ternary-fallthrough trap: without an explicit
// branch BEFORE the ": exited" fallthrough, a "created" signal renders as "exited").
//
// Runner: npx tsx --test --test-force-exit tests/test_ack_gate.ts

import { test } from "node:test";
import assert from "node:assert";
import {
  shouldSpeakOpeningAck,
  shouldSpeakReadyAck,
  OPERATOR_HOLD_MS,
} from "../src/voiceAckGate";
import { formatPaneSignal } from "../src/paneSignals";

// #1 — opening ack SPEAKS when the operator is idle (never spoke, or spoke long ago).
test("opening ack SPEAKS when operator idle", () => {
  const now = Date.now();
  assert.strictEqual(
    shouldSpeakOpeningAck({ lastOperatorSpeechAt: 0, interrupted: false, now }),
    "speak",
  );
  // Spoke comfortably outside the hold window -> still speak.
  assert.strictEqual(
    shouldSpeakOpeningAck({ lastOperatorSpeechAt: now - (OPERATOR_HOLD_MS + 500), interrupted: false, now }),
    "speak",
  );
});

// #2 — opening ack SUPPRESSES mid-utterance (recent speech) and on explicit barge-in.
test("opening ack SUPPRESSES mid-utterance and on barge-in", () => {
  const now = Date.now();
  // Mid-utterance: operator spoke 200ms ago (< hold window) -> suppress.
  assert.strictEqual(
    shouldSpeakOpeningAck({ lastOperatorSpeechAt: now - 200, interrupted: false, now }),
    "suppress",
  );
  // Explicit barge-in latch -> suppress even if speech recency would otherwise allow it.
  assert.strictEqual(
    shouldSpeakOpeningAck({ lastOperatorSpeechAt: 0, interrupted: true, now }),
    "suppress",
  );
});

// #3 — ready ack DEFERS mid-utterance, SUPPRESSES on barge-in, SPEAKS when clear (the trichotomy).
test("ready ack DEFERS mid-utterance, SUPPRESSES on barge-in, SPEAKS when clear", () => {
  const now = Date.now();
  // Mid-utterance -> defer (the pane IS ready; we just wait for a safe gap to say so).
  assert.strictEqual(
    shouldSpeakReadyAck({ lastOperatorSpeechAt: now - 200, interrupted: false, now }),
    "defer",
  );
  // Explicit barge-in -> suppress (drop; the operator seized the turn deliberately).
  assert.strictEqual(
    shouldSpeakReadyAck({ lastOperatorSpeechAt: now - 200, interrupted: true, now }),
    "suppress",
  );
  // Clear -> speak.
  assert.strictEqual(
    shouldSpeakReadyAck({ lastOperatorSpeechAt: 0, interrupted: false, now }),
    "speak",
  );
});

// #9 — the "created" signal renders "up and ready", NOT "exited" (the ternary-fallthrough trap).
test("created signal renders 'up and ready', not 'exited'", () => {
  const rendered = formatPaneSignal({ paneId: "p1", kind: "created" });
  assert.ok(rendered.includes("up and ready"), `created -> "up and ready": ${rendered}`);
  assert.ok(!rendered.includes("exited"), `created must NOT fall through to "exited": ${rendered}`);
});
