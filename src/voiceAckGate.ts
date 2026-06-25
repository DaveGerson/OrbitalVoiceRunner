// src/voiceAckGate.ts — B1 turn-aware two-phase ack GATE (pure).
//
// SEAM NOTE (Python⇄TS migration, Inc 1 task 1.9 — KEPT IN TS, do NOT port): this is pure and
// decision-shaped, so it superficially looks portable — but it decides "speak over the operator NOW?"
// against a 1500ms barge-in window using a `now` that must reflect the instant of decision. An NDJSON
// round-trip to a Python daemon would make `now`/`lastOperatorSpeechAt` stale relative to the live
// audio turn and could approve speaking right as the operator barges in. It stays synchronous +
// in-process by design. The regression test tests/test_ack_gate_in_process.ts pins this (no seam
// import; synchronous return). See the seam plan, task 1.9.
//
// The B1 spec REQUIRES Janus speak an async-spawn ack ONLY when it will not interrupt the operator.
// This module is the pure decision core: a function of the turn state derived from the live Gemini
// signals the server already tracks — operator-speech recency (onOperatorSpeech stamps
// `lastOperatorSpeechAt`) and the explicit barge-in latch (serverContent.interrupted). Keeping it
// pure makes the barge-in policy unit-testable with zero server/session (see tests/test_ack_gate.ts)
// and keeps the server dispatch loop a thin caller.
//
// Director-resolved trichotomy:
//   - phase-1 "opening": speak | suppress. NO defer — a stale "opening the pane" is pure noise once
//     the moment has passed; the model confirms the pane naturally on its next turn and phase-2
//     ("ready") catches up. So if the operator is mid-utterance or barged in, we simply DROP it.
//   - phase-2 "ready":   speak | defer | suppress. The pane IS ready, so the information has lasting
//     value: mid-utterance => DEFER (say it at the next safe gap); explicit barge-in => SUPPRESS
//     (the operator deliberately seized the turn — drop rather than queue).

export interface AckTurnState {
  /** Epoch ms of the operator's most recent transcript. 0 = the operator has never spoken. */
  lastOperatorSpeechAt: number;
  /** True if Gemini reported a barge-in (serverContent.interrupted) on this tick / since last clear. */
  interrupted: boolean;
  /** Epoch ms "now" (injected so the decision is pure + testable). */
  now: number;
  /** Override the hold window (default OPERATOR_HOLD_MS). */
  holdMs?: number;
}

/**
 * The "operator might still be talking" hold window. If the operator's last transcript landed within
 * this many ms of `now`, we treat the turn as theirs and avoid speaking over them. 1.5s is long enough
 * to bridge the natural gaps inside a single spoken instruction without swallowing a genuine yield.
 */
export const OPERATOR_HOLD_MS = 1500;

export type AckDecision = "speak" | "defer" | "suppress";

/** Phase-1 (opening) policy: speak | suppress (no defer — low value once stale). */
export function shouldSpeakOpeningAck(s: AckTurnState): "speak" | "suppress" {
  if (s.interrupted) return "suppress";
  if (s.now - s.lastOperatorSpeechAt < (s.holdMs ?? OPERATOR_HOLD_MS)) return "suppress";
  return "speak";
}

/** Phase-2 (ready) policy: speak | defer | suppress. Barge-in => suppress; mid-utterance => defer. */
export function shouldSpeakReadyAck(s: AckTurnState): AckDecision {
  if (s.interrupted) return "suppress";
  if (s.now - s.lastOperatorSpeechAt < (s.holdMs ?? OPERATOR_HOLD_MS)) return "defer";
  return "speak";
}
