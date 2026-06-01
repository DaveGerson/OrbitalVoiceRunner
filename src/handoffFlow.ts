/**
 * handoffFlow — the PURE state-mapping logic of the handoff delivery lifecycle, extracted from
 * the server's WebSocket closure so it is unit-testable against a real JanusStore WITHOUT a live
 * Gemini session (closes gap G3: the deliver_handoff -> flip mapping was previously only reachable
 * through the WS handler and so went unverified by the smoke test).
 *
 * Two mappings live here:
 *   1. deliverOutcomeToHandoff(dispatchKind) — given the dispatchProposal outcome for a staged
 *      handoff, what should happen to the persisted row.
 *   2. resolveReasonToHandoffState(reason) — given a pending-approval resolution reason, the
 *      terminal/transition state the handoff row flips to (the flipHandoffOnResolve mapping).
 *
 * These are the EXACT decisions the server makes; server.ts calls these so there is one source of
 * truth and the tests exercise the real mapping, not a copy.
 */
import type { HandoffState } from "./store/types";

/** The dispatchProposal outcome kinds relevant to a handoff delivery. */
export type DeliverDispatchKind = "executed" | "pending" | "blocked" | "error" | "clarify";

/** Pending-approval resolution reasons that flip a handoff row (mirrors ResolveReason). */
export type HandoffResolveReason = "approved" | "rejected" | "expired" | "dead_pane";

export type DeliverHandoffEffect =
  /** Full Auto: the write already landed via auto_execute; flip the row to delivered now. */
  | { kind: "deliver_now"; state: "delivered"; approvedVia: "full_auto" }
  /** HiTL: the write is pending operator approval; persist gate_approval_id, flip later on resolve. */
  | { kind: "await_approval" }
  /** Read-Only (or capability/mode block): record the row as blocked, no write. */
  | { kind: "block"; state: "blocked_read_only" }
  /** error/clarify: no state change; surface the dispatch text to the model. */
  | { kind: "noop" };

/**
 * Map a dispatchProposal outcome for a STAGED handoff to the persisted-row effect. This is the
 * authoritative deliver mapping the server's deliver_handoff handler applies.
 */
export function deliverOutcomeToHandoff(kind: DeliverDispatchKind): DeliverHandoffEffect {
  switch (kind) {
    case "executed": return { kind: "deliver_now", state: "delivered", approvedVia: "full_auto" };
    case "pending":  return { kind: "await_approval" };
    case "blocked":  return { kind: "block", state: "blocked_read_only" };
    default:         return { kind: "noop" }; // error | clarify
  }
}

/**
 * Map a pending-approval resolution reason to the handoff terminal/transition state. This is the
 * authoritative flip mapping flipHandoffOnResolve applies in the single resolver choke-point.
 * Returns null when the reason should NOT change the handoff state.
 */
export function resolveReasonToHandoffState(reason: HandoffResolveReason): HandoffState | null {
  switch (reason) {
    case "approved": return "delivered";
    case "rejected": return "rejected";
    case "expired":  return "expired";
    case "dead_pane": return "expired";
    default: return null;
  }
}
