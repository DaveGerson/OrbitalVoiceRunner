// src/exchanges/recoveryActions.ts
//
// AgentExchange spine — the OPERATOR-FACING RECOVERY ACTIONS (Phase 4, Step 4.3; spec
// docs/superpowers/specs/2026-07-09-agent-exchange-spine.md §4 "Restart behavior... the only path
// out of interrupted is the operator").
//
// Boot recovery (src/exchanges/recovery.ts) classifies and quarantines; it never gives the
// operator a way to DO anything about what it found. This module is that seam: resume-inspect
// (surface an exchange's current state + recent event timeline), retry (a guarded, never-automatic
// re-delivery), and cancel (dismiss). Thin REST ActionDefs (src/actions/defs/lifecycle_rest.ts)
// wrap the pure/store-level logic here; this module owns the actual decisions and durable writes.
//
// WHY THESE OPERATE DIRECTLY ON THE STORE, NOT ExchangeService's in-memory machine: a recovery
// action's whole reason to exist is acting on an exchange that may have been quarantined in a
// PRIOR process lifetime (recoverExchangesOnBoot already ran, then that process kept running for
// hours) — `ExchangeMachine`'s in-memory map (src/exchanges/lifecycle.ts) never had this row, so
// its transition methods would refuse with `exchange_not_found`. These functions therefore mirror
// recovery.ts's own style: guarded `store.updateExchange` CAS + `appendExchangeEvent`, never the
// machine's `transition()`. When a same-process live correlator needs to pick up what happens
// NEXT (a subsequent pane idle/running/needs_input signal), `ExchangeService.adoptExchangeSnapshot`
// (src/exchanges/service.ts) seeds it from the row this module just wrote — see `performRetry`.
//
// RETRY POLICY — the reconciliation this step's brief asked for (spec vs. a literal same-exchange
// resume for EVERY "provably failed" case):
//
//   - `interrupted` exchanges: ALWAYS produce a NEW exchange (a "follow-up", spec §4's own words),
//     NEVER a same-exchange resume — even for the narrower "quarantined before delivery_attempted
//     even fired" case, where nothing could possibly have landed. The spec's hard rule is
//     unconditional ("An interrupted exchange is never auto-resumed... a follow-up is a NEW
//     exchange") and the lifecycle machine's legal-transition table (pinned 1:1 by
//     tests/test_exchange_lifecycle.ts) has exactly ONE outgoing edge from `interrupted`:
//     `-> cancelled`. Adding a same-exchange resume edge would mean either (a) widening
//     `isLegalTransition` for EVERY caller (not just this guarded one), directly contradicting the
//     spec's own "illegal-by-construction" call-out ("interrupted → running|delivered — no
//     auto-resume, ever"), or (b) a machine method that bypasses the shared legality guard
//     entirely for one narrow case — judged not worth the risk of a subtly-wrong guard (e.g. a
///    race where `delivery_attempt` reads 0 but a write is genuinely in flight through some path
//     this reasoning didn't model) when the "new exchange" path is trivially safe and the spec
//     itself already describes exactly this UX ("optionally pre-filled from the interrupted one's
//     distilled_instruction — a draft convenience, never an automatic send"). NO LIFECYCLE-MACHINE
//     CHANGE was made for this case.
//   - `draft` exchanges whose most recent recorded event is `delivery_failed` (the CERTAIN-failure
//     re-arm, spec note ᵉ, `staged -> draft`): retry DOES resume the SAME exchange. This needs NO
//     machine change at all — `draft -> staged` is already a legal edge; retry just re-runs the
//     two-phase delivery ordering (`delivery_attempted` durably precedes the write, `_succeeded`/
//     `_failed` follows it) against the SAME row, incrementing `delivery_attempt` again.
//   - anything else (awaiting_clarification/awaiting_approval — resolve those through their own
//     normal paths, not retry; delivered/running/needs_input/terminal_idle — not provably failed,
//     still genuinely in flight or awaiting a terminal observation; agent_complete/agent_failed/
//     cancelled — already settled; a `draft` whose last event is NOT `delivery_failed`, e.g. a
//     composed-but-never-sent draft, or one whose approval merely vanished) is REFUSED with the
//     exact uncertainty/reason named — never a guess, matching "otherwise... require explicit
//     operator decision" from the brief.

import type { JanusStore } from "../store/sqliteStore";
import type { ExchangeService } from "./service";
import type { AgentExchange, ExchangeEvent } from "./types";
import { TERMINAL_STATES } from "./lifecycle";

// ── resume-inspect ──────────────────────────────────────────────────────────────────────────────

export interface ResumeInspectView {
  exchange: AgentExchange;
  /** Newest first, bounded — "the last events", not the full history. */
  recentEvents: ExchangeEvent[];
}

/** Surface an exchange's current durable state + its recent event timeline — the read-only half
 *  of recovery. Store-level (never the in-memory machine): the whole point is to work for an
 *  exchange this process never created. `null` when the id does not exist. */
export function resumeInspectExchange(
  store: JanusStore,
  exchangeId: string,
  opts?: { limit?: number },
): ResumeInspectView | null {
  const exchange = store.getExchange(exchangeId);
  if (!exchange) return null;
  const limit = opts?.limit ?? 10;
  const events = store.listExchangeEvents(exchangeId);
  return { exchange, recentEvents: events.slice(-limit).reverse() };
}

// ── retry eligibility (pure, independently testable) ────────────────────────────────────────────

export type RetryEligibility =
  | { kind: "same_exchange" }
  | { kind: "new_exchange" }
  | { kind: "refused"; reason: string };

/**
 * Classify what a retry of this exchange may legally do, from its CURRENT durable state plus its
 * event history (to tell WHY a `draft` row is a draft — see the module doc's retry-policy note).
 * Pure: no store writes, safe to call for a preview/confirmation UI.
 */
export function classifyRetryEligibility(exchange: AgentExchange, events: ExchangeEvent[]): RetryEligibility {
  if (exchange.state === "interrupted") return { kind: "new_exchange" };
  if (exchange.state === "draft") return classifyDraftRetryEligibility(events);
  if (TERMINAL_STATES.has(exchange.state)) {
    return { kind: "refused", reason: `exchange already settled (${exchange.state}) — nothing to retry` };
  }
  return {
    kind: "refused",
    reason: `exchange is '${exchange.state}' — its delivery outcome is not yet provably failed; cancel it or wait for it to settle before retrying`,
  };
}

function classifyDraftRetryEligibility(events: ExchangeEvent[]): RetryEligibility {
  const last = events[events.length - 1];
  if (last?.event_type === "delivery_failed") return { kind: "same_exchange" };
  return {
    kind: "refused",
    reason: "this draft's prior attempt is not provably failed (it was never sent, or its approval simply vanished) — send it normally instead of retrying",
  };
}

// ── retry execution ─────────────────────────────────────────────────────────────────────────────

export interface RetryOutcome {
  kind: "same_exchange" | "new_exchange" | "refused";
  exchangeId?: string;
  message: string;
}

export interface RetryTerm {
  writeInput: (s: string) => void;
  status?: string;
}

/**
 * Retry `exchangeId`, per the eligibility classification above. `term` is the CALLER's live pane
 * lookup (undefined/Exited when the pane is not live) — this module never reaches into a manager
 * itself, keeping it store/service-only and easy to unit test. Never throws.
 */
export function retryExchange(
  store: JanusStore,
  svc: ExchangeService,
  exchangeId: string,
  term: RetryTerm | undefined,
  now: () => number = () => Date.now(),
): RetryOutcome {
  const exchange = store.getExchange(exchangeId);
  if (!exchange) return { kind: "refused", message: `Exchange ${exchangeId} not found.` };
  const events = store.listExchangeEvents(exchangeId);
  const eligibility = classifyRetryEligibility(exchange, events);
  if (eligibility.kind === "refused") {
    return { kind: "refused", message: `Cannot retry ${exchangeId}: ${eligibility.reason}.` };
  }
  if (eligibility.kind === "new_exchange") {
    return createFollowUpExchange(store, exchange, now);
  }
  return performSameExchangeRetry(store, svc, exchange, term, now);
}

/** Interrupted -> a brand-new sibling exchange (spec §4's "follow-up"), pre-filled from the
 *  original's distilled instruction. The ORIGINAL exchange is left exactly as it was (still
 *  `interrupted`, still cancellable/dismissable on its own) — this never touches it. */
function createFollowUpExchange(store: JanusStore, original: AgentExchange, now: () => number): RetryOutcome {
  const nowTs = now();
  const fresh = store.insertExchange({
    project_id: original.project_id,
    pane_id: original.pane_id,
    operator_utterance: original.operator_utterance,
    distilled_instruction: original.distilled_instruction,
    instruction_envelope_json: original.instruction_envelope_json,
    state: "draft",
    created_at: nowTs,
    updated_at: nowTs,
  });
  store.appendExchangeEvent({
    exchange_id: fresh.exchange_id,
    event_type: "exchange_created",
    project_id: fresh.project_id,
    pane_id: fresh.pane_id,
    payload_redacted_json: JSON.stringify({ follow_up_of: original.exchange_id }),
    ts: nowTs,
  });
  return {
    kind: "new_exchange",
    exchangeId: fresh.exchange_id,
    message: `Exchange ${original.exchange_id} is interrupted and can never auto-resume — created a new follow-up draft ${fresh.exchange_id} for pane ${original.pane_id}, pre-filled from the original instruction. Review and send it explicitly; the original stays interrupted until cancelled.`,
  };
}

/** draft (via delivery_failed) -> staged -> delivery_attempted -> write -> succeeded/failed, on
 *  the SAME exchange row. Mirrors the two-phase durable-intent ordering every other delivery path
 *  in this codebase uses (renderApproved / applyAutoExecute / the Workbench send seam,
 *  server.ts): the durable `delivery_attempted` genuinely precedes the write, the outcome event
 *  genuinely follows it. */
function performSameExchangeRetry(
  store: JanusStore,
  svc: ExchangeService,
  exchange: AgentExchange,
  term: RetryTerm | undefined,
  now: () => number,
): RetryOutcome {
  if (!term || term.status === "Exited") {
    return { kind: "refused", message: `Cannot retry ${exchange.exchange_id}: pane ${exchange.pane_id} is not live.` };
  }
  const staged = store.updateExchange(exchange.exchange_id, { state: "staged" }, { state: "draft" });
  if (!staged.changed || !staged.exchange) {
    return { kind: "refused", message: `Cannot retry ${exchange.exchange_id}: it changed state before this retry could apply (lost race).` };
  }
  svc.adoptExchangeSnapshot(staged.exchange);
  const attempted = store.updateExchange(
    exchange.exchange_id,
    { delivery_attempt: exchange.delivery_attempt + 1 },
    { state: "staged" },
  );
  const nextAttempt = attempted.exchange?.delivery_attempt ?? exchange.delivery_attempt + 1;
  store.appendExchangeEvent({
    exchange_id: exchange.exchange_id, event_type: "retry_initiated",
    project_id: exchange.project_id, pane_id: exchange.pane_id,
    payload_redacted_json: JSON.stringify({ delivery_attempt: nextAttempt }), ts: now(),
  });
  try {
    term.writeInput(exchange.distilled_instruction);
  } catch (e) {
    return failRetryWrite(store, svc, exchange, now, e);
  }
  const delivered = store.updateExchange(exchange.exchange_id, { state: "delivered", delivered_at: now() }, { state: "staged" });
  store.appendExchangeEvent({
    exchange_id: exchange.exchange_id, event_type: "delivery_succeeded",
    project_id: exchange.project_id, pane_id: exchange.pane_id, ts: now(),
  });
  if (delivered.exchange) svc.adoptExchangeSnapshot(delivered.exchange);
  return {
    kind: "same_exchange", exchangeId: exchange.exchange_id,
    message: `Retried exchange ${exchange.exchange_id}: redelivered to pane ${exchange.pane_id} (delivery attempt ${nextAttempt}).`,
  };
}

function failRetryWrite(
  store: JanusStore, svc: ExchangeService, exchange: AgentExchange, now: () => number, err: unknown,
): RetryOutcome {
  const failed = store.updateExchange(
    exchange.exchange_id,
    { state: "draft", approval_id: null, approval_draft_version: null },
    { state: "staged" },
  );
  store.appendExchangeEvent({
    exchange_id: exchange.exchange_id, event_type: "delivery_failed",
    project_id: exchange.project_id, pane_id: exchange.pane_id,
    payload_redacted_json: JSON.stringify({ detail: "retry_write_threw" }), ts: now(),
  });
  if (failed.exchange) svc.adoptExchangeSnapshot(failed.exchange);
  return { kind: "refused", message: `Retry of ${exchange.exchange_id} failed to write to pane ${exchange.pane_id}: ${String(err)}` };
}

// ── cancel ───────────────────────────────────────────────────────────────────────────────────────

export interface CancelOutcome {
  ok: boolean;
  message: string;
}

/** Dismiss any cancellable exchange (durable, store-level — same reasoning as retry: the target
 *  may predate this process). Legal from every state EXCEPT the three terminal ones (mirrors
 *  `CANCELLABLE_STATES`, src/exchanges/lifecycle.ts — including `interrupted`, whose only real
 *  legal edge IS `-> cancelled`). */
export function cancelExchangeDurable(
  store: JanusStore,
  svc: ExchangeService,
  exchangeId: string,
  reason: string | undefined,
  now: () => number = () => Date.now(),
): CancelOutcome {
  const exchange = store.getExchange(exchangeId);
  if (!exchange) return { ok: false, message: `Exchange ${exchangeId} not found.` };
  if (TERMINAL_STATES.has(exchange.state)) {
    return { ok: false, message: `Exchange ${exchangeId} already ${exchange.state} — nothing to cancel.` };
  }
  const res = store.updateExchange(exchangeId, { state: "cancelled" }, { state: exchange.state });
  if (!res.changed) {
    return { ok: false, message: `Exchange ${exchangeId} could not be cancelled (it changed state first — lost race).` };
  }
  store.appendExchangeEvent({
    exchange_id: exchangeId, event_type: "exchange_cancelled",
    project_id: exchange.project_id, pane_id: exchange.pane_id,
    payload_redacted_json: JSON.stringify({ reason: reason ?? "operator_cancelled" }), ts: now(),
  });
  if (res.exchange) svc.adoptExchangeSnapshot(res.exchange);
  return { ok: true, message: `Exchange ${exchangeId} cancelled.` };
}

// ── open-pane (lightweight navigation lookup) ───────────────────────────────────────────────────

export interface OpenExchangePaneView {
  projectId: string;
  paneId: string;
}

/** Which (project, pane) an exchange belongs to — the "open-pane" recovery action: a client that
 *  only has an exchange_id (from an attention item / notification) can resolve where to navigate. */
export function openExchangePane(store: JanusStore, exchangeId: string): OpenExchangePaneView | null {
  const exchange = store.getExchange(exchangeId);
  if (!exchange) return null;
  return { projectId: exchange.project_id, paneId: exchange.pane_id };
}
