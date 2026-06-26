// src/memory/daemonStateTracker.ts — the OBSERVABLE-DEGRADATION accumulator for the daemon seam
// (seam Inc 2, task 2.3).
//
// What this measures, and why it is NOT `health.memory.synthesizer`:
//   - `health.memory.synthesizer` is the INSTANTANEOUS state ("python" or "fallback" right now).
//   - This tracker is the CUMULATIVE, POST-first-up degradation signal — the metric the operator
//     reads to make the FLIP/RETIRE-the-fallback decision. It answers "since the daemon first came
//     up, how many times did we fall back to TS, and how long did we spend degraded?".
//
// WARM-UP IMMUNITY (the crux): at boot the daemon is "fallback" until its first successful pong.
// That initial cold-start window is NOT a degradation — it is expected warm-up. So a "fallback"
// transition is only counted once we have observed at least one "python" (firstUp). This is exactly
// why a daemon that comes up cleanly at boot reports transitions=0: its boot-time "fallback" is
// ignored, and only a LATER python->fallback flip (a real regression) increments the counter.
//
// Pure, deterministic, no Node coupling, no timers. The `now` clock is injectable so tests pin time.

export interface DaemonStateStats {
  /** Count of python->fallback degradations observed AFTER the first successful "python" (warm-up-immune). */
  transitions: number;
  /** Cumulative wall-clock ms spent in a (post-first-up) fallback window, INCLUDING any still-open window. */
  msInFallback: number;
  /** True while a counted fallback window is currently open. */
  currentlyFallback: boolean;
}

export interface DaemonStateTracker {
  /** Feed each observed daemon state transition (the same value the daemon_state WS frame carries). */
  onTransition(state: "python" | "fallback"): void;
  /** Snapshot the cumulative degradation stats (accrues live fallback time via the injected clock). */
  stats(): DaemonStateStats;
}

/**
 * Build a daemon-state degradation tracker. `now` defaults to the standard epoch-millisecond clock;
 * inject a fake clock in tests for deterministic msInFallback assertions.
 */
export function createDaemonStateTracker(now: () => number = Date.now): DaemonStateTracker {
  let firstUp = false;
  let transitions = 0;
  let msInFallback = 0;
  let inFallbackSince = 0;

  return {
    onTransition(state) {
      if (state === "python") {
        firstUp = true;
        if (inFallbackSince > 0) {
          msInFallback += now() - inFallbackSince;
          inFallbackSince = 0;
        }
        return;
      }
      // state === "fallback": only count a degradation once the daemon has come up at least once.
      // Before firstUp this is boot warm-up, not a regression — ignore it.
      if (firstUp) {
        transitions++;
        inFallbackSince = now();
      }
    },
    stats() {
      return {
        transitions,
        msInFallback: msInFallback + (inFallbackSince > 0 ? now() - inFallbackSince : 0),
        currentlyFallback: inFallbackSince > 0,
      };
    },
  };
}
