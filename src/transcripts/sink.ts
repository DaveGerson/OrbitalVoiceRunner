// src/transcripts/sink.ts
//
// Durable transcript sink (bead 98f2). OPT-IN persistence of BOTH voice channels — operator ASR and
// Janus narration — fed straight from src/liveTranscripts.ts's `extractTranscripts` output. THE
// REDACTION BOUNDARY: every channel's text is scrubbed with `redactSecrets` (src/terminal.ts) BEFORE
// it reaches `store.recordTranscript` — the store persists `text_redacted` verbatim, exactly the
// same contract as `exchange_events.payload_redacted_json`. Never throws (voice hot path safety):
// a sink or DB fault must degrade silently, never break voice dispatch.

import type { JanusStore } from "../store/sqliteStore";
import { redactSecrets } from "../terminal";
import { TRANSCRIPT_SINK_ENABLED } from "./flag";

export interface LiveTranscriptsInput {
  /** The operator's words (ASR channel). */
  operator: string;
  /** The model's spoken text (modelTurn parts) — used only when `modelThinking` is blank. */
  model: string;
  /** The model's transcribed narration / "thinking" (outputTranscription) — the preferred source
   *  for the 'model' channel row (Janus narration), falling back to `model` when blank. */
  modelThinking: string;
}

export interface TranscriptCorrelationCtx {
  sessionId?: string | null;
  projectId?: string | null;
  paneId?: string | null;
  interactionId?: string | null;
}

/** The 'model' channel prefers `modelThinking` (Janus narration), falling back to `model`
 *  (modelTurn parts) only when the narration is blank. Trimmed; never null/undefined. */
function pickModelText(transcripts: LiveTranscriptsInput): string {
  const thinking = transcripts.modelThinking.trim();
  if (thinking) return thinking;
  return transcripts.model.trim();
}

/** The four correlation columns every transcript row carries, defaulted to null. */
function correlationColumns(ctx: TranscriptCorrelationCtx): {
  session_id: string | null; project_id: string | null; pane_id: string | null; interaction_id: string | null;
} {
  return {
    session_id: ctx.sessionId ?? null,
    project_id: ctx.projectId ?? null,
    pane_id: ctx.paneId ?? null,
    interaction_id: ctx.interactionId ?? null,
  };
}

/** Persist one channel's text, redacted, when non-blank. A no-op for an empty (post-trim) channel
 *  — no blank-text rows. */
function persistChannel(
  store: JanusStore,
  channel: "operator" | "model",
  text: string,
  base: ReturnType<typeof correlationColumns>,
): void {
  if (!text) return;
  store.recordTranscript({ channel, text_redacted: redactSecrets(text), ...base });
}

/** Persist BOTH transcript channels (operator ASR + Janus narration), redacted at write, when the
 *  sink is enabled. No-op when `!enabled` or `!store` — the sink is a hard no-op unless explicitly
 *  opted in. Empty (post-trim) channels are skipped — no blank-text rows. Never throws: any error
 *  is swallowed + logged, mirroring the voice hot path's never-throw contract. */
export function recordLiveTranscripts(
  store: JanusStore | null | undefined,
  transcripts: LiveTranscriptsInput,
  ctx: TranscriptCorrelationCtx = {},
  enabled: boolean = TRANSCRIPT_SINK_ENABLED,
): void {
  if (!enabled || !store) return;
  try {
    const base = correlationColumns(ctx);
    persistChannel(store, "operator", transcripts.operator.trim(), base);
    persistChannel(store, "model", pickModelText(transcripts), base);
  } catch (e) {
    console.error("[transcripts] recordLiveTranscripts failed (continuing, voice dispatch unaffected):", e);
  }
}
