// Single-active-pane guard (prompt-composer refactor, step 5).
//
// The pane the operator has open on screen is the SINGLE source of truth for where Janus may
// write. Janus proposes only to that pane, so the operator can SEE the command before it lands
// and improve it under HiTL. A proposal aimed at any other pane is refused (never written);
// Janus must ask the operator to switch panes first (operator-directed `switch_active_pane`).
//
// `activePaneId` is null when no pane is open in the UI (or no UI is connected). In that case
// there is no source of truth, so no write is permitted.

export function isPaneActiveForWrite(activePaneId: string | null, targetPaneId: string): boolean {
  return activePaneId !== null && activePaneId === targetPaneId;
}

/** The model-facing explanation when a proposal is refused for not targeting the active pane. */
export function inactivePaneClarify(activePaneId: string | null, targetPaneId: string): string {
  return activePaneId
    ? `I can only act on the pane you have open ('${activePaneId}'). Ask me to switch to '${targetPaneId}', or open it yourself, first.`
    : `No pane is open in the UI right now, so there is nowhere I can write. Open the pane you want to work in first.`;
}
