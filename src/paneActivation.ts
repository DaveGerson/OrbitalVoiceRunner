// src/paneActivation.ts — LEAF module (imports nothing from the action/effect graph) so that BOTH
// src/actions/defs/panes_write.ts (createPaneEffect) and src/actionEffects.ts (buildCreatePane) can
// share ONE pane-activation helper WITHOUT a circular import. (wsm-e2e-pinned-c6b9 originally placed
// this in actionEffects.ts and imported it into panes_write.ts, which formed a panes_write -> actionEffects
// -> ... -> panes_write cycle and crashed module init with "Cannot access 'PANES_WRITE_ACTIONS' before
// initialization". Keeping it in a dependency-free leaf breaks that cycle.)

/** Activate a newly created pane — make it the operator's active WRITE target + broadcast the view
 *  switch — but ONLY for an operator-initiated VOICE create. A REST/recipe/dispatch_group background
 *  spawn must never steal the operator's focus, so a non-voice OR unknown origin does NOT activate
 *  (fail-safe: undefined origin is treated as non-voice, never as voice). The broadcast mirrors
 *  switch_active_pane's wire contract (panes_write.ts) so the browser remounts its xterm on the new
 *  pane and subscribes the PTY stream; without it a voice-created pane leaves the browser on the OLD
 *  pane and the new pane's stdout has no listener ("you can see them, but I can't"). */
export function activateCreatedPane(
  deps: { setActivePane?: (paneId: string | null) => void; broadcast: (msg: any) => void },
  paneId: string | null | undefined,
  origin?: string
): void {
  if (!paneId) return;
  if (origin !== "voice") return; // fail-safe: only an explicit voice origin steals operator focus
  if (deps.setActivePane) {
    deps.setActivePane(paneId);
  }
  deps.broadcast({ type: "switch_active_pane", paneId });
}
