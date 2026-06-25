// src/classic/helpers/composerLogic.ts — pure, browser-API-free decision helper for the prompt-buffer
// composer hook (useComposer). Extracted out of src/App.tsx (bead dbt4 — App.tsx decomposition,
// mirroring the src/classic/helpers/historyLogic.ts / src/hooks/liveSessionLogic.ts gold-standard
// seam). The REST/WS I/O and the React state live in the hook; this module pins the ONE pure piece —
// the decision the former `handlePromptBufferChange` made inline about whether to push a draft edit
// over the live socket or fall back to a REST PUT.
//
// Behavior is VERBATIM from the original App.tsx body: the WS branch was taken iff
//   wsRef.current && wsRef.current.readyState === WebSocket.OPEN
// so the predicate here returns true on exactly that conjunction (and the hook then sends over WS;
// otherwise it fires the REST PUT). See tests/test_composer_logic.ts.

/**
 * Whether a draft edit should be pushed over the live WebSocket (vs. the REST-PUT fallback), given
 * the current socket. Pure: the caller passes the socket in; a null/non-OPEN socket → REST fallback.
 * `OPEN` is passed explicitly so this stays free of the DOM `WebSocket` global (Node test-runnable).
 */
export function shouldSendDraftOverWs(
  ws: { readyState: number } | null,
  openState: number,
): boolean {
  return !!ws && ws.readyState === openState;
}
