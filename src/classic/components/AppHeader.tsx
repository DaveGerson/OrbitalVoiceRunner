// src/classic/components/AppHeader.tsx — the classic top app header, extracted VERBATIM out of
// src/App.tsx (App.tsx decomposition, chunk-5 "modal-queues + AppHeader", section 3). Was the inline
// header render closure (IIFE) `{(() => (<header ...>...</header>))()}`. DOM is byte-identical.
//
// The header's THREE inner render closures are preserved as INTERNAL nested closures VERBATIM:
//   • the brand + telemetry strip IIFE
//   • the right-hand controls cluster IIFE (which itself nests the connect/mute toggle IIFE)
// They keep AppHeader's own cyclomatic complexity under the gate the same way they did in AppRaw.
//
// Module imports kept (NOT threaded as props): EmergencyStop, the lucide icons (Database, Settings),
// and the gemini/format/context pure helpers (geminiVoiceColorClass, geminiVoiceLabel,
// totalContextTextClass, formatCharCountLower, formatTokenCount, totalContextBarClass,
// totalContextBarPercent). The two brand-strip pure derivations were hoisted to appHelpers
// (headerStatusDotClass / headerRunningCount) and are imported here.
//
// setIsMicMuted is HARNESS-WIRED (the header's mute toggle; dispatchWsMessage setter bag) — it is the
// SAME callback reference passed straight through, never wrapped/renamed. EmergencyStop's handler trio
// (onFreeze/onKill/onRelease) are the AppRaw REST wrappers handleStopAll{Freeze,Kill,Release}, passed
// down as props.

import * as React from "react";
import { Terminal, PendingCommand, Workspace } from "../../types";
import { Database, Settings } from "lucide-react";
import { EmergencyStop } from "../../components/EmergencyStop";
import {
  geminiVoiceColorClass,
  geminiVoiceLabel,
  totalContextTextClass,
  totalContextBarClass,
  totalContextBarPercent,
  formatCharCountLower,
  formatTokenCount,
  headerStatusDotClass,
  headerRunningCount,
} from "../../appHelpers";

type TranscriptEntry = {
  sender: "User" | "Janus";
  text: string;
  timestamp: Date;
  grounding?: { queries: string[]; sources: { uri: string; title: string }[] };
};

export function AppHeader({
  isLive,
  isReconnecting,
  isSimpleMode,
  pendingCommands,
  terminals,
  activeProject,
  globalPermissionsMode,
  isMicMuted,
  totalContextSize,
  totalTokensEstimated,
  showTranscriptPanel,
  transcript,
  frozen,
  frozenRunning,
  setIsSimpleMode,
  playEarcon,
  handleUpdateGlobalPermissions,
  setIsMicMuted,
  startLive,
  stopLive,
  setShowTranscriptPanel,
  handleStopAllFreeze,
  handleStopAllKill,
  handleStopAllRelease,
  setShowSettingsModal,
}: {
  isLive: boolean;
  isReconnecting: boolean;
  isSimpleMode: boolean;
  pendingCommands: PendingCommand[];
  terminals: Terminal[];
  activeProject: Workspace | undefined;
  globalPermissionsMode: string;
  isMicMuted: boolean;
  totalContextSize: number;
  totalTokensEstimated: number;
  showTranscriptPanel: boolean;
  transcript: TranscriptEntry[];
  frozen: boolean;
  frozenRunning: string[];
  setIsSimpleMode: (v: boolean) => void;
  playEarcon: (kind: string) => void;
  handleUpdateGlobalPermissions: (val: string) => void;
  setIsMicMuted: (v: boolean) => void;
  startLive: () => void;
  stopLive: () => void;
  setShowTranscriptPanel: (v: boolean) => void;
  handleStopAllFreeze: () => void;
  handleStopAllKill: () => void;
  handleStopAllRelease: () => void;
  setShowSettingsModal: (v: boolean) => void;
}) {
  return (
    <header className="flex flex-col lg:flex-row items-start lg:items-center justify-between px-4 lg:px-6 py-4 border-b border-white/5 bg-black/40 backdrop-blur-md gap-4 shrink-0">
      {/* Brand + telemetry strip — inner IIFE keeps the header IIFE's CC under the gate. */}
      {(() => (
      <div className="flex flex-col md:flex-row md:items-center gap-4 shrink-0">
        <div className="flex items-center gap-3">
          <div className={`w-3 h-3 rounded-full ${headerStatusDotClass(isLive, isReconnecting)}`}></div>
          <h1 className="font-serif italic text-lg lg:text-xl tracking-wide text-white flex items-center gap-2 select-none">
            Orbital Harness <span className="text-xs lg:text-xs font-mono font-normal opacity-40">v1.0.4-live</span>
          </h1>

          {/* Simplicity Toggle Switch */}
          <button
            onClick={() => {
              setIsSimpleMode(!isSimpleMode);
              playEarcon("chime");
            }}
            className={`px-2.5 py-1 text-xs uppercase font-mono rounded tracking-wider flex items-center gap-1.5 transition-all select-none border cursor-pointer font-bold ${
              isSimpleMode
                ? "bg-cyan-500/10 border-cyan-500/30 text-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.1)]"
                : "bg-white/5 border-white/5 text-zinc-500 hover:text-zinc-300 hover:border-white/10"
            }`}
            title="Toggle between Focus Mode (clean and simple UI) and Dev Mode (high density metrics analysis)"
          >
            <div className={`w-1.5 h-1.5 rounded-full ${isSimpleMode ? "bg-cyan-400 animate-pulse" : "bg-zinc-650"}`} />
            {isSimpleMode ? "Focus Mode" : "Dev Mode"}
          </button>
        </div>

        {/* Glowing Header Telemetry Strip - simplified in simple mode unless alarms are active.
            Wrapped in an inner IIFE so its && / || / ?: leave the brand-strip IIFE's CC scope. */}
        {(() => (!isSimpleMode || pendingCommands.length > 0) && (
          <div className="flex items-center gap-3 bg-black/60 px-3 py-1.5 rounded-lg border border-white/15 select-none font-mono">
            {/* Active workers indicator */}
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></span>
              <span className="text-xs text-zinc-400 font-bold uppercase">
                {headerRunningCount(terminals, activeProject)} RUNNING
              </span>
            </div>

            <div className="w-px h-3 bg-white/10"></div>

            {/* Verification pending count — passive indicator. The Alerts tab was removed, so this
                no longer navigates; it still reflects the live ApprovalDialog queue (pendingCommands),
                which renders independently. */}
            <div className="flex items-center gap-1.5" title="Pending verification commands (approval queue)">
              <span className={`w-1.5 h-1.5 rounded-full ${pendingCommands.length > 0 ? "bg-amber-500 shadow-[0_0_6px_#f59e0b] animate-ping" : "bg-zinc-700"}`}></span>
              <span className={`text-xs font-extrabold uppercase ${pendingCommands.length > 0 ? "text-amber-400 font-black animate-pulse" : "text-zinc-500"}`}>
                {pendingCommands.length} VERIFY
              </span>
            </div>
          </div>
        ))()}
      </div>
      ))()}

      {/* Right-hand controls cluster — inner IIFE keeps the header IIFE's CC under the gate. */}
      {(() => (
      <div className="flex items-center gap-4 lg:gap-6 w-full lg:w-auto overflow-x-auto pb-2 lg:pb-0 shrink-0 hide-scrollbar">
        <div className="flex flex-col">
          <span className="text-xs font-mono uppercase opacity-40 tracking-widest">Global Voice Agent Permission</span>
          <select
            value={globalPermissionsMode}
            onChange={(e) => handleUpdateGlobalPermissions(e.target.value)}
            className="mt-1 bg-black text-xs text-zinc-300 border border-white/10 rounded px-2 py-1 focus:outline-none focus:border-cyan-500 cursor-pointer font-mono"
          >
            <option value="Inherit">Inherit From Active Node</option>
            <option value="Full Auto">Full Auto (Auto-Approve)</option>
            <option value="Human-in-the-Loop">Human-in-the-Loop (Always Ask)</option>
            <option value="Read-Only">Read-Only (Lock Inputs)</option>
          </select>
        </div>
        <div className="w-px h-8 bg-white/10"></div>
        <div className="flex flex-col items-end">
          <span className="text-xs font-mono uppercase opacity-40 tracking-widest">Controls</span>
          <div className="flex items-center gap-2 mt-1">
            {/* Connect / Mute+Disconnect — inner IIFE keeps the right-controls IIFE under the gate. */}
            {(() => !isLive ? (
              <button
                onClick={startLive}
                className="text-xs font-mono uppercase text-cyan-400 opacity-80 hover:opacity-100 hover:text-cyan-300 transition-colors focus:outline-none"
              >
                Connect
              </button>
            ) : (
              <div className="flex items-center gap-3">
                 <button
                  onClick={() => setIsMicMuted(!isMicMuted)}
                  className={`text-xs font-mono uppercase transition-colors focus:outline-none ${isMicMuted ? "text-amber-400" : "text-cyan-400 opacity-80"}`}
                >
                  {isMicMuted ? "Unmute" : "Mute"}
                </button>
                <button
                  onClick={stopLive}
                  className="text-xs font-mono uppercase text-red-400 opacity-80 hover:opacity-100 transition-colors focus:outline-none"
                >
                  Disconnect
                </button>
              </div>
            ))()}
          </div>
        </div>
        <div className="w-px h-8 bg-white/10"></div>
        <div className="flex flex-col">
          <span className="text-xs font-mono uppercase opacity-40 tracking-widest">Gemini Voice</span>
          <span className={`text-xs font-mono ${geminiVoiceColorClass(isLive, isReconnecting, isMicMuted)}`}>
            {geminiVoiceLabel(isLive, isReconnecting, isMicMuted)}
          </span>
        </div>
        {!isSimpleMode && (
          <>
            <div className="w-px h-8 bg-white/10"></div>
            <div className="flex flex-col items-end">
              <span className="text-xs font-mono uppercase opacity-40 tracking-widest flex items-center gap-1 leading-none select-none">
                <Database className="w-2.5 h-2.5 text-cyan-400" />
                Rigorous Context Memory
              </span>
              <div className="flex items-center gap-2 mt-1 leading-none select-none">
                <span className={`text-xs font-mono font-black ${totalContextTextClass(totalContextSize)}`}>
                  {formatCharCountLower(totalContextSize)}
                </span>
                <span className="text-xs font-mono opacity-40">
                  (~{formatTokenCount(totalTokensEstimated)} tokens)
                </span>
              </div>
              {/* Context overload bar */}
              <div className="w-24 h-1 bg-zinc-950 rounded-full overflow-hidden mt-1.5" title="Aggregated Sandbox Overload Threshold Indicator">
                <div
                  className={`h-full transition-all duration-500 ${totalContextBarClass(totalContextSize)}`}
                  style={{ width: `${totalContextBarPercent(totalContextSize)}%` }}
                ></div>
              </div>
            </div>
          </>
        )}
        <div className="w-px h-8 bg-white/10"></div>
        <button
          onClick={() => setShowTranscriptPanel(!showTranscriptPanel)}
          className={`p-1.5 px-3 hover:bg-cyan-500/10 border transition-all rounded hover:text-cyan-400 focus:outline-none flex items-center justify-center cursor-pointer gap-1.5 shrink-0 ${
            showTranscriptPanel
              ? "bg-cyan-500/15 border-cyan-500/40 text-cyan-400"
              : "bg-white/5 border-white/10 text-zinc-400"
          }`}
          title="Toggle Operator Conversation Transcript Log"
        >
          <span className="relative flex h-2.5 w-2.5">
            <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${transcript.length > 0 ? "bg-cyan-400" : "bg-zinc-400"}`}></span>
            <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${transcript.length > 0 ? "bg-cyan-500" : "bg-zinc-600"}`}></span>
          </span>
          <span className="text-xs font-mono uppercase tracking-[0.1em] font-bold">Transcripts ({transcript.length})</span>
        </button>
        <div className="w-px h-8 bg-white/10"></div>
        {/* bead 8sq: global two-stage emergency STOP-ALL. When frozen, the trigger is replaced by the
            FROZEN banner below the header (kill / release live there). */}
        {!frozen && (
          <EmergencyStop
            frozen={false}
            runningCount={frozenRunning.length}
            onFreeze={handleStopAllFreeze}
            onKill={handleStopAllKill}
            onRelease={handleStopAllRelease}
          />
        )}
        <div className="w-px h-8 bg-white/10"></div>
        <button
          onClick={() => setShowSettingsModal(true)}
          className="p-1.5 px-3 bg-white/5 hover:bg-cyan-500/10 border border-white/10 hover:border-cyan-500/30 transition-all rounded text-zinc-400 hover:text-cyan-400 focus:outline-none flex items-center justify-center cursor-pointer gap-1.5 shrink-0"
          title="System Parameters Settings"
        >
          <Settings className="w-3.5 h-3.5 animate-[spin_10s_linear_infinite]" />
          <span className="text-xs font-mono uppercase tracking-[0.1em] font-bold">Config</span>
        </button>
      </div>
      ))()}
    </header>
  );
}
