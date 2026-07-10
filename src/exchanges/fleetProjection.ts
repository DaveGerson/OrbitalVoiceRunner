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
import type { AgentExchange, ExchangeState } from "./types";
import type { FleetExchangeKind, FleetExchangeSummary, FleetExchangeTier } from "../types";

/** Structural read surface this module needs — mirrors ContextVersionSource / PoolKVSource's
 *  convention (small interface, not a full JanusStore import) so a hand-built test double can
 *  satisfy it without a real sqlite-backed store. `JanusStore` satisfies this directly. */
export interface FleetExchangeSource {
  getLatestExchangeForPane(paneId: string): AgentExchange | null;
}

const SUMMARY_TEXT_CAP = 160;

/** state -> (tier, kind). Any state not listed here (a future addition to the lifecycle union)
 *  falls back to tier 6 / "decision" — the LEAST urgent bucket, never silently promoted to an
 *  exception the operator hasn't actually earned a look at. */
const TIER_KIND_BY_STATE: Partial<Record<ExchangeState, { tier: FleetExchangeTier; kind: FleetExchangeKind }>> = {
  needs_input: { tier: 1, kind: "needs_input" },
  awaiting_clarification: { tier: 1, kind: "needs_input" },
  awaiting_approval: { tier: 1, kind: "approval" },
  agent_failed: { tier: 2, kind: "failed" },
  interrupted: { tier: 2, kind: "failed" },
  agent_complete: { tier: 3, kind: "complete" },
  running: { tier: 4, kind: "running" },
  delivered: { tier: 4, kind: "running" },
  terminal_idle: { tier: 4, kind: "running" },
  staged: { tier: 5, kind: "staged" },
  draft: { tier: 6, kind: "decision" },
  cancelled: { tier: 6, kind: "decision" },
};

const FALLBACK_TIER_KIND = { tier: 6 as FleetExchangeTier, kind: "decision" as FleetExchangeKind };

/** Redact + cap one text field. `null`/empty stays `null` (an absent field is never fabricated
 *  into an empty string the card would render as a blank line). */
function summaryText(raw: string | null | undefined, redact: (s: string) => string): string | null {
  if (!raw) return null;
  const r = redact(raw);
  return r.length > SUMMARY_TEXT_CAP ? r.slice(0, SUMMARY_TEXT_CAP) : r;
}

/** Project one durable exchange row into the bounded, redacted client view. */
export function buildFleetExchangeSummary(ex: AgentExchange, redact: (s: string) => string): FleetExchangeSummary {
  const { tier, kind } = TIER_KIND_BY_STATE[ex.state] ?? FALLBACK_TIER_KIND;
  return {
    exchangeId: ex.exchange_id,
    state: ex.state,
    tier,
    kind,
    instructionSummary: summaryText(ex.distilled_instruction || ex.operator_utterance, redact),
    waitingReason: summaryText(ex.terminal_state, redact),
    resultSummary: summaryText(ex.result_summary, redact),
    updatedAt: ex.updated_at,
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
