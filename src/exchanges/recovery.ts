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
import type { AgentExchange } from "./types";
import { EXCHANGE_STATES, recoveryDisposition, type ExchangeState } from "./lifecycle";

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
  const res = store.updateExchange(
    row.exchange_id,
    { state: "interrupted" },
    { state: row.state },
  );
  if (!res.changed) return; // lost race / already moved on — never invent history, never retry
  report.interrupted.push(row.exchange_id);
  store.appendExchangeEvent({
    exchange_id: row.exchange_id,
    event_type: "exchange_recovered",
    project_id: row.project_id,
    pane_id: row.pane_id,
    payload_redacted_json: JSON.stringify({
      disposition: "interrupted",
      reason: "boot_quarantine",
      from_state: row.state,
    }),
    ts: now(),
  });
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
  const res = store.updateExchange(
    row.exchange_id,
    { state: "draft", approval_id: null, approval_draft_version: null },
    { state: "awaiting_approval" },
  );
  if (!res.changed) { report.kept.push(row.exchange_id); return; } // lost race — leave it be
  report.reverted.push(row.exchange_id);
  store.appendExchangeEvent({
    exchange_id: row.exchange_id,
    event_type: "exchange_recovered",
    project_id: row.project_id,
    pane_id: row.pane_id,
    payload_redacted_json: JSON.stringify({
      disposition: "reverted_missing_approval",
      reason: "boot_recovery",
    }),
    ts: now(),
  });
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
