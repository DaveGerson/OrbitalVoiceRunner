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
 *
 * WS-F follow-up (scope B, bead wsm-e2e-pinned-kzt): the store now optionally rides a durable
 * JanusStore backend so a deferred action SURVIVES a process restart. Because `run` is a closure (not
 * serializable), we persist the action's INTENT (capability + `params`) and the server rebuilds the
 * closure on boot via src/actionEffects.ts. When `store === null` (legacy / store-init-failed) every
 * method takes the EXACT original in-memory path — byte-for-byte as before.
 */

import type { StoredPendingAction } from "./store/types";
import type { VersionStamp } from "./actionEffects";

/**
 * Durable backend contract PendingActionStore depends on. JanusStore implements it; a null backend
 * (legacy / store-init-failed) means pure in-memory behavior, byte-for-byte as before. Typed
 * structurally (not the whole JanusStore) so the dependency surface stays minimal — mirrors
 * ApprovalDurableStore in src/pendingApprovals.ts.
 */
export interface ActionDurableStore {
  insertPendingAction(a: StoredPendingAction): void;
  claimAction(id: string): boolean;
  deletePendingAction(id: string): void;
  getPendingActions(): StoredPendingAction[];
}

/** Fallback TTL when add() supplies no ttlMs (mirror APPROVAL_DEFAULT_TTL_MS / server APPROVAL_TTL_MS). */
export const ACTION_DEFAULT_TTL_MS = 5 * 60 * 1000;

export interface PendingAction {
  /** Durable id (the confirm/cancel key). */
  id: string;
  /** The capability this action rides (audit + operator-facing message). */
  capability: string;
  /** One-line human-facing description of what will happen on confirm. */
  summary: string;
  /**
   * Serializable INTENT the durable row persists; rebuilt into `run` on boot via actionEffects.
   * Optional on the legacy / in-memory path (only the closure is needed there). When a durable store
   * is present AND `params` is set, add() also writes a pending_actions row.
   *
   * PLM3 version guard (F3): the server stamps the OPTIONAL { actionName, schemaHash } (VersionStamp)
   * into this bag at staging time. On boot, checkActionVersion(actionEffects) re-derives the current
   * actionSchemaHash(actionName) and QUARANTINES the rehydrated intent (re-confirm, never blind
   * replay) when the action was renamed/removed or its identity/shape drifted. buildActionRun ignores
   * the stamp; it only discriminates effects by `capability`. Legacy rows carry neither field and are
   * treated as "unknown_action".
   */
  params?: Record<string, unknown> & VersionStamp;
  /** TTL override for the durable expires_at (defaults to ACTION_DEFAULT_TTL_MS). */
  ttlMs?: number;
  /** Creation epoch ms — drives the TTL sweep (parity with PendingApproval). */
  timestamp: number;
  /** Set before run() so a REST+voice double-confirm can't run the effect twice. */
  claimed?: boolean;
  /**
   * WS-F resumption transient (spec §5/§6.3): the moment a spoken LAST-CALL was issued while a
   * frontend is connected. Drives the same last-call→grace→reject shape as PendingApproval. IN-MEMORY
   * ONLY — like `run`, it is non-serializable and never persists (it has no durable column; only the
   * action's INTENT is persisted). Cleared implicitly by removal on confirm/cancel/expire.
   */
  lastCallAt?: number;
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

  // ── WS-F durability wiring (bead wsm-e2e-pinned-kzt) ────────────────────────────────────────
  // The optional durable store persists the action's INTENT (capability + params) so a deferred
  // action survives a process reopen. The in-memory maps above remain the live, O(1) working set
  // within a running process; the store is the source of truth ONLY across a reopen. add() dual-
  // writes; claim()/remove() flip/delete the durable row so the N-1 exactly-once gate survives a
  // restart. When `store === null` every method takes the EXACT original in-memory path.
  //
  // DELIBERATE divergence from PendingApprovalStore: this class does NOT hydrate runnable records on
  // construct — it cannot rebuild the non-serializable `run`. Instead `hydrateIntents()` exposes the
  // persisted intents for the SERVER to rebuild (via actionEffects) and re-stage through add().
  private readonly store: ActionDurableStore | null;
  constructor(store: ActionDurableStore | null = null) {
    this.store = store ?? null;
  }

  /** Stage a deferred action. `run` executes the side effect when confirmed. */
  add(rec: Omit<PendingAction, "claimed">): PendingAction {
    const full: PendingAction = { ...rec };
    this.records.set(full.id, full);
    this.order.push(full.id);
    // Dual-write the durable INTENT when a store is present AND the record carries params. A re-staged
    // survivor at boot already has its row, so re-inserting is a harmless INSERT OR REPLACE.
    if (this.store && full.params) {
      const ttlMs = full.ttlMs ?? ACTION_DEFAULT_TTL_MS;
      this.store.insertPendingAction({
        id: full.id,
        capability: full.capability,
        summary: full.summary,
        params: JSON.stringify(full.params),
        claimed: full.claimed ?? false,
        timestamp: full.timestamp,
        expires_at: full.timestamp + ttlMs,
      });
    }
    return full;
  }

  /**
   * Persisted survivors as bare durable rows (capability + JSON params, NO run yet). The SERVER
   * rebuilds run via actionEffects and re-stages each through add(). Empty when store===null.
   * Ordered by durable timestamp ASC (== insertion order). Claimed rows are excluded (the durable
   * getPendingActions filters claimed=0), so a claimed-but-undeleted survivor never re-replays.
   */
  hydrateIntents(): StoredPendingAction[] {
    return this.store ? this.store.getPendingActions() : [];
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
    if (this.store) this.store.deletePendingAction(id);
    this.records.delete(id);
    this.order = this.order.filter((x) => x !== id);
  }

  /**
   * Atomic claim: returns true only for the first caller (exactly-once seam). With a durable store
   * the winner is selected by the atomic SQL `claimAction` (UPDATE ... WHERE claimed=0 => exactly one
   * caller sees changes===1) so the single-writer gate survives a reopen (a claimed-but-undeleted
   * survivor stays claimed=1 and cannot be re-claimed). The in-memory `rec.claimed` mirror is kept in
   * sync so a same-process second resolve short-circuits and `expired()`'s `!claimed` filter holds.
   */
  private claim(id: string): boolean {
    if (this.store) {
      const won = this.store.claimAction(id);
      if (won) { const rec = this.records.get(id); if (rec) rec.claimed = true; }
      return won;
    }
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

  /**
   * Cancel an action: claim (so a concurrent confirm can't then run it), delete, no side effect.
   * Routes through `this.claim(id)` so the DURABLE claim flips before remove() — a mid-cancel crash
   * (claimed but not yet deleted) does NOT re-hydrate the row on the next boot.
   */
  cancel(id: string): ActionResolveResult {
    const record = this.records.get(id);
    if (!record) return { reason: "not_found" };
    if (!this.claim(id)) return { reason: "lost_race", record };
    this.remove(id);
    return { reason: "cancelled", record };
  }

  /**
   * Per-pane DRAIN (multi-cli adapter spec §11): on a pane's promotion to Full Auto its staged
   * actions are moot (the live agent self-approves), so every pending action TARGETING that pane is
   * CANCELLED — claimed + removed, the side effect NEVER runs (a promotion is not a confirm). Targets
   * by `params.paneId` (the field set_pane_permissions / write actions stamp; a global action with no
   * paneId is never pane-drained). Routes each through cancel() so the durable claim flips before
   * remove (parity with cancel/expire — a mid-drain crash doesn't re-replay). Returns the drained
   * records (in `order`) for the caller's audit/broadcast.
   */
  drainForPane(paneId: string): PendingAction[] {
    const targets = this.order
      .map((id) => this.records.get(id))
      .filter((a): a is PendingAction => !!a && (a.params as { paneId?: unknown } | undefined)?.paneId === paneId);
    const drained: PendingAction[] = [];
    for (const a of targets) {
      const r = this.cancel(a.id); // claim + remove, NO run
      if (r.reason === "cancelled" && r.record) drained.push(r.record);
    }
    return drained;
  }

  /** Records older than ttlMs (for the TTL sweep). */
  expired(ttlMs: number, now: number = Date.now()): PendingAction[] {
    return this.all().filter((a) => now - a.timestamp > ttlMs && !a.claimed);
  }

  /**
   * Expire (claim + drop) a stale action without running it. Routes through `this.claim(id)` so the
   * DURABLE claim flips before remove() (parity with cancel()): a mid-expire crash doesn't re-replay.
   */
  expire(id: string): ActionResolveResult {
    const record = this.records.get(id);
    if (!record) return { reason: "not_found" };
    if (!this.claim(id)) return { reason: "lost_race", record };
    this.remove(id);
    return { reason: "expired", record };
  }
}
