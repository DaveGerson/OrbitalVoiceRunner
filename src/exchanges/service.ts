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
import type { ExchangeEventType, AgentExchange as AgentExchangeRow } from "./types";
import type { JanusStore } from "../store/sqliteStore";
import { redactSecrets } from "../terminal";

export type PaneSignalKind = "running" | "quiescing" | "idle" | "prompt" | "error" | "exited";

/** Bound on the per-pane `commandLogs` ring (see that field's own doc comment). */
const COMMAND_LOG_RING_SIZE = 50;

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

/** Phase 4, Step 4.1: the outcome vocabulary a self-report can carry — either a matched result
 *  envelope (src/exchanges/resultEnvelope.ts) or the conservative legacy finalResponse heuristic
 *  (src/observe/index.ts). Deliberately narrower than `ExchangeEventType`: both report sources
 *  settle through the exact same three machine outcomes. */
export type ReportedOutcome = "complete" | "failed" | "needs_input";

interface CommandLogEntry {
  command: string;
  exchangeId: string | null;
}

interface CreateExchangeInput {
  projectId: string;
  paneId: string;
  operatorUtterance: string;
  distilledInstruction: string;
  // Phase 2 Step 2.2: the durable mirror ONLY — the pure in-memory ExchangeMachine (lifecycle.ts)
  // has no concept of these fields (they carry no transition-legality semantics), so they are
  // threaded straight past `this.machine.create` into `persistCreate`'s store write rather than
  // added to ExchangeSnapshot/CreateInput. Absent ⇒ the store's existing NULL defaults, unchanged.
  voiceSessionId?: string | null;
  interactionId?: string | null;
  contextVersion?: string | null;
  /** Phase 4, Step 4.3: the redacted JSON projection of the pane's open envelope draft (spec
   *  `instruction_envelope_json` — see src/exchanges/draftRegistry.ts's persisted-envelope shape),
   *  when this exchange correlates to one. Absent for a plain (non-envelope) dispatch — the
   *  column keeps its schema default `'{}'`, unchanged from before this field existed. This is
   *  the durable source `rehydrateDraftRegistryOnBoot` reads back on a fresh boot. */
  instructionEnvelopeJson?: string | null;
}

export class ExchangeService {
  private readonly machine: ExchangeMachine;
  /** paneId -> the exchange currently considered "in flight" on that pane. Set ONLY by a
   *  successful recordDelivery; cleared entirely on recoverOnBoot. This is the whole correlation
   *  mechanism — deliberately dumb (last-delivery-wins), because the spec forbids anything
   *  smarter (no text matching, no timing heuristics). */
  private readonly paneActive = new Map<string, string>();
  /** Per-pane command-log ring, bounded to `COMMAND_LOG_RING_SIZE` entries (oldest dropped first —
   *  production-invisible: this is a debug/observability convenience, never a durable audit trail
   *  — the durable one is `exchange_events`). Unbounded growth here would otherwise leak for the
   *  lifetime of a long-running pane/process. */
  private readonly commandLogs = new Map<string, CommandLogEntry[]>();
  /** Optional durable mirror (Phase 1, Step 1.5b) — constructor-injected or attached later via
   *  `attachStore`. Undefined by default, so every `new ExchangeService()` a unit test constructs
   *  stays pure in-memory (zero behavior delta from before this bridge existed): every persistence
   *  call below starts with `if (!this.store) return`. Production wiring: src/exchanges/spine.ts
   *  attaches the real `JanusStore` singleton at boot, once the flag is active. */
  private store?: JanusStore;
  /** Phase 2 Step 2.4/2.5 fix (secrets at rest): the redaction pass applied to every FREE-TEXT
   *  field the durable mirror persists (distilled_instruction, operator_utterance,
   *  result_summary, event payload JSON). The in-memory machine keeps the RAW text — delivery to
   *  the pane must never be silently altered (spec §13 nuance: deliver raw, persist redacted);
   *  only the at-rest copies are scrubbed. Injectable for tests; defaults to the ONE production
   *  scrubber (src/terminal.ts redactSecrets). */
  private readonly redact: (s: string) => string;

  constructor(opts?: { now?: () => number; store?: JanusStore; redact?: (s: string) => string }) {
    this.machine = new ExchangeMachine(opts);
    this.store = opts?.store;
    this.redact = opts?.redact ?? redactSecrets;
  }

  /** Redact a nullable free-text column for persistence (null/undefined pass through). */
  private redactText<T extends string | null | undefined>(s: T): T {
    return (s == null ? s : this.redact(s)) as T;
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
    this.persistCreate(snap, {
      voiceSessionId: input.voiceSessionId ?? null,
      interactionId: input.interactionId ?? null,
      contextVersion: input.contextVersion ?? null,
      instructionEnvelopeJson: input.instructionEnvelopeJson ?? null,
    });
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

  /**
   * Phase 4, Step 4.1 — settle the pane's ACTIVE exchange against an explicit, self-reported
   * outcome: either a validated+matched result envelope (src/exchanges/resultEnvelope.ts) or the
   * conservative legacy finalResponse heuristic (src/observe/index.ts's onIdle). Both callers
   * funnel through here so the multi-hop-safe sequencing (only `terminal_idle` has an outgoing
   * edge to `agent_complete`; `needs_input` is only reachable from `delivered`/`running`) lives in
   * exactly one place, and so the trust-boundary check — `exchangeId` MUST equal the pane's current
   * active delivery marker — is enforced identically for every report source.
   *
   * A mismatched/absent active marker (wrong pane, forged id, or a STALE id from an
   * already-superseded/retried delivery — `paneActive` only ever points at the CURRENT in-flight
   * exchange, so a superseded id can never match) is IGNORED and logged as uncorrelated; nothing is
   * read or written. An id that DOES match but whose current state has no legal path to the
   * requested outcome (e.g. the exchange already settled) is refused by the underlying machine CAS
   * and logged, also with no side effect — never a crash, never a partial application.
   */
  recordReportedOutcome(
    paneId: string,
    exchangeId: string,
    outcome: ReportedOutcome,
    summary: string,
    envelopeJson?: string | null,
  ): SettleOutcome | null {
    const activeId = this.paneActive.get(paneId);
    if (!activeId || activeId !== exchangeId) {
      console.log(
        `[exchange-spine] reported outcome '${outcome}' for ${exchangeId} on pane ${paneId} is ` +
        `UNCORRELATED (active exchange: ${activeId ?? "none"}) — ignored, nothing settled.`,
      );
      return null;
    }
    const before = this.machine.get(activeId);
    if (!before) return null;
    const result = this.settleReportedOutcome(before, outcome, summary, envelopeJson);
    // NOTE: `result.ok === false` (not `!result.ok`) — this file's tsconfig has strictNullChecks
    // off, under which TS does not narrow a discriminated union via negated property-access
    // truthiness (`!x.ok`); only an explicit equality check reliably narrows to the `reason`-bearing
    // member. `!x.ok` early-returns elsewhere in this file are fine (they never touch `.reason`).
    if (result.ok === false) {
      console.log(
        `[exchange-spine] reported outcome '${outcome}' for ${activeId} refused (${result.reason}) ` +
        `from state '${before.state}'.`,
      );
      return null;
    }
    return { exchangeId: activeId, state: result.snapshot.state };
  }

  /** Dispatch table for `recordReportedOutcome` — kept as a single-branch switch so each arm's own
   *  (possibly multi-hop) sequencing stays in its own small method. */
  private settleReportedOutcome(
    before: ExchangeSnapshot,
    outcome: ReportedOutcome,
    summary: string,
    envelopeJson?: string | null,
  ): LifecycleResult {
    switch (outcome) {
      case "failed":
        return this.settleReportedFailed(before, summary, envelopeJson);
      case "needs_input":
        return this.settleReportedNeedsInput(before, summary, envelopeJson);
      case "complete":
        return this.settleReportedComplete(before, summary, envelopeJson);
    }
  }

  /** agent_failed is legal from every in-flight state (delivered/running/needs_input/terminal_idle)
   *  — no hop needed. Illegal from draft/staged/etc. (an envelope arriving before any delivery
   *  landed, which real wiring cannot produce but a forged/malformed report might attempt) is
   *  refused by the CAS below exactly like any other illegal transition. */
  private settleReportedFailed(before: ExchangeSnapshot, summary: string, envelopeJson?: string | null): LifecycleResult {
    const result = this.machine.markAgentFailed(before.exchangeId, summary);
    this.persistTransition(before, result, "agent_failure_reported", this.reportOpts(summary, envelopeJson));
    return result;
  }

  /** needs_input is directly legal from delivered/running. Already-needs_input is an idempotent
   *  no-op (never a self-loop attempt against the machine). From terminal_idle, spec §1.2's
   *  "terminal_idle --> running: pane resumed (idle premature)" edge is the sanctioned bounce: an
   *  explicit report saying "actually I need input" means the prior idle was premature — hop
   *  through `running` (persisted as its own `terminal_running` event) before landing on
   *  `needs_input`. Unlike the ambient-idle stickiness guard in `onPaneSignal`, this path is driven
   *  by an EXPLICIT self-report, which is exactly the stronger evidence that guard is reserving room
   *  for. */
  private settleReportedNeedsInput(before: ExchangeSnapshot, summary: string, envelopeJson?: string | null): LifecycleResult {
    if (before.state === "needs_input") return { ok: true, snapshot: before };
    let cur = before;
    if (cur.state === "terminal_idle") {
      const resumed = this.machine.markRunning(cur.exchangeId);
      this.persistTransition(cur, resumed, "terminal_running");
      if (!resumed.ok) return resumed;
      cur = resumed.snapshot;
    }
    const result = this.machine.markNeedsInput(cur.exchangeId, summary);
    this.persistTransition(cur, result, "needs_input_detected", this.reportOpts(summary, envelopeJson));
    return result;
  }

  /** agent_complete is legal ONLY from terminal_idle (spec §1.3 — the diagram's ONE edge into it).
   *  From delivered/running/needs_input, hop through terminal_idle first (persisted as its own
   *  `terminal_idle` event, `before`'s state as the CAS anchor) — an explicit "complete" report is
   *  the strongest available evidence the terminal is now idle, even if the correlator's own
   *  ambient observation hasn't independently confirmed it yet. Already-terminal_idle skips the hop. */
  private settleReportedComplete(before: ExchangeSnapshot, summary: string, envelopeJson?: string | null): LifecycleResult {
    let cur = before;
    if (cur.state !== "terminal_idle") {
      const idled = this.machine.markTerminalIdle(cur.exchangeId, summary);
      this.persistTransition(cur, idled, "terminal_idle");
      if (!idled.ok) return idled;
      cur = idled.snapshot;
    }
    const result = this.machine.markAgentComplete(cur.exchangeId, summary);
    this.persistTransition(cur, result, "agent_completion_reported", this.reportOpts(summary, envelopeJson));
    return result;
  }

  /** The event payload + `result_envelope_json` column stamp shared by every reported-outcome leg
   *  (spec: "result_summary + result_envelope_json persisted (redacted)"). `envelopeJson` is
   *  ALREADY redacted by the caller (resultEnvelope.ts's `redactedEnvelopeJson`, or `undefined` for
   *  the legacy prose heuristic, which has no structured envelope to persist) — `persistTransition`
   *  redacts it again anyway (redactSecrets is pure + idempotent, the same double-safe posture the
   *  rest of this file already relies on), so a caller mistake here can never leak raw text. */
  private reportOpts(
    summary: string,
    envelopeJson?: string | null,
  ): { payload: Record<string, unknown>; resultEnvelopeJson?: string | null } {
    return {
      payload: envelopeJson != null ? { summary, has_envelope: true } : { summary },
      ...(envelopeJson !== undefined ? { resultEnvelopeJson: envelopeJson } : {}),
    };
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
    // Phase 4, Step 4.1 (needs-input stickiness, spec §10.2): once the pane's active exchange is
    // sitting at needs_input (an unanswered agent question), an AMBIENT 'idle' pane signal must
    // never be the thing that advances it — even though the pure machine's legal-transition table
    // still technically permits needs_input->terminal_idle (spec §1.3 note ᵍ, the "fast command"
    // case). That edge stays legal and untouched at the machine level (still pinned by
    // tests/test_exchange_lifecycle.ts); this is a SERVICE-layer policy on top of it: a passive
    // "the pane went quiet" observation is not the same kind of evidence as an explicit report, and
    // must never be read as "the outstanding question no longer needs an answer" (no flapping
    // needs_input -> terminal_idle -> ... on every repeated idle edge). The only ways off
    // needs_input are (a) a genuine 'running' signal (operator answered, a gated write landed), (b)
    // an explicit terminal outcome — `recordReportedOutcome` below, which DOES deliberately hop
    // through terminal_idle for a matched envelope/legacy report, because that is a stronger,
    // self-reported signal, not an ambient one — or (c) interruption/cancellation. Repeated idle
    // signals here are therefore idempotent no-ops, never persisted (nothing changed).
    if (sig.kind === "idle" && before?.state === "needs_input") return [];
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
   * neg1 (§5.3 mis-settle fix): does the MOST RECENT command-log entry for this pane belong to the
   * pane's own currently-active exchange? A pure read over the existing `paneActive` +
   * `commandLogs` maps — no CAS, no store write, no redaction surface touched.
   *
   * This is the correlation signal `settleTerminalOutcome` (src/observe/index.ts) needs before
   * trusting the conservative legacy prose heuristic: without it, a manual command typed directly
   * into a pane whose exchange is parked at `terminal_idle` could settle that exchange off the
   * MANUAL command's own output tail (a "Done." line the manual command itself printed), even
   * though that output has nothing to do with the delivered instruction. Returns `false` — never
   * throws — when there is no active exchange on the pane, or no command has been logged for it
   * at all; both are "nothing to correlate against", the same conservative answer as a genuine
   * mismatch.
   */
  lastCommandBelongsToActiveExchange(paneId: string): boolean {
    const activeId = this.paneActive.get(paneId);
    if (!activeId) return false;
    const log = this.commandLogs.get(paneId);
    if (!log || log.length === 0) return false;
    return log[log.length - 1].exchangeId === activeId;
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

  /**
   * Phase 4, Step 4.3: adopt a DURABLE row (src/store/sqliteStore.ts `AgentExchange`) into this
   * process's live tracking — the machine's in-memory snapshot (`ExchangeMachine.hydrate`, a raw
   * no-legality-check seed) AND the pane-correlation binding (`paneActive`). This is the seam a
   * recovery action (src/exchanges/recoveryActions.ts) calls after it mutates a row DIRECTLY at
   * the store layer (never through this class's own transition methods — a retry/cancel target
   * may have been minted in a PRIOR process this machine never saw). Without it, a live pane
   * signal (idle/running/needs_input) arriving after a same-process retry could never settle the
   * retried exchange (the correlator's `paneActive` binding would still point nowhere, or at
   * whatever this pane's PREVIOUS exchange was). Best-effort + never throws: recovery actions are
   * themselves best-effort (spec §9.6 — a spine outage must never block an operator's explicit
   * recovery decision); a failure here only means live signal correlation stays stale, not that
   * the durable row (already written by the caller) is lost.
   */
  adoptExchangeSnapshot(row: AgentExchangeRow): void {
    try {
      this.machine.hydrate({
        exchangeId: row.exchange_id,
        projectId: row.project_id,
        paneId: row.pane_id,
        state: row.state,
        draftVersion: row.draft_version,
        approvalId: row.approval_id,
        approvalDraftVersion: row.approval_draft_version,
        deliveryAttempt: row.delivery_attempt,
        operatorUtterance: row.operator_utterance,
        distilledInstruction: row.distilled_instruction,
        terminalState: row.terminal_state,
        resultSummary: row.result_summary,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        deliveredAt: row.delivered_at,
        completedAt: row.completed_at,
      });
      // Only an IN-FLIGHT row is worth binding as this pane's "active" exchange — a settled row
      // (agent_complete/agent_failed/cancelled) or a communication-only one (draft/awaiting_*)
      // has nothing for a subsequent pane signal to correlate against, and binding one would risk
      // a later ambient signal wrongly settling a row that was never actually delivered.
      if (row.state === "staged" || row.state === "delivered" || row.state === "running" ||
          row.state === "needs_input" || row.state === "terminal_idle") {
        this.paneActive.set(row.pane_id, row.exchange_id);
      }
    } catch (e) {
      console.error(`[exchange-spine] adoptExchangeSnapshot failed for ${row.exchange_id} (live correlation may be stale):`, e);
    }
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
    if (log.length > COMMAND_LOG_RING_SIZE) log.splice(0, log.length - COMMAND_LOG_RING_SIZE);
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
    opts?: { gateApproval?: boolean; payload?: Record<string, unknown>; resultEnvelopeJson?: string | null },
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
  /** The CAS predicate half of a mirrored write (spec §2a) — `before`'s state, plus (when
   *  `gateApproval` is set) its approval binding. Split out of `persistTransition` purely to keep
   *  that method's own branch count low (complexity gate). */
  private buildPersistCas(
    before: ExchangeSnapshot,
    opts?: { gateApproval?: boolean },
  ): { state: ExchangeState; approvalId?: string | null; approvalDraftVersion?: number | null } {
    const cas: { state: ExchangeState; approvalId?: string | null; approvalDraftVersion?: number | null } =
      { state: before.state };
    if (opts?.gateApproval) {
      cas.approvalId = before.approvalId;
      cas.approvalDraftVersion = before.approvalDraftVersion;
    }
    return cas;
  }

  /** The `updateExchange` patch half of a mirrored write. Every free-text column is redacted at
   *  THIS write boundary (Phase 2 Step 2.4/2.5 fix — secrets at rest; the in-memory snapshot keeps
   *  the raw text, only the durable copy is scrubbed). Split out of `persistTransition` for the
   *  same complexity-gate reason as `buildPersistCas`.
   *
   *  A free-text column (`result_summary`/`terminal_state`/`distilled_instruction`) is only
   *  INCLUDED in the patch — and therefore only redacted — when THIS transition actually changed
   *  its raw value (`before` vs. `after`, compared pre-redaction: every field `transition()`
   *  didn't touch carries the identical raw value forward, so the comparison is exact, never a
   *  guess). Skipping an unchanged column costs nothing observable: `redactSecrets` is
   *  deterministic on the same raw input, so re-deriving and re-writing the SAME already-stored
   *  redacted string every transition (the old behavior) always produced the identical row value —
   *  this only removes the redundant recompute-and-rewrite, never changes what ends up persisted. */
  private buildPersistPatch(
    before: ExchangeSnapshot,
    after: ExchangeSnapshot,
    opts?: { resultEnvelopeJson?: string | null },
  ): Record<string, unknown> {
    const patch: Record<string, unknown> = {
      state: after.state,
      draft_version: after.draftVersion,
      approval_id: after.approvalId,
      approval_draft_version: after.approvalDraftVersion,
      delivery_attempt: after.deliveryAttempt,
      delivered_at: after.deliveredAt,
      completed_at: after.completedAt,
      updated_at: after.updatedAt,
    };
    if (after.resultSummary !== before.resultSummary) {
      patch.result_summary = this.redactText(after.resultSummary);
    }
    // Phase 4.5 review hardening: terminal_state carries free text too (the detected question
    // line, an envelope summary) — every writer already redacts at source, but this column was
    // the one free-text field not double-scrubbed at the write boundary like its siblings.
    if (after.terminalState !== before.terminalState) {
      patch.terminal_state = this.redactText(after.terminalState);
    }
    if (after.distilledInstruction !== before.distilledInstruction) {
      patch.distilled_instruction = this.redactText(after.distilledInstruction);
    }
    // Phase 4, Step 4.1: stamp the redacted result-envelope JSON on the row itself (not just the
    // event payload) whenever a reported-outcome leg supplies one, so getExchange(...) reflects
    // the latest report without needing to replay the event timeline.
    if (opts?.resultEnvelopeJson !== undefined) {
      patch.result_envelope_json = this.redactText(opts.resultEnvelopeJson);
    }
    return patch;
  }

  /** The `appendExchangeEvent` half of a mirrored write — only called when `eventType` is
   *  non-null. Split out purely for the same complexity-gate reason as its siblings above. */
  private appendMirroredEvent(
    after: ExchangeSnapshot,
    eventType: ExchangeEventType,
    opts?: { payload?: Record<string, unknown> },
  ): void {
    this.store!.appendExchangeEvent({
      exchange_id: after.exchangeId,
      event_type: eventType,
      pane_id: after.paneId,
      project_id: after.projectId,
      payload_redacted_json: this.redact(JSON.stringify(opts?.payload ?? {})),
      ts: after.updatedAt,
    });
  }

  private persistTransition(
    before: ExchangeSnapshot,
    result: LifecycleResult,
    eventType: ExchangeEventType | null,
    opts?: { gateApproval?: boolean; payload?: Record<string, unknown>; resultEnvelopeJson?: string | null },
  ): void {
    if (!this.store || !result.ok) return;
    const after = result.snapshot;
    try {
      this.store.updateExchange(after.exchangeId, this.buildPersistPatch(before, after, opts), this.buildPersistCas(before, opts));
      if (eventType) this.appendMirroredEvent(after, eventType, opts);
    } catch (e) {
      console.error(
        `[exchange-spine] durable mirror failed for ${eventType ?? "state-only"} on ${after.exchangeId} (continuing in-memory only):`,
        e,
      );
    }
  }

  /** `exchange_created` — the one transition with no prior row to CAS against (`insertExchange`,
   *  not `updateExchange`). Same fail-soft contract as `persistTransition`. `extra` (Phase 2 Step
   *  2.2) carries the durable-only identity/correlation fields `createExchange` received but the
   *  pure in-memory snapshot does not model — see `CreateExchangeInput`'s doc comment. */
  /** Build the `insertExchange` payload — split out of `persistCreate` purely to keep that
   *  method's own branch count low (complexity gate); Phase 4 Step 4.3 added one more optional
   *  redacted field (`instructionEnvelopeJson`) which would otherwise push `persistCreate` over
   *  the CC-10 ceiling. */
  private buildInsertExchangeInput(
    snap: ExchangeSnapshot,
    extra?: {
      voiceSessionId: string | null;
      interactionId: string | null;
      contextVersion: string | null;
      instructionEnvelopeJson?: string | null;
    },
  ): Parameters<JanusStore["insertExchange"]>[0] {
    // Phase 2 Step 2.4/2.5 fix (secrets at rest): the operator's utterance and the distilled
    // instruction are persisted REDACTED (the raw instruction still reaches the pane through the
    // dispatch path untouched — deliver raw, persist redacted). Phase 4 Step 4.3: the
    // envelope-draft JSON projection (when supplied) is redacted the same way — it is free text
    // (objective/context/constraints) an operator spoke or typed.
    return {
      exchange_id: snap.exchangeId,
      project_id: snap.projectId,
      pane_id: snap.paneId,
      operator_utterance: this.redactText(snap.operatorUtterance),
      distilled_instruction: this.redactText(snap.distilledInstruction),
      voice_session_id: extra?.voiceSessionId ?? null,
      interaction_id: extra?.interactionId ?? null,
      context_version: extra?.contextVersion ?? null,
      instruction_envelope_json:
        extra?.instructionEnvelopeJson != null ? this.redactText(extra.instructionEnvelopeJson) : undefined,
      created_at: snap.createdAt,
      updated_at: snap.updatedAt,
    };
  }

  private persistCreate(
    snap: ExchangeSnapshot,
    extra?: {
      voiceSessionId: string | null;
      interactionId: string | null;
      contextVersion: string | null;
      instructionEnvelopeJson?: string | null;
    },
  ): void {
    if (!this.store) return;
    try {
      this.store.insertExchange(this.buildInsertExchangeInput(snap, extra));
      this.store.appendExchangeEvent({
        exchange_id: snap.exchangeId,
        event_type: "exchange_created",
        pane_id: snap.paneId,
        project_id: snap.projectId,
        ts: snap.createdAt,
      });
      // Phase 5.4 (observability wiring, closing the 5.3 gap): every exchange is minted with an
      // ALREADY-RESOLVED target (the resolver/Workbench decided the pane before createExchange
      // runs — src/voice/index.ts stampExchangeForDispatch, server.ts stampExchangeForWorkbenchSend),
      // so the `target_resolved` audit event lands here, immediately after `exchange_created`, with
      // the payload convention src/exchanges/metrics.ts defined for its first producer
      // ({ paneId, projectId }). Pure audit trail: ids only, no free text, append-only, no state
      // transition. NOTE the metrics consequence: countWrongTargetDeliveries compares this payload
      // against the row's own immutable pane_id, so live traffic reads 0 unless a future resolver
      // bug stamps a divergent pane — exactly the tripwire that metric exists to be.
      this.store.appendExchangeEvent({
        exchange_id: snap.exchangeId,
        event_type: "target_resolved",
        pane_id: snap.paneId,
        project_id: snap.projectId,
        payload_redacted_json: JSON.stringify({ paneId: snap.paneId, projectId: snap.projectId }),
        ts: snap.createdAt,
      });
    } catch (e) {
      console.error(`[exchange-spine] durable insertExchange failed for ${snap.exchangeId} (continuing in-memory only):`, e);
    }
  }

  /**
   * Phase 5.4 (observability wiring, closing the 5.3 gap): append a `clarification_requested`
   * audit event for an exchange whose dispatch came back needing the operator's clarification
   * (the dispatch-outcome clarify seam in src/voice/index.ts settleExchangeForDispatch). Append-
   * only — no state transition, no CAS; the exchange's own lifecycle disposition (typically the
   * `cancel` that follows at that seam) is recorded separately by its own event. `cause` follows
   * the payload convention src/exchanges/metrics.ts's countClarificationCauses defined (a short
   * label, capped there at 64 chars). Fail-soft + never throws (spec §9.6). The OTHER clarify seam
   * — the target resolver's own "which pane did you mean" (src/voice/targetResolver.ts) — fires
   * BEFORE any exchange exists (exchange_events.exchange_id is NOT NULL), so it cannot be wired
   * here; see the Phase 5.4 report (deferred to 5.5).
   */
  recordClarificationRequested(id: string, cause: string): void {
    if (!this.store) return;
    const snap = this.machine.get(id);
    if (!snap) return;
    try {
      this.store.appendExchangeEvent({
        exchange_id: id,
        event_type: "clarification_requested",
        pane_id: snap.paneId,
        project_id: snap.projectId,
        payload_redacted_json: this.redact(JSON.stringify({ cause })),
        ts: Date.now(),
      });
    } catch (e) {
      console.error(`[exchange-spine] clarification_requested event append failed for ${id} (audit trail only):`, e);
    }
  }
}
