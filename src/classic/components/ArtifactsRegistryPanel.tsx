// src/classic/components/ArtifactsRegistryPanel.tsx — the classic "Ledger Artifacts & Memory
// Registry" panel, extracted VERBATIM out of src/App.tsx (App.tsx decomposition, chunk-6
// "terminal-view + dashboard chrome", section 2). Was the inner IIFE
// `{(() => ( <div className="mt-12 ..."> ... </div> ))()}` at the bottom of the dashboard view.
// DOM is byte-identical.
//
// Two-column grid:
//   • LEFT  — "Registered Workspaces": projectList with [SWITCH]/[DELETE] + "+ Create Space".
//   • RIGHT — the activeProject's panes (Active RAM vs Idle Registry) with [PRUNE] / Recover.
// Below the grid it renders <ArchivePanel/> (section 1), which was the inner archive IIFE.
//
// Module imports kept (NOT threaded as props): formatCharCount (the pane Context readout). The
// `isLiveProcess = terminals.some(t => t.id === pane.pane_id)` check was hoisted to the pure helper
// isPaneLive(terminals, paneId) (appHelpers, char-pinned). projectList / activeProjectId /
// activeProject / terminals are read-only props; the project/pane mutation handlers
// (handleCreateProject / handleSwitchProject / handleDeleteProjectPrompt / handleDeletePanePrompt /
// handleRestartTerminal) stay in App and arrive here as props. The archive props are threaded
// straight through to <ArchivePanel/>.

import * as React from "react";
import { FileText } from "lucide-react";
import { Workspace, Terminal } from "../../types";
import { formatCharCount, isPaneLive } from "../../appHelpers";
import { ArchivePanel } from "./ArchivePanel";

export function ArtifactsRegistryPanel({
  projectList,
  activeProjectId,
  activeProject,
  terminals,
  handleCreateProject,
  handleSwitchProject,
  handleDeleteProjectPrompt,
  handleDeletePanePrompt,
  handleRestartTerminal,
  archive,
  showArchivePanel,
  setShowArchivePanel,
  handleRestoreArchived,
  handleDeleteArchived,
  fetchArchive,
}: {
  projectList: Workspace[];
  activeProjectId: string;
  activeProject: Workspace | undefined;
  terminals: Terminal[];
  handleCreateProject: () => void;
  handleSwitchProject: (id: string) => void;
  handleDeleteProjectPrompt: (id: string) => void;
  handleDeletePanePrompt: (projId: string, paneId: string) => void;
  handleRestartTerminal: (id: string) => void;
  archive: any[];
  showArchivePanel: boolean;
  setShowArchivePanel: React.Dispatch<React.SetStateAction<boolean>>;
  handleRestoreArchived: (paneId: string) => void;
  handleDeleteArchived: (paneId: string) => void;
  fetchArchive: () => void;
}) {
  return (
    <div className="mt-12 pt-8 border-t border-white/5 space-y-6">
      <div>
        <h2 className="text-sm font-mono text-white tracking-widest uppercase flex items-center gap-2">
          <FileText className="w-4 h-4 text-cyan-400" />
          Ledger Artifacts & Memory Registry
        </h2>
        <p className="text-xs text-zinc-500 font-mono mt-1">
          Manage and inspect workspace configurations, metadata snapshots, and idle session properties stored in memory.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left: Project Context Entities */}
        <div className="bg-[#0b0b0b] border border-white/5 rounded-lg p-5 space-y-4">
          <div className="flex justify-between items-center border-b border-white/5 pb-2">
            <span className="text-xs font-mono uppercase text-zinc-400 font-bold tracking-wider">Registered Workspaces ({projectList.length})</span>
            <button
              onClick={handleCreateProject}
              className="text-xs font-mono uppercase bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 border border-cyan-500/20 px-2 py-0.5 rounded cursor-pointer"
            >
              + Create Space
            </button>
          </div>

          <div className="space-y-2.5 max-h-72 overflow-y-auto pr-1">
            {projectList.map((p) => {
              const isActive = p.id === activeProjectId;
              const paneKeys = Object.keys(p.panes || {});
              return (
                <div key={p.id} className={`p-3 rounded border font-mono text-xs transition-colors ${isActive ? "bg-cyan-500/[0.02] border-cyan-500/20" : "bg-black/30 border-white/5"}`}>
                  <div className="flex justify-between items-center">
                    <span className={`font-bold ${isActive ? "text-cyan-400" : "text-zinc-400"}`}>{p.name?.toUpperCase() || p.id}</span>
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleSwitchProject(p.id)}
                        disabled={isActive}
                        className="text-xs text-zinc-400 hover:text-white disabled:opacity-30 disabled:hover:text-zinc-400 cursor-pointer"
                      >
                        [SWITCH]
                      </button>
                      {projectList.length > 1 && (
                        <button
                          onClick={() => handleDeleteProjectPrompt(p.id)}
                          className="text-xs text-zinc-500 hover:text-red-400 cursor-pointer"
                        >
                          [DELETE]
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="text-xs text-zinc-500 mt-1 space-y-1">
                    <div>Directory: <span className="text-zinc-400 font-bold">{p.directory}</span></div>
                    <div className="flex justify-between text-xs text-zinc-600">
                      <span>Panes registered: {paneKeys.length}</span>
                      <span>Notes: {p.notes?.length || 0}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right: Selected Workspace Panes & Terminal Session Artifacts */}
        <div className="bg-[#0b0b0b] border border-white/5 rounded-lg p-5 space-y-4">
          <div className="flex justify-between items-center border-b border-white/5 pb-2">
            <span className="text-xs font-mono uppercase text-zinc-400 font-bold tracking-wider">
              Stored Sessions of [{(activeProject?.name || activeProjectId).toUpperCase()}]
            </span>
            <span className="text-xs text-zinc-650 font-mono">
              {Object.keys(activeProject?.panes || {}).length} snapshots saved
            </span>
          </div>

          <div className="space-y-2.5 max-h-72 overflow-y-auto pr-1">
            {activeProject && Object.values(activeProject.panes || {}).length > 0 ? (
              Object.values(activeProject.panes).map((pane) => {
                const isLiveProcess = isPaneLive(terminals, pane.pane_id);
                return (
                  <div key={pane.pane_id} className="p-3 bg-black/30 border border-white/5 rounded font-mono text-xs">
                    <div className="flex justify-between items-center">
                      <span className="font-bold text-zinc-300">{pane.name}</span>
                      <div className="flex items-center gap-2">
                        <span className={`text-xs px-1 py-0.2 rounded font-sans uppercase ${
                          isLiveProcess ? "bg-green-500/10 text-green-400" : "bg-zinc-800 text-zinc-500"
                        }`}>
                          {isLiveProcess ? "Active RAM" : "Idle Registry"}
                        </span>
                        <button
                          onClick={() => handleDeletePanePrompt(activeProjectId, pane.pane_id)}
                          className="text-xs text-zinc-500 hover:text-red-400 cursor-pointer"
                          title="De-register module memory object completely"
                        >
                          [PRUNE]
                        </button>
                      </div>
                    </div>
                    <div className="text-xs text-zinc-500 mt-1.5 space-y-1">
                      <div className="flex justify-between">
                        <span>Preset: <span className="text-zinc-400">{pane.tool_preset}</span></span>
                        <span>Policy: <span className="text-zinc-400">{pane.permissions_mode}</span></span>
                      </div>
                      <div className="flex justify-between">
                        <span className="truncate max-w-[140px]">Session ID: <span className="text-zinc-400 text-xs">{pane.session_id || "None"}</span></span>
                        <span>Context: <span className="text-cyan-400 text-xs font-bold">{formatCharCount(pane.context_size)}</span></span>
                      </div>
                      {!isLiveProcess && (
                        <div className="pt-1.5 flex justify-end">
                          <button
                            onClick={() => handleRestartTerminal(pane.pane_id)}
                            className="text-xs text-cyan-400 hover:text-cyan-300 border border-cyan-400/20 px-2 py-0.5 rounded hover:bg-cyan-500/[0.05] cursor-pointer"
                          >
                            Recover & Wake up Engine
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="p-6 text-center text-zinc-600 text-xs italic border border-dashed border-white/5 rounded">
                No pane configuration snapshots saved.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Archive Panel — extracted to ArchivePanel (chunk-6, section 1). Same archive state + the
          restore/delete/refresh handler trio thread straight through. */}
      <ArchivePanel
        archive={archive}
        showArchivePanel={showArchivePanel}
        setShowArchivePanel={setShowArchivePanel}
        handleRestoreArchived={handleRestoreArchived}
        handleDeleteArchived={handleDeleteArchived}
        fetchArchive={fetchArchive}
      />
    </div>
  );
}
