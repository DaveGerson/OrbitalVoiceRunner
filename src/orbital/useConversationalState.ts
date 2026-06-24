// ── ORBITAL · the conversational pill STATE MACHINE ─────────────────────────
// Velocity-design layer (operator decision D7). The Kitchen Radio's status pill is one dot on a
// state line that walks left→right as the kitchen wakes up:
//
//   offline ─▶ tuning ─▶ blocked/muted ─▶ thinking ─▶ listening
//
// The position is DERIVED, never stored: it falls out of the voice-channel booleans the data layer
// already computes (live / connected / micBlocked / muted / reconnecting — same fields KitchenRadio's
// getChip* helpers read) PLUS "tool-call activity" — the activeSources signal — surfaced through the
// transcript's grounding sources. Pure + deterministic by design (Python⇄TS seam: this is frontend
// view-model logic, no Node coupling, no hot path), so the whole machine is one tiny reducer the
// unit suite pins exhaustively, with only a thin useMemo wrapper for React.
//
// INTEGRATION SEAM (cross-branch): the sibling `velocity-mech` branch adds the PURE presentation
// helpers getChipLabel/getChipBg in KitchenRadio.tsx (state → color/label). This branch owns the
// STATE; once both land, the radio chip should read deriveConversationalState(...).kind and route it
// through those helpers. We intentionally do NOT duplicate getChipLabel/getChipBg here.
import { useMemo } from "react";
import type { TranscriptEntry } from "./useOrbitalData";

/** The discrete state of the conversational pill, in wake-up order. */
export type ConversationalKind =
  | "offline"   // off air — no voice session
  | "tuning"    // session requested, socket not yet open
  | "blocked"   // mic denied/failed — named loudly, never faked as "listening"
  | "muted"     // session live, mic intentionally held
  | "thinking"  // a tool/grounding call is in flight (activeSources)
  | "listening"; // steady-state ready ear

export interface ConversationalState {
  kind: ConversationalKind;
  /** Glanceable label for the pill. Presentation color/label mapping is the velocity-mech branch. */
  label: string;
}

/** The raw signals the machine reduces — every field is already computed by useOrbitalData. */
export interface ConversationalSignals {
  /** Voice session requested (data.isLive). */
  live: boolean;
  /** The /live socket is actually OPEN (data.voiceConnected). */
  connected: boolean;
  /** getUserMedia denied/failed (data.micBlocked). */
  micBlocked: boolean;
  /** Mic intentionally held (data.micMuted). */
  muted: boolean;
  /** Bounded auto-reconnect window (data.voiceReconnecting). */
  reconnecting: boolean;
  /** A tool/grounding call is in flight — the "activeSources" signal (see hasToolActivity). */
  toolActive: boolean;
}

// Stable labels per state. Kept separate from the reducer so the precedence ladder stays flat
// (one return per branch) and well under the complexity gate.
const LABELS: Record<ConversationalKind, string> = {
  offline: "off air",
  tuning: "tuning in…",
  blocked: "mic blocked",
  muted: "muted",
  thinking: "thinking…",
  listening: "listening",
};

// SINGLE SOURCE OF TRUTH for chip/pill color (bead m9v). Both surfaces that paint this state — the
// velocity-mech radio status Chip (getChipBg in KitchenRadio.tsx) and the velocity-design nav pill
// dot (OrbitalApp's CONVO_DOT, now removed) — resolve through this one map keyed on the discrete
// kind, so the same state can never render two different colors. The hexes are the canonical values
// getChipBg pinned during the CC burndown; "thinking" is the design-only rung the radio chip never
// reaches (it has no tool-activity input), so it keeps its own accent.
const CHIP_COLORS: Record<ConversationalKind, string> = {
  offline: "#8a6a4f",
  tuning: "#8a6a4f",
  blocked: "#e23a3a",
  muted: "#8a6a4f",
  thinking: "#4b3bb3",
  listening: "#e23a3a",
};

/** The single source of truth: discrete conversational state → status color (chip bg / pill dot). */
export function chipColorForKind(kind: ConversationalKind): string {
  return CHIP_COLORS[kind];
}

/**
 * Tool-call activity off the transcript — the "activeSources" signal. A tool/grounding call is
 * considered in flight when the FRESHEST turn is a Janus turn that resolved at least one grounded
 * source (an older grounded turn does not count: activity is about the most recent turn). Defensive
 * against an undefined transcript so the hook can never throw mid-render.
 */
export function hasToolActivity(transcript: TranscriptEntry[]): boolean {
  if (!transcript || transcript.length === 0) return false;
  const last = transcript[transcript.length - 1];
  if (last.sender !== "Janus") return false;
  const sources = last.grounding?.sources;
  return Array.isArray(sources) && sources.length > 0;
}

/**
 * Pure reducer: signals → discrete pill state. The ladder is a TOTAL, ordered precedence —
 * offline > blocked > tuning > muted > thinking > listening — so exactly one state always wins,
 * and a higher-precedence condition can never be masked by a lower one. Mirrors the same priority
 * KitchenRadio's getChipLabel encodes (not-live → blocked → not-connected → muted → live), with an
 * added "thinking" rung for in-flight tool activity between muted and the steady listening ear.
 */
export function deriveConversationalState(s: ConversationalSignals): ConversationalState {
  const kind = resolveKind(s);
  return { kind, label: LABELS[kind] };
}

function resolveKind(s: ConversationalSignals): ConversationalKind {
  if (!s.live) return "offline";
  if (s.micBlocked) return "blocked";
  if (!s.connected) return "tuning";
  if (s.muted) return "muted";
  if (s.toolActive) return "thinking";
  return "listening";
}

/** Inputs the hook reads straight off useOrbitalData (plus the transcript for activeSources). */
export interface ConversationalInput {
  live: boolean;
  connected: boolean;
  micBlocked: boolean;
  muted: boolean;
  reconnecting: boolean;
  transcript: TranscriptEntry[];
}

/**
 * Thin React wrapper: memoizes the pure reduction so the pill only re-derives when a real signal
 * (or the transcript's tail) changes — additive and perf-safe (no per-frame work, no xterm).
 */
export function useConversationalState(input: ConversationalInput): ConversationalState {
  const { live, connected, micBlocked, muted, reconnecting, transcript } = input;
  const toolActive = useMemo(() => hasToolActivity(transcript), [transcript]);
  return useMemo(
    () => deriveConversationalState({ live, connected, micBlocked, muted, reconnecting, toolActive }),
    [live, connected, micBlocked, muted, reconnecting, toolActive],
  );
}
