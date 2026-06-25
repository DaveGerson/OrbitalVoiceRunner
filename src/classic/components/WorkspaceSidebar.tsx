// src/classic/components/WorkspaceSidebar.tsx — the classic (?ui=classic) workspace sidebar <nav>,
// extracted VERBATIM out of src/App.tsx (App.tsx decomposition into src/classic/, chunk-4
// "sidebar-swiper", section 2). Was the sidebar IIFE `{(() => ( <nav ...> ... </nav> ))()}` inside
// <main>. DOM is byte-identical, including the lone <nav> className (a pixel locator).
//
// LOAD-BEARING FIDELITY:
//   - <AnimatePresence initial={false}> wrapping <motion.div key={pane.pane_id}> drives the pane
//     enter/exit animation reconciliation — initial={false} and key={pane.pane_id} are preserved
//     EXACTLY, on the same array-item element.
//   - The four internal render closures (renderPinnedNotes / renderProjectDetails / renderActiveActions
//     / renderActiveNotes) stay as nested closures VERBATIM (the burndown's CC choke).
//   - GateChip, motion, AnimatePresence, paneMatchesFilter, sidebarPaneStatusColor,
//     sidebarRowContainerClass, sidebarRowNameClass are MODULE IMPORTS — never threaded as props.
//   - setActiveTerminalId is the SAME harness-wired callback ref, passed straight through. The 11
//     project/pane mutation handlers stay in App and arrive here as props.

import * as React from "react";
import { AnimatePresence, motion } from "motion/react";
import { Plus } from "lucide-react";
import { Terminal, PendingCommand, Workspace } from "../../types";
import { GateChip } from "../../components/GateChip";
import {
  paneMatchesFilter,
  sidebarPaneStatusColor,
  sidebarRowContainerClass,
  sidebarRowNameClass,
} from "../../appHelpers";

export function WorkspaceSidebar({
  mobileActiveView,
  activeTerminalId,
  termFilter,
  activeProjectId,
  projectList,
  terminals,
  pendingCommands,
  recentlyIdled,
  setActiveTerminalId,
  setTermFilter,
  handleCreateProject,
  handleSwitchProject,
  handleEditProject,
  handleRenameProject,
  handleAddProjectNote,
  handleDeleteProjectPrompt,
  handleRenamePane,
  handleAddPaneNote,
  setShowCreateModal,
}: {
  mobileActiveView: "terminal" | "buffer" | "menu";
  activeTerminalId: string | null;
  termFilter: "All" | "Running" | "Idle";
  activeProjectId: string;
  projectList: Workspace[];
  terminals: Terminal[];
  pendingCommands: PendingCommand[];
  recentlyIdled: Record<string, boolean>;
  setActiveTerminalId: (id: string | null) => void;
  setTermFilter: (filter: "All" | "Running" | "Idle") => void;
  handleCreateProject: () => void;
  handleSwitchProject: (id: string) => void;
  handleEditProject: (project: Workspace) => void;
  handleRenameProject: (id: string, current: string) => void;
  handleAddProjectNote: (id: string) => void;
  handleDeleteProjectPrompt: (id: string) => void;
  handleRenamePane: (projId: string, paneId: string, current: string) => void;
  handleAddPaneNote: (projId: string, paneId: string) => void;
  setShowCreateModal: (show: boolean) => void;
}) {
  return (
        <nav className={`w-full lg:w-72 border-b lg:border-b-0 lg:border-r border-white/5 bg-black/40 flex flex-col h-full shrink-0 min-h-0 overflow-hidden ${mobileActiveView === "menu" ? "flex" : "hidden lg:flex"}`}>
          <div className="p-4 flex-1 overflow-y-auto scrollbar-thin min-h-0">
            <button
              onClick={() => setActiveTerminalId(null)}
              className={`w-full flex items-center justify-between px-3 py-2.5 mb-4 rounded border text-xs font-mono tracking-wider transition-all ${
                activeTerminalId === null
                  ? "bg-cyan-500/10 text-cyan-400 border-cyan-500/30"
                  : "bg-transparent text-zinc-400 border-white/5 hover:border-white/10"
              }`}
            >
              <span className="flex items-center gap-2">
                <span className={`w-1.5 h-1.5 rounded-full ${activeTerminalId === null ? 'bg-cyan-400 animate-pulse' : 'bg-zinc-500'}`}></span>
                GRID SUMMARY VIEW
              </span>
              <span className="text-xs opacity-40 px-1 bg-white/5 rounded">ALL</span>
            </button>

            <div className="mb-5 flex items-center justify-between border border-white/5 bg-black/30 px-3 py-2 rounded">
              <label className="text-xs font-mono uppercase opacity-60">Filter Panes:</label>
              <select
                value={termFilter}
                onChange={(e) => setTermFilter(e.target.value as "All" | "Running" | "Idle")}
                className="bg-[#111] text-xs font-mono text-zinc-300 border border-white/10 rounded px-1.5 py-1 focus:outline-none focus:border-cyan-500 cursor-pointer"
              >
                <option value="All">All Panes</option>
                <option value="Running">Running</option>
                <option value="Idle">Idle</option>
              </select>
            </div>

            <div className="flex items-center justify-between mb-3 border-b border-white/5 pb-1 select-none">
              <h2 className="text-xs font-mono uppercase opacity-40 tracking-[0.2em]">Workspace Contexts</h2>
              <button
                onClick={handleCreateProject}
                className="text-xs font-mono uppercase text-cyan-400 opacity-60 hover:opacity-100 transition-opacity flex items-center gap-0.5 focus:outline-none"
                title="Create New Project Context Space"
              >
                <Plus className="w-2.5 h-2.5" /> NEW
              </button>
            </div>

            <div className="space-y-4">
              {projectList.map((project) => {
                // Burndown: the project's three conditional sub-blocks (pinned notes, summary/keyTerms
                // details, the panes list) are relocated VERBATIM into nested render closures so their
                // && / ?: guards leave this map callback's CC scope. JSX order/keys/props unchanged.
                const isActiveProject = activeProjectId === project.id;
                const projectTitleClass = isActiveProject ? 'text-cyan-400 bg-white/5 border border-white/5' : 'text-zinc-500 hover:text-zinc-400 hover:bg-white/[0.02]';
                const renderPinnedNotes = () => project.notes && project.notes.length > 0 && isActiveProject && (
                  <div className="px-3 py-1 space-y-1 my-2 border-l-2 border-cyan-400/20 ml-2">
                     {project.notes.map((note, idx) => (
                        <div key={idx} className="text-xs opacity-60 text-cyan-100 flex items-start gap-1">
                          <span className="opacity-40">-</span><span>{note}</span>
                        </div>
                     ))}
                  </div>
                );
                const renderProjectDetails = () => isActiveProject && (
                  <div className="pl-3 ml-2 border-l-2 border-white/5 space-y-2 mt-1.5 py-1 select-none">
                    {project.summary && (
                      <p className="text-xs text-zinc-500 leading-relaxed font-mono italic max-w-[210px] break-all">
                        {project.summary}
                      </p>
                    )}
                    {project.keyTerms && project.keyTerms.length > 0 && (
                      <div className="flex flex-wrap gap-1 max-w-[210px]">
                        {project.keyTerms.map((term, idx) => (
                          <span key={idx} className="bg-cyan-500/5 text-cyan-400/80 border border-cyan-500/10 px-1 py-0.5 rounded text-xs font-mono leading-none">
                            {term}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
                return (
                <div key={project.id} className="space-y-1">
                  <div className="flex items-center justify-between group">
                    <div
                      onClick={() => handleSwitchProject(project.id)}
                      className={`text-xs font-mono font-bold px-2 py-1 cursor-pointer transition-colors rounded ${projectTitleClass}`}
                    >
                      {(project.name || project.id).toUpperCase()}
                    </div>
                    <div className="flex gap-1.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                       <button onClick={() => handleEditProject(project)} className="text-xs uppercase hover:text-cyan-400 px-1 hover:bg-white/5 rounded" title="Edit workspace details">Edit</button>
                       <button onClick={() => handleRenameProject(project.id, project.name)} className="text-xs uppercase hover:text-cyan-450 text-zinc-500 hover:bg-white/5 px-1 rounded animate-pulse" title="Quick rename space">Rename</button>
                       <button onClick={() => handleAddProjectNote(project.id)} className="text-xs uppercase hover:text-cyan-450 text-zinc-400 hover:bg-white/5 px-1 rounded" title="Append note">Note</button>
                       {projectList.length > 1 && (
                         <button onClick={() => handleDeleteProjectPrompt(project.id)} className="text-xs uppercase hover:text-red-400 text-zinc-650 px-1 hover:bg-red-500/10 rounded" title="Prune Project Memory">Prune</button>
                       )}
                    </div>
                  </div>
                  {renderPinnedNotes()}

                  {renderProjectDetails()}

                  {isActiveProject && project.panes && (
                    <div className="space-y-1 pl-2 mt-2">
                      <AnimatePresence initial={false}>
                        {Object.values(project.panes).filter(pane => paneMatchesFilter(pane, terminals, termFilter)).map((pane) => {
                          const isActive = activeTerminalId === pane.pane_id;
                          const term = terminals.find(t => t.id === pane.pane_id);
                          const isAlertActive = pendingCommands.some(cmd => cmd.terminalId === pane.pane_id);
                          // Burndown: the status-dot ladder (alert / live-terminal / ledger-fallback)
                          // is the PURE helper `sidebarPaneStatusColor`. The idle heartbeat suffix is
                          // passed in (kept state-driven here) so the helper stays DOM-free.
                          const recentlyIdledClass = recentlyIdled[pane.pane_id] ? "heartbeat-animation" : "";
                          const statusColor = sidebarPaneStatusColor(isAlertActive, term, pane, recentlyIdledClass);
                          // Burndown: the two alert/active class chains are PURE helpers; the active-only
                          // action row + the notes row are relocated into nested closures (their &&
                          // guards leave this callback's CC scope). JSX order/keys/props unchanged.
                          const rowContainerClass = sidebarRowContainerClass(isAlertActive, isActive);
                          const rowNameClass = sidebarRowNameClass(isAlertActive, isActive);
                          const statusTitle = isAlertActive ? "Status: Alert (Approval Required)" : `Status: ${pane.last_known_state}`;
                          const renderActiveActions = () => isActive && (
                            <div className="flex px-3 mt-1 pb-1 gap-2 border-b border-white/5">
                               <button onClick={() => handleRenamePane(project.id, pane.pane_id, pane.name)} className="text-xs uppercase hover:text-cyan-400 opacity-60">Rename</button>
                               <button onClick={() => handleAddPaneNote(project.id, pane.pane_id)} className="text-xs uppercase hover:text-cyan-400 opacity-60">Note</button>
                            </div>
                          );
                          const renderActiveNotes = () => isActive && pane.notes && pane.notes.length > 0 && (
                            <div className="ml-4 pl-2 py-1 mt-1 border-l border-white/5 text-xs font-sans text-amber-200/60 leading-relaxed max-w-full italic overflow-hidden break-words">
                               {pane.notes.map((n, idx) => <div key={idx}>• {n}</div>)}
                            </div>
                          );

                          return (
                            <motion.div
                              key={pane.pane_id}
                              initial={{ opacity: 0, height: 0, scale: 0.95 }}
                              animate={{ opacity: 1, height: "auto", scale: 1 }}
                              exit={{ opacity: 0, height: 0, scale: 0.95 }}
                              transition={{ duration: 0.2 }}
                              className="flex flex-col group overflow-hidden"
                            >
                              <div
                                onClick={() => { setActiveTerminalId(pane.pane_id); }}
                                className={`group cursor-pointer p-2 rounded transition-colors flex items-center justify-between ${rowContainerClass}`}
                              >
                              <div className="flex flex-col overflow-hidden min-w-0 pr-2">
                                <span className={`text-xs font-mono truncate flex items-center gap-1.5 ${rowNameClass}`}>
                                  {pane.name}
                                  {isAlertActive && (
                                    <span className="text-xs bg-amber-500 text-black px-1 rounded font-sans font-black uppercase animate-bounce leading-none py-0.5">
                                      ▲ ALERT
                                    </span>
                                  )}
                                </span>
                                {term && <span className="text-xs opacity-30 font-mono truncate">{term.cwd}</span>}
                              </div>
                              <div className="flex items-center gap-2 shrink-0">
                                {/* bead 8sq: per-pane effective-posture chip (server truth via terminals payload). */}
                                {term?.posture && (
                                  <GateChip
                                    effectiveGates={term.effective_gates}
                                    posture={term.posture}
                                    isActivePane={isActive}
                                    compact
                                  />
                                )}
                                <span className={`flex-shrink-0 w-1.5 h-1.5 rounded-full transition-all duration-1000 ${statusColor}`} title={statusTitle}></span>
                              </div>
                            </div>
                            {renderActiveActions()}
                            {renderActiveNotes()}
                          </motion.div>
                        );
                      })}
                      </AnimatePresence>
                    </div>
                  )}
                </div>
                );
              })}
            </div>
          </div>
          <div className="p-4 border-t border-white/5 space-y-3">
            <button
              onClick={() => setShowCreateModal(true)}
              className="w-full text-center py-2 bg-transparent border border-dashed border-white/20 hover:border-cyan-500/50 hover:text-cyan-400 text-white/60 text-xs uppercase tracking-widest transition-colors focus:outline-none"
            >
              + Create Node
            </button>
            <div className="w-full text-center text-zinc-600 text-xs uppercase tracking-widest">
              {terminals.length} Nodes Online
            </div>
          </div>
        </nav>
  );
}
