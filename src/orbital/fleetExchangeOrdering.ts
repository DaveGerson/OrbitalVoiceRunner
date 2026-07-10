// src/orbital/fleetExchangeOrdering.ts — Phase 5, Step 5.1 (Fleet View "communication-by-exception").
//
// Pure row-building + ordering for the fleet exception lane. Merges a Station (station.ts) with
// whatever exchange-shaped signal is available for its pane — a HELD approval (PendingCommand,
// the SAME source Station.status="Needs Input" already derives from), the pane's open
// instruction-envelope draft (ExchangeDraftView, draftRegistry/viewOpenDraft — already threaded
// through the board as `exchangeByPane`, 3.3), and/or the durable per-pane exchange projection
// (FleetExchangeSummary, src/exchanges/fleetProjection.ts, additive/optional) — into one FleetRow,
// tiered per the Phase 4.2 six-tier priority (docs/superpowers/specs/2026-06-25-fleet-view-design.md
// + src/voice/sitrep.ts's composeExchangeBoard doc):
//   (1) needs-input / a held approval        — the operator must act
//   (2) failed / exited / interrupted        — a dead or errored pane
//   (3) a delivered exchange with a result   — something finished and has news
//   (4) running                              — in flight, nothing needed yet
//   (5) staged                               — queued, not yet delivered
//   (6) everything else (idle/decision)
// Tiers 1-2 are the "exception lane" (isException:true); everything else stays in the compact tail.
//
// No I/O, no React — independently unit-testable (tests/test_station_fleet_exception.ts). Absent
// exchange/pending-command data (mock mode, or a fresh install with no exchange history) degrades
// every row to the Station's own status ladder — the SAME urgency Station.status already carries —
// so this module is a pure ENHANCEMENT layer, never a second source of truth that could disagree
// with the board.
import type { Station } from "./station";
import type { ExchangeDraftView, FleetExchangeSummary, PendingCommand } from "../types";

export type FleetRowTier = 1 | 2 | 3 | 4 | 5 | 6;
export type FleetRowKind =
  | "needs_input" | "approval" | "failed" | "complete" | "running" | "staged" | "decision";

export interface FleetRow {
  station: Station;
  tier: FleetRowTier;
  kind: FleetRowKind;
  /** tier 1 or 2 — the exception lane; everything else is the compact, non-exception tail. */
  isException: boolean;
  /** The current/most-recent instruction (already redacted upstream), truncated, or null. */
  instructionSummary: string | null;
  /** Why the pane is waiting (an agent question, or the envelope's own clarification), or null. */
  waitingReason: string | null;
  /** A HELD approval this row can act on directly (Approve/Deny), or null when there is none. */
  pendingApproval: { messageId: string; summary: string } | null;
  /** The last meaningful agent result (a completion report), or null. */
  lastResult: string | null;
  /** The exchange this row correlates to (retry/cancel target), or null when there is none. */
  exchangeId: string | null;
  /** Epoch ms this row's underlying signal last changed, or null when unknown (no durable summary). */
  updatedAt: number | null;
}

/** A held approval this row can act on directly (Approve/Deny) — either source below projects to
 *  this same shape before reaching the precedence ladder. */
export interface FleetApprovalSignal {
  messageId: string;
  summary: string;
}

export interface FleetRowInputs {
  /** A pane's currently-HELD approval when it is ALSO the ACTIVE pane (the same PendingCommand[]
   *  the blocking ApprovalDialog modal already renders from) — keyed by pane id. This is the RARE
   *  case for a fleet-wide view (the fleet spans every project, most panes are not "active"); kept
   *  for completeness/precedence only. */
  pendingCommandByPane?: Record<string, PendingCommand | undefined>;
  /** A pane's currently-HELD approval when it is NOT the active pane (the focus-routed attention
   *  inbox, bead 8xn) — the COMMON fleet-wide case. Keyed by pane id; build with
   *  `attentionApprovalsByPane` below (reuses the existing `attentionResolveTarget` id-gate, so a
   *  triage-only attention item can never fabricate a resolvable approval). */
  attentionApprovalByPane?: Record<string, FleetApprovalSignal | undefined>;
  /** A pane's open instruction-envelope draft (3.3's exchangeByPane), keyed by pane id. */
  exchangeByPane?: Record<string, ExchangeDraftView | null | undefined>;
  /** The durable per-pane exchange projection (Phase 5.1, GET /api/fleet/exchange-summary),
   *  keyed by pane id — optional/additive; absent entirely degrades every row to the Station
   *  status ladder below. */
  summaryByPane?: Record<string, FleetExchangeSummary | undefined>;
}

/**
 * Project the attention queue's resolvable "approval" items (bead e7h/8xn — a background pane's
 * held approval, routed away from the blocking modal) into the `attentionApprovalByPane` shape,
 * keyed by pane id. Reuses `attentionResolveTarget` (useOrbitalDataHelpers.ts) so a triage-only
 * item (no messageId) is never treated as actionable here either — the SAME id-gate the inbox's
 * own Approve/Deny already enforces. A pane with more than one queued approval keeps the FIRST
 * (oldest — the queue is push-ordered), matching "resolve the one that's been waiting longest".
 * Prefers `rawCmd` (bead 8xn — the RAW staged command, when the item carries one) over `message`
 * (which is the wrapped "<pane> needs your ok: <cmd>" DISPLAY string) — the card already labels
 * the row "Awaiting your approval" via its kind chip, so the instruction text itself should be the
 * bare command, not a second copy of the same framing.
 */
export function attentionApprovalsByPane(
  queue: Array<{ type?: string; messageId?: unknown; terminalId?: string; message?: string; rawCmd?: string }>,
  resolveTarget: (item: { type?: string; messageId?: unknown }) => string | null,
): Record<string, FleetApprovalSignal> {
  const out: Record<string, FleetApprovalSignal> = {};
  for (const item of queue) {
    const messageId = resolveTarget(item);
    if (!messageId || !item.terminalId || out[item.terminalId]) continue;
    const summary = typeof item.rawCmd === "string" && item.rawCmd ? item.rawCmd : (typeof item.message === "string" ? item.message : "");
    out[item.terminalId] = { messageId, summary };
  }
  return out;
}

const TEXT_CAP = 140;

/** Truncate an already-redacted string to the card's display cap. `null`/empty stays `null` (never
 *  fabricated into a visible-but-blank row). */
function cap(s: string | null | undefined): string | null {
  if (!s) return null;
  return s.length > TEXT_CAP ? s.slice(0, TEXT_CAP - 1) + "…" : s;
}

/** The base fields every row shares, before the precedence ladder below fills in the
 *  signal-specific ones — keeps buildFleetRow itself a flat if-ladder (complexity gate). */
function baseRow(station: Station, draft: ExchangeDraftView | null | undefined): Omit<FleetRow, "tier" | "kind" | "isException" | "waitingReason" | "pendingApproval" | "lastResult"> {
  return {
    station,
    instructionSummary: cap(draft?.objective || station.scribble || null),
    exchangeId: draft?.exchangeId ?? null,
    updatedAt: null,
  };
}

/** Tier 1 — a HELD approval takes absolute precedence: it is the single most actionable "needs
 *  you" signal (the same source Station.status="Needs Input" already derives from), so it always
 *  wins over a durable summary or the draft/status fallback, even if those disagree. */
function approvalRow(
  station: Station,
  approval: FleetApprovalSignal,
  instructionText: string,
  waitingReason: string | null,
  summary: FleetExchangeSummary | undefined,
  draft: ExchangeDraftView | null | undefined,
): FleetRow {
  return {
    ...baseRow(station, draft),
    tier: 1, kind: "approval", isException: true,
    instructionSummary: cap(instructionText),
    waitingReason: cap(waitingReason),
    pendingApproval: { messageId: approval.messageId, summary: cap(approval.summary) ?? approval.summary },
    lastResult: null,
    exchangeId: summary?.exchangeId ?? draft?.exchangeId ?? null,
    updatedAt: summary?.updatedAt ?? null,
  };
}

/** The durable per-pane summary (when present) fully drives tier/kind — it is the freshest,
 *  most-precise signal (the exchange spine itself), so it overrides the Station-status fallback
 *  ladder below rather than merely supplementing it. */
function summaryRow(station: Station, summary: FleetExchangeSummary, draft: ExchangeDraftView | null | undefined): FleetRow {
  return {
    ...baseRow(station, draft),
    tier: summary.tier, kind: summary.kind, isException: summary.tier <= 2,
    instructionSummary: cap(summary.instructionSummary ?? draft?.objective ?? station.scribble ?? null),
    waitingReason: cap(summary.waitingReason),
    pendingApproval: null,
    lastResult: cap(summary.resultSummary),
    exchangeId: summary.exchangeId,
    updatedAt: summary.updatedAt,
  };
}

/** No pending approval, no durable summary — degrade to the Station's own status ladder (the
 *  SAME urgency ordering station.ts's sortStationsByUrgency already uses), so a fresh install or
 *  mock-mode board (no exchange data at all) still orders sensibly. */
function statusFallbackRow(station: Station, draft: ExchangeDraftView | null | undefined): FleetRow {
  const base = baseRow(station, draft);
  if (station.status === "Needs Input") {
    return {
      ...base, tier: 1, kind: "needs_input", isException: true, pendingApproval: null, lastResult: null,
      waitingReason: draft && draft.readiness.ready === false ? cap(draft.readiness.clarification) : null,
    };
  }
  if (station.status === "Exited") {
    return { ...base, tier: 2, kind: "failed", isException: true, waitingReason: null, pendingApproval: null, lastResult: null };
  }
  if (station.status === "Running") {
    return { ...base, tier: 4, kind: "running", isException: false, waitingReason: null, pendingApproval: null, lastResult: null };
  }
  // Idle (or any unmapped status — defensive, mirrors urgencyRank's own fallback).
  return { ...base, tier: 6, kind: "decision", isException: false, waitingReason: null, pendingApproval: null, lastResult: null };
}

/** Build one row from a Station + whatever exchange-shaped signals are available for its pane.
 *  Precedence (highest first): a HELD approval (active-pane modal source, THEN the background
 *  attention-inbox source) > the durable summary > the Station status ladder. */
export function buildFleetRow(station: Station, inputs: FleetRowInputs): FleetRow {
  const pending = inputs.pendingCommandByPane?.[station.id];
  const attentionApproval = inputs.attentionApprovalByPane?.[station.id];
  const summary = inputs.summaryByPane?.[station.id];
  const draft = inputs.exchangeByPane?.[station.id];
  if (pending) return approvalRow(station, { messageId: pending.messageId, summary: pending.cmd }, pending.cmd, pending.rationale?.summary ?? null, summary, draft);
  if (attentionApproval) return approvalRow(station, attentionApproval, attentionApproval.summary, null, summary, draft);
  if (summary) return summaryRow(station, summary, draft);
  return statusFallbackRow(station, draft);
}

/** Build a row per station, in the SAME order as the input array (sort separately). */
export function buildFleetRows(stations: Station[], inputs: FleetRowInputs): FleetRow[] {
  return stations.map((s) => buildFleetRow(s, inputs));
}

/**
 * Stable, non-mutating six-tier sort: tier ascending, then most-recently-updated first (a row with
 * no known `updatedAt` sorts after one that does, within the same tier), then a station-id
 * tie-break so a repeated build over an unchanged board never churns. Returns a new array.
 */
export function sortFleetRows(rows: FleetRow[]): FleetRow[] {
  return [...rows].sort(
    (a, b) => a.tier - b.tier || (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.station.id.localeCompare(b.station.id),
  );
}

export interface FleetCounters {
  total: number;
  needsYou: number;
  running: number;
}

/** Fleet-wide counters (design spec §5.2's "N agents · M need you · K running"), aggregated over
 *  every row — the exception count generalizes past Station.status="Needs Input" to also count a
 *  durable-summary-derived failed/exited exception. */
export function computeFleetCounters(rows: FleetRow[]): FleetCounters {
  return {
    total: rows.length,
    needsYou: rows.filter((r) => r.isException).length,
    running: rows.filter((r) => r.station.status === "Running").length,
  };
}
