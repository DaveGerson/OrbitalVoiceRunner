// src/classic/components/PaneGridSection.tsx — the dashboard pane-grid, extracted VERBATIM out of
// src/App.tsx (App.tsx decomposition, chunk-7 "pane-grid"). Was the grid IIFE
// `{(() => { const filteredPanes = …; return filteredPanes.length > 0 ? (<motion.div …>…</motion.div>)
// : (<empty-state/>); })()}` in the dashboard view.
//
// ATOMICITY (load-bearing): the four card renderers (renderSimpleCard / renderVideowallCard /
// renderCompactCard / renderDetailedCard) share ~11 per-iteration map-locals computed ONCE at the top
// of `filteredPanes.map` (term, status, contextSize, isAlertActive, the detailedCardPresetClasses
// destructure {primaryColorClass, bgHover, presetLabel}, contextPercent, contextColor). They are NOT
// splittable into separate prop-driven children without divergence risk, so the WHOLE grid lives here
// as ONE component: the filteredPanes derivation + the `.map` + the 4 render*Card closures + the
// dispatch ladder (simple → videowall → compact → detailed) + the empty-state, ALL internal & verbatim.
// The per-iteration locals are derived ONCE and never re-derived.
//
// AnimatePresence/key (load-bearing): the grid is <AnimatePresence mode="popLayout"> over
// <motion.div layout key={pane.pane_id}> with initial/animate/exit. mode/layout/key + every animation
// prop are preserved EXACTLY on the same per-card element. motion/AnimatePresence are module imports.
//
// Module imports kept (NOT props): ControlKeyBar, motion, AnimatePresence, lucide icons, and every
// *Logic/helper the grid calls (resolvePaneStatus, paneMatchesFilter, resolveCardContextSize,
// detailedCardPresetClasses, contextMeterPercent, contextMeterColor, videowallDotClass, compactDotClass,
// detailedDotClass, presetBadgeClass, compactCwdDisplay, compactProcessState, formatCompactBytes,
// estimateTokens, formatCharCount, plus the residual hoists paneHasPendingCommand / isRecentlyIdled /
// tailOutputLines / chooseChronicleSource). Every AppRaw-scope value the grid reads is threaded as a
// prop: read-only state + the harness-wired setActiveTerminalId (passed straight through, never wrapped)
// + writeControlKeyFromGrid (defined & owned by App, passed unchanged) + every mutation handler. The
// detailed warning's `pendingCommands.find(...)?.cmd` stays inline (distinct from the boolean
// paneHasPendingCommand). DOM/animation are byte-identical to the former App body.

import * as React from "react";
import { AnimatePresence, motion } from "motion/react";
import { RefreshCw, Database, Shield, Terminal as TermIcon, Clipboard, Plus, Trash2, Pencil } from "lucide-react";
import { Terminal, PendingCommand, Workspace } from "../../types";
import { ControlKeyBar } from "./ControlKeyBar";
import { ProjectNote } from "../hooks/useLedgerData";
import {
  resolvePaneStatus,
  paneMatchesFilter,
  detailedCardPresetClasses,
  presetBadgeClass,
  videowallDotClass,
  compactDotClass,
  detailedDotClass,
  compactCwdDisplay,
  compactProcessState,
  contextMeterColor,
  formatCharCount,
  formatCompactBytes,
  estimateTokens,
  resolveCardContextSize,
  contextMeterPercent,
  paneHasPendingCommand,
  isRecentlyIdled,
  tailOutputLines,
  chooseChronicleSource,
} from "../../appHelpers";

export function PaneGridSection({
  activeProject,
  terminals,
  termFilter,
  gridDisplayMode,
  isSimpleMode,
  pendingCommands,
  recentlyIdled,
  activeProjectNotes,
  activeProjectId,
  copiedId,
  editingNoteId,
  editingNoteText,
  newNoteInputs,
  setActiveTerminalId,
  handleRestartTerminal,
  writeControlKeyFromGrid,
  handleCopyClipboard,
  handleUpdatePermissions,
  handleAddPaneNoteInline,
  handleSaveNoteEdit,
  handleDeleteNote,
  setEditingNoteId,
  setEditingNoteText,
  setNewNoteInputs,
  setShowCreateModal,
}: {
  activeProject: Workspace | undefined;
  terminals: Terminal[];
  termFilter: string;
  gridDisplayMode: "detailed" | "compact" | "videowall";
  isSimpleMode: boolean;
  pendingCommands: PendingCommand[];
  recentlyIdled: Record<string, boolean>;
  activeProjectNotes: ProjectNote[];
  activeProjectId: string;
  copiedId: string | null;
  editingNoteId: string | null;
  editingNoteText: string;
  newNoteInputs: Record<string, string>;
  setActiveTerminalId: (id: string) => void;
  handleRestartTerminal: (id: string) => void;
  writeControlKeyFromGrid: (paneId: string, bytes: string) => void;
  handleCopyClipboard: (text: string, id: string) => void;
  handleUpdatePermissions: (paneId: string, val: string) => void;
  handleAddPaneNoteInline: (projId: string, paneId: string) => void;
  handleSaveNoteEdit: (id: string) => void;
  handleDeleteNote: (id: string) => void;
  setEditingNoteId: React.Dispatch<React.SetStateAction<string | null>>;
  setEditingNoteText: React.Dispatch<React.SetStateAction<string>>;
  setNewNoteInputs: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setShowCreateModal: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const filteredPanes = activeProject && activeProject.panes
    ? Object.values(activeProject.panes).filter(pane => paneMatchesFilter(pane, terminals, termFilter))
    : [];

  return filteredPanes.length > 0 ? (
    <motion.div
      layout
      className={
        gridDisplayMode === "videowall"
          ? "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-4"
          : gridDisplayMode === "compact"
          ? "flex flex-col gap-3"
          : "grid grid-cols-1 xl:grid-cols-2 gap-6"
      }
    >
      <AnimatePresence mode="popLayout">
      {filteredPanes.map((pane) => {
        const term = terminals.find(t => t.id === pane.pane_id);
        const status = resolvePaneStatus(term, pane);
        const contextSize = resolveCardContextSize(term, pane);
        const isAlertActive = paneHasPendingCommand(pendingCommands, pane.pane_id);

        // Burndown: each grid-mode card body is relocated VERBATIM into a nested render
        // closure so its inline ?:/&& (and the per-mode early `return`) leave this map
        // callback's CC scope. The closures are returned in the SAME order/condition as
        // the original if-ladder; preset/context derivations are the pure helpers.
        const renderSimpleCard = () => (
          <motion.div
            layout
            key={pane.pane_id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className={`bg-[#0c0c0c] border rounded-xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-4 transition-all ${
              isAlertActive ? 'border-amber-500 bg-amber-500/[0.04]' : 'border-white/5 hover:border-cyan-500/25 bg-black/50 hover:bg-black/80'
            }`}
          >
            <div className="flex items-center gap-3">
              <span className={`w-2.5 h-2.5 rounded-full ${
                isAlertActive ? "bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.9)] animate-ping" :
                status === "Running" ? "bg-green-500 shadow-[0_0_6px_#22c55e]" : "bg-zinc-650"
              }`} />
              <div>
                <h3 className="text-sm font-sans font-bold text-zinc-200 flex items-center gap-2">
                  {pane.name}
                  {isAlertActive && (
                    <span className="text-xs bg-amber-500 text-black px-1.5 py-0.5 rounded font-mono font-black uppercase">ACTION REQUIRED</span>
                  )}
                </h3>
                <p className="text-xs text-zinc-500 font-mono mt-0.5">Preset: {pane.tool_preset || "Standard Shell"} • ID: {pane.pane_id}</p>
              </div>
            </div>

            <div className="flex items-center gap-4 self-end md:self-auto select-none">
              <span className={`text-xs font-mono capitalize ${status === "Running" ? "text-green-400 font-black" : "text-zinc-500"}`}>{status.toLowerCase()}</span>
              <button
                onClick={() => setActiveTerminalId(pane.pane_id)}
                className="px-4 py-2 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-black text-xs font-sans font-bold rounded-lg tracking-wider transition-all cursor-pointer active:scale-95 shadow-md flex items-center gap-1.5"
              >
                <TermIcon className="w-3.5 h-3.5" />
                CONNECT CONSOLE
              </button>
            </div>
          </motion.div>
        );

        // Badge colors — the preset → class/hover/label ladder is the pure helper.
        const { primaryColorClass, bgHover, presetLabel } = detailedCardPresetClasses(pane.tool_preset);

        // Context memory warnings/colors
        const contextPercent = contextMeterPercent(contextSize);
        const contextColor = contextMeterColor(contextSize);

        const renderVideowallCard = () => (
          <motion.div
            layout
            key={pane.pane_id}
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.15 }}
            className={`bg-[#0a0a0a] border rounded-lg p-3 flex flex-col justify-between transition-all duration-200 ${
              isAlertActive ? 'border-amber-500 bg-amber-950/[0.04]' : 'border-white/5 bg-black/60'
            } hover:border-white/10 font-mono`}
          >
            <div className="flex justify-between items-center bg-black/40 p-2 border border-white/5 rounded select-none">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className={`w-2 h-2 rounded-full flex-shrink-0 transition-all ${videowallDotClass(isAlertActive, status)}`}></span>
                <span className="text-xs text-white font-extrabold uppercase truncate">{pane.name}</span>
              </div>
              <span className="text-xs tracking-widest text-zinc-500 uppercase">{pane.pane_id}</span>
            </div>

            {/* Live server security camera feed: terminal output window */}
            <div className="my-2 bg-[#050505] text-[#22d3ee]/80 font-mono text-xs p-2.5 rounded border border-white/[0.04] h-[105px] overflow-y-auto select-text scrollbar-thin scrollbar-thumb-zinc-800 leading-relaxed whitespace-pre-wrap">
              {term?.output ? (
                tailOutputLines(term.output, 7)
              ) : (
                <span className="text-zinc-650 italic opacity-35">[Engine Idle — No dynamic logs emitted yet]</span>
              )}
            </div>

            <div className="flex justify-between items-center text-xs text-zinc-500 font-mono select-none px-0.5 mt-1">
              <span className="flex items-center gap-1"><Database className="w-2.5 h-2.5 text-cyan-400 animate-pulse" /> {formatCompactBytes(contextSize)}</span>
              <span className="uppercase text-zinc-550 border border-white/5 px-1 rounded bg-[#0f0f0f] text-xs tracking-wide font-extrabold">{presetLabel}</span>
            </div>

            <div className="flex gap-2 mt-2.5 select-none pt-2 border-t border-white/[0.04]">
              <button
                onClick={() => handleRestartTerminal(pane.pane_id)}
                className="flex-1 py-1 bg-black hover:bg-white/5 border border-white/10 hover:border-white/20 text-zinc-400 hover:text-white rounded text-xs uppercase font-mono tracking-wider font-extrabold transition-all"
              >
                Restart
              </button>
              <button
                onClick={() => setActiveTerminalId(pane.pane_id)}
                className="flex-1 py-1 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 border border-cyan-500/20 hover:border-cyan-500/30 rounded text-xs uppercase font-mono tracking-wider font-extrabold transition-all animate-shimmer"
              >
                Connect
              </button>
            </div>
          </motion.div>
        );

        const renderCompactCard = () => (
          <motion.div
            layout
            key={pane.pane_id}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.15 }}
            className={`bg-[#0d0d0d] border rounded-lg p-3 lg:p-4 flex flex-col gap-3 transition-colors duration-200 ${
              isAlertActive ? 'border-amber-500 bg-amber-950/[0.04]' : 'border-white/5 bg-black/40'
            } ${bgHover}`}
          >
            {/* Identity + stats row */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
            {/* Inner element container */}
            <div className="flex items-center gap-3 flex-1 min-w-0">
              <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 transition-all duration-1000 ${compactDotClass(isAlertActive, status, isRecentlyIdled(recentlyIdled, pane.pane_id) ? "heartbeat-animation" : "")}`}></span>

              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-1.5 md:gap-2">
                  <h3 className="text-xs font-mono font-bold text-white uppercase truncate">
                    {pane.name}
                  </h3>
                  <span className={`text-xs font-mono px-1.5 py-0.2 rounded uppercase ${presetBadgeClass(pane.tool_preset, "bg-zinc-805 text-zinc-500")}`}>
                    {presetLabel}
                  </span>
                  {isAlertActive && (
                    <span className="text-xs bg-amber-500 text-black px-1.5 py-0.2 rounded font-sans font-black uppercase tracking-wider animate-bounce">
                      ALERT REQUIRED
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-500 font-mono mt-0.5">
                  <span>{pane.pane_id}</span>
                  <span>•</span>
                  <span className="truncate max-w-[180px]" title={term?.cwd || "/workspace"}>Cwd: {compactCwdDisplay(term?.cwd)}</span>
                </div>
              </div>
            </div>

            {/* Stats Metrics Badge */}
            <div className="flex items-center gap-4 shrink-0 justify-between md:justify-end border-t border-white/[0.04] md:border-0 pt-2.5 md:pt-0">
              <div className="flex items-center gap-3">
                <div className="flex flex-col items-end text-right">
                  <span className="text-xs font-mono text-cyan-400 flex items-center gap-1 font-bold">
                    <Database className="w-2.5 h-2.5" />
                    {formatCompactBytes(contextSize)}
                  </span>
                  <span className="text-xs font-mono text-zinc-550">
                    ~{estimateTokens(contextSize)} tkn
                  </span>
                </div>
                <div className="h-6 w-px bg-white/5 hidden md:block"></div>
                <div className="flex flex-col items-start min-w-[64px]">
                  <span className={`text-xs uppercase tracking-wider font-bold ${compactProcessState(status, isAlertActive).className}`}>
                    {compactProcessState(status, isAlertActive).label}
                  </span>
                  <span className="text-xs text-zinc-550 uppercase font-mono">Process</span>
                </div>
              </div>

              {/* Connectivity Activations */}
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  onClick={() => handleRestartTerminal(pane.pane_id)}
                  className="p-2 border border-white/5 hover:border-white/10 hover:bg-white/5 text-zinc-400 hover:text-white rounded active:scale-95 transition-all text-xs"
                  title="Restart Node Engine"
                >
                  <RefreshCw className="w-3 h-3" />
                </button>
                <button
                  onClick={() => {
                    setActiveTerminalId(pane.pane_id);
                  }}
                  className="px-3.5 py-1.5 bg-cyan-500/10 hover:bg-cyan-500/15 text-cyan-400 border border-cyan-500/20 hover:border-cyan-500/30 rounded text-xs font-mono uppercase tracking-wider flex items-center gap-1 active:scale-95 transition-all font-bold select-none h-[34px]"
                >
                  <TermIcon className="w-3.5 h-3.5" />
                  CONNECT
                </button>
              </div>
            </div>
            </div>
            {/* Nit #2: grid-view raw control-key bar. Mirrors the active-pane control bar
                into the grid cluster so panes are controllable without leaving grid view.
                Each key FIRST activates this pane (writeControlKeyFromGrid → set_active_pane)
                then sends the byte, so it always lands on the now-active pane and passes the
                server's active-pane guard (nit #1). Reuses ControlKeyBar (no duplicated byte
                map) and carries the raw-key-bar-grid testid. */}
            <div className="flex items-center gap-2 pt-2 border-t border-white/[0.04]">
              <span className="text-xs font-mono uppercase tracking-[0.15em] text-zinc-600 shrink-0">Keys</span>
              <ControlKeyBar paneId={pane.pane_id} onKey={writeControlKeyFromGrid} testId="raw-key-bar-grid" />
            </div>
          </motion.div>
        );

        const renderDetailedWarning = () => isAlertActive && (
          <div className="mb-4 bg-amber-500/10 border border-amber-500/25 rounded p-2.5 font-mono text-xs text-amber-300 animate-pulse">
            <span className="font-bold block text-amber-400">🚨 AGENT DISPATCHED WARNING:</span>
            <span className="block mt-1 font-mono text-xs text-white break-all bg-black/50 p-1.5 rounded border border-white/5">
              {pendingCommands.find(cmd => cmd.terminalId === pane.pane_id)?.cmd}
            </span>
            <span className="block mt-1.5 text-xs opacity-75">
              Execute with voice "Confirm" or hit the approve trigger below.
            </span>
          </div>
        );
        const renderDetailedMetadata = () => (
          <div className="space-y-2 text-xs font-mono text-zinc-400 border-t border-b border-white/[0.04] py-3 my-3">
            <div className="flex items-center justify-between">
              <span>Session ID</span>
              <span className="flex items-center gap-1.5 bg-black px-2 py-1 rounded text-zinc-300 border border-white/5">
                <span className="text-xs font-bold tracking-tight max-w-[150px] truncate">{pane.session_id || "None"}</span>
                {pane.session_id && (
                  <button
                    onClick={() => handleCopyClipboard(pane.session_id, pane.pane_id)}
                    className="hover:text-cyan-400 transition-colors"
                  >
                    <Clipboard className="w-3 h-3" />
                  </button>
                )}
              </span>
            </div>
            {copiedId === pane.pane_id && (
              <div className="text-right text-xs text-green-400 -mt-1 scale-in">Copied!</div>
            )}

            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1"><Shield className="w-3 h-3" /> Security Access</span>
              <select
                value={pane.permissions_mode || "Human-in-the-Loop"}
                onChange={(e) => handleUpdatePermissions(pane.pane_id, e.target.value)}
                className="bg-black text-xs text-zinc-300 border border-white/10 rounded px-1 py-0.5 focus:outline-none focus:border-cyan-500 cursor-pointer"
              >
                <option value="Full Auto">Full Auto</option>
                <option value="Human-in-the-Loop">Human-in-the-Loop</option>
                <option value="Read-Only">Read-Only</option>
              </select>
            </div>

            <div className="flex items-center justify-between">
              <span>Process State</span>
              <span className={`uppercase font-bold text-xs ${status === "Running" ? "text-green-400" : "text-zinc-500"}`}>{status}</span>
            </div>
          </div>
        );
        const renderDetailedCard = () => (
        <motion.div
          layout
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.9 }}
          transition={{ duration: 0.2 }}
          key={pane.pane_id}
          className={`bg-[#111] border rounded-lg p-5 flex flex-col justify-between transition-colors transition-shadow duration-300 ${isAlertActive ? 'border-amber-500 bg-amber-950/[0.02] shadow-[0_0_15px_rgba(245,158,11,0.05)]' : primaryColorClass} ${bgHover}`}
        >
          {/* Card Header */}
          <div>
            <div className="flex items-start justify-between gap-2 mb-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 transition-all duration-1000 rounded-full ${detailedDotClass(isAlertActive, status, isRecentlyIdled(recentlyIdled, pane.pane_id) ? "heartbeat-animation" : "")}`}></span>
                  <h3 className="text-xs font-mono font-bold text-white tracking-widest uppercase flex items-center gap-1.5">
                    {pane.name}
                    {isAlertActive && (
                      <span className="text-xs bg-amber-500 text-black px-1.5 py-0.5 rounded font-sans font-black uppercase tracking-wider animate-bounce">
                        ▲ ALERT REQUIRED
                      </span>
                    )}
                  </h3>
                </div>
                <span className="text-xs font-mono text-zinc-500 uppercase tracking-widest ml-4 block">{pane.pane_id}</span>
              </div>
              <span className={`text-xs font-mono px-2 py-0.5 rounded uppercase tracking-wider ${presetBadgeClass(pane.tool_preset, "bg-zinc-800 text-zinc-400")}`}>
                {presetLabel}
              </span>
            </div>

            {renderDetailedWarning()}

            {/* Pane Context Size Meter */}
            <div className="space-y-1 mb-4">
              <div className="flex justify-between items-center text-xs font-mono text-zinc-400">
                <span className="flex items-center gap-1 text-cyan-400"><Database className="w-3 h-3" /> Context Memory</span>
                <span>
                  {formatCharCount(contextSize)} (~{estimateTokens(contextSize)} Tokens)
                </span>
              </div>
              <div className="w-full h-1 bg-zinc-950 rounded overflow-hidden" title="Relative fill up to 20k characters memory threshold">
                <div className={`h-full ${contextColor} transition-all duration-500`} style={{ width: `${contextPercent}%` }}></div>
              </div>
            </div>

            {/* Metadata Fields */}
            {renderDetailedMetadata()}
          </div>

          {/* Inline notes and actions */}
          <div>
            {/* Pane Notes Area */}
            <div className="mt-2 bg-black/40 rounded p-2.5 border border-white/[0.02]">
              <div className="text-xs font-mono text-zinc-500 uppercase tracking-widest mb-1.5 flex justify-between items-center">
                <span>Node Chronicle</span>
                <span className="opacity-40">{(activeProjectNotes.filter(n => n.pane_id === pane.pane_id).length || pane.notes?.length || 0)} Entries</span>
              </div>
              <div className="max-h-24 overflow-y-auto space-y-1 pr-1 scrollbar-thin">
                {(() => {
                  // bead bjm: render id-bearing notes (delete/amend controls keyed by id).
                  // Fall back to the ledger's bare strings until the id-feed loads.
                  const chronicle = chooseChronicleSource(activeProjectNotes, pane.notes, pane.pane_id);
                  if (chronicle.kind === "notes") {
                    return chronicle.notes.map((n) => (
                      <div key={n.id} className="text-xs text-[#e0e0e0]/70 flex items-start gap-1 font-sans group">
                        <span className="text-cyan-500/40 select-none font-mono">•</span>
                        {editingNoteId === n.id ? (
                          <input
                            autoFocus
                            type="text"
                            value={editingNoteText}
                            onChange={(e) => setEditingNoteText(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleSaveNoteEdit(n.id);
                              if (e.key === 'Escape') { setEditingNoteId(null); setEditingNoteText(""); }
                            }}
                            onBlur={() => handleSaveNoteEdit(n.id)}
                            className="flex-1 bg-black text-xs border border-cyan-500/40 rounded px-1 py-0.5 text-zinc-200 focus:outline-none"
                          />
                        ) : (
                          <>
                            <span
                              className="flex-1 cursor-text"
                              title="Double-click to edit"
                              onDoubleClick={() => { setEditingNoteId(n.id); setEditingNoteText(n.text); }}
                            >{n.text}</span>
                            <button
                              onClick={() => { setEditingNoteId(n.id); setEditingNoteText(n.text); }}
                              className="opacity-0 group-hover:opacity-60 hover:!opacity-100 text-zinc-400 hover:text-cyan-400 transition-opacity"
                              title="Edit note"
                            ><Pencil className="w-3 h-3" /></button>
                            <button
                              onClick={() => handleDeleteNote(n.id)}
                              className="opacity-0 group-hover:opacity-60 hover:!opacity-100 text-zinc-400 hover:text-red-400 transition-opacity"
                              title="Delete note"
                            ><Trash2 className="w-3 h-3" /></button>
                          </>
                        )}
                      </div>
                    ));
                  }
                  if (chronicle.kind === "legacy") {
                    return chronicle.notes.map((note, idx) => (
                      <div key={idx} className="text-xs text-[#e0e0e0]/70 flex items-start gap-1 font-sans">
                        <span className="text-cyan-500/40 select-none font-mono">•</span>
                        <span>{note}</span>
                      </div>
                    ));
                  }
                  return <div className="text-xs font-mono py-1.5 text-zinc-600 italic">No notes created.</div>;
                })()}
              </div>
              <div className="flex items-center gap-1 mt-2.5 pt-2 border-t border-white/[0.04]">
                <input
                  type="text"
                  placeholder="Add note..."
                  value={newNoteInputs[pane.pane_id] || ""}
                  onChange={(e) => setNewNoteInputs(prev => ({ ...prev, [pane.pane_id]: e.target.value }))}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddPaneNoteInline(activeProjectId, pane.pane_id)}
                  className="flex-1 bg-black text-xs border border-white/5 rounded px-2 py-1 text-zinc-300 focus:outline-none focus:border-cyan-500/50"
                />
                <button
                  onClick={() => handleAddPaneNoteInline(activeProjectId, pane.pane_id)}
                  className="p-1 text-cyan-500 hover:text-cyan-400 hover:bg-white/5 rounded transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex gap-2.5 mt-4">
              <button
                onClick={() => handleRestartTerminal(pane.pane_id)}
                className="flex-1 py-1.5 border border-white/10 hover:border-white/20 text-white rounded text-xs font-mono uppercase tracking-wider flex items-center justify-center gap-1"
              >
                <RefreshCw className="w-3 h-3" />
                RESTART
              </button>
              <button
                onClick={() => {
                  setActiveTerminalId(pane.pane_id);
                }}
                className="flex-1 py-1.5 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 border border-cyan-500/20 hover:border-cyan-500/30 rounded text-xs font-mono uppercase tracking-wider flex items-center justify-center gap-1"
              >
                <TermIcon className="w-3 h-3" />
                CONNECT
              </button>
            </div>
          </div>
        </motion.div>
        );

        // Burndown: dispatch to the per-mode card in the SAME order/condition as the
        // original if-ladder (simple → videowall → compact → detailed default).
        if (isSimpleMode) return renderSimpleCard();
        if (gridDisplayMode === "videowall") return renderVideowallCard();
        if (gridDisplayMode === "compact") return renderCompactCard();
        return renderDetailedCard();
    })}
    </AnimatePresence>
  </motion.div>
) : (
  <div className="flex-1 flex flex-col items-center justify-center bg-[#090909] border border-dashed border-white/5 rounded-xl p-12">
    <div className="w-10 h-10 rounded-full border border-dashed border-white/20 flex items-center justify-center text-zinc-500 mb-4 animate-pulse">
      <TermIcon className="w-5 h-5" />
    </div>
    <div className="text-xs font-mono uppercase text-zinc-500 tracking-[0.2em] mb-3">
      No active node modules in project.
    </div>
    <button
      onClick={() => setShowCreateModal(true)}
      className="px-4 py-1.5 text-xs font-mono uppercase bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 border border-cyan-500/20 hover:border-cyan-500/30 rounded tracking-[0.1em]"
    >
      Launch Core Engine Note
    </button>
  </div>
);
}
