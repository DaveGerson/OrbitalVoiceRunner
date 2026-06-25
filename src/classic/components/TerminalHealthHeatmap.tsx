// src/classic/components/TerminalHealthHeatmap.tsx — the "Agent Telemetry Heatmap" surface,
// extracted VERBATIM out of src/App.tsx's AppRaw() (bead dbt4 — App.tsx decomposition, chunk-3
// "telemetry-voice-transcript"). Mirrors the src/classic/components/ seam.
//
// Renders: the header running-count, the per-terminal status-tile grid (with its own inline
// bg/border/text/dot ladder), the legend, and the hover tooltip. The tooltip is kept as an
// INTERNAL render closure, byte-identical to the former App body — this keeps its ?:/&& guards
// inside their own function scope (CC gate) and maximizes fidelity. JSX order/keys/props/
// data-testids/className strings are unchanged.
//
// The status/field derivations remain PURE module imports (heatmapTooltipStatus /
// heatmapTooltipFields / heatmapSnippetLines from ../../appHelpers) — they are NOT threaded as
// props. The closure-captured AppRaw state the surface READS (terminals, pendingCommands,
// activeTerminalId, hoveredTermId) arrives as props; onHoverTerm is App's setHoveredTermId passed
// straight through.

import * as React from "react";
import { heatmapTooltipStatus, heatmapTooltipFields, heatmapSnippetLines } from "../../appHelpers";
import type { Terminal, PendingCommand } from "../../types";

export function TerminalHealthHeatmap({
  terminals,
  pendingCommands,
  activeTerminalId,
  hoveredTermId,
  onHoverTerm,
}: {
  terminals: Terminal[];
  pendingCommands: PendingCommand[];
  activeTerminalId: string | null;
  hoveredTermId: string | null;
  onHoverTerm: (id: string | null) => void;
}) {
  return (
    <div className="flex flex-col bg-[#090909] border border-white/5 rounded-lg p-4 select-none relative w-full">
      {/* Title & Stats */}
      <div className="flex items-center justify-between mb-3.5 pb-2 border-b border-white/[0.04]">
        <div className="flex items-center gap-1.5">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
          </span>
          <h3 className="text-xs font-mono font-bold tracking-widest text-zinc-200 uppercase flex items-center gap-1.5">
            Agent Telemetry Heatmap
          </h3>
        </div>
        <span className="text-xs font-mono text-cyan-400/80 bg-cyan-500/10 px-1.5 py-0.5 rounded border border-cyan-500/10">
          {terminals.filter(t => t.status === "Running").length}/{terminals.length} Running
        </span>
      </div>

      {/* Heatmap Grid */}
      {terminals.length === 0 ? (
        <div className="text-xs text-zinc-500 font-mono italic text-center py-4 bg-black/20 rounded border border-dashed border-white/5">
          No active agents registered in ledger.
        </div>
      ) : (
        <div>
          <div className="grid grid-cols-5 sm:grid-cols-6 lg:grid-cols-5 xl:grid-cols-8 gap-2 mb-2">
            {terminals.map((term, index) => {
              const isAlertActive = pendingCommands.some(cmd => cmd.terminalId === term.id);
              const isActive = activeTerminalId === term.id;

              // Determine color classes for tiles
              let bgClass = "bg-zinc-950";
              let borderClass = "border-white/5";
              let textClass = "text-zinc-400";
              let animateDot = "";
              let dotColor = "bg-zinc-600";

              if (isAlertActive) {
                bgClass = "bg-amber-500/15";
                borderClass = "border-amber-500/70 shadow-[0_0_8px_rgba(245,158,11,0.2)]";
                textClass = "text-amber-300 font-extrabold";
                animateDot = "animate-ping";
                dotColor = "bg-amber-500";
              } else if (term.status === "Running" && term.quiescing) {
                // Conservative Phase 2: humble "cooking…" — quiet inside the pre-idle window.
                // Muted amber, NOT the emerald "executing" pulse and NOT the yellow "idle".
                bgClass = "bg-amber-500/5";
                borderClass = "border-amber-500/20";
                textClass = "text-amber-400/70";
                dotColor = "bg-amber-400/70";
              } else if (term.status === "Running") {
                bgClass = "bg-emerald-500/10";
                borderClass = "border-emerald-500/30";
                textClass = "text-emerald-400 font-semibold";
                animateDot = "animate-pulse";
                dotColor = "bg-emerald-500";
              } else if (term.status === "Idle") {
                bgClass = "bg-yellow-500/5";
                borderClass = "border-yellow-500/20";
                textClass = "text-yellow-500/80";
                dotColor = "bg-yellow-500";
              } else {
                bgClass = "bg-red-500/5";
                borderClass = "border-red-500/20";
                textClass = "text-red-400/80";
                dotColor = "bg-red-500";
              }

              // If currently viewed connected terminal, add cyan glow/override
              if (isActive) {
                borderClass = "border-cyan-500 shadow-[0_0_8px_rgba(6,182,212,0.3)]";
              }

              return (
                <div
                  key={term.id}
                  className={`h-11 rounded-md border flex flex-col items-center justify-center relative cursor-pointer group/tile transition-all duration-250 select-none ${bgClass} ${borderClass} hover:scale-105 active:scale-95`}
                  onMouseEnter={() => onHoverTerm(term.id)}
                  onMouseLeave={() => onHoverTerm(null)}
                  onClick={() => {
                    // Clicking on heatmap cell toggles tooltip or connects active terminal
                    onHoverTerm(hoveredTermId === term.id ? null : term.id);
                  }}
                >
                  <span className={`text-xs font-mono tracking-tight ${textClass}`}>
                    T{index + 1}
                  </span>

                  {/* Tiny status indicator dot */}
                  <span className="absolute top-1.5 right-1.5 flex h-1.5 w-1.5">
                    {animateDot && (
                      <span className={`absolute inline-flex h-full w-full rounded-full opacity-75 ${animateDot} ${dotColor}`}></span>
                    )}
                    <span className={`relative inline-flex rounded-full h-1.5 w-1.5 ${dotColor}`}></span>
                  </span>

                  {/* Badge showing truncated Name */}
                  <span className="text-xs font-mono text-zinc-650 group-hover/tile:text-zinc-400 select-none uppercase truncate max-w-[90%] pointer-events-none mt-0.5 leading-none">
                    {term.id.slice(-4)}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Visual Legend */}
          <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs font-mono text-zinc-500 pt-1.5 border-t border-white/[0.03]">
            <span className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block"></span>
              Running
            </span>
            <span className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-yellow-500 inline-block"></span>
              Idle
            </span>
            <span className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-red-500 inline-block"></span>
              Exited
            </span>
            <span className="flex items-center gap-1 text-amber-500">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse inline-block"></span>
              Alert Needed
            </span>
          </div>
        </div>
      )}

      {/* Floating popover/tooltip element when cell hovered, rendering rich diagnostics & last stdout snippet inside! */}
      {(() => {
        if (!hoveredTermId) return null;
        const term = terminals.find(t => t.id === hoveredTermId);
        if (!term) return null;

        const isAlertActive = pendingCommands.some(cmd => cmd.terminalId === term.id);
        const currentOutputSnippetLines = heatmapSnippetLines(term.output);

        // Burndown: the status-label/badge ladder + the small inline ?:/|| derivations are the
        // PURE helpers `heatmapTooltipStatus` / `heatmapTooltipFields` (the ternaries genuinely
        // leave this function's CC scope). `hasSnippet` stays inline (its `?:` is in the JSX).
        const { statusLabel, statusBadgeClass } = heatmapTooltipStatus(isAlertActive, term);
        const { dotColorClass, presetText, modeText, contextSizeText, commandText, outputBytes } = heatmapTooltipFields(isAlertActive, term);
        const hasSnippet = currentOutputSnippetLines.length > 0;

        return (
          <div className="absolute top-[102%] left-0 right-0 z-50 bg-[#0d0d0d] border border-cyan-500/30 shadow-[0_4px_24px_rgba(0,0,0,0.85)] rounded-lg p-3.5 text-left font-mono text-xs leading-relaxed animate-in fade-in slide-in-from-top-1 duration-150">
            <div className="absolute top-3 right-3 flex gap-1.5">
              <span className={`text-xs uppercase tracking-wider px-1.5 py-0.5 rounded font-black ${statusBadgeClass}`}>
                {statusLabel}
              </span>
              <button
                onClick={() => onHoverTerm(null)}
                className="text-zinc-500 hover:text-white px-1 font-sans font-bold hover:bg-white/5 rounded text-xs leading-none"
              >
                ✕
              </button>
            </div>

            {/* Title & Preset Identifier */}
            <div className="mb-2">
              <h4 className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
                <span className={`w-1.5 h-1.5 rounded-full ${dotColorClass}`}></span>
                NODE: {term.id.toUpperCase()}
              </h4>
              <p className="text-xs text-zinc-500 -mt-0.5 uppercase tracking-wide">
                Type: {presetText} • Mode: {modeText}
              </p>
            </div>

            {/* Specs Bento List */}
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs text-zinc-400 bg-black/40 border border-white/[0.03] p-2 rounded-md mb-2.5">
              <div>
                <span className="text-zinc-650 uppercase text-xs block">Active Cwd</span>
                <span className="text-zinc-300 truncate block whitespace-nowrap" title={term.cwd}>{term.cwd}</span>
              </div>
              <div>
                <span className="text-zinc-650 uppercase text-xs block">Context memory</span>
                <span className="text-cyan-400 block font-bold">
                  {contextSizeText}
                </span>
              </div>
              <div className="col-span-2">
                <span className="text-zinc-650 uppercase text-xs block">Active process thread</span>
                <span className="text-zinc-300 truncate block whitespace-nowrap" title={term.command}>$ {commandText}</span>
              </div>
            </div>

            {/* last stdout console output panel widget */}
            <div className="bg-black/80 rounded border border-white/5 p-2 font-mono text-xs leading-relaxed text-zinc-500">
              <div className="text-xs uppercase tracking-wider text-cyan-500/60 font-semibold mb-1 flex items-center justify-between border-b border-white/[0.04] pb-1 select-none">
                <span>🛰️ Live Stdout Capture</span>
                <span className="opacity-40">{outputBytes} bytes</span>
              </div>
              <div className="space-y-0.5 selection:bg-cyan-500/25 selection:text-white overflow-hidden max-h-24">
                {hasSnippet ? (
                  currentOutputSnippetLines.map((line, idx) => (
                    <div key={idx} className="truncate text-emerald-400/80 leading-normal block whitespace-pre">
                      {line || " "}
                    </div>
                  ))
                ) : (
                  <div className="italic text-zinc-600 py-1 font-mono">No live stream log. Waiting on execute triggers...</div>
                )}
              </div>
            </div>

            {/* Action notice helper */}
            <div className="mt-2 text-right">
              <span className="text-xs text-zinc-650 italic">
                Tap to lock popup • Hover another tile to swap inspect
              </span>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
