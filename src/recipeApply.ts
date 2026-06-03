import type { GateValue } from "./types";

export type RecipePaneDisposition = "spawn" | "defer" | "block" | "skip-existing";

export interface RecipePanePlan {
  paneId: string;
  disposition: RecipePaneDisposition;
}

export interface RecipeApplyPlan {
  /** Layout-level Off veto on apply_recipe — caller refuses the whole layout. */
  layoutForbidden: boolean;
  panes: RecipePanePlan[]; // in recipe order
}

/**
 * Pure planner shared by the voice (`apply_orchestration_recipe`) and REST
 * (`POST /api/recipes/apply`) paths so the two cannot drift again (WF-2 divergence:
 * voice spawned-now on Ask while REST deferred). Mirrors restGateOutcome / buildLaunchCommand:
 * decision logic extracted out of the server so it is unit-testable (no Express/PTY/session boot).
 *
 * resolveLayout / resolvePane return the effective GateValue ("Off"|"Ask"|"Auto") for the
 * apply_recipe (layout) and create_pane (per-pane) capabilities respectively. The caller maps:
 *   spawn         -> run the spawn effect now (Auto)
 *   defer         -> stage in pendingActions (Ask)
 *   block         -> Off veto on create_pane for that pane
 *   skip-existing -> pane already live; do nothing
 */
export function planRecipeApply(
  panes: ReadonlyArray<{ id: string }>,
  livePaneIds: ReadonlySet<string>,
  resolveLayout: () => GateValue,
  resolvePane: (paneId: string) => GateValue,
): RecipeApplyPlan {
  if (resolveLayout() === "Off") {
    return { layoutForbidden: true, panes: [] };
  }
  const out: RecipePanePlan[] = [];
  for (const p of panes) {
    if (livePaneIds.has(p.id)) {
      out.push({ paneId: p.id, disposition: "skip-existing" });
      continue;
    }
    const g = resolvePane(p.id);
    out.push({
      paneId: p.id,
      disposition: g === "Off" ? "block" : g === "Ask" ? "defer" : "spawn",
    });
  }
  return { layoutForbidden: false, panes: out };
}
