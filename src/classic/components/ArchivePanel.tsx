// src/classic/components/ArchivePanel.tsx — the classic Pane Archive panel, extracted VERBATIM out
// of src/App.tsx (App.tsx decomposition, chunk-6 "terminal-view + dashboard chrome", section 1).
// Was the inner IIFE `{(() => ( <div className="mt-6 ..."> ... </div> ))()}` nested at the BOTTOM of
// the Artifacts & Memory Registry panel. DOM is byte-identical, including the archived-count badge,
// the empty-state copy, and the `new Date(item.archived_at).toLocaleString()` formatting.
//
// EXTRACTED FIRST (this nests inside ArtifactsRegistryPanel, which renders <ArchivePanel/>).
//
// Module imports kept (NOT threaded as props): the lucide icons (Layers, RefreshCw, Trash2).
// `archive` is the recoverable-pane list (useLedgerData, `any[]`); showArchivePanel is a plain
// useState boolean. setShowArchivePanel / handleRestoreArchived / handleDeleteArchived / fetchArchive
// stay in App and arrive here as props (the mutation handlers route through the App orchestration).

import * as React from "react";
import { Layers, RefreshCw, Trash2 } from "lucide-react";

export function ArchivePanel({
  archive,
  showArchivePanel,
  setShowArchivePanel,
  handleRestoreArchived,
  handleDeleteArchived,
  fetchArchive,
}: {
  archive: any[];
  showArchivePanel: boolean;
  setShowArchivePanel: React.Dispatch<React.SetStateAction<boolean>>;
  handleRestoreArchived: (paneId: string) => void;
  handleDeleteArchived: (paneId: string) => void;
  fetchArchive: () => void;
}) {
  return (
    <div className="mt-6 bg-[#0b0b0b] border border-white/5 rounded-lg overflow-hidden">
      <button
        onClick={() => setShowArchivePanel(prev => !prev)}
        className="w-full flex items-center justify-between px-5 py-3 hover:bg-white/[0.02] transition-colors select-none"
      >
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-zinc-500" />
          <span className="text-xs font-mono uppercase text-zinc-400 font-bold tracking-wider">Pane Archive</span>
          {archive.length > 0 && (
            <span className="text-xs font-mono px-1.5 py-0.5 bg-zinc-800 text-zinc-400 rounded uppercase">{archive.length} archived</span>
          )}
        </div>
        <span className="text-zinc-600 text-xs font-mono">{showArchivePanel ? "▲ hide" : "▼ show"}</span>
      </button>

      {showArchivePanel && (
        <div className="border-t border-white/5 p-5 space-y-3">
          <p className="text-xs text-zinc-500 font-mono">
            Exited panes moved here via "Clear Exited". Restore to bring them back into the ledger, or permanently delete.
          </p>
          {archive.length === 0 ? (
            <div className="p-6 text-center text-zinc-600 text-xs italic border border-dashed border-white/5 rounded">
              Archive is empty. Clear exited panes to populate it.
            </div>
          ) : (
            <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
              {archive.map((item) => (
                <div key={item.pane_id} className="p-3 bg-black/30 border border-white/5 rounded font-mono text-xs flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-bold text-zinc-300 truncate">{item.name}</span>
                      <span className="text-xs px-1 py-0.2 rounded bg-zinc-800 text-zinc-500 uppercase">{item.tool_preset || "Custom"}</span>
                    </div>
                    <div className="text-xs text-zinc-500 mt-0.5 space-x-2">
                      <span>Project: <span className="text-zinc-400">{item.project_id}</span></span>
                      {item.last_command && <span>Last cmd: <span className="text-zinc-400 truncate max-w-[140px] inline-block align-bottom">{item.last_command}</span></span>}
                    </div>
                    <div className="text-xs text-zinc-600 mt-0.5">
                      Archived: {new Date(item.archived_at).toLocaleString()}
                    </div>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button
                      onClick={() => handleRestoreArchived(item.pane_id)}
                      className="text-xs font-mono uppercase px-2 py-1 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 border border-cyan-500/20 hover:border-cyan-500/30 rounded cursor-pointer transition-colors"
                      title="Restore this pane back into the project ledger"
                    >
                      Restore
                    </button>
                    <button
                      onClick={() => handleDeleteArchived(item.pane_id)}
                      className="text-xs font-mono uppercase px-2 py-1 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 hover:border-red-500/30 rounded cursor-pointer transition-colors"
                      title="Permanently delete this archived pane"
                    >
                      <Trash2 className="w-2.5 h-2.5 inline mr-0.5" />
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="flex justify-end pt-1">
            <button
              onClick={fetchArchive}
              className="text-xs font-mono uppercase text-zinc-500 hover:text-zinc-300 flex items-center gap-1 transition-colors"
              title="Refresh archive"
            >
              <RefreshCw className="w-2.5 h-2.5" /> Refresh
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
