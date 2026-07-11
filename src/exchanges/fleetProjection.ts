// src/exchanges/fleetProjection.ts — Phase 5, Step 5.1 (Fleet View "communication-by-exception").
//
// A small, read-only, per-pane projection off the durable AgentExchange spine, mirroring
// draftRegistry.ts's `viewOpenDraft` pattern (a pure, JSON-serializable client view built from one
// durable read) but for a pane's MOST RECENT exchange regardless of whether its draft is still
// "open" — a pane whose exchange has already moved to running/agent_complete/agent_failed/
// interrupted still carries a summary here, which `viewOpenDraft` (open-drafts-only) cannot give.
//
// Tiering mirrors src/voice/sitrep.ts's composeExchangeBoard six-tier priority (spec docs/
// superpowers/specs/2026-06-25-fleet-view-design.md + the Phase 4.2 module doc), but per-PANE
// (one row: this pane's single latest exchange) rather than per-exchange-across-the-fleet — the
// fleet card needs "what is THIS pane's exchange doing", not a global ranked list.
//
// Every text field is REDACTED (the caller-injected `redact`) and length-capped before it leaves
// this module — the wire never carries raw operator/agent text, matching the exchange spine's own
// storage-layer convention ("operator_utterance: redacted at the boundary by the caller").
import type { AgentExchange } from "./types";
import type { FleetExchangeSummary } from "../types";
import { tierKindForState } from "./priority";
import { redactCapped } from "./textUtil";
import { CANCELLABLE_STATES } from "./lifecycle";
import { classifyRetryEligibility } from "./recoveryActions";

/** Structural read surface this module needs — mirrors ContextVersionSource / PoolKVSource's
 *  convention (small interface, not a full JanusStore import) so a hand-built test double can
 *  satisfy it without a real sqlite-backed store. `JanusStore` satisfies this directly. */
export interface FleetExchangeSource {
  getLatestExchangeForPane(paneId: string): AgentExchange | null;
}

const SUMMARY_TEXT_CAP = 160;

/**
 * Phase 5.5 (release review): the fleet card's quick-action offers, computed from the REAL
 * lifecycle/recovery rules rather than the display `kind` (which collapses terminal `agent_failed`
 * and recoverable `interrupted` into one "failed" chip). `classifyRetryEligibility` is called with
 * an EMPTY events array — safe here because its only events-dependent branch is the `draft` state
 * (classifyDraftRetryEligibility, which needs the event timeline to prove a prior delivery
 * actually failed); every other state (including the one this fleet card ever offers a retry for,
 * `interrupted`) resolves before it would ever look at `events`. That "draft-after-delivery_failed
 * same-exchange retry" leg deliberately stays off the fleet card (recoveryActions.ts's own module
 * doc) — it needs the timeline this per-pane summary projection doesn't carry, and stays reachable
 * via REST/inspect instead.
 */
function computeFleetOffers(ex: AgentExchange): { retry: boolean; cancel: boolean } {
  return {
    retry: classifyRetryEligibility(ex, []).kind === "new_exchange",
    cancel: CANCELLABLE_STATES.has(ex.state),
  };
}

/** Project one durable exchange row into the bounded, redacted client view. */
export function buildFleetExchangeSummary(ex: AgentExchange, redact: (s: string) => string): FleetExchangeSummary {
  const { tier, kind } = tierKindForState(ex.state);
  return {
    exchangeId: ex.exchange_id,
    state: ex.state,
    tier,
    kind,
    instructionSummary: redactCapped(ex.distilled_instruction || ex.operator_utterance, redact, SUMMARY_TEXT_CAP),
    waitingReason: redactCapped(ex.terminal_state, redact, SUMMARY_TEXT_CAP),
    resultSummary: redactCapped(ex.result_summary, redact, SUMMARY_TEXT_CAP),
    updatedAt: ex.updated_at,
    offers: computeFleetOffers(ex),
  };
}

/**
 * Project every pane in `paneIds` to its latest-exchange summary (a pane with no exchange history
 * is simply absent from the result — never a fabricated placeholder row). Never throws: a single
 * pane's read fault is logged and skipped, mirroring src/voice/sitrep.ts's `safeList` idiom, so one
 * bad row can never blank the whole fleet projection. Bounded: exactly one row per pane, one query
 * per pane (idx_agent_exchanges_pane_state, LIMIT 1) — the caller (server.ts) already bounds
 * `paneIds` to the live terminals set.
 */
export function projectFleetExchangeSummaries(
  store: FleetExchangeSource,
  paneIds: string[],
  redact: (s: string) => string,
): Record<string, FleetExchangeSummary> {
  const out: Record<string, FleetExchangeSummary> = {};
  for (const paneId of paneIds) {
    try {
      const ex = store.getLatestExchangeForPane(paneId);
      if (ex) out[paneId] = buildFleetExchangeSummary(ex, redact);
    } catch (e) {
      console.error("[fleetProjection] getLatestExchangeForPane failed for pane", paneId, e);
    }
  }
  return out;
}
