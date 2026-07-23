// src/voice/synthLane/scores.ts — Scenario "score" DSL + four scores (pure data)
// bead wsm-e2e-pinned-t5hb (LIVE-SYNTH lane Unit 1)

export type TurnVerb = "say" | "awaitTurnDone" | "gap" | "bargeIn";

export interface TurnSay {
  type: "say";
  text: string;
}

export interface TurnAwaitTurnDone {
  type: "awaitTurnDone";
}

export interface TurnGap {
  type: "gap";
  ms: number;
}

export interface TurnBargeIn {
  type: "bargeIn";
  text: string;
}

export type Turn = TurnSay | TurnAwaitTurnDone | TurnGap | TurnBargeIn;

export type Score = Turn[];

export type ScoreName = "spike" | "dictation" | "approval" | "bargein";

// ── Factory helpers ──────────────────────────────────────────────────────────

export function say(text: string): TurnSay {
  return { type: "say", text };
}

export function awaitTurnDone(): TurnAwaitTurnDone {
  return { type: "awaitTurnDone" };
}

export function gap(ms: number = 500): TurnGap {
  return { type: "gap", ms };
}

export function bargeIn(text: string): TurnBargeIn {
  return { type: "bargeIn", text };
}

// ── Validator ────────────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

function validateTurn(turn: Turn, index: number, hasPrecedingModelWait: boolean): ValidationResult {
  if (turn.type === "say") {
    if (!turn.text || turn.text.trim().length === 0) {
      return { valid: false, error: `say turn at index ${index} has empty or whitespace text` };
    }
  } else if (turn.type === "bargeIn") {
    if (!turn.text || turn.text.trim().length === 0) {
      return { valid: false, error: `bargeIn turn at index ${index} has empty or whitespace text` };
    }
    if (!hasPrecedingModelWait) {
      return { valid: false, error: `bargeIn turn at index ${index} has no preceding model-turn wait (awaitTurnDone)` };
    }
  }
  return { valid: true };
}

export function validateScore(score: Score): ValidationResult {
  if (!Array.isArray(score) || score.length === 0) {
    return { valid: false, error: "Score must be a non-empty array of Turns" };
  }

  let hasPrecedingModelWait = false;
  for (let i = 0; i < score.length; i++) {
    const turn = score[i];
    if (turn.type === "awaitTurnDone") {
      hasPrecedingModelWait = true;
    }
    const result = validateTurn(turn, i, hasPrecedingModelWait);
    if (!result.valid) {
      return result;
    }
  }

  return { valid: true };
}

// ── Four Built-in Scores ────────────────────────────────────────────────────

export const SCORES: Record<ScoreName, Score> = {
  // Spike is deliberately a NEUTRAL statement (no imperative): its only job is proving the
  // real Gemini ASR transcribes SAPI TTS speech — it must not tempt the model into tool calls.
  spike: [
    say("This is a microphone check for the synthetic operator lane."),
    awaitTurnDone(),
  ],
  // Conversational, NON-actionable turns (keyed-run incident 2026-07-22): placeholder phrases like
  // "first dictation phrase" read as things-to-do, so the model sometimes proposes a command instead
  // of replying — cleaner realistic dictation traces come from plain talk it can only answer.
  dictation: [
    say("Good morning. Can you hear me clearly on the line?"),
    awaitTurnDone(),
    gap(500),
    say("Great, thank you. That is all I needed to check for now."),
    awaitTurnDone(),
    gap(500),
  ],
  // Benign, concrete imperative (review fix — was "Delete production database", which risks the
  // spoken destructive-confirm protocol and model refusals): with the pane gate armed to Ask,
  // this reliably yields propose_command -> pending approval for the spoken "approve" to resolve.
  approval: [
    say("Please run the command echo hello in the active pane."),
    awaitTurnDone(),
    say("approve"),
    awaitTurnDone(),
  ],
  bargein: [
    say("Explain quantum physics in detail"),
    awaitTurnDone(),
    bargeIn("Stop, next topic"),
    awaitTurnDone(),
  ],
};
