// src/classic/helpers/streamLogic.ts — pure, browser-API-free decision helpers for the rAF-batched
// stdout flush + the debounced terminal-resize hook (useStdoutStream). Extracted out of src/App.tsx
// (bead dbt4 — App.tsx decomposition, mirroring the src/hooks/liveSessionLogic.ts gold-standard
// seam). The rAF / setTimeout / publishChunk / apiFetch I/O stays in the hook; this module pins the
// two pure pieces so the behavior-preserving extraction changes nothing observable. See
// tests/test_stream_logic.ts.

import type { Terminal } from "../../types";

/** The per-pane preview-tail cap (lines kept in React state for the pane-card snippet). */
export const STDOUT_PREVIEW_LINE_CAP = 110;

/**
 * Append a stdout chunk to one pane's preview tail and re-cap to the last STDOUT_PREVIEW_LINE_CAP
 * lines. VERBATIM from the former App flush: `(t.output + bufMatch).split("\n").slice(-110).join("\n")`.
 */
export function appendCappedOutput(prevOutput: string, chunk: string): string {
  return (prevOutput + chunk).split("\n").slice(-STDOUT_PREVIEW_LINE_CAP).join("\n");
}

/**
 * The rAF flush body: merge the buffered chunks (keyed by terminal id) into the terminals array,
 * re-capping each touched pane's preview tail. A pane with no buffered bytes is returned untouched
 * (same object reference). VERBATIM from the former App `setTerminals((prev) => prev.map(...))`.
 */
export function applyBufferedChunks(
  terminals: Terminal[],
  buffers: Record<string, string>,
): Terminal[] {
  return terminals.map((t) => {
    const bufMatch = buffers[t.id];
    if (bufMatch) {
      return { ...t, output: appendCappedOutput(t.output, bufMatch) };
    }
    return t;
  });
}

/**
 * The grid-key dedup: skip the resize POST when the new cols×rows key matches the last one sent for
 * this pane (an unchanged grid never hits the server). VERBATIM from `lastGridRef.current[id] === key`.
 */
export function shouldSkipResize(lastKey: string | undefined, key: string): boolean {
  return lastKey === key;
}
