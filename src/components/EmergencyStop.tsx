/**
 * EmergencyStop — the global two-stage STOP-ALL control + FROZEN banner (bead 8sq, spec §2.C).
 *
 * STAGE 1 (instant, reversible): a top-bar "Stop everything" button. One tap freezes Janus (the
 * server short-circuits every capability to Off) and cancels everything in flight; panes keep
 * running. The FROZEN banner then appears with two affordances:
 *   - STAGE 2 (deliberate, irreversible): a HOLD-TO-FIRE button (a ~1s filling ring; release to
 *     cancel) that kills the N running pane PTYs. Plain copy: "Also kill the N running panes?
 *     Can't be undone."
 *   - Release: clears the freeze (the matrix was never mutated, so it's a clean restore).
 *
 * All strings are plain human language (no raw identifiers). The component is presentational: the
 * parent owns `frozen`/`runningCount` (server truth via the `frozen` WS event) and supplies the
 * three action callbacks.
 */

import React, { useEffect, useRef, useState } from "react";
import { Square, Flame } from "lucide-react";

interface EmergencyStopProps {
  frozen: boolean;
  /** Panes still running while frozen (the Stage-2 kill target count). */
  runningCount: number;
  onFreeze: () => void;          // Stage 1
  onKill: () => void;            // Stage 2 (fired only after the full hold)
  onRelease: () => void;         // clear the freeze
}

const HOLD_MS = 1000; // hold-to-fire duration for the irreversible kill.

export function EmergencyStop({ frozen, runningCount, onFreeze, onKill, onRelease }: EmergencyStopProps) {
  // Hold-to-fire progress (0..1) for the Stage-2 kill ring.
  const [progress, setProgress] = useState(0);
  const holdingRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const startRef = useRef(0);

  const cancelHold = () => {
    holdingRef.current = false;
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    setProgress(0);
  };

  // Tear down any in-flight hold if the banner unmounts (e.g. release elsewhere).
  useEffect(() => cancelHold, []);
  // If the freeze clears (release), reset the ring.
  useEffect(() => { if (!frozen) cancelHold(); }, [frozen]);

  const beginHold = () => {
    if (runningCount === 0) return; // nothing to kill
    holdingRef.current = true;
    startRef.current = performance.now();
    const tick = (now: number) => {
      if (!holdingRef.current) return;
      const p = Math.min((now - startRef.current) / HOLD_MS, 1);
      setProgress(p);
      if (p >= 1) {
        holdingRef.current = false;
        rafRef.current = null;
        setProgress(0);
        onKill();
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  if (!frozen) {
    // Stage-1 trigger lives in the top bar.
    return (
      <button
        type="button"
        data-testid="stop-all-trigger"
        onClick={onFreeze}
        title="Freeze Janus and cancel everything in progress (you can release this). Panes keep running."
        className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-red-500/40 bg-red-500/10 text-red-400 hover:bg-red-500/20 hover:text-red-300 transition-colors cursor-pointer font-mono text-xs uppercase tracking-[0.1em] font-bold shrink-0"
      >
        <Square className="w-3.5 h-3.5" />
        Stop Everything
      </button>
    );
  }

  // FROZEN banner (rendered below the header by the parent).
  return (
    <div
      data-testid="frozen-banner"
      className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 px-4 lg:px-6 py-3 bg-red-950/40 border-b border-red-500/40 backdrop-blur-md shrink-0 animate-in fade-in slide-in-from-top-2 duration-200"
    >
      <div className="flex items-center gap-3 min-w-0">
        <span className="relative flex h-3 w-3 shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />
          <span className="relative inline-flex rounded-full h-3 w-3 bg-red-500" />
        </span>
        <div className="min-w-0">
          <span className="text-red-300 font-mono text-xs uppercase tracking-widest font-bold block leading-none">Frozen — Janus is on hold</span>
          <span className="text-xs text-red-200/70 font-sans block mt-0.5">
            Everything in progress was cancelled. {runningCount > 0
              ? `${runningCount} pane${runningCount === 1 ? "" : "s"} ${runningCount === 1 ? "is" : "are"} still running.`
              : "No panes are still running."}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {runningCount > 0 && (
          <button
            type="button"
            data-testid="stop-all-kill"
            onMouseDown={beginHold}
            onMouseUp={cancelHold}
            onMouseLeave={cancelHold}
            onTouchStart={beginHold}
            onTouchEnd={cancelHold}
            title={`Hold to kill the ${runningCount} running pane${runningCount === 1 ? "" : "s"}. This can't be undone.`}
            className="relative overflow-hidden flex items-center gap-1.5 px-3 py-1.5 rounded border border-red-500/60 bg-red-600/20 text-red-200 hover:bg-red-600/30 transition-colors cursor-pointer font-mono text-xs uppercase tracking-wider font-bold select-none"
          >
            {/* Filling ring: a left-to-right progress fill while held. */}
            <span
              data-testid="stop-all-kill-progress"
              className="absolute inset-0 bg-red-500/40 origin-left pointer-events-none"
              style={{ transform: `scaleX(${progress})`, transition: progress === 0 ? "transform 120ms ease-out" : "none" }}
            />
            <Flame className="w-3.5 h-3.5 relative" />
            <span className="relative">Hold to kill {runningCount} pane{runningCount === 1 ? "" : "s"}</span>
          </button>
        )}
        <button
          type="button"
          data-testid="stop-all-release"
          onClick={onRelease}
          title="Un-freeze Janus. Your safety gates come back exactly as they were. Any panes you killed stay killed."
          className="px-3 py-1.5 rounded border border-white/20 bg-white/5 text-zinc-200 hover:bg-white/10 hover:text-white transition-colors cursor-pointer font-mono text-xs uppercase tracking-wider font-bold"
        >
          Release
        </button>
      </div>
    </div>
  );
}
