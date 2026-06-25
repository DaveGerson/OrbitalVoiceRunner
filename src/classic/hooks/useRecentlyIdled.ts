// src/classic/hooks/useRecentlyIdled.ts — the recently-idled pulse layer, extracted VERBATIM out of
// src/App.tsx's AppRaw() (bead dbt4 — App.tsx decomposition, mirroring the gold-standard
// src/classic/hooks/useStdoutStream.ts / src/hooks/useLiveSession.ts seam: params-interface in,
// returns-interface out, pure decision split into the node:test-pinned
// src/classic/helpers/idleDiff.ts sibling).
//
// Owns:
//   * recentlyIdled — the per-pane "just went idle" flag map that drives the heartbeat-animation
//     class on the sidebar / compact / detailed pane dots.
//   * prevTerminalsRef — the previous-tick terminals snapshot the diff compares against.
//   * the terminals-diff effect — on each terminals change, compute the Running→Idle / stale-clear
//     diff (pure, in idleDiff), set the new flag map iff something moved, arm a 6s clear timer for
//     each newly-idled pane, and record the current terminals as the new previous snapshot.
//
// *** NO HARNESS COUPLING ***: setRecentlyIdled is NOT wired into the e2e harness (E2EHarnessDeps
// owns setTerminals / setActiveTerminalId / etc., not this), so no identity is threaded into
// useE2EHarness for this hook.
//
// Behavior is byte-identical to the former App effect: same diff loop (if/else, first branch wins),
// same `hasChanges`-gated setRecentlyIdled, same 6s per-pane clear timer (with its own no-op guard),
// same prevTerminalsRef bookkeeping, same `[terminals]` dep array with the exhaustive-deps rationale.

import { useEffect, useRef, useState } from "react";
import type { Terminal } from "../../types";
import { computeIdleDiff } from "../helpers/idleDiff";

/** How long a newly-idled pane keeps its heartbeat pulse (ms) — 2 heartbeats, VERBATIM from App. */
const IDLE_PULSE_MS = 6000;

export interface RecentlyIdledParams {
  /** The live terminals list — the diff is keyed to its changes. */
  terminals: Terminal[];
}

export interface RecentlyIdled {
  /** Per-pane "just went idle" flag map (drives the heartbeat-animation class). */
  recentlyIdled: Record<string, boolean>;
}

export function useRecentlyIdled(params: RecentlyIdledParams): RecentlyIdled {
  const { terminals } = params;

  const [recentlyIdled, setRecentlyIdled] = useState<Record<string, boolean>>({});
  const prevTerminalsRef = useRef<Terminal[]>([]);

  useEffect(() => {
    const prev = prevTerminalsRef.current;
    const { nextRecentlyIdled, hasChanges, newlyIdledIds } = computeIdleDiff(prev, terminals, recentlyIdled);

    // Remove animation after 6 seconds (2 heartbeats) for each pane that just went idle.
    newlyIdledIds.forEach((id) => {
      setTimeout(() => {
        setRecentlyIdled(current => {
          if (!current[id]) return current;
          const updated = { ...current };
          delete updated[id];
          return updated;
        });
      }, IDLE_PULSE_MS);
    });

    if (hasChanges) {
      setRecentlyIdled(nextRecentlyIdled);
    }

    prevTerminalsRef.current = terminals;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- diff is intentionally keyed to terminals changes only; adding recentlyIdled would re-run on its own setState (incl. setTimeout) and re-register timers. Reading the latest recentlyIdled snapshot is fine here.
  }, [terminals]);

  return { recentlyIdled };
}
