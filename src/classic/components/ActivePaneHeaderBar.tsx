// src/classic/components/ActivePaneHeaderBar.tsx — the classic active-pane header bar, extracted
// VERBATIM out of src/App.tsx (App.tsx decomposition, chunk-6 "terminal-view + dashboard chrome",
// section 3). Was the `<div className="flex items-center justify-between px-4 py-3 ...">` at the top
// of the terminal-view sub-tree. DOM is byte-identical.
//
// Contents: the project/pane name chips, the `$ command` + cwd labels, the GateChip, and the
// History-toggle / Restart / Back-to-Grid / Exit buttons.
//
// *** LOAD-BEARING FIDELITY: data-testid="gate-chip-header" is preserved BYTE-IDENTICAL on the exact
// same <span className="shrink-0"> — it is the real-pointer clickability regression guard (the e2e
// targets THIS center-header chip specifically, not a sidebar chip). ***
//
// Module imports kept (NOT threaded as props): GateChip + the lucide icons (History, RefreshCw,
// Layers, Square). setActiveTerminalId is HARNESS-WIRED — Back-to-Grid calls setActiveTerminalId(null)
// with the SAME callback reference, never wrapped/renamed. setShowHistoryPanel comes from the
// useTerminalHistory hook (NOT the harness). The History-toggle keeps its `nextState = !showHistoryPanel;
// if (nextState) fetchActiveTerminalHistory()` conditional verbatim. handleRestartTerminal / handleStopPane
// stay in App and arrive as props.

import * as React from "react";
import { History, RefreshCw, Layers, Square } from "lucide-react";
import { Terminal, PaneMeta, Workspace } from "../../types";
import { GateChip } from "../../components/GateChip";

export function ActivePaneHeaderBar({
  activeProjectMeta,
  activePaneMeta,
  activeTerminal,
  activeProjectId,
  showHistoryPanel,
  setShowHistoryPanel,
  fetchActiveTerminalHistory,
  handleRestartTerminal,
  setActiveTerminalId,
  handleStopPane,
}: {
  activeProjectMeta: Workspace | null;
  activePaneMeta: PaneMeta | null;
  activeTerminal: Terminal;
  activeProjectId: string;
  showHistoryPanel: boolean;
  setShowHistoryPanel: (val: boolean) => void;
  fetchActiveTerminalHistory: (terminalId?: string | null) => void;
  handleRestartTerminal: (id: string) => void;
  setActiveTerminalId: (id: string | null) => void;
  handleStopPane: (projId: string, paneId: string) => void;
}) {
  // One home for the badge text: it renders truncated (min-w-0, bead 357), so the SAME full
  // string goes on the title tooltip.
  const badgeLabel = `${activeProjectMeta?.name?.toUpperCase() || "NODE"}: ${activePaneMeta?.name || activeTerminal.id}`;
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3 bg-white/[0.02] border-b border-white/5 shadow-sm">
      <div className="flex gap-2 items-center min-w-0 flex-1">
        <span
          className="text-xs font-mono px-2 py-0.5 bg-cyan-400/20 text-cyan-400 rounded truncate min-w-0"
          title={badgeLabel}
        >
          {badgeLabel}
        </span>
        {/* bead 8sq / bead 357: the active pane's effective-posture chip (server truth via the
            terminals payload). Click for the full breakdown in plain language. The chip is the
            ONLY shrink-0 element in this group — under squeeze the command and the name badge
            truncate (both min-w-0) and the chip keeps its full box. That is the structural fix
            for the 1280px-with-transcript-panel occlusion the popover-content specs previously
            routed around via dispatchEvent('click'). Deliberately NO `overflow-hidden` here:
            clipping the group pushes the chip's click point outside its own box, and the
            gate_chip.spec.ts real-pointer test fails (reproduced both ways). The companion
            hazard — header content stealing pointer events from the right-hand Grid/Exit
            controls (pane_exit_controls + terminal_header_affordances, the adversarial-review
            blocker) — is prevented by keeping every width in this header flexible or capped
            (badge/command truncate; cwd capped in the right group), never by clipping. All
            three spec files pin this at the default 1280px viewport. */}
        {activeTerminal.posture && (
          // data-testid: an inert hook so e2e can target THIS (center-header) chip
          // specifically — `getByTestId("gate-chip-trigger").first()` resolves to a sidebar
          // chip, not this one. Used by the real-pointer clickability regression guard.
          <span className="shrink-0" data-testid="gate-chip-header">
            <GateChip
              effectiveGates={activeTerminal.effective_gates}
              posture={activeTerminal.posture}
              isActivePane
            />
          </span>
        )}
        <span className="text-xs font-mono px-2 py-0.5 opacity-40 truncate min-w-0" title={activeTerminal.command}>
          $ {activeTerminal.command}
        </span>
      </div>
      <div className="flex items-center gap-4 shrink-0">
        {/* bead 357: the cwd is CAPPED, not just `truncate` — inside a shrink-0 flex group a
            bare truncate has no width constraint, so a long path inflates the whole right
            group and crushes the left flex-1 group (the header's only unbounded rigid width).
            Full path stays available on the title tooltip. */}
        <span className="text-xs font-mono opacity-40 truncate max-w-[12rem]" title={activeTerminal.cwd}>
          {activeTerminal.cwd}
        </span>
        <button
          onClick={() => {
            const nextState = !showHistoryPanel;
            setShowHistoryPanel(nextState);
            if (nextState) {
              fetchActiveTerminalHistory();
            }
          }}
          className={`p-1.5 hover:bg-white/5 rounded transition-colors ${showHistoryPanel ? "text-cyan-400 bg-white/5" : "text-zinc-400 hover:text-white"}`}
          title="Toggle Command History Pane"
        >
          <History className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => handleRestartTerminal(activeTerminal.id)}
          className="p-1.5 hover:bg-white/5 rounded text-zinc-400 hover:text-white transition-colors"
          title="Restart Node Engine"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
        {/* B4: back-to-grid — leave the pane view without killing it. Auto-activation
            (voice create_pane) drops you into a pane with no header way out; acute on
            mobile where the sidebar grid control is hidden behind the Menu view. */}
        <button
          onClick={() => setActiveTerminalId(null)}
          className="flex items-center gap-1 px-2 py-1 hover:bg-white/5 rounded text-zinc-400 hover:text-white transition-colors text-xs font-mono uppercase tracking-wider"
          title="Back to grid (leave this pane running)"
        >
          <Layers className="w-3.5 h-3.5" />
          Grid
        </button>
        {/* B3: graceful EXIT — terminate this pane's process and archive it (recoverable),
            the non-destructive middle between Restart and PRUNE (hard delete). */}
        <button
          onClick={() => handleStopPane(activeProjectId, activeTerminal.id)}
          className="flex items-center gap-1 px-2 py-1 hover:bg-rose-500/10 rounded text-zinc-400 hover:text-rose-400 transition-colors text-xs font-mono uppercase tracking-wider"
          title="Exit pane (terminate the process and archive it — recoverable)"
        >
          <Square className="w-3.5 h-3.5" />
          Exit
        </button>
      </div>
    </div>
  );
}
