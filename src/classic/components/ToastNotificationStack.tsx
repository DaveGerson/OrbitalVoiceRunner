// src/classic/components/ToastNotificationStack.tsx — the classic (?ui=classic) fixed top-right
// toast column, extracted VERBATIM out of src/App.tsx (App.tsx decomposition into src/classic/,
// chunk-1 "warmup leaves"). Was a `{(() => ( <div ...> ... </div> ))()}` render-closure IIFE in
// AppRaw; now a leaf taking a flat prop bag of the four independently null-gated toasts. Pure leaf:
// no hooks, no state. DOM is byte-identical — data-testid="raw-key-notification" preserved.
//
// The only tone-derived class/glyph selection (rawKeyNotification.tone === "deferred" ? amber/⏳ :
// red/⛔) is hoisted to src/classic/helpers/toastLogic.ts (pinned by tests/test_toast_logic.ts).
// The four notification state shapes are exported here so App's setters keep type-checking.

import * as React from "react";
import {
  rawKeyToneContainerClass,
  rawKeyToneTitleClass,
  rawKeyToneGlyph,
  type RawKeyTone,
} from "../helpers/toastLogic";

export type AutoApprovedNotification = { terminalId: string; cmd: string } | null;
export type BlockedNotification = { terminalId: string; cmd: string; reason: string } | null;
export type WsErrorNotification = { message: string } | null;
export type RawKeyNotification = { tone: RawKeyTone; title: string; detail: string } | null;

export function ToastNotificationStack({
  autoApprovedNotification,
  blockedNotification,
  wsErrorNotification,
  rawKeyNotification,
}: {
  autoApprovedNotification: AutoApprovedNotification;
  blockedNotification: BlockedNotification;
  wsErrorNotification: WsErrorNotification;
  rawKeyNotification: RawKeyNotification;
}) {
  return (
    <div className="fixed top-4 right-4 z-50 space-y-2 pointer-events-none">
      {autoApprovedNotification && (
        <div className="bg-[#111] border border-green-500/30 text-green-400 p-4 rounded-lg shadow-xl max-w-sm flex flex-col gap-1 pointer-events-auto animate-in slide-in-from-top-4 duration-300">
          <span className="text-xs font-mono uppercase tracking-widest text-green-500">▶ Auto-Approved & Executed</span>
          <span className="text-xs font-mono text-white/90">Node ID: {autoApprovedNotification.terminalId}</span>
          <pre className="text-xs bg-black/40 p-2 rounded text-[#b4b4b4] border border-white/5 whitespace-pre-wrap font-mono mt-1 max-h-24 overflow-y-auto">{autoApprovedNotification.cmd}</pre>
        </div>
      )}
      {blockedNotification && (
        <div className="bg-[#111] border border-red-500/30 text-red-400 p-4 rounded-lg shadow-xl max-w-sm flex flex-col gap-1 pointer-events-auto animate-in slide-in-from-top-4 duration-300">
          <span className="text-xs font-mono uppercase tracking-widest text-red-500">⛔ Access Blocked (Read-Only)</span>
          <span className="text-xs font-mono text-white/90">Node ID: {blockedNotification.terminalId}</span>
          <span className="text-xs text-zinc-400">Policy: {blockedNotification.reason}</span>
          <pre className="text-xs bg-black/40 p-2 rounded text-zinc-500 border border-white/5 whitespace-pre-wrap font-mono mt-1 max-h-24 overflow-y-auto">{blockedNotification.cmd}</pre>
        </div>
      )}
      {wsErrorNotification && (
        <div className="bg-[#111] border border-red-500/50 text-red-500 p-4 rounded-lg shadow-xl max-w-sm flex flex-col gap-1 pointer-events-auto animate-in slide-in-from-top-4 duration-300">
          <span className="text-xs font-mono uppercase tracking-widest text-red-500 font-bold">⛔ Connection / AI Error</span>
          <span className="text-xs font-mono text-white/90">{wsErrorNotification.message}</span>
        </div>
      )}
      {/* Nit #3: raw control-key outcome toast — gated (403) / deferred (202) / refused (409). */}
      {rawKeyNotification && (
        <div
          data-testid="raw-key-notification"
          className={`bg-[#111] p-4 rounded-lg shadow-xl max-w-sm flex flex-col gap-1 pointer-events-auto animate-in slide-in-from-top-4 duration-300 border ${rawKeyToneContainerClass(rawKeyNotification.tone)}`}
        >
          <span className={`text-xs font-mono uppercase tracking-widest font-bold ${rawKeyToneTitleClass(rawKeyNotification.tone)}`}>
            {rawKeyToneGlyph(rawKeyNotification.tone)}{rawKeyNotification.title}
          </span>
          <span className="text-xs font-mono text-white/90">{rawKeyNotification.detail}</span>
        </div>
      )}
    </div>
  );
}
