// src/classic/hooks/useStdoutStream.ts — the terminal stdout-streaming + resize layer, extracted
// VERBATIM out of src/App.tsx's AppRaw() (bead dbt4 — App.tsx decomposition, mirroring the
// gold-standard src/hooks/useLiveSession.ts seam: params-interface in, returns-interface out, pure
// decisions split into the node:test-pinned src/classic/helpers/streamLogic.ts sibling).
//
// Owns:
//   * stdoutBufferRef / animationFrameRef + queueStdoutChunk — the rAF-batched preview-tail flush.
//     The display lane (publishChunk → xterm) fires synchronously; the preview lane coalesces a
//     frame's worth of chunks into one setTerminals via requestAnimationFrame.
//   * resizeDebounceRef / lastGridRef + handleTerminalResize — the per-pane debounced resize POST
//     (a flurry of fit() events collapses into one POST; an unchanged grid never hits the server).
//
// *** HARNESS CONTRACT ***: queueStdoutChunk is consumed by the e2e harness (src/e2e/harness.ts —
// the E2EHarnessDeps.queueStdoutChunk field, wired into injectStdoutChunk). The extracted hook
// exposes the SAME function with identical behavior, and App still feeds that exact identity into
// useE2EHarness's deps — so the mock e2e net (terminal.spec.ts injectStdoutChunk round-trip) is
// unchanged. The mock-mode resize guard (isMockModeRef / e2eActiveRef) is threaded in unchanged.
//
// Behavior is byte-identical to the former App body: same -110 line cap, same rAF coalescing, same
// 120ms resize debounce, same grid-key dedup. No observable change — the terminal e2e is the witness.

import { useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { Terminal } from "../../types";
import { publishChunk } from "../../terminalStream";
import { apiFetch } from "../../utils/api";
import { applyBufferedChunks, shouldSkipResize } from "../helpers/streamLogic";

export interface StdoutStreamParams {
  /** The terminals updater — the rAF flush merges buffered chunks into it (updater form only). */
  setTerminals: Dispatch<SetStateAction<Terminal[]>>;
  /** App-owned mock-mode mirror; in mock mode there's no backend to resize… */
  isMockModeRef: MutableRefObject<boolean>;
  /** …EXCEPT under the e2e harness, where Playwright intercepts the POST to assert the round-trip. */
  e2eActiveRef: MutableRefObject<boolean>;
}

export interface StdoutStream {
  /** HARNESS-WIRED (see file header): App must pass THIS identity into useE2EHarness's deps. */
  queueStdoutChunk: (terminalId: string, chunk: string) => void;
  handleTerminalResize: (terminalId: string, cols: number, rows: number) => void;
}

export function useStdoutStream(params: StdoutStreamParams): StdoutStream {
  const { setTerminals, isMockModeRef, e2eActiveRef } = params;

  const stdoutBufferRef = useRef<Record<string, string>>({});
  const animationFrameRef = useRef<number | null>(null);

  const queueStdoutChunk = (terminalId: string, chunk: string) => {
    // Display lane: stream raw bytes straight into xterm (no React state, no line
    // cap, no reset thrash). xterm owns the live buffer.
    publishChunk(terminalId, chunk);

    // Preview lane: keep a capped, ANSI-bearing tail in React state purely to feed
    // the pane-card text snippets / byte count. This NO LONGER drives xterm, so the
    // -110 line cap here is harmless (it once forced a full xterm.reset per frame).
    stdoutBufferRef.current[terminalId] = (stdoutBufferRef.current[terminalId] || "") + chunk;

    if (!animationFrameRef.current) {
      animationFrameRef.current = requestAnimationFrame(() => {
        animationFrameRef.current = null;
        const currentBuffers = { ...stdoutBufferRef.current };
        stdoutBufferRef.current = {};

        setTerminals((prev) => applyBufferedChunks(prev, currentBuffers));
      });
    }
  };

  // Per-pane debounce + last-sent-grid so a flurry of fit() events (drag-resize)
  // collapses into one POST, and an unchanged grid never hits the server.
  const resizeDebounceRef = useRef<Record<string, any>>({});
  const lastGridRef = useRef<Record<string, string>>({});

  const handleTerminalResize = (terminalId: string, cols: number, rows: number) => {
    // In mock mode there's no backend to resize — EXCEPT under the e2e harness,
    // where Playwright intercepts the POST to assert the grid-sync round-trip.
    if (isMockModeRef.current && !e2eActiveRef.current) return;
    if (!cols || !rows) return;
    const key = `${cols}x${rows}`;
    if (shouldSkipResize(lastGridRef.current[terminalId], key)) return;
    lastGridRef.current[terminalId] = key;
    clearTimeout(resizeDebounceRef.current[terminalId]);
    resizeDebounceRef.current[terminalId] = setTimeout(() => {
      apiFetch(`/api/terminals/${terminalId}/resize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cols, rows }),
      }).catch(() => { /* pane may have exited; resize is best-effort */ });
    }, 120);
  };

  return { queueStdoutChunk, handleTerminalResize };
}
