/**
 * PendingActionStore — deferred execution for GATED NON-PTY mutators (closes gap G1).
 *
 * The capability matrix's `Ask` tier means "human-in-the-loop". For pane WRITES that is the
 * PendingApprovalStore (the write is held, then dispatched on approve). But the non-PTY mutators
 * (create_pane, set_pane_permissions, set_global_permissions, …) have no in-flight writeInput to
 * hold — previously `Ask` for them just proceeded-and-audited (G1: the Ask tier was non-functional
 * for these, only the Off veto worked).
 *
 * This store fixes that WITHOUT touching the pane-centric write path (resolveDecision/applyResolution
 * and the 100+ tests that pin its claim/dead-pane/exactly-once invariants). It holds a deferred
 * SIDE-EFFECT closure that runs exactly once on confirm. It is deliberately separate so the two
 * concerns never entangle: PendingApproval = "should this WRITE land?"; PendingAction = "should this
 * non-write MUTATION happen?".
 *
 * Exactly-once is preserved by the same claim seam used elsewhere: confirm() claims before running.
 */

export interface PendingAction {
  /** Durable id (the confirm/cancel key). */
  id: string;
  /** The capability this action rides (audit + operator-facing message). */
  capability: string;
  /** One-line human-facing description of what will happen on confirm. */
  summary: string;
  /** Creation epoch ms — drives the TTL sweep (parity with PendingApproval). */
  timestamp: number;
  /** Set before run() so a REST+voice double-confirm can't run the effect twice. */
  claimed?: boolean;
  /** The deferred side effect. Returns a model/operator-facing result string. NOT serializable. */
  run: () => string;
}

export type ActionResolveReason = "not_found" | "lost_race" | "confirmed" | "cancelled" | "expired";

export interface ActionResolveResult {
  reason: ActionResolveReason;
  /** The record (for narration/audit). Absent only for "not_found". */
  record?: PendingAction;
  /** Present only for "confirmed": the string returned by run(). */
  output?: string;
}

export class PendingActionStore {
  private records = new Map<string, PendingAction>();
  private order: string[] = [];

  /** Stage a deferred action. `run` executes the side effect when confirmed. */
  add(rec: Omit<PendingAction, "claimed">): PendingAction {
    const full: PendingAction = { ...rec };
    this.records.set(full.id, full);
    this.order.push(full.id);
    return full;
  }

  get(id: string): PendingAction | undefined {
    return this.records.get(id);
  }

  has(id: string): boolean {
    return this.records.has(id);
  }

  all(): PendingAction[] {
    return this.order.map((id) => this.records.get(id)!).filter(Boolean);
  }

  private remove(id: string): void {
    this.records.delete(id);
    this.order = this.order.filter((x) => x !== id);
  }

  /** Atomic claim: returns true only for the first caller (exactly-once seam). */
  private claim(id: string): boolean {
    const rec = this.records.get(id);
    if (!rec || rec.claimed) return false;
    rec.claimed = true;
    return true;
  }

  /**
   * Confirm an action: claim, run its side effect exactly once, delete. A concurrent confirm/cancel
   * that lost the claim returns "lost_race" with no second run. Unknown id => "not_found".
   * If run() throws, the record is still removed (terminal) and the error is rethrown to the caller
   * to surface — the action does not linger half-applied in the store.
   */
  confirm(id: string): ActionResolveResult {
    const record = this.records.get(id);
    if (!record) return { reason: "not_found" };
    if (!this.claim(id)) return { reason: "lost_race", record };
    this.remove(id);
    const output = record.run();
    return { reason: "confirmed", record, output };
  }

  /** Cancel an action: claim (so a concurrent confirm can't then run it), delete, no side effect. */
  cancel(id: string): ActionResolveResult {
    const record = this.records.get(id);
    if (!record) return { reason: "not_found" };
    if (record.claimed) return { reason: "lost_race", record };
    record.claimed = true;
    this.remove(id);
    return { reason: "cancelled", record };
  }

  /** Records older than ttlMs (for the TTL sweep). */
  expired(ttlMs: number, now: number = Date.now()): PendingAction[] {
    return this.all().filter((a) => now - a.timestamp > ttlMs && !a.claimed);
  }

  /** Expire (claim + drop) a stale action without running it. */
  expire(id: string): ActionResolveResult {
    const record = this.records.get(id);
    if (!record) return { reason: "not_found" };
    if (record.claimed) return { reason: "lost_race", record };
    record.claimed = true;
    this.remove(id);
    return { reason: "expired", record };
  }
}
