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
  turnStartClockMs: number;
  gapStartClockMs: number | null;
  lastAudioClockMs: number | null;
  lastJanusTranscriptClockMs: number | null;
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
  if (state.maxTurnMs !== undefined) {
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
    return { type: "START_UTTERANCE", index: currentIndex, text: turn.text };
  }

  advanceTurn(state);
  return { type: "WAIT" };
}

function isModelQuiescent(state: ConductorState): boolean {
  if (state.lastJanusTranscriptClockMs === null) {
    return false;
  }
  const lastSignalMs = state.lastAudioClockMs !== null
    ? Math.max(state.lastAudioClockMs, state.lastJanusTranscriptClockMs)
    : state.lastJanusTranscriptClockMs;

  return state.clockMs - lastSignalMs >= state.quiescenceMs;
}

function reduceAwaitModel(state: ConductorState): Command {
  const nextTurn = state.score[state.turnIndex + 1];
  if (nextTurn && nextTurn.type === "bargeIn" && state.lastAudioClockMs !== null) {
    advanceTurn(state);
    return reduceBargeIn(state, nextTurn);
  }

  if (state.approvalPending && !state.approvalResolved) {
    const remainingTurns = state.score.slice(state.turnIndex + 1);
    const hasApproveSay = remainingTurns.some((t) => t.type === "say" && t.text === "approve");
    if (!hasApproveSay) {
      return { type: "WAIT" };
    }
    advanceTurn(state);
    return runStep(state);
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

// ── Main Conductor Factory ───────────────────────────────────────────────────

export function createConductor(score: Score, cfg: ConductorConfig = {}): Conductor {
  const state: ConductorState = {
    score,
    quiescenceMs: cfg.quiescenceMs ?? 1200,
    maxTurnMs: cfg.maxTurnMs,
    turnIndex: 0,
    clockMs: 0,
    turnStartClockMs: 0,
    gapStartClockMs: null,
    lastAudioClockMs: null,
    lastJanusTranscriptClockMs: null,
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
      if (frame.type === "transcript_text") {
        // WIRE FIDELITY (review fix): the server emits sender "User" / "Janus" EXACTLY
        // (src/voice/index.ts:1870 and the Janus twin) — match exactly, ignore unknown senders.
        // A substring/lowercase match would count the operator's own ASR echo as a Janus
        // transcript and trigger premature turn-over.
        if (frame.sender === "User") {
          state.userTranscripts++;
        } else if (frame.sender === "Janus") {
          state.janusTranscripts++;
          state.lastJanusTranscriptClockMs = state.clockMs;
        }
      } else if (frame.type === "audio") {
        state.lastAudioClockMs = state.clockMs;
      } else if (frame.type === "approval_pending") {
        state.approvalPending = true;
      } else if (frame.type === "approval_resolved") {
        if (frame.outcome === "approved" || !frame.outcome) {
          state.approvalResolved = true;
          state.approvalResolvedCount++;
        }
      } else if (frame.type === "interrupted") {
        state.interrupted = true;
        state.interruptedCount++;
      }
    },

    onClock(nowMs: number): void {
      state.clockMs = nowMs;
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
