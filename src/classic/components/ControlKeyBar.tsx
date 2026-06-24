// src/classic/components/ControlKeyBar.tsx — the classic (?ui=classic) compact control-key strip
// and its RAW_KEY byte-sequence table, extracted VERBATIM out of src/App.tsx (bead dbt4 PR-A —
// App.tsx decomposition into a src/classic/ tree mirroring src/orbital/). Pure leaf: no hooks,
// no state, no Context. Behavior is byte-identical to the former App body.
//
// NOTE (drift guard): tests/test_rawkey_allowlist.ts scans THIS file's source AS TEXT for the
// RAW_KEY object literal (matched by its `as const` declaration) — keep that exact declaration
// shape so the 6q5 frontend-to-server raw-key drift guard keeps matching. (src/orbital/
// TerminalWindow.tsx keeps its OWN separate ControlKeyBar with a `dark` prop — unrelated.)

import * as React from "react";
import { ArrowUp, ArrowDown, ArrowLeft, ArrowRight, CornerDownLeft } from "lucide-react";

// Raw control-key byte sequences (multi-cli adapter spec §8). Written verbatim to a pane's PTY via
// the raw-input endpoint. Disruptive keys (Ctrl+C, Shift+Tab) take the amber/warn tint.
// NOTE (bead 6q5): every value here MUST also exist in the SERVER allowlist RAW_KEY_TABLE
// (src/rawKeyClass.ts) — the /raw-input route 400s any sequence not in that table. There is no
// shared import across the client/server build boundary, so the invariant is pinned by the drift
// guard in tests/test_rawkey_allowlist.ts ("every frontend RAW_KEY value is a member of
// RAW_KEY_TABLE"). Adding a key here that the server lacks fails that test RED.
export const RAW_KEY = {
  up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D",
  enter: "\r", tab: "\t", esc: "\x1b",
  pageUp: "\x1b[5~", pageDown: "\x1b[6~",
  ctrlC: "\x03", shiftTab: "\x1b[Z",
} as const;

// Compact control-key strip for a pane (arrows / Tab / Esc / Enter / Ctrl+C / Shift+Tab). Each
// button POSTs its raw bytes through `onKey` (App.writeControlKey). Reuses the existing icon-button
// styling; disruptive keys (Ctrl+C, Shift+Tab) carry the warn palette per spec §8.
export function ControlKeyBar({ paneId, onKey, testId = "control-key-bar" }: { paneId: string; onKey: (paneId: string, bytes: string) => void; testId?: string }) {
  const navBtn = "p-2 border border-white/5 hover:border-white/10 hover:bg-white/5 text-zinc-400 hover:text-white rounded active:scale-95 transition-all";
  const warnBtn = "px-2 py-1 border border-amber-500/30 hover:border-amber-500/50 bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 rounded active:scale-95 transition-all text-xs font-mono uppercase tracking-wider font-bold";
  const press = (bytes: string) => onKey(paneId, bytes);
  return (
    <div className="flex items-center gap-1 flex-wrap" data-testid={testId} role="group" aria-label="Send control key to pane">
      {/* Navigation — always-allowed */}
      <button type="button" onClick={() => press(RAW_KEY.up)} className={navBtn} title="Send Up arrow"><ArrowUp className="w-3 h-3" /></button>
      <button type="button" onClick={() => press(RAW_KEY.down)} className={navBtn} title="Send Down arrow"><ArrowDown className="w-3 h-3" /></button>
      <button type="button" onClick={() => press(RAW_KEY.left)} className={navBtn} title="Send Left arrow"><ArrowLeft className="w-3 h-3" /></button>
      <button type="button" onClick={() => press(RAW_KEY.right)} className={navBtn} title="Send Right arrow"><ArrowRight className="w-3 h-3" /></button>
      <button type="button" onClick={() => press(RAW_KEY.enter)} className={navBtn} title="Send Enter (commit staged line)"><CornerDownLeft className="w-3 h-3" /></button>
      {/* Terminal-ops — always-allowed */}
      <button type="button" onClick={() => press(RAW_KEY.tab)} className={`${navBtn} text-xs font-mono uppercase tracking-wider`} title="Send Tab">Tab</button>
      <button type="button" onClick={() => press(RAW_KEY.esc)} className={`${navBtn} text-xs font-mono uppercase tracking-wider`} title="Send Esc (dismiss/cancel)">Esc</button>
      {/* Paging — always-allowed */}
      <button type="button" onClick={() => press(RAW_KEY.pageUp)} className={`${navBtn} text-xs font-mono uppercase tracking-wider`} title="Send Page Up">PgUp</button>
      <button type="button" onClick={() => press(RAW_KEY.pageDown)} className={`${navBtn} text-xs font-mono uppercase tracking-wider`} title="Send Page Down">PgDn</button>
      {/* Disruptive — gated (warn tint) */}
      <button type="button" onClick={() => press(RAW_KEY.ctrlC)} className={warnBtn} title="Send Ctrl+C (interrupt / emergency brake)">^C</button>
      <button type="button" onClick={() => press(RAW_KEY.shiftTab)} className={warnBtn} title="Send Shift+Tab (cycle agent mode — gated)">⇧Tab</button>
    </div>
  );
}
