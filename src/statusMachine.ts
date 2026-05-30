import type { ProbeResult } from "./statusProbe";

/**
 * Pure status-decision function (WS-C design §3) — extracted from the old
 * updateStatusOnOutput for replay testing (closes BUG-038).
 *
 * The decision is busy-biased (I2): any positive "still running" signal wins.
 * Idle is only declared when the authoritative probe says no running child
 * (after debounce), or — in fallback mode — when quiescence + a narrowed prompt
 * (shell panes) hold.
 *
 * This function makes NO side effects and arms NO timers; the caller
 * (UniversalTerminal) owns the timers and fires onIdle on the Running->Idle edge.
 */

export type Status = "Running" | "Idle" | "Exited";
export type RuntimeType = "shell" | "interactive_cli";

/** Narrowed shell prompt: the ENTIRE last line is a prompt (otherwise empty). */
export const SHELL_PROMPT = /(^|\n)[^\n]{0,80}?[\$#%>]\s?$/;

export type StatusEvent =
  | { kind: "output"; text: string }   // an output chunk arrived (ANSI-stripped recent tail)
  | { kind: "probe"; probe: ProbeResult } // a probe tick
  | { kind: "input" }                  // writeInput — optimistic Running
  | { kind: "idleTimer" };             // the debounced idle timer fired

export interface DecideInputs {
  event: StatusEvent;
  currentStatus: Status;
  runtimeType: RuntimeType;
  /** Recent ANSI-stripped tail used for fallback prompt detection. */
  recentTail: string;
  /**
   * Confidence of the most recent probe. "authoritative" => the process-state
   * probe drives idle (output never claims idle on its own). "fallback" =>
   * quiescence + prompt drive idle (no-worse-than-today).
   */
  confidence: "authoritative" | "fallback";
  /**
   * Whether a debounced idle timer is already pending. Prevents an authoritative
   * stream of "no child" probes from continually re-arming (and thus never
   * firing) the timer — the timer must be allowed to run to completion.
   */
  idleTimerArmed: boolean;
}

export interface DecideResult {
  /** Resulting status after applying the event. */
  status: Status;
  /** Whether the caller should (re)arm the debounced idle timer. */
  armIdleTimer: boolean;
  /** Whether the caller should clear any pending idle timer. */
  clearIdleTimer: boolean;
  /** True on a genuine Running->Idle edge — caller fires onIdle exactly once. */
  fireOnIdle: boolean;
}

function lastLineIsPrompt(tail: string): boolean {
  return SHELL_PROMPT.test(tail);
}

const NO_CHANGE = (status: Status): DecideResult => ({
  status,
  armIdleTimer: false,
  clearIdleTimer: false,
  fireOnIdle: false,
});

export function decideStatus(inp: DecideInputs): DecideResult {
  const { event, currentStatus, runtimeType, recentTail, confidence, idleTimerArmed } = inp;

  // Tier 0 — Exited is terminal and immune to all lower tiers.
  if (currentStatus === "Exited") {
    return { status: "Exited", armIdleTimer: false, clearIdleTimer: true, fireOnIdle: false };
  }

  const setRunning = (): DecideResult => ({
    status: "Running",
    armIdleTimer: false,
    clearIdleTimer: true,
    fireOnIdle: false,
  });

  // Arm the debounced idle timer, but only if one is not already pending — a
  // stream of identical "no child" probes must not keep resetting it (otherwise
  // it never fires). Status is unchanged until the timer actually elapses.
  const armIdleOnce = (): DecideResult => ({
    status: currentStatus,
    armIdleTimer: !idleTimerArmed,
    clearIdleTimer: false,
    fireOnIdle: false,
  });

  const setIdle = (): DecideResult => ({
    status: "Idle",
    armIdleTimer: false,
    clearIdleTimer: true,
    fireOnIdle: currentStatus === "Running",
  });

  switch (event.kind) {
    case "input":
      // An input means a turn is starting — optimistic Running (Tier A kick, I2).
      return setRunning();

    case "probe": {
      if (event.probe.confidence === "authoritative") {
        if (event.probe.hasRunningChild) {
          // I2 — authoritative busy wins, cancel any pending idle timer.
          return setRunning();
        }
        // No running child: eligible for Idle but debounced by idleTimeoutMs.
        return armIdleOnce();
      }
      // Fallback-confidence probe carries no authoritative signal; ignore it and
      // let output/quiescence drive.
      return NO_CHANGE(currentStatus);
    }

    case "output": {
      if (confidence === "authoritative") {
        // Authoritative mode: the probe OWNS idle (I1). A stray async byte (a
        // clock, a notification) from a resting shell/agent must not cancel an
        // armed idle timer. Only treat output as a Running kick when currently
        // Idle; while already Running/awaiting-idle, leave the timer to the probe.
        if (currentStatus === "Idle") {
          return setRunning();
        }
        return NO_CHANGE(currentStatus);
      }
      // Fallback mode: Running now, and arm the quiescence timer so silence can
      // later mean Idle (no-worse-than-today). Re-arm on every chunk so the
      // window is measured from the LAST output.
      return {
        status: "Running",
        armIdleTimer: true,
        clearIdleTimer: false,
        fireOnIdle: false,
      };
    }

    case "idleTimer": {
      // The debounced timer fired.
      if (confidence === "authoritative") {
        // The timer is only armed in authoritative mode after a "no running
        // child" probe; any reappearing child would have fired a probe tick that
        // called setRunning() and cleared this timer. So if it survives to fire,
        // no child is running ⇒ safe to declare Idle.
        return setIdle();
      }
      // Fallback mode: gate by runtime_type (I4). Shell panes idle on
      // quiescence + a narrowed prompt; interactive_cli idles on quiescence only
      // and NEVER on a prompt-looking line.
      if (runtimeType === "shell") {
        if (lastLineIsPrompt(recentTail)) {
          return setIdle();
        }
        // No prompt visible — quiescence alone (no worse than today).
        return setIdle();
      }
      // interactive_cli in fallback: idle purely on quiescence, never prompt regex.
      return setIdle();
    }

    default:
      return NO_CHANGE(currentStatus);
  }
}
