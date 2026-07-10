// src/exchanges/recovery.ts
//
// AgentExchange spine — STORE-BACKED boot recovery (Phase 1, Step 1.4; spec
// docs/superpowers/specs/2026-07-09-agent-exchange-spine.md §4 "Restart behavior").
//
// `ExchangeMachine.recoverOnBoot` (src/exchanges/lifecycle.ts) already implements the PURE
// classification rule against its own in-memory map — exactly what tests/test_exchange_lifecycle.ts
// and tests/test_exchange_correlation.ts exercise. But a real process restart starts with a FRESH,
// empty ExchangeMachine (in-memory state does not survive a crash) — the durable truth lives in
// SQLite (`agent_exchanges`, schema v12). This module is the missing bridge: it walks every exchange
// row a real boot would find, applies the SAME `recoveryDisposition` rule (reused verbatim, never
// re-implemented), and persists the quarantine through the store's own guarded CAS
// (`updateExchange`), so a lost race / already-superseded row is a harmless no-op — never a second
// write, never invented history (spec §4 hard rules).
//
// `awaiting_approval` gets the one case `recoveryDisposition` deliberately does not decide (it only
// classifies keep/interrupt): the exchange's own row can't tell whether its bound `pending_approvals`
// row survived the crash. This module checks the durable approval store directly
// (`store.hasPendingApproval`) and reverts to `draft` (clearing the stale binding) when it is gone —
// it NEVER assumes a missing approval was confirmed (spec §4: "a fresh approval_requested must
// re-fire").
//
// Dispatch-group members (step 1.4 join-tracker correlation) need NO special handling here: each
// member's own correlation IS an `agent_exchanges` row (see src/dispatch/joinTracker.ts /
// src/actions/defs/dispatch_group.ts), so an "ambiguous member" — one whose correlation cannot be
// re-established after a restart — quarantines through this exact same per-exchange rule. The
// DispatchJoinTracker itself is intentionally NOT made durable (its own module doc: "Records are
// IN-MEMORY... a bounded ring keeps the registry small"); the spec's non-goal §9.1 confirms
// `dispatch_group_id` is a reporting label with "no state semantics", so there is nothing to recover
// at the group level beyond what each member's exchange row already carries.

import type { JanusStore } from "../store/sqliteStore";
import type { AgentExchange, ExchangeEvent } from "./types";
import { EXCHANGE_STATES, recoveryDisposition, type ExchangeState } from "./lifecycle";

/** The event half of `casTransitionWithEvent` — everything `appendExchangeEvent` needs EXCEPT
 *  `exchange_id` (the caller already supplies that as its own parameter). */
export interface CasTransitionEvent {
  event_type: ExchangeEvent["event_type"];
  project_id?: string | null;
  pane_id?: string | null;
  payload_redacted_json?: string;
  ts?: number;
}

/**
 * Shared "guarded CAS update, then append the matching audit event" pair — the shape every
 * boot-recovery/recovery-action write in this subsystem uses: a `store.updateExchange` CAS,
 * and (by default) an `appendExchangeEvent` row ONLY when the CAS actually won (a lost race is a
 * harmless no-op, never a duplicate/invented write — spec §4 hard rules). `opts.alwaysAppendEvent`
 * opts OUT of that guard for the handful of call sites (src/exchanges/recoveryActions.ts's
 * same-exchange retry steps) whose CAS predicate is, by construction, uncontested within the same
 * synchronous action — those sites always appended their event unconditionally before this helper
 * existed, and keep doing so here for byte-identical behavior. Returns the same `{changed,
 * exchange}` shape `updateExchange` does, so a caller that also needs the fresh row (e.g. to
 * `adoptExchangeSnapshot` it into the live correlator) doesn't need a second store read.
 */
export function casTransitionWithEvent(
  store: JanusStore,
  exchangeId: string,
  patch: Parameters<JanusStore["updateExchange"]>[1],
  cas: Parameters<JanusStore["updateExchange"]>[2],
  event: CasTransitionEvent,
  opts?: { alwaysAppendEvent?: boolean },
): { changed: boolean; exchange: AgentExchange | null } {
  const res = store.updateExchange(exchangeId, patch, cas);
  if (res.changed || opts?.alwaysAppendEvent) {
    store.appendExchangeEvent({ exchange_id: exchangeId, ...event });
  }
  return res;
}

/** Which exchanges this boot pass touched, and how — for the operator-facing recovery digest
 *  (spec §4: "quarantined exchanges surface once as an attention item"). */
export interface ExchangeRecoveryReport {
  /** Pure durable text (draft/awaiting_clarification), an already-settled row (agent_complete/
   *  agent_failed/cancelled/interrupted), or an awaiting_approval row whose bound approval row is
   *  still durably present — untouched. */
  kept: string[];
  /** Quarantined: staged/delivered/running/needs_input/terminal_idle — the observed PTY/outcome is
   *  gone or ambiguous after an inert-boot restart; never resent. */
  interrupted: string[];
  /** awaiting_approval whose bound pending_approvals row did NOT survive the crash — reverted to
   *  draft (approval binding cleared) rather than assumed confirmed. */
  reverted: string[];
}

function freshReport(): ExchangeRecoveryReport {
  return { kept: [], interrupted: [], reverted: [] };
}

/** In-flight quarantine (spec §4 table rows: staged/delivered/running/needs_input/terminal_idle). */
function quarantineOne(
  store: JanusStore,
  row: AgentExchange,
  now: () => number,
  report: ExchangeRecoveryReport,
): void {
  const res = casTransitionWithEvent(
    store,
    row.exchange_id,
    { state: "interrupted" },
    { state: row.state },
    {
      event_type: "exchange_recovered",
      project_id: row.project_id,
      pane_id: row.pane_id,
      payload_redacted_json: JSON.stringify({
        disposition: "interrupted",
        reason: "boot_quarantine",
        from_state: row.state,
      }),
      ts: now(),
    },
  );
  if (res.changed) report.interrupted.push(row.exchange_id); // else: lost race — never invent history, never retry
}

/** awaiting_approval (spec §4 table row + prose): kept when the durable approval survives; reverted
 *  to draft (never assumed confirmed) when it does not. */
function recoverAwaitingApproval(
  store: JanusStore,
  row: AgentExchange,
  now: () => number,
  report: ExchangeRecoveryReport,
): void {
  if (row.approval_id && store.hasPendingApproval(row.approval_id)) {
    report.kept.push(row.exchange_id);
    return;
  }
  const res = casTransitionWithEvent(
    store,
    row.exchange_id,
    { state: "draft", approval_id: null, approval_draft_version: null },
    { state: "awaiting_approval" },
    {
      event_type: "exchange_recovered",
      project_id: row.project_id,
      pane_id: row.pane_id,
      payload_redacted_json: JSON.stringify({
        disposition: "reverted_missing_approval",
        reason: "boot_recovery",
      }),
      ts: now(),
    },
  );
  if (res.changed) report.reverted.push(row.exchange_id);
  else report.kept.push(row.exchange_id); // lost race — leave it be
}

function recoverOne(
  store: JanusStore,
  row: AgentExchange,
  state: ExchangeState,
  now: () => number,
  report: ExchangeRecoveryReport,
): void {
  if (state === "awaiting_approval") {
    recoverAwaitingApproval(store, row, now, report);
    return;
  }
  if (recoveryDisposition(state) === "interrupt") {
    quarantineOne(store, row, now, report);
    return;
  }
  report.kept.push(row.exchange_id); // draft/awaiting_clarification/terminal/interrupted — untouched
}

/**
 * Walk every durable exchange row a real boot would find (one `listExchangesByState` per state —
 * a one-shot boot cost, not a hot path) and apply the disposition rule (spec §4). Never scans
 * `exchange_events`/history to guess anything — purely a per-row state classification + a guarded
 * CAS, exactly mirroring `ExchangeMachine.recoverOnBoot`'s in-memory contract but against the
 * durable store a fresh process actually starts with.
 */
export function recoverExchangesOnBoot(
  store: JanusStore,
  opts?: { now?: () => number },
): ExchangeRecoveryReport {
  const now = opts?.now ?? (() => Date.now());
  const report = freshReport();
  for (const state of EXCHANGE_STATES) {
    for (const row of store.listExchangesByState(state)) {
      recoverOne(store, row, state, now, report);
    }
  }
  return report;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 4, Step 4.3 — the interruption class → disposition table.
//
// The 4.2 boot-quarantine story above answers ONE question ("what happens to an exchange when
// THIS process starts fresh"). This step's brief asks the broader question: across every kind of
// "something got interrupted" event this program can observe — a process restart, a browser tab's
// WS reconnecting, the Gemini Live socket dropping/reconnecting, the Python daemon (memory/policy
// synthesis) restarting — which ones create GENUINE delivery uncertainty for an in-flight
// exchange, and which do not?
//
// The answer, reasoned from the ground truth this module already documents (§4 of the spec, the
// "Ground truth constraints" above): delivery uncertainty for an AgentExchange is entirely a
// property of whether the SERVER PROCESS that holds the live PTY handle survived. `writeInput`
// gives no receipt (module doc, spec §2b) — the only reason a delivery's outcome becomes
// unknowable is that the PROCESS that could have observed the outcome is gone. None of the other
// three event classes touch that:
//
//   - a BROWSER reconnect (the operator's WS socket drops and reconnects) never touches the
//     server process at all — the PTY, the ExchangeService singleton, and every durable row are
//     completely unaffected. The operator's browser was a SPECTATOR of the delivery, never a
//     participant in it.
//   - a GEMINI LIVE session reconnect (or the resumption-handle churn src/voiceResumption.ts
//     exists to manage) drops the VOICE/NARRATION channel, not the PTY: `term.writeInput` already
//     happened (or didn't) independently of whether Gemini's socket is currently open — the write
//     path never round-trips through the Live session. Pending approvals already survive a
//     session detach/reattach untouched (this module's own "Ground truth constraints" list,
//     `detachSession`/`reattachSession`), and the exchange spine rides the SAME approval rows.
//   - a PYTHON DAEMON restart (memory/policy synthesis, the stdio-JSON bridge,
//     docs/design/2026-06-19-python-ts-seam.md) is entirely downstream of the exchange spine — it
//     never holds a PTY handle, never owns a pending_approvals/agent_exchanges row, and the seam's
//     own contract (fail-soft, `src/memory/pythonClient.ts`) means a daemon outage degrades
//     synthesis quality, never delivery certainty.
//
// So the table has exactly one "does something" row. This is intentionally a PURE, no-op-for-most-
// classes classification — the whole point of writing it down explicitly (rather than leaving it
// implicit in "well, nothing calls recoverExchangesOnBoot from those places") is to make the
// reasoning above an auditable, testable artifact instead of an assumption a future change could
// silently violate (e.g. a well-intentioned "let's also quarantine on Gemini reconnect, just to be
// safe" patch would be a REGRESSION — it would spuriously interrupt perfectly-delivered exchanges
// on every ordinary voice reconnect, which is a worse operator experience than doing nothing).

/** Every interruption-shaped event this program can observe, for the purpose of deciding whether
 *  an in-flight AgentExchange's delivery became uncertain. */
export type InterruptionEventClass =
  | "process_boot"
  | "browser_ws_reconnect"
  | "gemini_session_reconnect"
  | "python_daemon_reconnect";

/** `quarantine_uncertain_inflight`: the disposition this module's `recoverOnBoot` machinery
 *  already implements (walk the durable rows, interrupt the 5 uncertain in-flight states). `no_op`:
 *  the event class touches nothing an AgentExchange's delivery certainty depends on — no state is
 *  read or written, by design (see the doc block above). */
export type InterruptionDisposition = "quarantine_uncertain_inflight" | "no_op_delivery_unaffected";

/**
 * The class → disposition table (spec-adjacent, Phase 4 Step 4.3). Only `process_boot` triggers
 * real machinery (`recoverExchangesOnBoot`, wired at server.ts's boot seam via
 * `initExchangeSpineOnBoot`); the other three classes are documented, TESTED no-ops — there is no
 * corresponding "quarantine on reconnect" call site anywhere in the codebase, and this function is
 * the auditable proof that omission is deliberate, not an oversight.
 */
export function interruptionDispositionFor(eventClass: InterruptionEventClass): InterruptionDisposition {
  switch (eventClass) {
    case "process_boot":
      return "quarantine_uncertain_inflight";
    case "browser_ws_reconnect":
    case "gemini_session_reconnect":
    case "python_daemon_reconnect":
      return "no_op_delivery_unaffected";
  }
}
