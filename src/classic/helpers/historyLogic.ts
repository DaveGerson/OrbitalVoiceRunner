// src/classic/helpers/historyLogic.ts — pure, browser-API-free decision helper for the active-pane
// command-history hook (useTerminalHistory). Extracted out of src/App.tsx (bead dbt4 — App.tsx
// decomposition, mirroring the src/classic/helpers/earconLogic.ts / src/hooks/liveSessionLogic.ts
// gold-standard seam). The fetch/clear I/O and the 5s poll timer are irreducibly App/DOM-coupled and
// stay in the hook; this module pins the ONE pure piece — the gate that decides whether the
// history-panel poll should run at all.
//
// Behavior is VERBATIM from the original App.tsx body: the poll effect armed iff
//   showHistoryPanel && activeTerminalId
// so the predicate here returns true on exactly that conjunction. See tests/test_history_logic.ts.

/** The history-panel poll cadence (ms) — VERBATIM from the original App.tsx setInterval. */
export const HISTORY_POLL_INTERVAL_MS = 5000;

/**
 * Whether the active-pane history poll should be armed, given the panel-open toggle and the active
 * terminal id. Pure: the caller passes the current React state in; a null/empty active id never polls.
 */
export function shouldPollHistory(showHistoryPanel: boolean, activeTerminalId: string | null): boolean {
  return showHistoryPanel && !!activeTerminalId;
}
