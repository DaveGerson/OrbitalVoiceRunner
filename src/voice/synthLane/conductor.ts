// src/voice/synthLane/conductor.ts — Pure injectable turn-taking state machine
// bead wsm-e2e-pinned-t5hb (LIVE-SYNTH lane Unit 2)

import type { Score, Turn } from "./scores";

export interface ConductorConfig {
  quiescenceMs?: number;
  maxTurnMs?: number;
}

export type CommandType =
  | "START_UTTERANCE"
  | "WAIT"
  | "BARGE_IN"
  | "SCENARIO_DONE"
  | "SCENARIO_FAILED";

export interface Command {
  type: CommandType;
  index?: number;
  text?: string;
  reason?: string;
}

export interface Outcome {
  status: "IN_PROGRESS" | "DONE" | "FAILED";
  userTranscripts: number;
  janusTranscripts: number;
  modelBubbles: number;
  approvalResolvedCount: number;
  interruptedCount: number;
  approvalResolved: boolean;
  interrupted: boolean;
  failureReason?: string;
}

export interface FrameInput {
  type: string;
  sender?: string;
  outcome?: string;
  [key: string]: any;
}

export interface Conductor {
  onFrame(frame: FrameInput): void;
  onClock(nowMs: number): void;
  step(): Command;
  outcome(): Outcome;
}

// ── State Interface for Internal Helpers ─────────────────────────────────────

interface ConductorState {
  score: Score;
  quiescenceMs: number;
  maxTurnMs?: number;
  turnIndex: number;
  clockMs: number;
  /** null until the first onClock — the clock BASIS is caller-defined (epoch wall-clock ms in
   *  the real runner, small integers in tests), so a zero init would make the first
   *  checkTimeout see elapsed ~= the entire epoch and insta-fail (keyed-run incident 2026-07-22). */
  turnStartClockMs: number | null;
  gapStartClockMs: number | null;
  lastAudioClockMs: number | null;
  lastJanusTranscriptClockMs: number | null;
  /** Clock of the LAST model-side signal of ANY kind this turn — Janus transcript, audio frame,
   *  OR tool activity (action_activity). null until the model produces its first signal this turn.
   *  Turn-over keys off THIS, not the Janus transcript alone (keyed-run incident 2026-07-22, run 5):
   *  a real voice turn can be pure-TOOL (list_panes/switch_context/propose_command) with zero spoken
   *  transcript, so requiring a Janus bubble hung the whole scenario at maxTurnMs. */
  lastModelSignalClockMs: number | null;
  approvalPending: boolean;
  approvalResolved: boolean;
  interrupted: boolean;
  utteredIndices: Set<number>;
  bargeEmittedIndices: Set<number>;
  userTranscripts: number;
  janusTranscripts: number;
  modelBubbles: number;
  approvalResolvedCount: number;
  interruptedCount: number;
  status: "IN_PROGRESS" | "DONE" | "FAILED";
  failureReason?: string;
}

// ── Reducer Helpers (CC <= 10 guaranteed) ────────────────────────────────────

function advanceTurn(state: ConductorState): void {
  state.turnIndex++;
  state.turnStartClockMs = state.clockMs;
  state.gapStartClockMs = state.clockMs;
}

function checkTimeout(state: ConductorState): Command | null {
  if (state.maxTurnMs !== undefined && state.turnStartClockMs !== null) {
    const elapsed = state.clockMs - state.turnStartClockMs;
    if (elapsed > state.maxTurnMs) {
      state.status = "FAILED";
      state.failureReason = `Turn timeout: maxTurnMs (${state.maxTurnMs}ms) exceeded`;
      return { type: "SCENARIO_FAILED", reason: state.failureReason };
    }
  }
  return null;
}

function reduceSay(state: ConductorState, turn: Extract<Turn, { type: "say" }>): Command {
  if (turn.text === "approve" && !state.approvalPending) {
    return { type: "WAIT" };
  }

  const currentIndex = state.turnIndex;
  if (!state.utteredIndices.has(currentIndex)) {
    state.utteredIndices.add(currentIndex);
    advanceTurn(state);
    // Reset model-signal timestamps at each new utterance: the following awaitTurnDone must
    // complete on a FRESH Janus transcript + quiescence, never on turn N-1's stale signals
    // (review fix: cross-turn staleness caused instant premature turn-over). Deliberately NOT
    // reset on the awaitModel->bargeIn advance — the barge gate needs the flowing-audio evidence.
    state.lastAudioClockMs = null;
    state.lastJanusTranscriptClockMs = null;
    state.lastModelSignalClockMs = null;
    return { type: "START_UTTERANCE", index: currentIndex, text: turn.text };
  }

  advanceTurn(state);
  return { type: "WAIT" };
}

function isModelQuiescent(state: ConductorState): boolean {
  // A turn completes once the model has produced SOME signal this turn (speech, audio, OR tool
  // activity) and then gone quiet for quiescenceMs. Keying off any-signal (not the Janus
  // transcript alone) is what makes a pure-tool turn end instead of hanging to maxTurnMs.
  if (state.lastModelSignalClockMs === null) {
    return false;
  }
  return state.clockMs - state.lastModelSignalClockMs >= state.quiescenceMs;
}

function reduceAwaitModel(state: ConductorState): Command {
  const nextTurn = state.score[state.turnIndex + 1];
  if (nextTurn && nextTurn.type === "bargeIn" && state.lastAudioClockMs !== null) {
    advanceTurn(state);
    return reduceBargeIn(state, nextTurn);
  }

  // Approval gating applies ONLY to a score that actually has a spoken "approve" ahead. An
  // INCIDENTAL approval_pending (keyed-run incident 2026-07-22: the model proposed a command off
  // an ambiguous dictation phrase, emitting approval_pending to the voice client) must NOT block a
  // non-approval score — fall through to normal quiescence so the turn still completes.
  const remainingTurns = state.score.slice(state.turnIndex + 1);
  const wantsApprove = remainingTurns.some((t) => t.type === "say" && t.text === "approve");
  if (wantsApprove && !state.approvalResolved) {
    if (state.approvalPending) {
      advanceTurn(state);
      return runStep(state);
    }
    return { type: "WAIT" }; // this score WANTS the pending — wait for it, don't advance early.
  }

  if (isModelQuiescent(state)) {
    state.modelBubbles++;
    advanceTurn(state);
    return runStep(state);
  }

  return { type: "WAIT" };
}

function reduceBargeIn(state: ConductorState, turn: Extract<Turn, { type: "bargeIn" }>): Command {
  if (state.interrupted) {
    advanceTurn(state);
    return runStep(state);
  }

  const lastAudio = state.lastAudioClockMs;
  const audioFlowing = lastAudio !== null && state.clockMs - lastAudio < state.quiescenceMs;

  // Fire-once guard (review fix): without it every step() during flowing audio re-emits
  // BARGE_IN and the runner would stream the barge utterance repeatedly until `interrupted`.
  if (audioFlowing && !state.bargeEmittedIndices.has(state.turnIndex)) {
    state.bargeEmittedIndices.add(state.turnIndex);
    return { type: "BARGE_IN", index: state.turnIndex, text: turn.text };
  }

  return { type: "WAIT" };
}

function reduceGap(state: ConductorState, turn: Extract<Turn, { type: "gap" }>): Command {
  if (state.gapStartClockMs === null) {
    state.gapStartClockMs = state.clockMs;
  }

  if (state.clockMs - state.gapStartClockMs >= turn.ms) {
    advanceTurn(state);
    return runStep(state);
  }

  return { type: "WAIT" };
}

function runStep(state: ConductorState): Command {
  if (state.status === "FAILED") {
    return { type: "SCENARIO_FAILED", reason: state.failureReason || "Scenario failed" };
  }

  if (state.turnIndex >= state.score.length) {
    state.status = "DONE";
    return { type: "SCENARIO_DONE" };
  }

  const timeoutCmd = checkTimeout(state);
  if (timeoutCmd) {
    return timeoutCmd;
  }

  const turn = state.score[state.turnIndex];
  switch (turn.type) {
    case "say":
      return reduceSay(state, turn);
    case "awaitTurnDone":
      return reduceAwaitModel(state);
    case "bargeIn":
      return reduceBargeIn(state, turn);
    case "gap":
      return reduceGap(state, turn);
  }
}

// ── Frame intake helpers (split out of onFrame to hold CC <= 10) ──────────────

function recordTranscript(state: ConductorState, frame: FrameInput): void {
  // WIRE FIDELITY (review fix): the server emits sender "User" / "Janus" EXACTLY
  // (src/voice/index.ts:1870 and the Janus twin) — match exactly, ignore unknown senders. A
  // substring/lowercase match would count the operator's own ASR echo as a Janus transcript.
  if (frame.sender === "User") {
    state.userTranscripts++;
  } else if (frame.sender === "Janus") {
    state.janusTranscripts++;
    state.lastJanusTranscriptClockMs = state.clockMs;
    state.lastModelSignalClockMs = state.clockMs;
  }
}

/** audio / action_activity / grounding / approval_pending are all MODEL signals — they keep the
 *  turn "active" so turn-over waits for quiescence (and lets a pure-tool turn complete at all). */
function recordModelSignal(state: ConductorState, frame: FrameInput): void {
  state.lastModelSignalClockMs = state.clockMs;
  if (frame.type === "audio") {
    state.lastAudioClockMs = state.clockMs;
  } else if (frame.type === "approval_pending") {
    state.approvalPending = true;
  }
}

function recordResolution(state: ConductorState, frame: FrameInput): void {
  if (frame.type === "approval_resolved") {
    if (frame.outcome === "approved" || !frame.outcome) {
      state.approvalResolved = true;
      state.approvalResolvedCount++;
    }
  } else if (frame.type === "interrupted") {
    state.interrupted = true;
    state.interruptedCount++;
  }
}

const MODEL_SIGNAL_TYPES = new Set(["audio", "action_activity", "grounding", "approval_pending"]);
const RESOLUTION_TYPES = new Set(["approval_resolved", "interrupted"]);

function applyFrame(state: ConductorState, frame: FrameInput): void {
  const t = frame.type;
  if (t === "transcript_text") recordTranscript(state, frame);
  else if (MODEL_SIGNAL_TYPES.has(t)) recordModelSignal(state, frame);
  else if (RESOLUTION_TYPES.has(t)) recordResolution(state, frame);
}

// ── Main Conductor Factory ───────────────────────────────────────────────────

export function createConductor(score: Score, cfg: ConductorConfig = {}): Conductor {
  const state: ConductorState = {
    score,
    quiescenceMs: cfg.quiescenceMs ?? 1200,
    maxTurnMs: cfg.maxTurnMs,
    turnIndex: 0,
    clockMs: 0,
    turnStartClockMs: null,
    gapStartClockMs: null,
    lastAudioClockMs: null,
    lastJanusTranscriptClockMs: null,
    lastModelSignalClockMs: null,
    approvalPending: false,
    approvalResolved: false,
    interrupted: false,
    utteredIndices: new Set(),
    bargeEmittedIndices: new Set(),
    userTranscripts: 0,
    janusTranscripts: 0,
    modelBubbles: 0,
    approvalResolvedCount: 0,
    interruptedCount: 0,
    status: "IN_PROGRESS",
  };

  return {
    onFrame(frame: FrameInput): void {
      applyFrame(state, frame);
    },

    onClock(nowMs: number): void {
      state.clockMs = nowMs;
      // First observed clock defines the basis for the first turn's timeout window.
      if (state.turnStartClockMs === null) state.turnStartClockMs = nowMs;
    },

    step(): Command {
      return runStep(state);
    },

    outcome(): Outcome {
      return {
        status: state.status,
        userTranscripts: state.userTranscripts,
        janusTranscripts: state.janusTranscripts,
        modelBubbles: state.modelBubbles,
        approvalResolvedCount: state.approvalResolvedCount,
        interruptedCount: state.interruptedCount,
        approvalResolved: state.approvalResolved,
        interrupted: state.interrupted,
        failureReason: state.failureReason,
      };
    },
  };
}
