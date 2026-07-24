/**
 * BUG-043 — pure, side-effect-free helpers for the smoke:claude health check.
 *
 * This module imports NOTHING from src/terminal.ts and has NO main() / no spawn / no process.exit,
 * so importing it (e.g. from tests/test_smoke_timeouts.ts) can never stand up a live `claude` pane.
 * scripts/smoke-claude-pane.ts imports both helpers from here.
 *
 *  - resolveSmokeTimeouts(env): env-overridable, guarded parsing of the smoke's startup/response
 *    windows, with raised defaults (a plugin-heavy Claude can init well past the old hardcoded 6s).
 *  - waitForReady(term, opts): replaces the blind fixed-6s startup sleep with a real readiness gate —
 *    the pane's onReady edge (first PTY data) followed by an output-quiescence window that RE-ARMS on
 *    every post-onReady output chunk, hard-capped at startupMs so a silent/degraded child never hangs.
 */

const DEFAULT_STARTUP_MS = 15000;
const DEFAULT_RESPONSE_MS = 40000;
const DEFAULT_QUIET_MS = 1500;

/**
 * Parse a raw env value into a usable timeout, else fall back to `def`. A finite number strictly
 * greater than 0 wins; non-numeric (NaN), negative, zero, and empty-string all fall back — none of
 * those are usable submit/response windows.
 */
function parseTimeout(raw: string | undefined, def: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : def;
}

/**
 * Pure resolution of the smoke's startup/response timeouts from the environment.
 *   - startupMs: JANUS_SMOKE_STARTUP_MS   (default 15000)
 *   - responseMs: JANUS_SMOKE_RESPONSE_MS (default 40000)
 */
export function resolveSmokeTimeouts(
  env: NodeJS.ProcessEnv = process.env,
): { startupMs: number; responseMs: number } {
  return {
    startupMs: parseTimeout(env.JANUS_SMOKE_STARTUP_MS, DEFAULT_STARTUP_MS),
    responseMs: parseTimeout(env.JANUS_SMOKE_RESPONSE_MS, DEFAULT_RESPONSE_MS),
  };
}

export interface WaitForReadyOpts {
  /** Hard cap (ms): resolve `startup-timeout` if the pane never becomes ready, so the smoke never hangs. */
  startupMs: number;
  /** Output-quiescence window (ms) that must pass with no output AFTER onReady before we submit. */
  quietMs?: number;
  /** Injectable clock (defaults to setTimeout) so the gate is unit-testable with no wall-clock. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  /** Injectable clock (defaults to clearTimeout). */
  clearTimer?: (handle: unknown) => void;
}

export interface WaitForReadyResult {
  ready: boolean;
  reason: "quiescent" | "startup-timeout";
}

/**
 * Gate a submit on the pane actually being ready. Composes (does not clobber) any pre-existing
 * `term.onReady` / `term.onOutput` handler, so the caller's output accumulator keeps running.
 *
 * Semantics:
 *  - onReady (first PTY data) arms a `quietMs` quiescence timer.
 *  - each output chunk AFTER onReady RE-ARMS that timer (a still-noisy child is not yet quiescent).
 *  - the quiet window elapsing => resolve { ready: true, reason: "quiescent" }.
 *  - the `startupMs` cap elapsing first => resolve { ready: false, reason: "startup-timeout" }.
 * Resolve is idempotent (a `done` guard) and clears both timers on settle.
 */
export function waitForReady(
  term: {
    onReady?: ((id: string) => void) | null;
    onOutput?: ((id: string, chunk: string) => void) | null;
  },
  opts: WaitForReadyOpts,
): Promise<WaitForReadyResult> {
  const quietMs = opts.quietMs ?? DEFAULT_QUIET_MS;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  const priorReady = term.onReady;
  const priorOutput = term.onOutput;

  return new Promise<WaitForReadyResult>((resolve) => {
    let done = false;
    let readyFired = false;
    let quietHandle: unknown = null;
    let capHandle: unknown = null;

    const settle = (result: WaitForReadyResult): void => {
      if (done) return;
      done = true;
      if (quietHandle !== null) clearTimer(quietHandle);
      if (capHandle !== null) clearTimer(capHandle);
      resolve(result);
    };

    const armQuiet = (): void => {
      if (quietHandle !== null) clearTimer(quietHandle);
      quietHandle = setTimer(() => settle({ ready: true, reason: "quiescent" }), quietMs);
    };

    capHandle = setTimer(
      () => settle({ ready: false, reason: "startup-timeout" }),
      opts.startupMs,
    );

    term.onReady = (id: string): void => {
      if (priorReady) priorReady(id);
      if (done) return;
      readyFired = true;
      armQuiet();
    };

    term.onOutput = (id: string, chunk: string): void => {
      if (priorOutput) priorOutput(id, chunk);
      if (done || !readyFired) return;
      armQuiet(); // re-arm: output after onReady means the child is still noisy
    };
  });
}
