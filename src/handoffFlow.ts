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
import type { HandoffState, StoredHandoff } from "./store/types";

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

/**
 * The MINIMAL durable-store surface the resolve-leg flip depends on. Typed structurally (NOT as the
 * whole JanusStore) so handoffFlow stays free of the SQLite import and the seam is trivially fakeable
 * in tests. JanusStore satisfies this contract.
 */
export interface HandoffFlipStore {
  getHandoff(id: string): StoredHandoff | null;
  listHandoffs(filter?: { workspaceId?: string; toPane?: string; state?: HandoffState }): StoredHandoff[];
  updateHandoffState(id: string, state: HandoffState, patch?: Partial<StoredHandoff>): StoredHandoff | null;
}

/** Result of an attempted flip, so callers/tests can observe whether a row was touched. */
export interface HandoffFlipResult {
  /** True only when a linked handoff row was found AND the reason mapped to a state AND it was written. */
  flipped: boolean;
  /** The handoff id that was flipped (present iff flipped). */
  handoffId?: string;
  /** The state the row was flipped to (present iff flipped). */
  state?: HandoffState;
}

const NO_FLIP: HandoffFlipResult = { flipped: false };

/**
 * The resolve-leg flip (design §5.3, gap G3): given a resolved pending-approval `messageId` and its
 * resolution `reason`, transition the LINKED handoff row to its terminal/transition state. This is the
 * single, exported source of truth the server's resolver choke-point calls (server.ts:flipHandoffOnResolve
 * is a thin wrapper) so the composition resolveDecision -> flip is exercised against the REAL store, not a copy.
 *
 * Linkage (gate leg): the gated-delivery case sets gate_approval_id == handoff_id == the approval messageId,
 * so the lookup is two-way: (1) primary getHandoff(messageId) — a direct PK hit when messageId == handoff_id;
 * (2) fallback listHandoffs().filter(gate_approval_id === messageId) — covers any future case where the
 * approval id differs from the handoff id. A non-handoff approval (no matching row) is a no-op.
 *
 * Exactly-once is the CALLER's responsibility: this helper is invoked only for the resolveDecision claim
 * WINNER (reason in approved/rejected/expired/dead_pane; lost_race/not_found are excluded upstream), so a
 * double-resolve never reaches a second flip. The store performs no terminal-state early-return, so do NOT
 * rely on the store to dedupe — rely on the upstream claim gate.
 *
 * The reason->state mapping reuses resolveReasonToHandoffState (one source of truth). Provenance:
 *   approved => delivered (approved_via voice|rest + delivered_at), rejected => rejected (approved_via voice|rest),
 *   expired/dead_pane => expired (approved_via 'ttl_expire'). Throws are swallowed and reported via onError.
 */
export function applyHandoffFlipOnResolve(
  store: HandoffFlipStore | null | undefined,
  messageId: string,
  reason: HandoffResolveReason,
  opts: { vocal?: boolean; now?: () => number; onError?: (e: unknown) => void } = {}
): HandoffFlipResult {
  if (!store) return NO_FLIP;
  let handoff = store.getHandoff(messageId);
  if (!handoff) {
    const matches = store.listHandoffs().filter((h) => h.gate_approval_id === messageId);
    handoff = matches[0] ?? null;
  }
  if (!handoff) return NO_FLIP;

  const nextState = resolveReasonToHandoffState(reason);
  if (!nextState) return NO_FLIP;

  const now = opts.now ?? Date.now;
  try {
    if (nextState === "delivered") {
      store.updateHandoffState(handoff.id, "delivered", {
        approved_via: opts.vocal ? "voice" : "rest",
        delivered_at: now(),
      });
    } else if (nextState === "rejected") {
      store.updateHandoffState(handoff.id, "rejected", { approved_via: opts.vocal ? "voice" : "rest" });
    } else if (nextState === "expired") {
      store.updateHandoffState(handoff.id, "expired", { approved_via: "ttl_expire" });
    }
  } catch (e) {
    if (opts.onError) opts.onError(e);
    else console.error("[HANDOFF] Failed to flip handoff state on resolve:", e);
    return NO_FLIP;
  }
  return { flipped: true, handoffId: handoff.id, state: nextState };
}
