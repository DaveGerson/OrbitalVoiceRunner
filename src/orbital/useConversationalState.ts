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
// INTEGRATION SEAM (cross-branch): the KitchenRadio chip now reads deriveConversationalState(...)
// directly (kind → label + chipColorForKind) instead of routing through the older getChipLabel/
// getChipBg boolean ladders — those two functions stay exported (test_chip_color_parity.ts pins
// getChipBg's parity with chipColorForKind) but are RETIRED from the chip's own render path
// (bead 8fz.2). This file owns the STATE, full stop.
import { useMemo } from "react";
import type { TranscriptEntry } from "./useOrbitalData";

/** The discrete state of the conversational pill, in wake-up order. */
export type ConversationalKind =
  | "offline"      // off air — no voice session
  | "tuning"       // session requested, socket not yet open
  | "blocked"      // mic denied/failed — named loudly, never faked as "listening"
  | "reconnecting" // bounded auto-reconnect window after a transient drop (session was live)
  | "muted"        // session live, mic intentionally held
  | "speaking"     // Janus audio is ACTUALLY playing (subscribeAudioPlayback in src/utils/audio.ts)
  | "waiting"      // an attention item carries a resolvable approval (operator action needed)
  | "executing"    // a dispatched/tool write is in flight
  | "thinking"     // a tool/grounding call is in flight (activeSources)
  | "listening";   // steady-state ready ear

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
  /** Janus audio is ACTUALLY playing — derived from src/utils/audio.ts's activeSources via the
   *  subscribeAudioPlayback seam, never inferred from the freshest transcript sender. */
  speaking: boolean;
  /** An attention item carries a resolvable approval target (attentionResolveTarget != null). */
  waiting: boolean;
  /** A dispatched/tool write is in flight. */
  executing: boolean;
  /** A tool/grounding call is in flight — the "activeSources" signal (see hasToolActivity). */
  toolActive: boolean;
}

// Stable labels per state. Kept separate from the reducer so the precedence ladder stays flat
// (one return per branch) and well under the complexity gate. Record totality (compile-enforced)
// means adding a ConversationalKind without a label here is a type error, not a runtime gap.
//
// TEXT PARITY (bead 8fz.2): the KitchenRadio chip used to render the OLD getChipLabel's own
// uppercase strings ("OFF AIR" / "TUNING IN…" / "MIC BLOCKED" / "MUTED" / "● LIVE"), and the
// existing e2e suite (e2e/orbital_radio.spec.ts) asserts on those exact strings. Now that the chip
// reads LABELS directly, the six original entries are byte-exact with getChipLabel's old text so
// that suite (and the new aria-live e2e test) keeps passing unchanged; the four new rungs follow
// the same all-caps house style.
const LABELS: Record<ConversationalKind, string> = {
  offline: "OFF AIR",
  tuning: "TUNING IN…",
  blocked: "MIC BLOCKED",
  reconnecting: "RECONNECTING…",
  muted: "MUTED",
  speaking: "SPEAKING…",
  waiting: "WAITING ON YOU",
  executing: "EXECUTING…",
  thinking: "THINKING…",
  listening: "● LIVE",
};

// SINGLE SOURCE OF TRUTH for chip/pill color (bead m9v). Both surfaces that paint this state — the
// velocity-mech radio status Chip (now via chipColorForKind directly, bead 8fz.2) and the
// velocity-design nav pill dot (OrbitalApp's CONVO_DOT, now removed) — resolve through this one map
// keyed on the discrete kind, so the same state can never render two different colors. The original
// six hexes are the canonical values getChipBg pinned during the CC burndown (test_chip_color_parity
// pins them byte-exact) — untouched here; the four new rungs get their own distinct accents.
const CHIP_COLORS: Record<ConversationalKind, string> = {
  offline: "#8a6a4f",
  tuning: "#8a6a4f",
  blocked: "#e23a3a",
  reconnecting: "#ff8a3d",
  muted: "#8a6a4f",
  speaking: "#2f7a5e",
  waiting: "#c98a16",
  executing: "#1f6fb2",
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
 * offline > blocked > tuning > reconnecting > muted > speaking > waiting > executing > thinking >
 * listening — so exactly one state always wins, and a higher-precedence condition can never be
 * masked by a lower one. `reconnecting` used to be silently dropped (accepted as an input but never
 * consulted); it now outranks muted/speaking so a reconnect while muted is never masked as "muted".
 */
export function deriveConversationalState(s: ConversationalSignals): ConversationalState {
  const kind = resolveKind(s);
  return { kind, label: LABELS[kind] };
}

// Flat ladder of early returns — one branch per rung, no nesting. The full 10-kind, 9-branch
// ladder sits right at the McCabe CC<=10 ceiling (risk noted in the spec), so it's split into two
// single-purpose helpers (5 branches + 4 branches) — each function stays comfortably under both the
// McCabe and cognitive-complexity gates, and the split is itself a rung boundary (idle vs. active
// session), not an arbitrary chop.
function resolveKind(s: ConversationalSignals): ConversationalKind {
  if (!s.live) return "offline";
  if (s.micBlocked) return "blocked";
  if (!s.connected) return "tuning";
  if (s.reconnecting) return "reconnecting";
  if (s.muted) return "muted";
  return resolveActiveKind(s);
}

// The tail of the ladder for a session that's live, connected, not reconnecting, and not muted —
// split out so resolveKind stays a 5-branch function (CC well under the gate) instead of a single
// 9-branch one.
function resolveActiveKind(s: ConversationalSignals): ConversationalKind {
  if (s.speaking) return "speaking";
  if (s.waiting) return "waiting";
  if (s.executing) return "executing";
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
  /** Janus audio is ACTUALLY playing (data.audioPlaying — subscribeAudioPlayback-backed). */
  speaking: boolean;
  /** A resolvable approval is waiting on the operator (data.approvalWaiting). */
  waiting: boolean;
  /** A dispatched/tool write is in flight. */
  executing: boolean;
  transcript: TranscriptEntry[];
}

/**
 * Thin React wrapper: memoizes the pure reduction so the pill only re-derives when a real signal
 * (or the transcript's tail) changes — additive and perf-safe (no per-frame work, no xterm).
 */
export function useConversationalState(input: ConversationalInput): ConversationalState {
  const { live, connected, micBlocked, muted, reconnecting, speaking, waiting, executing, transcript } = input;
  const toolActive = useMemo(() => hasToolActivity(transcript), [transcript]);
  return useMemo(
    () => deriveConversationalState({ live, connected, micBlocked, muted, reconnecting, speaking, waiting, executing, toolActive }),
    [live, connected, micBlocked, muted, reconnecting, speaking, waiting, executing, toolActive],
  );
}
