// src/classic/components/DashboardHeader.tsx — the classic dashboard chrome ABOVE the pane grid,
// extracted VERBATIM out of src/App.tsx (App.tsx decomposition, chunk-6 "terminal-view + dashboard
// chrome", section 5). Was the `<div className="mb-8 select-none ...">` at the top of the dashboard
// view (the "Project Terminal Workspace" title + the grid-mode view switcher + the conditional
// Clear-Exited button). DOM is byte-identical.
//
// *** This is ONLY the chrome ABOVE the grid. The pane grid (filteredPanes.map + the render*Card
// closures) is a SEPARATE later chunk and is NOT part of this component — stop at the grid boundary. ***
//
// LOAD-BEARING FIDELITY: the inner view-switcher IIFE
// `{(() => !isSimpleMode ? ( <view switcher> ) : ( <focus notice> ))()}` is kept INTERNAL VERBATIM
// (the three grid-mode chains leave its scope — the burndown CC choke). The Clear-Exited button keeps
// its `activeProject && countExitedPanes(activeProject.panes, terminals) > 0 &&` guard verbatim.
//
// Module imports kept (NOT threaded as props): countExitedPanes (the Exited-count predicate) + the
// lucide icons (Cpu, Laptop, Smartphone, Tv, Trash2). isSimpleMode / gridDisplayMode / activeProject /
// terminals are read-only props; setGridDisplayMode (plain useState setter) + handleClearExited stay
// in App and arrive as props.

import * as React from "react";
import { Cpu, Laptop, Smartphone, Tv, Trash2 } from "lucide-react";
import { Workspace, Terminal } from "../../types";
import { countExitedPanes } from "../../appHelpers";

export function DashboardHeader({
  isSimpleMode,
  gridDisplayMode,
  activeProject,
  terminals,
  setGridDisplayMode,
  handleClearExited,
}: {
  isSimpleMode: boolean;
  gridDisplayMode: "detailed" | "compact" | "videowall";
  activeProject: Workspace | undefined;
  terminals: Terminal[];
  setGridDisplayMode: (mode: "detailed" | "compact" | "videowall") => void;
  handleClearExited: () => void;
}) {
  return (
    <div className="mb-8 select-none flex flex-col md:flex-row md:items-center md:justify-between gap-4 border-b border-white/5 pb-6">
      <div>
        <h1 className="text-xl font-mono text-white tracking-widest uppercase mb-1 flex items-center gap-2">
          <Cpu className="w-5 h-5 text-cyan-400 shrink-0" />
          Project Terminal Workspace
        </h1>
        <p className="text-xs text-zinc-500 font-mono">
          Active terminal sessions tracking Claude Code, Codex, and Antigravity orchestrator engines.
        </p>
      </div>

      {/* View switcher or inline Focus mode notice — inner IIFE keeps the dashboard IIFE's
          CC under the gate (the 3 grid-mode chains leave its scope). */}
      {(() => !isSimpleMode ? (
        <div className="flex items-center gap-1 bg-black/80 p-1.5 rounded-lg border border-white/10 shrink-0 select-none self-start md:self-auto shadow-inner font-mono">
          <button
            onClick={() => setGridDisplayMode("detailed")}
            className={`px-3 py-1.5 text-xs font-mono rounded-md transition-all uppercase font-bold flex items-center gap-1.5 ${
              gridDisplayMode === "detailed"
                ? "bg-cyan-500/15 text-cyan-400 border border-cyan-500/30 font-black shadow-sm"
                : "text-zinc-500 hover:text-zinc-300 border border-transparent"
            }`}
          >
            <Laptop className="w-3.5 h-3.5" />
            Detailed
          </button>
          <button
            onClick={() => setGridDisplayMode("compact")}
            className={`px-3 py-1.5 text-xs font-mono rounded-md transition-all uppercase font-bold flex items-center gap-1.5 ${
              gridDisplayMode === "compact"
                ? "bg-cyan-500/15 text-cyan-400 border border-cyan-500/30 font-black shadow-sm"
                : "text-zinc-500 hover:text-zinc-300 border border-transparent"
            }`}
          >
            <Smartphone className="w-3.5 h-3.5" />
            Compact List
          </button>
          <button
            onClick={() => setGridDisplayMode("videowall")}
            className={`px-3 py-1.5 text-xs font-mono rounded-md transition-all uppercase font-bold flex items-center gap-1.5 ${
              gridDisplayMode === "videowall"
                ? "bg-cyan-500/15 text-cyan-400 border border-cyan-500/30 font-black shadow-sm"
                : "text-zinc-500 hover:text-zinc-300 border border-transparent"
            }`}
          >
            <Tv className="w-3.5 h-3.5" />
            Video Wall
          </button>
        </div>
      ) : (
        <div className="text-xs bg-cyan-950/10 border border-cyan-500/15 px-3 py-1.5 rounded-lg font-mono text-cyan-300 flex items-center gap-2 select-none">
          <span className="w-1.5 h-1.5 bg-cyan-400 rounded-full animate-pulse" />
          <span>Focus View activated: click any terminal pane below to run commands.</span>
        </div>
      ))()}
      {/* Clear exited panes button — only shown when at least one pane is Exited (the
          Exited-count predicate is the pure helper countExitedPanes). */}
      {activeProject && countExitedPanes(activeProject.panes, terminals) > 0 && (
        <button
          onClick={handleClearExited}
          className="text-xs font-mono uppercase tracking-wider px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 hover:border-red-500/30 rounded-lg transition-all flex items-center gap-1.5 shrink-0 select-none"
          title="Archive all exited panes for this project"
        >
          <Trash2 className="w-3.5 h-3.5" />
          Clear Exited
        </button>
      )}
    </div>
  );
}
