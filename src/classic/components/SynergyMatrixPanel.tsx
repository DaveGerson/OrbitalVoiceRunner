// src/classic/components/SynergyMatrixPanel.tsx — the "Core Goal: Live Conversation & Synergy
// Matrix" 2-col hero, extracted VERBATIM out of src/App.tsx's AppRaw() (bead dbt4 — App.tsx
// decomposition, chunk-3 "telemetry-voice-transcript"). Mirrors the src/classic/components/ seam.
//
// Left half = the Voice Conversation Hub (status card + start/mute/disconnect); right half = the
// Spec Buffer surface tile. Both halves are kept as INTERNAL render closures, byte-identical to the
// former App body — keeping each live/reconnect/mute ?: inside its own function scope (CC gate).
// JSX order/keys/props/className strings are unchanged.
//
// VOICE-LABEL FIDELITY: the "AGENT STATUS" line renders DISTINCT strings ("AI Reconnecting..." /
// "Muted (Zephyr Listening)" / "Zephyr Voice Agent Live" / "Offline (Mic Standby)") that do NOT
// match the header's geminiVoiceLabel output ("RECONNECTING…"/"MUTED"/"LISTENING…"/"OFFLINE"), so a
// NEW pure helper `voiceAgentStatusLabel` was hoisted (../../appHelpers) preserving the exact inline
// strings; geminiVoiceLabel is NOT reused here. The Spec Buffer badge is `specBufferBadge`.
//
// setIsMicMuted is harness-wired (the mute toggle) and is passed as the SAME callback reference
// straight through.

import * as React from "react";
import { Mic, CheckSquare } from "lucide-react";
import { voiceAgentStatusLabel, specBufferBadge } from "../../appHelpers";

export function SynergyMatrixPanel({
  isLive,
  isReconnecting,
  isMicMuted,
  promptBuffer,
  startLive,
  stopLive,
  setIsMicMuted,
  setMobileActiveView,
}: {
  isLive: boolean;
  isReconnecting: boolean;
  isMicMuted: boolean;
  promptBuffer: string;
  startLive: () => void;
  stopLive: () => void;
  setIsMicMuted: (muted: boolean) => void;
  setMobileActiveView: (view: "terminal" | "buffer" | "menu") => void;
}) {
  return (
    <div className="mb-8 grid grid-cols-1 xl:grid-cols-2 gap-6 bg-[#090909] border border-white/5 p-5 rounded-xl shadow-2xl relative overflow-hidden">
      {/* Glow effect in background */}
      <div className="absolute top-0 right-0 w-64 h-64 bg-cyan-500/5 rounded-full blur-[100px] pointer-events-none" />

      {/* Left Side: Live Voice Conversation Hub */}
      <div className="flex flex-col justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1.5 select-none">
            <div className="p-1 rounded bg-cyan-500/10 text-cyan-400">
              <Mic className="w-4 h-4" />
            </div>
            <span className="text-xs font-mono uppercase tracking-[0.2em] text-cyan-400 font-extrabold">LIVE SPEECH SYSTEMS</span>
          </div>
          <h2 className="text-base font-mono text-white tracking-wide font-black">
            Voice Converse with Project Janus
          </h2>
          <p className="text-xs text-zinc-400 leading-relaxed font-sans mt-1">
            Engage in dynamic, low-latency voice discussions with Janus. Discuss project specifications, trigger workspace playbooks, or coordinate terminal code execution seamlessly.
          </p>
        </div>

        {/* Voice state visual feedback card */}
        <div className="bg-black/40 border border-white/5 rounded-lg p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 select-none">
          <div className="flex items-center gap-3">
            {isLive ? (
              <div className="flex items-center gap-1 shrink-0">
                <span className="w-3 h-3 rounded-full bg-cyan-400 animate-pulse" />
                {/* Simulated Equalizer wave */}
                <div className="flex items-end gap-0.5 h-4 ml-1">
                  <span className="w-0.75 bg-cyan-400 rounded-full equalizer-animation-1" style={{ height: '60%' }} />
                  <span className="w-0.75 bg-cyan-400 rounded-full equalizer-animation-2" style={{ height: '100%' }} />
                  <span className="w-0.75 bg-cyan-400 rounded-full equalizer-animation-3" style={{ height: '40%' }} />
                  <span className="w-0.75 bg-cyan-400 rounded-full equalizer-animation-4" style={{ height: '80%' }} />
                </div>
              </div>
            ) : (
              <div className="relative flex h-3 w-3 shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-zinc-600 opacity-40"></span>
                <span className="relative inline-flex rounded-full h-3 w-3 bg-zinc-650"></span>
              </div>
            )}

            <div className="flex flex-col">
              <span className="text-xs font-mono text-zinc-500 uppercase tracking-widest leading-none">AGENT STATUS</span>
              <span className="text-xs font-mono font-bold text-zinc-200 mt-1">
                {voiceAgentStatusLabel(isLive, isReconnecting, isMicMuted)}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 select-none self-end sm:self-auto shrink-0">
            {!isLive ? (
              <button
                onClick={startLive}
                className="px-4 py-2 bg-cyan-500 hover:bg-cyan-400 text-black font-extrabold text-xs font-mono rounded uppercase tracking-wider transition-all shadow-[0_0_15px_rgba(34,211,238,0.2)] hover:shadow-[0_0_20px_rgba(34,211,238,0.45)] cursor-pointer focus:outline-none"
              >
                Start Voice Chat
              </button>
            ) : (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setIsMicMuted(!isMicMuted)}
                  className={`px-3 py-1.5 border text-xs font-mono uppercase tracking-wider rounded font-extrabold transition-all cursor-pointer focus:outline-none ${
                    isMicMuted
                      ? "bg-amber-500/10 border-amber-500/30 text-amber-400"
                      : "bg-white/5 border-white/10 text-white hover:bg-white/10"
                  }`}
                >
                  {isMicMuted ? "Unmute" : "Mute"}
                </button>
                <button
                  onClick={stopLive}
                  className="px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 hover:border-red-500/30 text-red-400 text-xs font-mono uppercase tracking-wider rounded font-extrabold transition-all cursor-pointer focus:outline-none"
                >
                  Disconnect
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Right Side: Synergy Surfaces Map */}
      <div className="border-t xl:border-t-0 xl:border-l border-white/5 pt-4 xl:pt-0 xl:pl-6 flex flex-col justify-between gap-3">
        <span className="text-xs font-mono uppercase tracking-[0.2em] text-zinc-500 select-none">SYNERGY SURFACES DIRECTORY</span>

        {/* Single surface: the Spec Buffer. The Orchestration & Alerts planes were removed
            along with their helper-panel tabs. */}
        <div className="grid grid-cols-1 gap-2.5">
          {/* Plane 1: Spec Buffer */}
          <div
            onClick={() => {
              if (window.innerWidth < 1024) setMobileActiveView("buffer");
            }}
            className="p-2.5 bg-black/40 border border-white/5 hover:border-cyan-500/20 hover:bg-cyan-500/[0.01] rounded-lg transition-all cursor-pointer flex items-center justify-between group select-none"
          >
            <div className="flex gap-2.5 items-center">
              <div className="p-1 rounded bg-[#121212] text-cyan-400 group-hover:text-white font-bold flex items-center justify-center">
                <CheckSquare className="w-3.5 h-3.5" />
              </div>
              <div className="flex flex-col">
                <span className="text-xs font-mono text-zinc-200 font-bold leading-normal">System Spec Draft</span>
                <span className="text-xs text-zinc-500 leading-none">Shared Requirements Buffer</span>
              </div>
            </div>
            <span className="text-xs font-mono px-1.5 py-0.5 bg-white/5 text-zinc-400 rounded uppercase">
              {specBufferBadge(promptBuffer)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
