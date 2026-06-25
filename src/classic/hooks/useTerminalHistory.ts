// src/classic/hooks/useTerminalHistory.ts — the active-pane command-history layer, extracted VERBATIM
// out of src/App.tsx's AppRaw() (bead dbt4 — App.tsx decomposition, mirroring the gold-standard
// src/classic/hooks/useStdoutStream.ts / src/hooks/useLiveSession.ts seam: params-interface in,
// returns-interface out, pure decisions split into the node:test-pinned
// src/classic/helpers/historyLogic.ts sibling).
//
// Owns:
//   * showHistoryPanel / historyList / selectedHistoryEntry — the history-panel UI state.
//   * fetchActiveTerminalHistory(terminalId?) — GET the active pane's command history (defaults the id
//     to the App-supplied activeTerminalId, exactly as the original did).
//   * clearActiveTerminalHistory() — POST the clear, then empty the list + drop the selection.
//   * the 5s history-poll effect — while the panel is open on an active pane, re-fetch every 5000ms
//     (and once immediately); the interval is torn down on panel/pane change. The arm-gate
//     (showHistoryPanel && activeTerminalId) and the cadence are pinned in historyLogic.
//
// NOTE on call sites that STAY in App: the active-pane-change effect and the history-panel toggle
// button both CALL fetchActiveTerminalHistory — those keep their original call order/args and now
// invoke THIS hook's returned fetcher (identity is stable per render, same as the former body fn).
//
// *** NO HARNESS COUPLING ***: setHistoryList / setShowHistoryPanel / setSelectedHistoryEntry are NOT
// wired into the e2e harness (E2EHarnessDeps owns setTerminals / setActiveTerminalId / etc., not
// these), so no identity needs to be threaded into useE2EHarness for this hook.
//
// Behavior is byte-identical to the former App body: same default-arg fetcher, same try/catch +
// console.error sites, same immediate-fetch-then-5s-poll, same interval cleanup.

import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { apiFetch } from "../../utils/api";
import { HISTORY_POLL_INTERVAL_MS, shouldPollHistory } from "../helpers/historyLogic";

/** One command-history row, as returned by GET /api/terminals/:id/history. */
export interface HistoryEntry {
  command: string;
  timestamp: string;
  output: string;
}

export interface TerminalHistoryParams {
  /** The pane the history panel tracks — defaults the fetcher's id and gates the poll. */
  activeTerminalId: string | null;
}

export interface TerminalHistory {
  showHistoryPanel: boolean;
  setShowHistoryPanel: Dispatch<SetStateAction<boolean>>;
  historyList: HistoryEntry[];
  selectedHistoryEntry: HistoryEntry | null;
  setSelectedHistoryEntry: Dispatch<SetStateAction<HistoryEntry | null>>;
  /** GET the active pane's history (id defaults to the App-supplied activeTerminalId). */
  fetchActiveTerminalHistory: (terminalId?: string | null) => Promise<void>;
  /** POST the clear for the active pane, then empty the list + drop the selection. */
  clearActiveTerminalHistory: () => Promise<void>;
}

export function useTerminalHistory(params: TerminalHistoryParams): TerminalHistory {
  const { activeTerminalId } = params;

  const [showHistoryPanel, setShowHistoryPanel] = useState<boolean>(false);
  const [historyList, setHistoryList] = useState<HistoryEntry[]>([]);
  const [selectedHistoryEntry, setSelectedHistoryEntry] = useState<HistoryEntry | null>(null);

  const fetchActiveTerminalHistory = async (terminalId: string | null = activeTerminalId) => {
    if (!terminalId) return;
    try {
      const res = await apiFetch(`/api/terminals/${terminalId}/history`);
      if (res.ok) {
        const data = await res.json();
        setHistoryList(data);
      }
    } catch (e) {
      console.error("Failed to load terminal history:", e);
    }
  };

  const clearActiveTerminalHistory = async () => {
    if (!activeTerminalId) return;
    try {
      const res = await apiFetch(`/api/terminals/${activeTerminalId}/history/clear`, {
        method: "POST"
      });
      if (res.ok) {
        setHistoryList([]);
        setSelectedHistoryEntry(null);
      }
    } catch (e) {
      console.error("Failed to clear terminal history:", e);
    }
  };

  useEffect(() => {
    let interval: NodeJS.Timeout | null = null;
    if (shouldPollHistory(showHistoryPanel, activeTerminalId)) {
      fetchActiveTerminalHistory(activeTerminalId);
      interval = setInterval(() => {
        fetchActiveTerminalHistory(activeTerminalId);
      }, HISTORY_POLL_INTERVAL_MS);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- (re)start the poll on panel/pane change only; fetchActiveTerminalHistory is an unstable body fn, listing it would re-run every render.
  }, [showHistoryPanel, activeTerminalId]);

  return {
    showHistoryPanel,
    setShowHistoryPanel,
    historyList,
    selectedHistoryEntry,
    setSelectedHistoryEntry,
    fetchActiveTerminalHistory,
    clearActiveTerminalHistory,
  };
}
