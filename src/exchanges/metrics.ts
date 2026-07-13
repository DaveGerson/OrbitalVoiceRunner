// src/exchanges/metrics.ts — Phase 5, Step 5.2 (communication-quality metrics).
//
// Pure aggregation over the AgentExchange spine's durable rows/events (schema v12:
// `agent_exchanges`, `exchange_events`, `context_deliveries`) — mirrors src/memory/
// contextMetricsReport.ts's idiom exactly: no store I/O beyond a couple of bounded, windowed reads,
// NO wall-clock in the output (same DB in -> same JSON out, deterministic percentiles), NO network/
// process side effects. Every metric this report cannot honestly derive from durable state is `null`
// with an explanatory `notes[]` entry, never faked (same posture as that module's
// `durableDuplicatePaneCount`/`wrongPaneRefusals`/`approvalExactlyOnceSuccessRate`).
//
// EVENT-VOCABULARY CAVEATS worth reading before trusting a number here:
//   - `target_resolved` and `clarification_requested` ARE live as of Phase 5.4 (this header used to
//     say "no producer yet"; that is stale): every `createExchange` appends `target_resolved`
//     (ExchangeService.persistCreate) and the dispatch clarify seam appends `clarification_requested`
//     (recordClarificationRequested, called from src/voice/index.ts settleExchangeForDispatch). Two
//     honest consequences, both documented at their producers: (a) `wrongTargetDeliveries` still
//     reads 0 on live traffic — the payload's paneId is stamped from the row's own immutable
//     pane_id, so a non-zero value means a future resolver bug diverged them (the metric is a live
//     TRIPWIRE, not unwired); (b) `clarificationCauses` counts only POST-exchange clarifies — the
//     target resolver's own pre-exchange "which pane did you mean" turn cannot carry an exchange
//     event (exchange_events.exchange_id is NOT NULL; decision of record in
//     docs/review/2026-07-10-release-validation-5.5.md).
//   - `delivery_succeeded`/`delivery_failed` events do not carry `draft_version` in their payload
//     today (`ExchangeService.completeDelivery`/`failDelivery` append them with no `opts.payload`) —
//     `duplicateDeliveries` is therefore derived from EVENT ADJACENCY (two `delivery_succeeded`
//     events for the same exchange with no `delivery_attempted`/`retry_initiated` marker between
//     them), not a literal `(exchange, draft_version)` key. Documented here so this derivation is an
//     auditable choice, not a silent approximation.
import type { AgentExchange, ContextDelivery, ExchangeEvent, ExchangeEventType } from "./types";
import { parseJsonObject, safeArrayLength } from "./payload";

/** Structural read surface this report needs — mirrors ContextMetricsSource's convention (small
 *  interface, not a full JanusStore import). `JanusStore` satisfies this directly.
 *  `getContextDeliveries` is OPTIONAL (mirrors contextMetricsReport's own optional context-delivery
 *  join) so a lighter test double that never implemented it still satisfies this interface — its
 *  absence degrades `contextCost` to its empty-set values, never a throw. */
export interface ExchangeMetricsSource {
  listExchangesSince(sinceMs: number, opts?: { limit?: number }): AgentExchange[];
  listExchangeEventsSince(sinceMs: number, opts?: { limit?: number }): ExchangeEvent[];
  getContextDeliveries?(filter?: { since?: number; limit?: number }): ContextDelivery[];
}

/** Query cap for the underlying store reads — mirrors contextMetricsReport's DEFAULT_QUERY_LIMIT
 *  ("effectively all rows" for a smoke-journey or single-day operator DB). */
const DEFAULT_QUERY_LIMIT = 1_000_000;

export interface ExchangeMetricsReportOptions {
  /** Only rows with ts/created_at >= sinceMs are included. Default 0 (all time). Caller-supplied,
   *  never a wall-clock read here (CLI: --since-ms, tests: a fixed cutoff). */
  sinceMs?: number;
  /** Max rows each underlying store read may return. Default DEFAULT_QUERY_LIMIT. */
  limit?: number;
}

export interface LatencyStats {
  count: number;
  /** Milliseconds. Nearest-rank percentile over the sorted sample set (deterministic, no
   *  interpolation) — see `percentile` below. */
  p50: number;
  p95: number;
}

export interface ExchangeContextCost {
  /** Delivered exchanges (a non-null voice_session_id + context_version) that matched at least one
   *  context_deliveries row for that exact (project, session, context_version) triple. */
  deliveredExchangesWithContext: number;
  /** Total matched context_deliveries rows across those exchanges (an exchange may match more than
   *  one delivery for its own context_version — e.g. a re-delivered/re-acknowledged brief). */
  totalDeliveries: number;
  totalIncludedSources: number;
  totalDroppedSources: number;
}

export interface ExchangeRecoveryState {
  /** `exchange_recovered` events with payload.disposition === "interrupted" (boot quarantine or a
   *  live-delivery supersession — src/exchanges/recovery.ts / src/exchanges/service.ts's
   *  `supersede`). */
  interruptedEvents: number;
  /** `exchange_recovered` events with payload.disposition === "reverted_missing_approval" (boot
   *  recovery reverted an `awaiting_approval` row whose bound approval did not survive). */
  revertedMissingApprovalEvents: number;
  /** `retry_initiated` events (an operator-confirmed same-exchange retry, src/exchanges/
   *  recoveryActions.ts). */
  retriedEvents: number;
  /** Exchanges CURRENTLY sitting in `interrupted` (the durable row state, not an event count) —
   *  the operator's live "needs recovery attention" backlog. */
  currentlyInterruptedExchanges: number;
}

export interface ExchangeMetricsReport {
  sinceMs: number;
  exchangeCount: number;
  eventCount: number;
  /** delivered exchanges whose `target_resolved` event named a different pane than the exchange's
   *  own delivery pane (see the module doc's event-vocabulary caveat). */
  wrongTargetDeliveries: number;
  duplicateDeliveries: number;
  /** Null — not durably derivable today; see `UNCORRELATED_COMPLETIONS_NOTE`. */
  uncorrelatedCompletions: number | null;
  /** `clarification_requested` events bucketed by `payload.cause` (a short label the FIRST producer
   *  of this event type should adopt); events with no/blank `cause` bucket under `"unspecified"`. */
  clarificationCauses: Record<string, number>;
  /** `draft_revised` events per exchange_id — only exchanges with at least one revision appear
   *  (sparse, bounded by actual activity, not by exchangeCount). */
  draftEditCounts: Record<string, number>;
  /** exchange_created -> the first "the draft moved forward" milestone event (draft_revised /
   *  target_resolved / approval_requested / delivery_attempted, whichever comes first). Null when
   *  no exchange in the window has both. */
  speechToDraftLatency: LatencyStats | null;
  /** The latest of {approval_confirmed, delivery_attempted, retry_initiated} preceding a
   *  delivery_succeeded, to that delivery_succeeded. Null when no such pair exists in the window. */
  deliveryLatency: LatencyStats | null;
  /** Null — no durable event/row records WHEN a narration/attention item was raised for an exchange;
   *  see `NOTIFICATION_LATENCY_NOTE`. */
  needsInputNotificationLatency: null;
  resultNotificationLatency: null;
  contextCost: ExchangeContextCost;
  recoveryState: ExchangeRecoveryState;
  notes: string[];
}

// `parseJsonObject`/`safeArrayLength` (the shared parsing helpers this module used to carry its own
// copies of) now live in src/exchanges/payload.ts, shared with src/exchanges/replay.ts.

/** Group a globally `ts ASC, event_id ASC`-ordered event stream by exchange_id. Grouping a
 *  pre-sorted sequence preserves each group's own chronological order — no per-group re-sort
 *  needed downstream. */
function groupEventsByExchange(events: ExchangeEvent[]): Map<string, ExchangeEvent[]> {
  const out = new Map<string, ExchangeEvent[]>();
  for (const e of events) {
    const arr = out.get(e.exchange_id);
    if (arr) arr.push(e);
    else out.set(e.exchange_id, [e]);
  }
  return out;
}

// ── percentiles ──────────────────────────────────────────────────────────────────────────────────

/** Deterministic nearest-rank percentile over an ASCENDING-sorted sample array (no interpolation —
 *  the returned value is always an actual observed sample, never a synthesized average of two). */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.ceil(p * sortedAsc.length);
  const idx = Math.min(sortedAsc.length, Math.max(1, rank)) - 1;
  return sortedAsc[idx];
}

function latencyStats(samples: number[]): LatencyStats | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return { count: sorted.length, p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95) };
}

// ── wrong-target / duplicate deliveries ─────────────────────────────────────────────────────────

/** A `target_resolved` event's payload is expected to carry `{ paneId: string, projectId?: string }`
 *  — the CONVENTION this module defines for the first producer of this (currently unwired) event
 *  type. `e.pane_id` (stamped on every exchange_events row, spec-established) is always the
 *  exchange's own fixed delivery pane (`pane_id` is immutable per exchange row) — a resolution
 *  naming a DIFFERENT pane is the wrong-target signal. */
function countWrongTargetDeliveries(byExchange: Map<string, ExchangeEvent[]>): number {
  let n = 0;
  for (const evs of byExchange.values()) {
    for (const e of evs) {
      if (e.event_type !== "target_resolved") continue;
      const payload = parseJsonObject(e.payload_redacted_json);
      const resolvedPaneId = typeof payload.paneId === "string" ? payload.paneId : null;
      if (resolvedPaneId && e.pane_id && resolvedPaneId !== e.pane_id) n++;
    }
  }
  return n;
}

const DELIVERY_RESET_EVENT_TYPES: ReadonlySet<ExchangeEventType> = new Set(["delivery_attempted", "retry_initiated"]);

/** See the module doc's "EVENT-VOCABULARY CAVEATS": counts each `delivery_succeeded` beyond the
 *  first since the last `delivery_attempted`/`retry_initiated` marker as a duplicate. */
function countDuplicateDeliveries(byExchange: Map<string, ExchangeEvent[]>): number {
  let n = 0;
  for (const evs of byExchange.values()) {
    let sinceReset = 0;
    for (const e of evs) {
      if (DELIVERY_RESET_EVENT_TYPES.has(e.event_type)) {
        sinceReset = 0;
        continue;
      }
      if (e.event_type === "delivery_succeeded") {
        sinceReset++;
        if (sinceReset > 1) n++;
      }
    }
  }
  return n;
}

// ── clarification causes / draft edit counts ────────────────────────────────────────────────────

const CLARIFICATION_CAUSE_CAP = 64;

function countClarificationCauses(events: ExchangeEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events) {
    if (e.event_type !== "clarification_requested") continue;
    const payload = parseJsonObject(e.payload_redacted_json);
    const raw = typeof payload.cause === "string" ? payload.cause.trim() : "";
    const cause = raw ? raw.slice(0, CLARIFICATION_CAUSE_CAP) : "unspecified";
    out[cause] = (out[cause] ?? 0) + 1;
  }
  return out;
}

function countDraftEditsPerExchange(events: ExchangeEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events) {
    if (e.event_type !== "draft_revised") continue;
    out[e.exchange_id] = (out[e.exchange_id] ?? 0) + 1;
  }
  return out;
}

// ── latency metrics ──────────────────────────────────────────────────────────────────────────────

const DRAFT_MILESTONE_EVENT_TYPES: ReadonlySet<ExchangeEventType> = new Set([
  "draft_revised", "target_resolved", "approval_requested", "delivery_attempted",
]);

function computeSpeechToDraftLatency(byExchange: Map<string, ExchangeEvent[]>): LatencyStats | null {
  const samples: number[] = [];
  for (const evs of byExchange.values()) {
    const createdIdx = evs.findIndex((e) => e.event_type === "exchange_created");
    if (createdIdx === -1) continue;
    for (let i = createdIdx + 1; i < evs.length; i++) {
      if (DRAFT_MILESTONE_EVENT_TYPES.has(evs[i].event_type)) {
        samples.push(evs[i].ts - evs[createdIdx].ts);
        break;
      }
    }
  }
  return latencyStats(samples);
}

const DELIVERY_START_EVENT_TYPES: ReadonlySet<ExchangeEventType> = new Set([
  "approval_confirmed", "delivery_attempted", "retry_initiated",
]);

function computeDeliveryLatency(byExchange: Map<string, ExchangeEvent[]>): LatencyStats | null {
  const samples: number[] = [];
  for (const evs of byExchange.values()) {
    let lastStart: ExchangeEvent | null = null;
    for (const e of evs) {
      if (DELIVERY_START_EVENT_TYPES.has(e.event_type)) {
        lastStart = e;
        continue;
      }
      if (e.event_type === "delivery_succeeded" && lastStart) {
        samples.push(e.ts - lastStart.ts);
        lastStart = null; // consumed — a subsequent delivery needs its own fresh start marker
      }
    }
  }
  return latencyStats(samples);
}

// ── context cost ─────────────────────────────────────────────────────────────────────────────────

function contextDeliveryKey(projectId: string | null, sessionId: string | null, contextVersion: string): string {
  return `${projectId ?? ""}::${sessionId ?? ""}::${contextVersion}`;
}

function computeContextCost(exchanges: AgentExchange[], deliveries: ContextDelivery[]): ExchangeContextCost {
  const byKey = new Map<string, ContextDelivery[]>();
  for (const d of deliveries) {
    const key = contextDeliveryKey(d.project_id, d.voice_session_id, d.context_version);
    const arr = byKey.get(key);
    if (arr) arr.push(d);
    else byKey.set(key, [d]);
  }
  let deliveredExchangesWithContext = 0, totalDeliveries = 0, totalIncludedSources = 0, totalDroppedSources = 0;
  for (const ex of exchanges) {
    if (!ex.voice_session_id || !ex.context_version) continue;
    const matched = byKey.get(contextDeliveryKey(ex.project_id, ex.voice_session_id, ex.context_version));
    if (!matched || matched.length === 0) continue;
    deliveredExchangesWithContext++;
    for (const d of matched) {
      totalDeliveries++;
      totalIncludedSources += safeArrayLength(d.included_sources_json);
      totalDroppedSources += safeArrayLength(d.dropped_sources_json);
    }
  }
  return { deliveredExchangesWithContext, totalDeliveries, totalIncludedSources, totalDroppedSources };
}

// ── recovery state ───────────────────────────────────────────────────────────────────────────────

function computeRecoveryState(exchanges: AgentExchange[], events: ExchangeEvent[]): ExchangeRecoveryState {
  let interruptedEvents = 0, revertedMissingApprovalEvents = 0, retriedEvents = 0;
  for (const e of events) {
    if (e.event_type === "exchange_recovered") {
      const payload = parseJsonObject(e.payload_redacted_json);
      if (payload.disposition === "interrupted") interruptedEvents++;
      else if (payload.disposition === "reverted_missing_approval") revertedMissingApprovalEvents++;
    } else if (e.event_type === "retry_initiated") {
      retriedEvents++;
    }
  }
  const currentlyInterruptedExchanges = exchanges.filter((ex) => ex.state === "interrupted").length;
  return { interruptedEvents, revertedMissingApprovalEvents, retriedEvents, currentlyInterruptedExchanges };
}

// ── honest-null notes (mirrors contextMetricsReport's NOT_DERIVABLE_NOTE idiom) ─────────────────

export const UNCORRELATED_COMPLETIONS_NOTE =
  "uncorrelatedCompletions is null: ExchangeService.recordReportedOutcome (src/exchanges/service.ts) " +
  "logs an uncorrelated reported outcome via console.log ONLY — it appends no durable row or event " +
  "when a report's exchange_id does not match the pane's active marker — so this count is not " +
  "derivable from durable state today. Never faked; would need a durable 'uncorrelated_report' event " +
  "to make this measurable.";

export const NOTIFICATION_LATENCY_NOTE =
  "needsInputNotificationLatency / resultNotificationLatency are null: no durable event or row " +
  "records WHEN a narration/attention item was raised for an exchange (the attention table carries " +
  "no exchange_id correlation column) — only the underlying needs_input_detected / " +
  "agent_completion_reported / agent_failure_reported event timestamps are available (see " +
  "src/exchanges/replay.ts's terminalTransitions/resultSummaries for those), not the notification's " +
  "own timestamp.";

/**
 * Build the deterministic communication-quality metrics report (task B) from durable rows/events in
 * `[sinceMs, +inf)`. Deterministic: given the same rows, always returns the same JSON.
 */
export function buildExchangeMetricsReport(
  store: ExchangeMetricsSource,
  options: ExchangeMetricsReportOptions = {},
): ExchangeMetricsReport {
  const sinceMs = options.sinceMs ?? 0;
  const limit = options.limit ?? DEFAULT_QUERY_LIMIT;

  const exchanges = store.listExchangesSince(sinceMs, { limit });
  const events = store.listExchangeEventsSince(sinceMs, { limit });
  const byExchange = groupEventsByExchange(events);

  let deliveries: ContextDelivery[] = [];
  try {
    deliveries = store.getContextDeliveries?.({ since: sinceMs, limit }) ?? [];
  } catch {
    deliveries = [];
  }

  return {
    sinceMs,
    exchangeCount: exchanges.length,
    eventCount: events.length,
    wrongTargetDeliveries: countWrongTargetDeliveries(byExchange),
    duplicateDeliveries: countDuplicateDeliveries(byExchange),
    uncorrelatedCompletions: null,
    clarificationCauses: countClarificationCauses(events),
    draftEditCounts: countDraftEditsPerExchange(events),
    speechToDraftLatency: computeSpeechToDraftLatency(byExchange),
    deliveryLatency: computeDeliveryLatency(byExchange),
    needsInputNotificationLatency: null,
    resultNotificationLatency: null,
    contextCost: computeContextCost(exchanges, deliveries),
    recoveryState: computeRecoveryState(exchanges, events),
    notes: [UNCORRELATED_COMPLETIONS_NOTE, NOTIFICATION_LATENCY_NOTE],
  };
}
