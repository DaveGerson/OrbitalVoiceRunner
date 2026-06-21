/**
 * src/dispatch/paneWrite.ts — the SHARED PANE-WRITE DISPATCH CORE (c55.9 / A3-min).
 *
 * This is the [apply effect] half of the pane-write pipe `[decide gate] → [apply effect]` carved out
 * of the voice closure `dispatchProposal` (src/voice/index.ts:429-522). The [decide] half
 * (effectiveModeFor + effectiveCapabilityGateFor + decideProposal, src/gating + src/pendingApprovals)
 * is ALREADY shared, pure code — this module does NOT duplicate it. Callers resolve the gate first and
 * hand the resulting `ProposalDecision` in.
 *
 * Why a NEW module (not src/gating): `src/gating` is the [decide] core (the pure resolver + the
 * pending stores + the posture surface). The effect-switch is the connection-bound WRITE engine — it
 * branches on the decision, fires `term.writeInput`, emits `broadcast`/notify frames, and stages an
 * approval record. Folding it into src/gating would re-couple the just-decoupled decision core to
 * broadcast frames + live pane I/O. Keeping it in src/dispatch keeps the seam clean and is exactly the
 * module both surfaces (voice now, REST in c55.9 step 2) import.
 *
 * The THREE connection-bound bindings live on `conn`; everything else (manager, the stores, broadcast,
 * the HistoryManager write, redaction, posture) is connection-AGNOSTIC and lives on `deps`. One dispatch
 * engine, two bindings — structurally preventing the voice/REST surfaces from ever re-diverging.
 *
 * STEP 1 INVARIANT: the voice path that calls this (the thin wrapper in src/voice/index.ts) is
 * BYTE-IDENTICAL to the pre-extraction inline switch — same frames, same side effects, same return
 * text. Pinned by the voice regression suite (tests/test_approvals_wse.ts).
 */

import type { OrchestratorManager } from "../terminal";
import type {
  ApprovalKind,
  EffectiveMode,
  PendingApproval,
  PendingApprovalStore,
  ProposalDecision,
} from "../pendingApprovals";
import { isPaneActiveForWrite, inactivePaneClarify } from "../activePane";
import type { CapabilityGate, GateValue } from "../types";
import type { LiveSessionLike, DispatchOutcome } from "../actions/types";

/**
 * The connection-AGNOSTIC collaborators + the per-call request context the effect-switch needs. This
 * bag is rebuilt per dispatch call by the thin wrapper (it captures the server-lifetime collaborators
 * by closure and folds in the call's resolved request: targetId, instruction, capability, kind, trigger,
 * the resolved effectiveMode, the pre-redacted instruction, the live term, and the live activePaneId
 * read). NONE of these differ between voice and REST — only `conn` (below) does.
 */
export interface DispatchDeps {
  // ── server-lifetime collaborators ──────────────────────────────────────────
  manager: OrchestratorManager;
  pendingApprovals: PendingApprovalStore;
  broadcast: (msg: any) => void;
  /** record the command in the HistoryManager singleton (auto-execute arm) — passed in, not imported. */
  addCommand: (terminalId: string, command: string) => void;
  redactSecrets: (text: string) => string;
  /** redacted pane snapshot for the approval rationale (== manager.getPaneSummary, injected by name). */
  getPaneSummary: (paneId: string, lines: number) => string;
  posturePayloadForPane: (paneId: string) => {
    id: string;
    effective_gates: Record<CapabilityGate, GateValue>;
    posture: unknown;
  };
  announcementBus: { enqueue: (item: any) => void };
  /** TTL for an unresolved approval (pendingApprovals.add). */
  approvalTtlMs: number;
  /** live read of the operator's active pane (governs the active-pane guard when enforced). */
  getActivePaneId: () => string | null;
  /** the active-pane predicate (injected so the guard logic stays a single source of truth). */
  isPaneActiveForWrite: typeof isPaneActiveForWrite;

  // ── per-call request context (resolved by the caller before applyDispatchDecision) ──
  targetId: string;
  instruction: string;
  capability: CapabilityGate;
  kind: ApprovalKind;
  trigger: string;
  /** the resolved effective mode for targetId (sent on the approval frame). */
  effectiveMode: EffectiveMode;
  /** the pending-entry key (synthetic for plan steps, callId otherwise). */
  pendingId: string;
  /** the Live functionCall id consumed exactly once. */
  callId: string;
  /** the live terminal handle for targetId (undefined for an inert/ledger-only pane). */
  term: { writeInput: (s: string) => void } | undefined;
  /**
   * Fan-out staging (dispatch_to_panes). When true: (a) an `auto_execute` decision is DOWNGRADED to
   * `pending_approval` before the effect switch — nothing can land without operator confirmation —
   * and (b) the active-pane guard's clarify is skipped, which is sound precisely BECAUSE of (a):
   * the guard exists so the operator sees a write before it lands, and a staged approval is exactly
   * that. Strictly more cautious than the normal path; false/absent everywhere else.
   */
  forceStage?: boolean;
}

/**
 * The THREE connection-bound bindings (design §5). Voice binds the originating socket + live session +
 * the guard ON; REST binds broadcast + a null session + the guard OFF.
 */
export interface DispatchConn {
  /** the live Gemini session stored in the approval side-map (null on REST — a legal type; PLM4
   *  detachSession survivors already keep + resolve session-less pendings). */
  sess: LiveSessionLike | null;
  /** the pending-notify sink: voice → clientWs.send (the one originating socket); REST → broadcast. */
  notifyPending: (frame: any) => void;
  /** voice: true (Janus may only propose into the operator's open pane); REST: false (operator click). */
  enforceActivePaneGuard: boolean;
  /** for the pending record / audit. */
  origin: "voice" | "rest";
}

/**
 * applyDispatchDecision — the shared [apply effect] switch. Given a resolved gate `decision`, fire the
 * matching effect and return the model-facing DispatchOutcome. The ONLY connection-specific behavior is
 * the active-pane guard (governed by conn.enforceActivePaneGuard), the pending side-map session
 * (conn.sess), and the pending-notify sink (conn.notifyPending).
 */
export function applyDispatchDecision(
  decision: ProposalDecision,
  deps: DispatchDeps,
  conn: DispatchConn
): DispatchOutcome {
  // forceStage: a Full-Auto write becomes a staged approval (strictly more restrictive; never less).
  // Computed BEFORE the guard below so the guard-skip can key on it structurally.
  const effectiveDecision: ProposalDecision =
    deps.forceStage && decision.type === "auto_execute" ? { type: "pending_approval" } : decision;

  const refusal = activePaneGuardRefusal(effectiveDecision, deps, conn);
  if (refusal) {
    return refusal;
  }

  return applyEffect(effectiveDecision, deps, conn);
}

/**
 * Step 5 (single active pane): Janus may only propose to the pane the operator has open, so the
 * operator can SEE and improve the command before it lands (HiTL). A proposal for any other pane is
 * refused here — never written, in ANY policy mode — and Janus is told to ask for a switch. This sits
 * ABOVE the effective-mode gate on purpose. (architecture step 5.) GOVERNED by conn.enforceActivePaneGuard:
 * voice enforces it (Janus proposal); REST skips it (operator-directed click — design §5 row 3).
 * forceStage (dispatch_to_panes fan-out) skips the clarify INSTEAD of the guard's protection: the
 * auto_execute→pending downgrade guarantees nothing auto-executes, so every off-focus write still
 * surfaces to the operator as a pending approval before it can land — the property the guard exists to
 * protect. The skip is keyed on the DOWNGRADED decision (not the flag alone), so the coupling is
 * structural: if a refactor ever drops the downgrade, the skip condition fails and the guard re-engages.
 *
 * Returns the clarify outcome when the off-focus write is refused, or null to proceed.
 */
function activePaneGuardRefusal(
  effectiveDecision: ProposalDecision,
  deps: DispatchDeps,
  conn: DispatchConn
): DispatchOutcome | null {
  const forceStagedSafely = deps.forceStage === true && effectiveDecision.type !== "auto_execute";
  if (!conn.enforceActivePaneGuard || forceStagedSafely) {
    return null;
  }
  const activePaneId = deps.getActivePaneId();
  if (deps.isPaneActiveForWrite(activePaneId, deps.targetId)) {
    return null;
  }
  return { kind: "clarify", text: inactivePaneClarify(activePaneId, deps.targetId) };
}

/** The post-guard [apply effect] switch — fire the matching effect for the resolved decision. */
function applyEffect(
  effectiveDecision: ProposalDecision,
  deps: DispatchDeps,
  conn: DispatchConn
): DispatchOutcome {
  const { broadcast, targetId, instruction, capability } = deps;
  const safeInstr = deps.redactSecrets(instruction);

  switch (effectiveDecision.type) {
    case "error_no_pane":
      return { kind: "error", text: `Error: pane ${targetId} not found.` };
    case "error_kind_mismatch":
      return { kind: "error", text: effectiveDecision.reason };
    case "clarify_shell":
      // Non-blocking re-route (never a dead-end, never execution).
      return { kind: "clarify", text: effectiveDecision.reason };
    case "capability_forbidden":
      broadcast({ type: "command_blocked", terminalId: targetId, cmd: safeInstr, reason: `Capability '${capability}' is set to Off.` });
      return { kind: "blocked", text: `Error: the '${capability}' capability is gated Off for pane ${targetId}; this action is forbidden by policy.` };
    case "blocked_read_only":
      broadcast({ type: "command_blocked", terminalId: targetId, cmd: safeInstr, reason: "Read-Only policy enforced." });
      return { kind: "blocked", text: `Error: Write execution block is active. Pane ${targetId} is Read-Only.` };
    case "auto_execute":
      return applyAutoExecute(deps, safeInstr);
    case "pending_approval":
      return applyPendingApproval(deps, conn, safeInstr);
  }
}

/** auto_execute arm — immediate Full-Auto write (guards the inert/ledger-only pane). */
function applyAutoExecute(deps: DispatchDeps, safeInstr: string): DispatchOutcome {
  const { broadcast, addCommand, targetId, instruction, term } = deps;
  // Inert boot (feat/local-testing) means a pane can exist in the ledger without a live process
  // until it is restarted. `paneExists` is true for such a pane, so guard the immediate Full-Auto
  // write: if there is no live terminal, refuse instead of crashing on `term!.writeInput`. (The
  // pending-approval path re-checks liveness at resolve time.)
  if (!term) {
    return { kind: "error", text: `Pane ${targetId} is not running. Start it first (restart the pane), then try again.` };
  }
  addCommand(targetId, instruction);
  term.writeInput(instruction);
  broadcast({ type: "command_auto_executed", terminalId: targetId, cmd: safeInstr });
  return { kind: "executed", text: `Command executed automatically on pane ${targetId}: "${safeInstr}"` };
}

/** pending_approval arm — stage a serializable record + session and notify NON-BLOCKINGLY. */
function applyPendingApproval(
  deps: DispatchDeps,
  conn: DispatchConn,
  safeInstr: string
): DispatchOutcome {
  const {
    manager,
    pendingApprovals,
    redactSecrets,
    getPaneSummary,
    posturePayloadForPane,
    announcementBus,
    approvalTtlMs,
    targetId,
    instruction,
    capability,
    kind,
    trigger,
    effectiveMode,
    pendingId,
    callId,
  } = deps;
  // WS-E.1 two-phase: store a serializable pending entry + the session in the side-map, mark it
  // announced for targeting, and let the caller answer call.id NON-BLOCKINGLY.
  const pSummary = redactSecrets(getPaneSummary(targetId, 5));
  const rationale = { trigger: redactSecrets(trigger), summary: pSummary };
  const record: PendingApproval = { messageId: pendingId, instruction, kind, terminalId: targetId, callId, rationale, timestamp: Date.now(), capability };
  pendingApprovals.add(record, conn.sess, {
    workspaceId: manager.ledger.activeProjectId || "default_project",
    ttlMs: approvalTtlMs,
  });
  // WS-D path: approval arrival is a high-severity attention source (earcon + stack).
  // 1C.1: the REAL approval_pending kind — this used to borrow kind:"exited" for its severity,
  // which rendered "Pane 'x' exited." for a healthy pane awaiting approval.
  announcementBus.enqueue({ kind: "approval_pending", terminalId: targetId, summary: "Awaiting your approval." });
  // rbh: enrich the approval frame with the TARGET pane's EFFECTIVE posture so the dialog can show
  // "into what posture am I approving this write?". posturePayloadForPane is frozen-aware on main, so
  // the approval path needs no separate frozen fix (only the action path did). All additive optional
  // fields — older clients ignore them; the harness-fed e2e specs degrade.
  const approvalPosture = posturePayloadForPane(targetId);
  conn.notifyPending({
    type: "approval_pending", messageId: pendingId, cmd: safeInstr, instruction: safeInstr, kind, terminalId: targetId, rationale,
    effective_gates: approvalPosture.effective_gates,
    posture: approvalPosture.posture,
    effective_mode: effectiveMode,
    capability,
  });
  const verb = kind === "agent_instruction" ? "direct pane" : "run on pane";
  return { kind: "pending", text: `Pending approval: ${verb} ${targetId} — "${safeInstr}". Read it back to the operator and ask them to approve or reject.` };
}
