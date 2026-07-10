// src/exchanges/service.ts
//
// AgentExchange spine — the CORRELATOR (Phase 1, Step 1.3; spec
// docs/superpowers/specs/2026-07-09-agent-exchange-spine.md §4-§5).
//
// Wraps the pure state machine (src/exchanges/lifecycle.ts) with the one piece of bookkeeping the
// machine itself deliberately does not own: "which exchange is the ACTIVE (in-flight) one for a
// given pane right now". That binding is set EXPLICITLY, exactly once, at the moment a write
// lands (`recordDelivery`) — never inferred from matching text or timing after the fact. It is
// the mechanism behind every correlation invariant in the spec:
//   - unrelated-pane signals never settle anything (no active binding for that pane);
//   - pre-delivery signals never advance a draft/staged exchange (no active binding yet);
//   - a second delivery on the same pane supersedes (interrupts) the previous in-flight one and
//     becomes the sole target of subsequent signals;
//   - legacy/manual writes never carry an exchange_id, even byte-identical text;
//   - a restart clears the binding entirely (`recoverOnBoot`) so no post-boot signal can ever
//     reach back and settle a pre-boot exchange — the machine's own boot quarantine already moved
//     those rows to `interrupted`, and this class just makes sure nothing can un-quarantine them
//     by accident.
//
// This module intentionally has NO SQLite dependency: it is the same "pure correlation core"
// shape as the lifecycle machine it wraps, so it is fully unit-testable (tests/test_exchange_
// correlation.ts) without a database. Real wiring (src/voice/index.ts, src/dispatch/paneWrite.ts,
// src/gating/index.ts, etc., task C of step 1.3) constructs one ExchangeService per process,
// drives it from the existing observe/dispatch seams, and separately best-effort-persists the
// same events to the store (src/store/sqliteStore.ts's insertExchange/updateExchange/
// appendExchangeEvent) — persistence failures must never throw back into this class or its
// callers (spec §9.6: "a spine outage must never block or loosen a write decision").

import {
  ExchangeMachine,
  type ExchangeSnapshot,
  type ExchangeState,
  type LifecycleResult,
} from "./lifecycle";

export type PaneSignalKind = "running" | "quiescing" | "idle" | "prompt" | "error" | "exited";

export interface PaneSignal {
  paneId: string;
  kind: PaneSignalKind;
  detail?: string;
}

export interface SettleOutcome {
  exchangeId: string;
  state: ExchangeState;
}

interface CommandLogEntry {
  command: string;
  exchangeId: string | null;
}

interface CreateExchangeInput {
  projectId: string;
  paneId: string;
  operatorUtterance: string;
  distilledInstruction: string;
}

export class ExchangeService {
  private readonly machine: ExchangeMachine;
  /** paneId -> the exchange currently considered "in flight" on that pane. Set ONLY by a
   *  successful recordDelivery; cleared entirely on recoverOnBoot. This is the whole correlation
   *  mechanism — deliberately dumb (last-delivery-wins), because the spec forbids anything
   *  smarter (no text matching, no timing heuristics). */
  private readonly paneActive = new Map<string, string>();
  private readonly commandLogs = new Map<string, CommandLogEntry[]>();

  constructor(opts?: { now?: () => number }) {
    this.machine = new ExchangeMachine(opts);
  }

  createExchange(input: CreateExchangeInput): ExchangeSnapshot {
    return this.machine.create(input);
  }

  get(id: string): ExchangeSnapshot | undefined {
    return this.machine.get(id);
  }

  /** draft -> staged (the gate has already decided; this is not a gate). */
  stageForDelivery(id: string): LifecycleResult {
    return this.machine.stageAutoExecute(id);
  }

  /**
   * Two-phase delivery, PHASE 1 (spec §2b): the durable pre-write intent — legal only from
   * `staged`, increments `deliveryAttempt` WITHOUT touching the pane-correlation binding. Real
   * wiring calls this BEFORE the pane write fires (voice/index.ts's dispatch seam), so a crash
   * between phase 1 and phase 2 leaves exactly the "uncertain delivery" signature spec §4
   * quarantines on boot — never a phantom `delivered`.
   */
  beginDeliveryAttempt(id: string): LifecycleResult {
    return this.machine.markDeliveryAttempted(id);
  }

  /**
   * Two-phase delivery, PHASE 2: the write was ACCEPTED by a live PTY. Only now do the
   * correlation side effects fire: supersede whatever was previously active on this pane, bind
   * this exchange as the new active one, and record the command-log entry under this
   * exchange_id. Requires a prior `beginDeliveryAttempt` (enforced by the underlying machine).
   */
  completeDelivery(id: string): LifecycleResult {
    const before = this.machine.get(id);
    if (!before) return { ok: false, reason: "exchange_not_found" };
    const delivered = this.machine.markDelivered(id);
    if (delivered.ok) {
      this.supersede(before.paneId, id);
      this.paneActive.set(before.paneId, id);
      this.pushCommandLog(before.paneId, before.distilledInstruction, id);
    }
    return delivered;
  }

  /** Two-phase delivery, PHASE 2 (certain-failure leg): the write did NOT land (pane missing or
   *  `status === "Exited"` — the two pre-write guards a caller checks before firing the write).
   *  Re-arms the exchange to `draft` and clears the approval binding (spec §1.3 note ᵉ); the
   *  pane-correlation binding is left untouched (nothing was superseded, nothing landed). */
  failDelivery(id: string, detail?: string): LifecycleResult {
    return this.machine.markDeliveryFailed(id, detail);
  }

  /** Convenience: both delivery phases in one call, for callers (like the correlation test's
   *  `delivered()` helper) that don't need the durable gap between attempt and write — e.g. a
   *  synchronous in-process write where phase 1 and phase 2 are inseparable in practice. Real
   *  wiring that fires an actual pane write should call `beginDeliveryAttempt` BEFORE the write
   *  and `completeDelivery`/`failDelivery` AFTER, so the durable intent record truly precedes the
   *  write (spec §2b) rather than being reconstructed after the fact. */
  recordDelivery(id: string): LifecycleResult {
    const attempted = this.beginDeliveryAttempt(id);
    if (!attempted.ok) return attempted;
    return this.completeDelivery(id);
  }

  /** Draft-version binding passthroughs (spec §3) — real wiring (gating/index.ts's approval
   *  resolution, voice/index.ts's dispatch seam) drives these directly; the correlation tests
   *  exercise the lifecycle machine's own coverage for this (tests/test_exchange_lifecycle.ts,
   *  tests/test_exchange_approval_version.ts), so these are thin, untested-here passthroughs. */
  reviseDraft(id: string, instruction: string): LifecycleResult {
    return this.machine.reviseDraft(id, instruction);
  }

  requestApproval(id: string, approvalId: string): LifecycleResult {
    return this.machine.requestApproval(id, approvalId);
  }

  confirmApproval(id: string, approvalId: string, draftVersion: number): LifecycleResult {
    return this.machine.confirmApproval(id, approvalId, draftVersion);
  }

  cancel(id: string, reason?: string): LifecycleResult {
    return this.machine.cancel(id, reason);
  }

  /**
   * The delivery-marker API step 1.4 will need (task D): "which exchange is currently the ACTIVE
   * (in-flight, not yet settled) one on this pane, if any" — the exact binding `onPaneSignal`
   * consults. Step 1.4 replaces the in-memory `dispatchJoinTracker` join with this correlation;
   * this getter is the seam it will call instead of re-deriving the same state.
   */
  activeExchangeForPane(paneId: string): string | undefined {
    return this.paneActive.get(paneId);
  }

  /** terminal_idle -> agent_complete: the agent's own reported outcome (spec §9.3 — a report, not
   *  a verification). */
  recordCompletionReport(id: string, summary: string): LifecycleResult {
    return this.machine.markAgentComplete(id, summary);
  }

  /** Route one observed pane signal to whatever exchange is currently ACTIVE on that pane, if
   *  any. Signals for a pane with no active exchange (unrelated pane, pre-delivery pane, unknown
   *  pane, or a pane whose active exchange already settled) are a harmless no-op. `quiescing` is
   *  advisory-only per spec §1.4 and never reaches the machine. */
  onPaneSignal(sig: PaneSignal): SettleOutcome[] {
    if (sig.kind === "quiescing") return [];
    const activeId = this.paneActive.get(sig.paneId);
    if (!activeId) return [];
    const result = this.applySignal(activeId, sig.kind, sig.detail);
    if (!result.ok) return [];
    return [{ exchangeId: activeId, state: result.snapshot.state }];
  }

  /** A raw/legacy pane write with no exchange behind it. Recorded so `commandLog` stays a
   *  faithful ordered history, but `exchangeId` is always null — never adopted, even when the
   *  text matches a delivered instruction byte-for-byte (spec §5, command-history row). */
  recordManualCommand(paneId: string, command: string): void {
    this.pushCommandLog(paneId, command, null);
  }

  commandLog(paneId: string): CommandLogEntry[] {
    return [...(this.commandLogs.get(paneId) ?? [])];
  }

  /** Boot recovery: quarantine every uncertain in-flight exchange (delegates to the machine),
   *  then clear the active-pane binding UNCONDITIONALLY — the correlator's binding is cleared on
   *  boot (spec §4 hard rules), so no post-boot pane signal can ever reach back and settle (or
   *  un-quarantine) a pre-boot exchange, even one this class itself just interrupted. */
  recoverOnBoot(): { interrupted: string[] } {
    const out = this.machine.recoverOnBoot();
    this.paneActive.clear();
    return { interrupted: out.interrupted };
  }

  /** Interrupt whatever was previously active on this pane (if anything, and if it isn't the
   *  exchange being delivered now). Best-effort: if the prior exchange already settled, the
   *  machine's own legal-transition guard refuses the interrupt and we simply move on — an
   *  already-settled exchange is immutable, not an error. */
  private supersede(paneId: string, incomingId: string): void {
    const prior = this.paneActive.get(paneId);
    if (prior && prior !== incomingId) {
      this.machine.markInterrupted(prior, "superseded_by_new_delivery");
    }
  }

  private applySignal(activeId: string, kind: PaneSignalKind, detail?: string): LifecycleResult {
    switch (kind) {
      case "running":
        return this.machine.markRunning(activeId);
      case "idle":
        return this.machine.markTerminalIdle(activeId, detail);
      case "prompt":
        return this.machine.markNeedsInput(activeId, detail);
      case "error":
      case "exited":
        return this.machine.markAgentFailed(activeId, detail);
    }
  }

  private pushCommandLog(paneId: string, command: string, exchangeId: string | null): void {
    const log = this.commandLogs.get(paneId) ?? [];
    log.push({ command, exchangeId });
    this.commandLogs.set(paneId, log);
  }
}
