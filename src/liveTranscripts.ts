// src/liveTranscripts.ts — extract operator + model transcripts from a Gemini LiveServerMessage.
//
// THE FIX (RC, proven by the 2026-06 live capture): the operator's spoken words arrive on
// `serverContent.inputTranscription.text` — the ASR channel that the `inputAudioTranscription` config
// enables. The server previously read only the speculative `serverContent.turn/userTurn.parts` casts,
// which this model/config never populates, so `userUtterance` was always empty and the hands-free
// approval parser + dictation capture never ran (every action came from Gemini's own tool calls). This
// reads inputTranscription as the operator source, with the legacy casts kept as a fallback.
//
// Symmetrically, the model's spoken narration ("thinking") arrives on `serverContent.outputTranscription`
// — captured here as `modelThinking` (distinct from `modelTurn.parts`, the spoken text).

export interface LiveTranscripts {
  /** The operator's words (ASR). Fed into userUtterance -> approval parser + dictation + transcript. */
  operator: string;
  /** The model's spoken text (modelTurn parts). */
  model: string;
  /** The model's transcribed narration / "thinking" (outputTranscription). */
  modelThinking: string;
}

/** Concatenate the `.text` of every part (skipping text-less/empty parts), preserving order. */
function joinParts(parts: any): string {
  let out = "";
  for (const part of parts ?? []) if (part?.text) out += part.text;
  return out;
}

/**
 * Operator ASR. The REAL channel is inputTranscription; the legacy turn/userTurn casts are a
 * FALLBACK used ONLY when inputTranscription is absent (this model populates one channel per
 * message, never both — but prefer-then-fallback stays correct even if that ever changes; we must
 * not concatenate the legacy casts onto a real transcript).
 */
function extractOperator(sc: any): string {
  const inputTx = sc?.inputTranscription?.text;
  if (typeof inputTx === "string" && inputTx.length > 0) return inputTx;
  return joinParts(sc?.turn?.parts) + joinParts(sc?.userTurn?.parts);
}

/** Model narration / "thinking" transcription, from outputTranscription (string only). */
function extractModelThinking(sc: any): string {
  const outputTx = sc?.outputTranscription?.text;
  return typeof outputTx === "string" ? outputTx : "";
}

/**
 * wsm-e2e-pinned-zmu5: accumulate one outputTranscription fragment onto the per-turn modelThinking
 * buffer. PLAIN concatenation — no inserted separator, ever. Forensics against the real incident log
 * (ixn_mro7cpfy_9 / ixn_mro7dthy_c) showed every fragment after the first already carries its own
 * leading whitespace (or none, where punctuation abuts, e.g. "apologies" + " again."), so raw `+`
 * already reproduces the spoken sentence byte-for-byte; inserting a synthesized separator when a
 * fragment has NO boundary whitespace on either side would be wrong here too — two single-character
 * fragments like "o" + "k" must join to "ok", not "o k".
 */
export function appendThinkingFragment(buf: string, fragment: string): string {
  return buf + fragment;
}

/** Read operator/model transcripts from a LiveServerMessage. Pure; never throws on malformed input. */
export function extractTranscripts(message: any): LiveTranscripts {
  const sc = message?.serverContent;
  return {
    operator: extractOperator(sc),
    model: joinParts(sc?.modelTurn?.parts),
    modelThinking: extractModelThinking(sc),
  };
}
