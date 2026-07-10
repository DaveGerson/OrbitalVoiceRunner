// src/exchanges/lifecycle.ts
//
// AgentExchange spine — the PURE state machine (Phase 1, Step 1.3; spec
// docs/superpowers/specs/2026-07-09-agent-exchange-spine.md §1-§4).
//
// No I/O, no SQLite, no clock other than the injected `now()` — mirrors the decideProposal /
// resolveDecision pure-core idiom used elsewhere in this codebase. Persistence (the storage layer,
// src/store/sqliteStore.ts, already landed in step 1.2) and pane/command correlation (step 1.3's
// src/exchanges/service.ts) are built ON TOP of this module; this file owns only the 12-state
// machine, the legal-transition relation, draft-version/approval CAS binding, two-phase delivery
// ordering, cancellation, and boot-quarantine disposition.

import { type ExchangeState, mintExchangeId } from "./types";

/** The 12 lifecycle states (spec §1.1) — the canonical type lives in ./types (schema-layer,
 *  column-for-column with the DB); re-exported here for compatibility with every existing
 *  `import { ExchangeState } from "./lifecycle"` call site (this machine module is where most
 *  consumers first met the type). */
export type { ExchangeState };

export const EXCHANGE_STATES: readonly ExchangeState[] = [
  "draft", "awaiting_clarification", "awaiting_approval", "staged", "delivered",
  "running", "needs_input", "terminal_idle", "agent_complete", "agent_failed",
  "interrupted", "cancelled",
];

/** Terminal states have no outgoing edges at all (spec §1.1). */
export const TERMINAL_STATES: ReadonlySet<ExchangeState> = new Set([
  "agent_complete", "agent_failed", "cancelled",
]);

/** Every non-terminal state, including the semi-terminal `interrupted` (spec §1.1: 9 states). */
export const CANCELLABLE_STATES: ReadonlySet<ExchangeState> = new Set(
  EXCHANGE_STATES.filter((s) => !TERMINAL_STATES.has(s)),
);

/**
 * The normative legal-transition relation, transcribed verbatim from spec §1.3 (and pinned
 * 1:1 by tests/test_exchange_lifecycle.ts's own `LEGAL` table — do not drift from either without
 * updating both). Every ordered pair NOT listed here is illegal, including every self-loop.
 */
const LEGAL_TRANSITIONS: ReadonlySet<string> = new Set([
  "draft->awaiting_clarification",
  "draft->awaiting_approval",
  "draft->staged",
  "draft->cancelled",
  "awaiting_clarification->draft",
  "awaiting_clarification->cancelled",
  "awaiting_approval->draft",
  "awaiting_approval->staged",
  "awaiting_approval->cancelled",
  "staged->delivered",
  "staged->draft",
  "staged->interrupted",
  "staged->cancelled",
  "delivered->running",
  "delivered->needs_input",
  "delivered->terminal_idle",
  "delivered->agent_failed",
  "delivered->interrupted",
  "delivered->cancelled",
  "running->needs_input",
  "running->terminal_idle",
  "running->agent_failed",
  "running->interrupted",
  "running->cancelled",
  "needs_input->running",
  "needs_input->terminal_idle",
  "needs_input->agent_failed",
  "needs_input->interrupted",
  "needs_input->cancelled",
  "terminal_idle->agent_complete",
  "terminal_idle->agent_failed",
  "terminal_idle->running",
  "terminal_idle->interrupted",
  "terminal_idle->cancelled",
  "interrupted->cancelled",
]);

export function isLegalTransition(from: ExchangeState, to: ExchangeState): boolean {
  return LEGAL_TRANSITIONS.has(`${from}->${to}`);
}

// `assertTransition` (a throwing wrapper around `isLegalTransition`) was removed here — dead API,
// zero consumers anywhere in src/ or tests/ beyond its own definition (Fix 5, dead-API removal
// pass). The service layer always wants the soft `LifecycleResult` form (`transition` below); a
// future tooling/debug call site that genuinely wants a hard throw can trivially re-add a one-line
// wrapper around `isLegalTransition`.

/**
 * Boot-recovery disposition, per state (spec §4 table). Pure: no store access, no scanning of
 * history — recovery must never invent correlation, it only classifies the state a row already
 * has.
 */
export function recoveryDisposition(state: ExchangeState): "keep" | "interrupt" {
  switch (state) {
    case "staged":
    case "delivered":
    case "running":
    case "needs_input":
    case "terminal_idle":
      return "interrupt";
    default:
      return "keep";
  }
}

export interface ExchangeSnapshot {
  exchangeId: string;
  projectId: string;
  paneId: string;
  state: ExchangeState;
  draftVersion: number;
  approvalId: string | null;
  approvalDraftVersion: number | null;
  deliveryAttempt: number;
  operatorUtterance: string;
  distilledInstruction: string;
  terminalState: string | null;
  resultSummary: string | null;
  createdAt: number;
  updatedAt: number;
  deliveredAt: number | null;
  completedAt: number | null;
}

export type LifecycleResult =
  | { ok: true; snapshot: ExchangeSnapshot }
  | { ok: false; reason: string; snapshot?: ExchangeSnapshot };

interface CreateInput {
  projectId: string;
  paneId: string;
  operatorUtterance: string;
  distilledInstruction: string;
  exchangeId?: string;
}

function copy(snap: ExchangeSnapshot): ExchangeSnapshot {
  return { ...snap };
}

/**
 * The pure state machine. In-memory only (a Map keyed by exchangeId) — durable persistence is a
 * separate concern (the store already implements the same CAS idiom in SQL, src/store/sqliteStore
 * .ts `updateExchange`); this class is the single source of truth for what transitions are LEGAL
 * and what side effects (version bump, approval binding, delivery stamps) each one carries.
 */
export class ExchangeMachine {
  private readonly now: () => number;
  private readonly exchanges = new Map<string, ExchangeSnapshot>();

  constructor(opts?: { now?: () => number }) {
    this.now = opts?.now ?? (() => Date.now());
  }

  create(input: CreateInput): ExchangeSnapshot {
    const ts = this.now();
    const snap: ExchangeSnapshot = {
      exchangeId: input.exchangeId ?? mintExchangeId(ts),
      projectId: input.projectId,
      paneId: input.paneId,
      state: "draft",
      draftVersion: 1,
      approvalId: null,
      approvalDraftVersion: null,
      deliveryAttempt: 0,
      operatorUtterance: input.operatorUtterance,
      distilledInstruction: input.distilledInstruction,
      terminalState: null,
      resultSummary: null,
      createdAt: ts,
      updatedAt: ts,
      deliveredAt: null,
      completedAt: null,
    };
    this.exchanges.set(snap.exchangeId, snap);
    return copy(snap);
  }

  get(id: string): ExchangeSnapshot | undefined {
    const s = this.exchanges.get(id);
    return s ? copy(s) : undefined;
  }

  /** Generic guarded transition: legality comes from `isLegalTransition` alone; `patch` supplies
   *  any additional field changes (version bumps, stamps, binding clears). Central helper so each
   *  public method stays a one-line legality-plus-effect call (keeps McCabe/cognitive complexity
   *  low per method). */
  private transition(
    id: string,
    to: ExchangeState,
    patch?: (cur: ExchangeSnapshot) => Partial<ExchangeSnapshot>,
  ): LifecycleResult {
    const cur = this.exchanges.get(id);
    if (!cur) return { ok: false, reason: "exchange_not_found" };
    if (!isLegalTransition(cur.state, to)) {
      return { ok: false, reason: `illegal_transition:${cur.state}->${to}`, snapshot: copy(cur) };
    }
    const next: ExchangeSnapshot = {
      ...cur,
      ...(patch ? patch(cur) : {}),
      state: to,
      updatedAt: this.now(),
    };
    this.exchanges.set(id, next);
    return { ok: true, snapshot: copy(next) };
  }

  reviseDraft(id: string, instruction: string): LifecycleResult {
    const cur = this.exchanges.get(id);
    if (!cur) return { ok: false, reason: "exchange_not_found" };
    if (cur.state !== "draft" && cur.state !== "awaiting_approval") {
      return { ok: false, reason: `illegal_transition:${cur.state}->draft(revise)`, snapshot: copy(cur) };
    }
    const next: ExchangeSnapshot = {
      ...cur,
      state: "draft",
      draftVersion: cur.draftVersion + 1,
      distilledInstruction: instruction,
      approvalId: null,
      approvalDraftVersion: null,
      updatedAt: this.now(),
    };
    this.exchanges.set(id, next);
    return { ok: true, snapshot: copy(next) };
  }

  requestClarification(id: string, _question: string): LifecycleResult {
    return this.transition(id, "awaiting_clarification");
  }

  resolveClarification(id: string, instruction: string): LifecycleResult {
    return this.transition(id, "draft", (cur) => ({
      draftVersion: cur.draftVersion + 1,
      distilledInstruction: instruction,
    }));
  }

  requestApproval(id: string, approvalId: string): LifecycleResult {
    return this.transition(id, "awaiting_approval", (cur) => ({
      approvalId,
      approvalDraftVersion: cur.draftVersion,
    }));
  }

  /** CAS: only the caller holding the exact bound (approvalId, draftVersion) pair can confirm
   *  (spec §3). A stale/mismatched pair is a recorded no-op, never a second delivery. */
  confirmApproval(id: string, approvalId: string, draftVersion: number): LifecycleResult {
    const cur = this.exchanges.get(id);
    if (!cur) return { ok: false, reason: "exchange_not_found" };
    if (cur.state !== "awaiting_approval") {
      return { ok: false, reason: "not_awaiting_approval", snapshot: copy(cur) };
    }
    if (cur.approvalId !== approvalId || cur.approvalDraftVersion !== draftVersion) {
      return { ok: false, reason: "stale_approval_binding", snapshot: copy(cur) };
    }
    return this.transition(id, "staged");
  }

  stageAutoExecute(id: string): LifecycleResult {
    return this.transition(id, "staged");
  }

  /** Two-phase durable intent, phase 1 (spec §2b): legal only from `staged`; increments
   *  `deliveryAttempt` WITHOUT changing state (the attempt is intent, not the delivered fact). */
  markDeliveryAttempted(id: string): LifecycleResult {
    const cur = this.exchanges.get(id);
    if (!cur) return { ok: false, reason: "exchange_not_found" };
    if (cur.state !== "staged") {
      return { ok: false, reason: `illegal_attempt_from:${cur.state}`, snapshot: copy(cur) };
    }
    const next: ExchangeSnapshot = { ...cur, deliveryAttempt: cur.deliveryAttempt + 1, updatedAt: this.now() };
    this.exchanges.set(id, next);
    return { ok: true, snapshot: copy(next) };
  }

  /** Two-phase durable intent, phase 2: requires a prior recorded attempt (spec §2b) — refuses
   *  otherwise. Idempotent: once `delivered`, a repeat call fails the `staged` CAS and
   *  `deliveredAt` never moves. */
  markDelivered(id: string): LifecycleResult {
    const cur = this.exchanges.get(id);
    if (!cur) return { ok: false, reason: "exchange_not_found" };
    if (cur.state !== "staged" || cur.deliveryAttempt < 1) {
      return { ok: false, reason: "no_recorded_delivery_attempt", snapshot: copy(cur) };
    }
    return this.transition(id, "delivered", () => ({ deliveredAt: this.now() }));
  }

  /** Certain-failure re-arm (spec §1.3 note ᵉ): the approval binding is cleared — a re-send needs
   *  a FRESH approval — but `deliveryAttempt` is left on the record (it happened). */
  markDeliveryFailed(id: string, _detail?: string): LifecycleResult {
    return this.transition(id, "draft", () => ({ approvalId: null, approvalDraftVersion: null }));
  }

  markRunning(id: string): LifecycleResult {
    return this.transition(id, "running");
  }

  markNeedsInput(id: string, detail?: string): LifecycleResult {
    return this.transition(id, "needs_input", () => (detail ? { terminalState: detail } : {}));
  }

  markTerminalIdle(id: string, summary?: string): LifecycleResult {
    return this.transition(id, "terminal_idle", () => (summary ? { terminalState: summary } : {}));
  }

  markAgentComplete(id: string, resultSummary: string): LifecycleResult {
    return this.transition(id, "agent_complete", () => ({
      resultSummary,
      completedAt: this.now(),
    }));
  }

  markAgentFailed(id: string, detail?: string): LifecycleResult {
    return this.transition(id, "agent_failed", () => ({
      terminalState: detail ?? null,
      completedAt: this.now(),
    }));
  }

  /** Legal from every cancellable state — the legal-transition table already encodes exactly
   *  that (every one of the 9 cancellable states has a `-> cancelled` edge; terminal states do
   *  not), so this needs no separate membership check. */
  cancel(id: string, _reason?: string): LifecycleResult {
    return this.transition(id, "cancelled");
  }

  /** Quarantine an in-flight exchange (restart or supersession). Legal only from the 5
   *  uncertain in-flight states (spec §1.3); never auto-resumed afterward. */
  markInterrupted(id: string, _reason?: string): LifecycleResult {
    return this.transition(id, "interrupted");
  }

  /**
   * Phase 4, Step 4.3: adopt an ALREADY-DURABLE snapshot into this in-memory machine, verbatim,
   * with NO legality check. This is deliberately not a "transition" — it exists for exactly one
   * case: a recovery action (retry/cancel/resume-inspect, src/exchanges/recoveryActions.ts)
   * operates on an exchange the durable store already knows about (possibly minted in a PRIOR
   * process — the whole point of a recovery action) but this process's `ExchangeMachine` never
   * created (a fresh boot's machine starts empty, per `recoverOnBoot`'s own doc). Without this
   * seam, a store-level CAS performed by a recovery action would leave the LIVE machine + the
   * correlator's active-pane binding (`ExchangeService.paneActive`) unaware the row now exists —
   * so a later pane signal (idle/running/needs_input) could never correlate back to it. `hydrate`
   * is the one-line fix: seed the map directly from durable truth. Never used to CREATE new
   * history, never used to skip a legality check for an ordinary transition — every ordinary
   * caller still goes through `transition()`/the named methods above. */
  hydrate(snapshot: ExchangeSnapshot): void {
    this.exchanges.set(snapshot.exchangeId, copy(snapshot));
  }

  /** Boot recovery (spec §4): quarantine every uncertain in-flight exchange to `interrupted`;
   *  never resend, never invent an outcome for anything else. Pure classification + the same
   *  guarded transition used everywhere else — no history scanning. */
  recoverOnBoot(): { kept: string[]; interrupted: string[] } {
    const kept: string[] = [];
    const interrupted: string[] = [];
    for (const [id, snap] of this.exchanges) {
      if (recoveryDisposition(snap.state) === "interrupt") {
        const r = this.markInterrupted(id, "boot_quarantine");
        if (r.ok) { interrupted.push(id); continue; }
      }
      kept.push(id);
    }
    return { kept, interrupted };
  }
}
