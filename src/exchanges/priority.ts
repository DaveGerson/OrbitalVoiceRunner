// src/exchanges/priority.ts — Phase 5 simplification: SINGLE authority for the six-tier
// state -> (tier, kind) mapping.
//
// Previously this exact table was maintained in two places that had to be kept in lockstep by
// hand: src/exchanges/fleetProjection.ts's TIER_KIND_BY_STATE (the per-pane fleet summary
// projection) and src/voice/sitrep.ts's composeExchangeBoard (the spoken/caption board), whose
// module doc explicitly says "mirrors src/voice/sitrep.ts's composeExchangeBoard six-tier
// priority". This module is that one source of truth; both callers import it rather than each
// keeping their own copy.
//
// Any state not listed here (a future addition to the ExchangeState union) falls back to tier 6 /
// "decision" — the LEAST urgent bucket, never silently promoted to an exception the operator
// hasn't actually earned a look at.
import type { ExchangeState } from "./types";
import type { FleetExchangeTier, FleetExchangeKind } from "../types";

export interface TierKind {
  tier: FleetExchangeTier;
  kind: FleetExchangeKind;
}

/** state -> (tier, kind). Six-tier priority (spec docs/superpowers/specs/2026-06-25-fleet-view-design.md). */
export const TIER_KIND_BY_STATE: Partial<Record<ExchangeState, TierKind>> = {
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

export const FALLBACK_TIER_KIND: TierKind = { tier: 6, kind: "decision" };

/** Resolve one state to its (tier, kind), falling back to FALLBACK_TIER_KIND for any state not
 *  (yet) listed in TIER_KIND_BY_STATE. */
export function tierKindForState(state: ExchangeState): TierKind {
  return TIER_KIND_BY_STATE[state] ?? FALLBACK_TIER_KIND;
}
