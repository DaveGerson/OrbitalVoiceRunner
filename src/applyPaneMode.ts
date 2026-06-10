/**
 * applyPaneMode — the SINGLE live mode-switch choke point (multi-cli adapter spec §6, bead
 * wsm-e2e-pinned-1y8). EVERY mode-change caller routes through here so a Full-Auto promotion actually
 * reaches the LIVE process (bug B1: setPermissionsMode only mutated the next spawn):
 *   - the voice `set_pane_permissions` tool,
 *   - the voice `restart_pane` tool,
 *   - the UI mode <select>.
 *
 * The flow (spec §6):
 *   1. GATE on "set_pane_permissions" (it IS a lock change) — forbidden | deferred | run.
 *   2. Ask the pane's per-CLI ADAPTER how to change the mode (planModeChange):
 *        live-signal    => writeRaw(step.bytes) then READ-AFTER-WRITE — poll the pane's recent output
 *                          against the adapter's parseCurrentMode (or a step's expectMarker), bounded
 *                          by a timeout. NEVER blind cycle-counting (the ring is non-idempotent).
 *        restart-resume => rebuild shellCmd from adapter.buildResumeCommand({sessionId,mode}); await
 *                          stop(); start() (the existing lifecycle reads the rebuilt command).
 *        unsupported    => Custom has no permission model (fail-safe leg).
 *   3. On promotion to "Full Auto", DRAIN pending approvals + pending actions FOR THAT PANE (§11) — a
 *      promoted pane self-approves, so the held writes are moot; broadcast approval_resolved on each.
 *   4. Persist the mode (PERSIST-WINS, sibling of bead gpd) + broadcast settings_updated /
 *      terminals_updated.
 *
 * This is a free function over INJECTED seams (the codebase's pure-decision pattern: decideProposal,
 * resolveDecision) so it is unit-testable with a scripted fake pane + fake gate + the real pending
 * stores — no server, no real PTY, no Gemini. The server (and the locks ActionDefs) call it with the
 * live gateOrDefer / stores / broadcast / ledger-persist.
 */

import type { AgentAdapter, Mode } from "./agents";
import type { PendingApprovalStore } from "./pendingApprovals";
import type { PendingActionStore } from "./pendingActions";

/** The disposition the injected gate returns — MATCHES server.ts gateOrDefer (server.ts:1768). */
export type GateDisposition =
  | { disposition: "run" }
  | { disposition: "forbidden" }
  | { disposition: "deferred"; actionId: string; summary: string };

/** The injected gate choke-point (server.ts:1753 signature). */
export type PaneModeGate = (
  capability: string,
  paneId: string | null,
  summary: string,
  run: () => string,
  params?: Record<string, unknown>,
  requestedMode?: string,
) => GateDisposition;

/**
 * The minimal slice of UniversalTerminal applyPaneMode touches. Typed structurally (not the whole
 * class) so a scripted fake satisfies it in tests and the real terminal satisfies it in prod.
 */
export interface PaneLike {
  adapter: AgentAdapter;
  permissionsMode: Mode;
  sessionId: string;
  shellCmd: string;
  /** Raw control-byte passthrough (the live-signal primitive). */
  writeRaw(bytes: string): void;
  /** The pane's recent PTY output (the read-after-write status frame). */
  getRecentOutput(linesCount?: number): string;
  stop(): Promise<void>;
  start(): void;
}

export interface PaneModeDeps {
  gateOrDefer: PaneModeGate;
  pendingApprovals: PendingApprovalStore;
  pendingActions: PendingActionStore;
  broadcast: (msg: unknown) => void;
  /** Persist the resolved mode to the ledger (PERSIST-WINS). Called inside the gated run closure. */
  persistMode: (paneId: string, mode: Mode) => void;
  /** Read-after-write ceiling (ms) for the live-signal convergence poll. Default 1500. */
  readAfterWriteTimeoutMs?: number;
  /** Read-after-write poll interval (ms). Default 25. */
  readAfterWritePollMs?: number;
}

export type PaneModeKind = "live-signal" | "restart-resume" | "unsupported" | "forbidden" | "deferred";

export interface PaneModeResult {
  ok: boolean;
  kind: PaneModeKind;
  /** Operator-facing message (success summary or failure reason). */
  reason?: string;
  /** The deferred action id when kind === "deferred". */
  actionId?: string;
}

const DEFAULT_RAW_TIMEOUT_MS = 1500;
const DEFAULT_RAW_POLL_MS = 25;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Drain pending approvals + actions for ONE pane on its promotion to Full Auto (spec §11). Each
 * drained approval emits an `approval_resolved` frame (the PR #29 event) keyed by messageId so every
 * client dismisses its ApprovalDialog in real time; the outcome "drained" distinguishes it from an
 * approve/reject. Drained actions are cancelled silently (never run).
 */
function drainPaneOnPromotion(paneId: string, deps: PaneModeDeps): void {
  for (const rec of deps.pendingApprovals.drainForPane(paneId)) {
    deps.broadcast({
      type: "approval_resolved",
      messageId: rec.messageId,
      terminalId: rec.terminalId,
      outcome: "drained",
    });
  }
  deps.pendingActions.drainForPane(paneId);
}

/**
 * The live-signal execution: write each step's bytes, then poll the pane's recent output until the
 * adapter confirms `targetMode` (or the step's expectMarker matches), bounded by a timeout. Returns
 * true on confirmed convergence, false on timeout (an unconfirmed switch is NEVER reported as success).
 */
async function runLiveSignal(
  term: PaneLike,
  targetMode: Mode,
  steps: { bytes: string; expectMarker?: RegExp }[],
  timeoutMs: number,
  pollMs: number,
): Promise<boolean> {
  const adapter = term.adapter;
  for (const step of steps) {
    term.writeRaw(step.bytes);
    const deadline = Date.now() + timeoutMs;
    let confirmed = false;
    // Read-after-write: poll until the marker / parsed mode confirms, or the deadline passes.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const frame = term.getRecentOutput();
      if (step.expectMarker) {
        if (step.expectMarker.test(frame)) { confirmed = true; break; }
      } else if (adapter.parseCurrentMode(frame) === targetMode) {
        confirmed = true;
        break;
      }
      if (Date.now() >= deadline) break;
      await sleep(pollMs);
    }
    if (!confirmed) return false;
  }
  return true;
}

/**
 * Switch a pane to `targetMode` through the gate + the per-CLI adapter, reaching the LIVE process.
 * `source` is the caller surface (voice | ui | restart_pane), threaded into the gate intent for audit.
 */
export async function applyPaneMode(
  paneId: string,
  targetMode: Mode,
  source: "voice" | "ui" | "restart_pane",
  term: PaneLike,
  deps: PaneModeDeps,
): Promise<PaneModeResult> {
  const timeoutMs = deps.readAfterWriteTimeoutMs ?? DEFAULT_RAW_TIMEOUT_MS;
  const pollMs = deps.readAfterWritePollMs ?? DEFAULT_RAW_POLL_MS;
  const fromMode = term.permissionsMode;

  // The gated execution closure (spec §6 ordering: GATE first, then plan). On Auto it runs inline;
  // on Ask it is deferred to operator confirm. It is the ONLY thing that touches term.adapter, so a
  // gate that forbids/defers never reaches a pane's permission mechanics (and a deferred change on a
  // stub-shaped pane in tests never needs an adapter). The synchronous gate `run` signature
  // (() => string) drives these async mechanics via a shared outcome cell + an awaited promise.
  let outcome: PaneModeResult | null = null;
  const execute = async (): Promise<PaneModeResult> => {
    const plan = term.adapter.planModeChange(fromMode, targetMode);
    if (plan.kind === "unsupported") {
      return { ok: false, kind: "unsupported", reason: `Pane ${paneId} has no permission model (Custom); mode change unsupported.` };
    }
    if (plan.kind === "live-signal") {
      const converged = await runLiveSignal(term, targetMode, plan.steps, timeoutMs, pollMs);
      if (!converged) {
        return { ok: false, kind: "live-signal", reason: `Could not confirm pane ${paneId} reached ${targetMode} (read-after-write timed out).` };
      }
    } else {
      // restart-resume: rebuild the launch command from the adapter, then bounce the process.
      const sid = term.adapter.pinnedSessionId() ?? term.sessionId;
      const resume = term.adapter.buildResumeCommand({ sessionId: sid, mode: targetMode, cwd: "" });
      term.shellCmd = resume.argv.join(" ");
      await term.stop();
      term.start();
    }
    // Persist (PERSIST-WINS) + reflect the mode on the live pane object.
    term.permissionsMode = targetMode;
    deps.persistMode(paneId, targetMode);
    // Drain pending FOR THIS PANE on promotion to Full Auto (spec §11) — after the switch landed.
    if (targetMode === "Full Auto") drainPaneOnPromotion(paneId, deps);
    deps.broadcast({ type: "settings_updated", paneId, permissionsMode: targetMode });
    deps.broadcast({ type: "terminals_updated", paneId });
    return { ok: true, kind: plan.kind, reason: `Pane ${paneId} mode set to ${targetMode}.` };
  };

  // The gate's run() is synchronous; kick the async execute and stash its eventual result. Under Auto
  // we then AWAIT that promise so callers see the real outcome; under Ask the deferred run fires later.
  let executePromise: Promise<PaneModeResult> | null = null;
  const syncRun = (): string => {
    executePromise = execute().then((r) => { outcome = r; return r; });
    // Side-consumer on a SEPARATE derived promise: on the Ask→confirm path the gate replays this
    // closure later and NOBODY awaits executePromise, so a rejecting execute() would otherwise be
    // an unhandledRejection (process-killer). Deriving the .catch (instead of reassigning) leaves
    // executePromise itself rejected, so the Auto path's `await` below still sees the rejection
    // unchanged.
    executePromise.catch((e) => console.error("[applyPaneMode] deferred mode-change failed:", e));
    return `Setting pane ${paneId} permissions to ${targetMode}.`;
  };

  const g = deps.gateOrDefer(
    "set_pane_permissions",
    paneId,
    `Set pane ${paneId} permissions to ${targetMode}`,
    syncRun,
    { paneId, permissionsMode: targetMode, source },
    targetMode,
  );

  if (g.disposition === "forbidden") {
    // Same operator-facing string the legacy set_pane_permissions branch returned (golden parity).
    return { ok: false, kind: "forbidden", reason: `Error: the 'set_pane_permissions' capability is gated Off for pane ${paneId}; forbidden by policy.` };
  }
  if (g.disposition === "deferred") {
    // Byte-for-byte the legacy deferred string (voice-tool golden parity).
    return { ok: false, kind: "deferred", actionId: g.actionId, reason: `'${g.summary}' needs operator confirmation (gated Ask). I've queued it — confirm to apply.` };
  }
  // disposition === "run": the gate already invoked syncRun synchronously; await the async mechanics.
  if (executePromise) {
    await executePromise;
    return outcome ?? { ok: false, kind: "live-signal", reason: `Pane ${paneId} mode change did not complete.` };
  }
  // Defensive: a gate that returned "run" without invoking run() — execute directly.
  return execute();
}
