// src/classic/components/TranscriptPanel.tsx — the right-side "Janus Voice Log" transcript aside,
// extracted VERBATIM out of src/App.tsx's AppRaw() (bead dbt4 — App.tsx decomposition, chunk-3
// "telemetry-voice-transcript"). Mirrors the src/classic/components/ seam.
//
// Only the <aside> BODY moved here; the `showTranscriptPanel &&` gate STAYS in AppRaw (it is NOT a
// prop). JSX order/keys/data-testids/className strings/&&-?: guards are unchanged: the per-message
// isUser branch, the grounding visibility guard `item.grounding && (sources.length > 0 ||
// queries.length > 0)`, the `item.grounding!` non-null assertion narrowing, and the source-label
// derivation (now the pure `transcriptSourceLabel` helper) are all byte-identical.
//
// setTranscript is harness-wired (Clear button); AppRaw passes onClear={() => setTranscript([])} so
// the SAME setter identity fires.

import * as React from "react";
import { transcriptSourceLabel } from "../../appHelpers";

type TranscriptItem = {
  sender: "User" | "Janus";
  text: string;
  timestamp: Date;
  grounding?: { queries: string[]; sources: { uri: string; title: string }[] };
};

export function TranscriptPanel({
  transcript,
  onClear,
}: {
  transcript: TranscriptItem[];
  onClear: () => void;
}) {
  return (
    <aside className="w-80 border-l border-white/5 bg-[#090909] flex flex-col shrink-0">
      <div className="p-4 border-b border-white/5 flex items-center justify-between select-none">
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse"></span>
          <span className="text-xs font-mono tracking-wider text-white uppercase font-bold">Janus Voice Log</span>
        </div>
        <button
          onClick={onClear}
          className="text-xs uppercase font-mono px-2 py-0.5 bg-white/5 hover:bg-red-500/10 hover:text-red-400 text-zinc-500 rounded border border-transparent hover:border-red-500/20 cursor-pointer focus:outline-none"
          title="Clear transcript history"
        >
          Clear
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-3.5 scrollbar-thin">
        {transcript.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-4">
            <div className="w-8 h-8 rounded-full border border-white/5 flex items-center justify-center text-zinc-600 mb-2 font-mono text-xs select-none">?</div>
            <p className="text-xs font-mono text-zinc-500 leading-relaxed max-w-[170px] italic">
              Speak to Janus or trigger a query to stream transcripts...
            </p>
          </div>
        ) : (
          transcript.map((item, idx) => {
            const isUser = item.sender === "User";
            return (
              <div
                key={idx}
                data-testid="transcript-message"
                data-sender={item.sender}
                className={`flex flex-col max-w-[90%] ${isUser ? "ml-auto items-end" : "mr-auto items-start"}`}
              >
                <span className="text-xs font-mono opacity-30 mb-0.5 select-none uppercase">
                  {item.sender}
                </span>
                <div className={`p-2.5 rounded-lg text-xs leading-relaxed font-sans ${
                  isUser
                    ? "bg-zinc-850 text-zinc-200 rounded-tr-none border border-white/5"
                    : "bg-cyan-950/25 border border-cyan-500/20 text-cyan-200 rounded-tl-none pr-3"
                }`}>
                  {item.text}
                </div>
                {!isUser && item.grounding && (item.grounding.sources.length > 0 || item.grounding.queries.length > 0) && (
                  <div
                    data-testid="transcript-grounding"
                    className="mt-1 max-w-full text-xs font-mono text-cyan-400/60 leading-relaxed break-words"
                  >
                    <span className="opacity-70 uppercase tracking-wider">grounded via </span>
                    {item.grounding.sources.length > 0 ? (
                      item.grounding.sources.map((s, i) => (
                        <span key={i}>
                          <a
                            href={s.uri}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={s.uri}
                            className="underline decoration-dotted hover:text-cyan-300"
                          >
                            {transcriptSourceLabel(s)}
                          </a>
                          {i < item.grounding!.sources.length - 1 ? ", " : ""}
                        </span>
                      ))
                    ) : (
                      <span className="italic opacity-70">{item.grounding.queries.join("; ")}</span>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
      <div className="p-3 border-t border-white/5 bg-black/40 text-xs font-mono text-zinc-500 leading-normal select-none">
        Derived from client mic input PCM streaming mapping at 16,000 Hz.
      </div>
    </aside>
  );
}
