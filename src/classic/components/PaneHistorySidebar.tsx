// src/classic/components/PaneHistorySidebar.tsx — the classic collapsible per-pane command-history
// aside, extracted VERBATIM out of src/App.tsx (App.tsx decomposition, chunk-6 "terminal-view +
// dashboard chrome", section 4). Was the inner IIFE `{showHistoryPanel && (() => ( <aside ...> ))()}`
// in the terminal-view sub-tree. The `showHistoryPanel &&` gate STAYS in App
// (`{showHistoryPanel && <PaneHistorySidebar .../>}`); this component is the inner <aside>. DOM is
// byte-identical.
//
// Contents: reload/clear buttons, the reversed `.janus_history` list (per-entry timestamp / copy /
// outcome briefing / stdout-toggle), and the selected-entry stdout reader pane.
//
// LOAD-BEARING FIDELITY:
//   - `[...historyList].reverse()` ordering is preserved EXACTLY (newest-first, non-mutating copy).
//   - The `(entry as any).finalResponse` casts are preserved BYTE-IDENTICAL.
//   - The per-row selected predicate was hoisted to the pure helper historyEntryIsSelected(selected,
//     entry) (appHelpers, char-pinned). It is computed ONCE per row and used three times verbatim:
//     row className, the toggle-to-null click, and the "Hide/Read stdout" label.
//
// Module imports kept (NOT threaded as props): the lucide icons (History, RefreshCw, Trash2, Clock,
// Clipboard). historyList / selectedHistoryEntry are read-only props; fetchActiveTerminalHistory /
// clearActiveTerminalHistory / setSelectedHistoryEntry come from the useTerminalHistory hook (NOT
// the harness) and thread straight through.

import * as React from "react";
import { History, RefreshCw, Trash2, Clock, Clipboard } from "lucide-react";
import { HistoryEntry } from "../hooks/useTerminalHistory";
import { historyEntryIsSelected } from "../../appHelpers";

export function PaneHistorySidebar({
  historyList,
  selectedHistoryEntry,
  fetchActiveTerminalHistory,
  clearActiveTerminalHistory,
  setSelectedHistoryEntry,
}: {
  historyList: HistoryEntry[];
  selectedHistoryEntry: HistoryEntry | null;
  fetchActiveTerminalHistory: (terminalId?: string | null) => void;
  clearActiveTerminalHistory: () => void;
  setSelectedHistoryEntry: React.Dispatch<React.SetStateAction<HistoryEntry | null>>;
}) {
  return (
    <aside className="w-80 border-l border-white/5 bg-[#090909] flex flex-col shrink-0 overflow-hidden">
      <div className="p-4 border-b border-white/5 flex items-center justify-between select-none">
        <div className="flex items-center gap-2">
          <History className="w-4 h-4 text-cyan-400 shrink-0" />
          <span className="text-xs font-mono tracking-wider text-white uppercase font-bold">Local Pane History</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => fetchActiveTerminalHistory()}
            className="p-1 hover:bg-white/5 rounded text-zinc-400 hover:text-white transition-colors"
            title="Reload History"
          >
            <RefreshCw className="w-3 h-3" />
          </button>
          <button
            onClick={clearActiveTerminalHistory}
            className="text-xs uppercase font-mono px-2 py-0.5 bg-white/5 hover:bg-red-500/10 hover:text-red-400 text-zinc-500 rounded border border-transparent hover:border-red-500/20 cursor-pointer focus:outline-none flex items-center gap-1"
            title="Clear command history"
          >
            <Trash2 className="w-2.5 h-2.5" /> Clear
          </button>
        </div>
      </div>

      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Commands List Area */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2.5 scrollbar-thin border-b border-white/5">
          {historyList.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center p-4">
              <History className="w-6 h-6 text-zinc-700 mb-2" />
              <p className="text-xs font-mono text-zinc-500 leading-relaxed max-w-[170px] italic">
                No commands recorded in .janus_history.json
              </p>
            </div>
          ) : (
            [...historyList].reverse().map((entry, idx) => {
              // Burndown: the selected-entry predicate (command+timestamp match, with its
              // optional chains) was inlined THREE times. Compute it ONCE — same value,
              // same three uses — so the map callback's CC drops below the gate.
              const isSelected = historyEntryIsSelected(selectedHistoryEntry, entry);
              return (
              <div
                key={idx}
                onClick={() => setSelectedHistoryEntry(isSelected ? null : entry)}
                className={`group border rounded p-2.5 font-mono cursor-pointer transition-all duration-200 text-left ${
                  isSelected
                    ? "border-cyan-500/40 bg-cyan-950/[0.08]"
                    : "border-white/5 bg-[#121212] hover:border-white/10"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="text-xs text-zinc-500 flex items-center gap-1 shrink-0">
                    <Clock className="w-3 h-3 opacity-60" />
                    {new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      navigator.clipboard.writeText(entry.command);
                    }}
                    className="opacity-100 md:opacity-0 md:group-hover:opacity-100 p-1 hover:bg-white/5 rounded text-zinc-400 hover:text-white transition-opacity duration-200"
                    title="Copy command"
                  >
                    <Clipboard className="w-3 h-3" />
                  </button>
                </div>

                <div className="text-xs text-zinc-200 break-all font-semibold mt-1 bg-black/40 px-2 py-1.5 rounded border border-white/5 select-text">
                  $ {entry.command}
                </div>

                {(entry as any).finalResponse && (
                  <div className="mt-2 text-xs text-zinc-400 font-mono bg-cyan-950/10 border border-cyan-500/15 p-2 rounded flex gap-1.5 items-start">
                    <span className="text-cyan-400 font-bold shrink-0">◇ Outcome Briefing:</span>
                    <span className="leading-relaxed select-text">{(entry as any).finalResponse}</span>
                  </div>
                )}

                {entry.output && (
                  <div className="mt-2 flex items-center justify-between text-xs text-cyan-500/80 uppercase tracking-widest leading-none">
                    <span>{isSelected ? "▲ Hide stdout" : "▼ Read stdout context"}</span>
                    <span className="opacity-40">{entry.output.length} Chars</span>
                  </div>
                )}
              </div>
              );
            })
          )}
        </div>

        {/* Selected stdout reading pane */}
        {selectedHistoryEntry && (
          <div className="h-1/2 flex flex-col bg-black/60 border-t border-white/5 overflow-hidden shrink-0">
            <div className="px-3 py-1.5 border-b border-white/5 bg-[#141414] flex items-center justify-between">
              <span className="text-xs font-mono text-cyan-400 font-bold uppercase tracking-widest">Stdout capture context</span>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(selectedHistoryEntry.output);
                }}
                className="p-1 hover:bg-white/5 rounded text-zinc-400 hover:text-white transition-colors"
                title="Copy captured context"
              >
                <Clipboard className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-3 font-mono text-xs text-zinc-400 leading-normal scrollbar-thin select-text whitespace-pre-wrap selection:bg-cyan-500/30 selection:text-white">
              {selectedHistoryEntry.output || "No output captured for this command."}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
