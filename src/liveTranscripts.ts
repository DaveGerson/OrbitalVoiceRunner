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

/** Read operator/model transcripts from a LiveServerMessage. Pure; never throws on malformed input. */
export function extractTranscripts(message: any): LiveTranscripts {
  const sc = message?.serverContent;
  let operator = "";
  let model = "";

  // Operator ASR — the REAL channel is inputTranscription. The legacy turn/userTurn casts are a
  // FALLBACK used ONLY when inputTranscription is absent (this model populates one channel per
  // message, never both — but prefer-then-fallback stays correct even if that ever changes; we must
  // not concatenate the legacy casts onto a real transcript).
  const inputTx = sc?.inputTranscription?.text;
  if (typeof inputTx === "string" && inputTx.length > 0) {
    operator = inputTx;
  } else {
    for (const part of sc?.turn?.parts ?? []) if (part?.text) operator += part.text;
    for (const part of sc?.userTurn?.parts ?? []) if (part?.text) operator += part.text;
  }

  // Model spoken text.
  for (const part of sc?.modelTurn?.parts ?? []) if (part?.text) model += part.text;

  // Model narration / "thinking" transcription.
  const outputTx = sc?.outputTranscription?.text;
  const modelThinking = typeof outputTx === "string" ? outputTx : "";

  return { operator, model, modelThinking };
}
