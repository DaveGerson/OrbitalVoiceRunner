// src/classic/helpers/idleDiff.ts — pure, browser-API-free decision helper for the recently-idled
// pulse hook (useRecentlyIdled). Extracted out of src/App.tsx (bead dbt4 — App.tsx decomposition,
// mirroring the src/classic/helpers/earconLogic.ts / liveSessionLogic.ts gold-standard seam). The 6s
// flag-clear timers (setTimeout → setRecentlyIdled) are irreducibly hook-coupled and stay in the
// hook; this module pins the ONE pure piece — the prev-vs-current terminals diff that decides which
// panes just went Running→Idle (and which stale flags to drop).
//
// Behavior is VERBATIM from the original App.tsx effect body, walking `terminals` in order:
//   * a pane that was Running last tick and is now Idle  → flag it recentlyIdled[id]=true AND record
//     it in newlyIdledIds (the hook arms a 6s clear timer for each of those).
//   * a pane that is now Running but still carries a (pending) flag → drop the flag.
// The first branch wins when both could apply (it's an if/else, exactly as before). `hasChanges`
// tracks whether either branch fired, so the caller only re-sets state when something moved.
// See tests/test_idle_diff.ts.

import type { Terminal } from "../../types";

export interface IdleDiff {
  /** The next recentlyIdled map (a fresh copy — never mutates the input). */
  nextRecentlyIdled: Record<string, boolean>;
  /** Whether anything changed (gates the caller's setRecentlyIdled). */
  hasChanges: boolean;
  /** Pane ids that just transitioned Running→Idle — the hook arms one 6s clear timer per id. */
  newlyIdledIds: string[];
}

/**
 * Diff the previous terminals snapshot against the current one, given the current recentlyIdled map,
 * to decide which panes newly idled (and should pulse) and which stale flags to clear. Pure: returns
 * a fresh map + the newly-idled ids; the caller owns the timers and the prevTerminalsRef bookkeeping.
 */
export function computeIdleDiff(
  prev: Terminal[],
  terminals: Terminal[],
  recentlyIdled: Record<string, boolean>,
): IdleDiff {
  let hasChanges = false;
  const nextRecentlyIdled = { ...recentlyIdled };
  const newlyIdledIds: string[] = [];

  terminals.forEach((term) => {
    const prevTerm = prev.find((p) => p.id === term.id);
    if (prevTerm && prevTerm.status === "Running" && term.status === "Idle") {
      nextRecentlyIdled[term.id] = true;
      hasChanges = true;
      newlyIdledIds.push(term.id);
    } else if (term.status === "Running" && nextRecentlyIdled[term.id]) {
      delete nextRecentlyIdled[term.id];
      hasChanges = true;
    }
  });

  return { nextRecentlyIdled, hasChanges, newlyIdledIds };
}
