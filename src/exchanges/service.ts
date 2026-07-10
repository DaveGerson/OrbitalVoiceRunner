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
// This module has NO HARD SQLite dependency: the pure in-memory correlation core (everything
// `ExchangeMachine` already provides) works with zero store attached, which is what keeps
// tests/test_exchange_correlation.ts and friends database-free. What follows (Phase 1, Step 1.5b)
// is an OPTIONAL durable mirror: a `JanusStore` may be attached (constructor or `attachStore`),
// and every successful transition below is best-effort persisted through the store's own CAS/
// event APIs (insertExchange/updateExchange/appendExchangeEvent, src/store/sqliteStore.ts) —
// EXACTLY the calls tests/test_exchange_integration_battery.ts's `ExchangeHarness` used to make by
// hand before this bridge existed (see that file's history / the step 1.5 CRITICAL FINDING for
// why the bridge was missing). A store failure (or no store attached) NEVER throws back into a
// caller and never changes the in-memory `LifecycleResult` returned (spec §9.6: "a spine outage
// must never block or loosen a write decision"; the QW5 never-throw philosophy in src/observe/).
//
// Persistence policy: EVERY successful transition mirrors the resulting row STATE (so the store's
// CAS predicate — "WHERE state=<from>" — never drifts out of sync with the live machine), but only
// the transitions the spec's event table (§1.4) names (plus the diagram's "superseded delivery"
// note, §1.2) also append an `exchange_events` row. One transition — `draft → staged` via the
// auto-execute gate (§1.2's "draft --> staged: auto-execute gate" edge) — has NO dedicated
// event_type in §1.4's table at all (a genuine gap between the diagram and the table, verified by
// reading both); it still gets its row-state mirrored (real call sites need that CAS anchor for
// the `delivery_attempted` write that always immediately follows it) but appends no event, which
// is the closest reading of "the spec doesn't name an audit row for this edge" without inventing
// new spec vocabulary.

import {
  ExchangeMachine,
  type ExchangeSnapshot,
  type ExchangeState,
  type LifecycleResult,
} from "./lifecycle";
import type { ExchangeEventType } from "./types";
import type { JanusStore } from "../store/sqliteStore";

export type PaneSignalKind = "running" | "quiescing" | "idle" | "prompt" | "error" | "exited";

/** event_type each pane-signal kind records, straight from spec §1.4's table — `quiescing` is
 *  intentionally absent (advisory-only, never reaches the machine, see `onPaneSignal` below). */
const PANE_SIGNAL_EVENT: Partial<Record<PaneSignalKind, ExchangeEventType>> = {
  running: "terminal_running",
  idle: "terminal_idle",
  prompt: "needs_input_detected",
  error: "agent_failure_reported",
  exited: "agent_failure_reported",
};

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
  /** Optional durable mirror (Phase 1, Step 1.5b) — constructor-injected or attached later via
   *  `attachStore`. Undefined by default, so every `new ExchangeService()` a unit test constructs
   *  stays pure in-memory (zero behavior delta from before this bridge existed): every persistence
   *  call below starts with `if (!this.store) return`. Production wiring: src/exchanges/spine.ts
   *  attaches the real `JanusStore` singleton at boot, once the flag is active. */
  private store?: JanusStore;

  constructor(opts?: { now?: () => number; store?: JanusStore }) {
    this.machine = new ExchangeMachine(opts);
    this.store = opts?.store;
  }

  /** Attach (or replace/detach with `undefined`) the durable store sink after construction — the
   *  seam src/exchanges/spine.ts uses so the store can be wired in whichever order it becomes
   *  available (the ExchangeService singleton may be constructed lazily before OR after boot
   *  finishes initializing the store). */
  attachStore(store: JanusStore | undefined): void {
    this.store = store;
  }

  createExchange(input: CreateExchangeInput): ExchangeSnapshot {
    const snap = this.machine.create(input);
    this.persistCreate(snap);
    return snap;
  }

  get(id: string): ExchangeSnapshot | undefined {
    return this.machine.get(id);
  }

  /** draft -> staged (the gate has already decided; this is not a gate). See the module-doc
   *  "Persistence policy" note: this edge has no dedicated event_type (a genuine gap between spec
   *  §1.2's diagram and §1.4's event table), so only the row STATE is mirrored — no event row. */
  stageForDelivery(id: string): LifecycleResult {
    return this.mirrored(id, () => this.machine.stageAutoExecute(id), null);
  }

  /**
   * Two-phase delivery, PHASE 1 (spec §2b): the durable pre-write intent — legal only from
   * `staged`, increments `deliveryAttempt` WITHOUT touching the pane-correlation binding. Real
   * wiring calls this BEFORE the pane write fires (voice/index.ts's dispatch seam), so a crash
   * between phase 1 and phase 2 leaves exactly the "uncertain delivery" signature spec §4
   * quarantines on boot — never a phantom `delivered`.
   */
  beginDeliveryAttempt(id: string): LifecycleResult {
    return this.mirrored(id, () => this.machine.markDeliveryAttempted(id), "delivery_attempted");
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
    this.persistTransition(before, delivered, "delivery_succeeded");
    return delivered;
  }

  /** Two-phase delivery, PHASE 2 (certain-failure leg): the write did NOT land (pane missing or
   *  `status === "Exited"` — the two pre-write guards a caller checks before firing the write).
   *  Re-arms the exchange to `draft` and clears the approval binding (spec §1.3 note ᵉ); the
   *  pane-correlation binding is left untouched (nothing was superseded, nothing landed). */
  failDelivery(id: string, detail?: string): LifecycleResult {
    return this.mirrored(id, () => this.machine.markDeliveryFailed(id, detail), "delivery_failed",
      detail !== undefined ? { payload: { detail } } : undefined);
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
    const before = this.machine.get(id);
    const result = this.machine.reviseDraft(id, instruction);
    if (before) {
      this.persistTransition(before, result, "draft_revised", {
        payload: { superseded_approval_id: before.approvalId },
      });
    }
    return result;
  }

  requestApproval(id: string, approvalId: string): LifecycleResult {
    return this.mirrored(id, () => this.machine.requestApproval(id, approvalId), "approval_requested",
      { payload: { approval_id: approvalId } });
  }

  /** CAS-gated: the durable mirror's predicate also checks the store's `approval_id` +
   *  `approval_draft_version` (spec §2a's exchange-level CAS), not just `state` — a stale/
   *  mismatched pair loses the durable CAS exactly like it loses the in-memory one. */
  confirmApproval(id: string, approvalId: string, draftVersion: number): LifecycleResult {
    return this.mirrored(id, () => this.machine.confirmApproval(id, approvalId, draftVersion), "approval_confirmed",
      { gateApproval: true, payload: { approval_id: approvalId, draft_version: draftVersion } });
  }

  cancel(id: string, reason?: string): LifecycleResult {
    return this.mirrored(id, () => this.machine.cancel(id, reason), "exchange_cancelled",
      reason !== undefined ? { payload: { reason } } : undefined);
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
    return this.mirrored(id, () => this.machine.markAgentComplete(id, summary), "agent_completion_reported");
  }

  /** Route one observed pane signal to whatever exchange is currently ACTIVE on that pane, if
   *  any. Signals for a pane with no active exchange (unrelated pane, pre-delivery pane, unknown
   *  pane, or a pane whose active exchange already settled) are a harmless no-op. `quiescing` is
   *  advisory-only per spec §1.4 and never reaches the machine (so it is never durably mirrored
   *  either — nothing changed to persist). */
  onPaneSignal(sig: PaneSignal): SettleOutcome[] {
    if (sig.kind === "quiescing") return [];
    const activeId = this.paneActive.get(sig.paneId);
    if (!activeId) return [];
    const before = this.machine.get(activeId);
    const result = this.applySignal(activeId, sig.kind, sig.detail);
    if (before) {
      this.persistTransition(before, result, PANE_SIGNAL_EVENT[sig.kind] ?? null,
        sig.detail !== undefined ? { payload: { detail: sig.detail } } : undefined);
    }
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

  /**
   * Boot recovery: quarantine every uncertain in-flight exchange this IN-MEMORY machine still
   * knows about (delegates to the machine), then clear the active-pane binding UNCONDITIONALLY —
   * the correlator's binding is cleared on boot (spec §4 hard rules), so no post-boot pane signal
   * can ever reach back and settle (or un-quarantine) a pre-boot exchange, even one this class
   * itself just interrupted.
   *
   * UNIFIED RECOVERY STORY (Step 1.5b): at a REAL process boot this machine is always freshly
   * empty (in-memory state does not survive a crash), so this method alone finds nothing to
   * quarantine — the actual restart-safety mechanism is the DURABLE walk,
   * `recoverExchangesOnBoot` (src/exchanges/recovery.ts), which reads the real `agent_exchanges`
   * rows a fresh process starts with and is what src/exchanges/spine.ts's boot wiring
   * (`initExchangeSpineOnBoot`) actually calls first. This method still runs right after it,
   * purely so the "a restart clears the active-pane binding" invariant documented above holds
   * unconditionally, even in an unusual case where something touched the singleton earlier in the
   * same process (a warm-reboot path, a test harness reusing a singleton across a simulated
   * restart). It does not touch the store — `recoverExchangesOnBoot` already applied the durable
   * disposition directly, and this class has no rows of its own to reconcile against it.
   */
  recoverOnBoot(): { interrupted: string[] } {
    const out = this.machine.recoverOnBoot();
    this.paneActive.clear();
    return { interrupted: out.interrupted };
  }

  /** Interrupt whatever was previously active on this pane (if anything, and if it isn't the
   *  exchange being delivered now). Best-effort: if the prior exchange already settled, the
   *  machine's own legal-transition guard refuses the interrupt and we simply move on — an
   *  already-settled exchange is immutable, not an error. Durably mirrored as `exchange_recovered`
   *  (spec §1.2: "exchange_recovered quarantine / superseded delivery" — the SAME event type boot
   *  quarantine uses, disambiguated by the `reason` payload). */
  private supersede(paneId: string, incomingId: string): void {
    const prior = this.paneActive.get(paneId);
    if (!prior || prior === incomingId) return;
    const before = this.machine.get(prior);
    const result = this.machine.markInterrupted(prior, "superseded_by_new_delivery");
    if (before) {
      this.persistTransition(before, result, "exchange_recovered", {
        payload: { disposition: "interrupted", reason: "superseded_by_new_delivery", from_state: before.state },
      });
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

  // ── durable mirror (Phase 1, Step 1.5b) ────────────────────────────────────────────────────────

  /** Run a machine transition, then durably mirror the outcome using the snapshot captured
   *  BEFORE the call as the CAS "from" state. The shared shape behind every simple (single-id,
   *  single-transition) public method above — keeps each of those a one-line call instead of
   *  repeating the before/run/mirror sequence (McCabe/cognitive complexity per method stays low).
   *  A missing exchange (`before` undefined) is passed straight through with no mirror attempt —
   *  the underlying `run()` already returns the correct `exchange_not_found` result. */
  private mirrored(
    id: string,
    run: () => LifecycleResult,
    eventType: ExchangeEventType | null,
    opts?: { gateApproval?: boolean; payload?: Record<string, unknown> },
  ): LifecycleResult {
    const before = this.machine.get(id);
    const result = run();
    if (before) this.persistTransition(before, result, eventType, opts);
    return result;
  }

  /** Durably persist a REFUSED-transition-safe mirror of one successful in-memory transition: a
   *  CAS-guarded `updateExchange` (predicate = `before`'s state — and, when `gateApproval` is set,
   *  also its approval binding, spec §2a) plus, when `eventType` is non-null, one
   *  `appendExchangeEvent` row (spec §1.4). No-ops immediately when no store is attached OR the
   *  in-memory transition was refused (`result.ok === false`) — a refused transition must never
   *  produce a durable record either (mirrors the exact rule
   *  tests/test_exchange_integration_battery.ts's `ExchangeHarness` documented and pinned before
   *  this bridge existed). Fail-soft (spec §9.6 / the QW5 never-throw philosophy in src/observe/):
   *  a store failure is logged and the live in-memory result is left untouched — the caller always
   *  gets the correct in-memory `LifecycleResult` regardless of what happened here. */
  private persistTransition(
    before: ExchangeSnapshot,
    result: LifecycleResult,
    eventType: ExchangeEventType | null,
    opts?: { gateApproval?: boolean; payload?: Record<string, unknown> },
  ): void {
    if (!this.store || !result.ok) return;
    const after = result.snapshot;
    try {
      const cas: { state: ExchangeState; approvalId?: string | null; approvalDraftVersion?: number | null } =
        { state: before.state };
      if (opts?.gateApproval) {
        cas.approvalId = before.approvalId;
        cas.approvalDraftVersion = before.approvalDraftVersion;
      }
      this.store.updateExchange(after.exchangeId, {
        state: after.state,
        draft_version: after.draftVersion,
        approval_id: after.approvalId,
        approval_draft_version: after.approvalDraftVersion,
        delivery_attempt: after.deliveryAttempt,
        delivered_at: after.deliveredAt,
        completed_at: after.completedAt,
        result_summary: after.resultSummary,
        terminal_state: after.terminalState,
        distilled_instruction: after.distilledInstruction,
        updated_at: after.updatedAt,
      }, cas);
      if (eventType) {
        this.store.appendExchangeEvent({
          exchange_id: after.exchangeId,
          event_type: eventType,
          pane_id: after.paneId,
          project_id: after.projectId,
          payload_redacted_json: JSON.stringify(opts?.payload ?? {}),
          ts: after.updatedAt,
        });
      }
    } catch (e) {
      console.error(
        `[exchange-spine] durable mirror failed for ${eventType ?? "state-only"} on ${after.exchangeId} (continuing in-memory only):`,
        e,
      );
    }
  }

  /** `exchange_created` — the one transition with no prior row to CAS against (`insertExchange`,
   *  not `updateExchange`). Same fail-soft contract as `persistTransition`. */
  private persistCreate(snap: ExchangeSnapshot): void {
    if (!this.store) return;
    try {
      this.store.insertExchange({
        exchange_id: snap.exchangeId,
        project_id: snap.projectId,
        pane_id: snap.paneId,
        operator_utterance: snap.operatorUtterance,
        distilled_instruction: snap.distilledInstruction,
        created_at: snap.createdAt,
        updated_at: snap.updatedAt,
      });
      this.store.appendExchangeEvent({
        exchange_id: snap.exchangeId,
        event_type: "exchange_created",
        pane_id: snap.paneId,
        project_id: snap.projectId,
        ts: snap.createdAt,
      });
    } catch (e) {
      console.error(`[exchange-spine] durable insertExchange failed for ${snap.exchangeId} (continuing in-memory only):`, e);
    }
  }
}
