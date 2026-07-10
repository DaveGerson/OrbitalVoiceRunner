// src/exchanges/replay.ts — Phase 5, Step 5.2 (exchange replay).
//
// One exchange's full communication history, joined from every durable source the AgentExchange
// spine writes to, into a single ordered, redacted, JSON-serializable `ReplayTimeline`:
//   - the exchange row itself (redacted fields; free-text columns are already persist-redacted by
//     ExchangeService, this module re-redacts defensively — see the module-level note below)
//   - every `exchange_events` row (payload_redacted_json, parsed + defensively re-redacted)
//   - target resolutions / draft revisions / questions / terminal transitions / result summaries —
//     all bucketed VIEWS over the same event list (never a separate read)
//   - approval records durably stamped with this exchange_id (src/store/sqliteStore.ts
//     listPendingApprovalsByExchange) — present only while the row survives (deleted on resolve;
//     see that method's own doc comment)
//   - context-delivery/version records for the exchange's own (project, voice_session, context
//     version) — joined via the existing `listContextDeliveries` read
//   - a HASH of the delivered instruction (never the raw text — reuses the hashText idiom from
//     src/memory/contextTelemetry.ts, the same fingerprint family `context_deliveries` uses)
//
// REDACTION POSTURE: every free-text field that reaches `agent_exchanges`/`exchange_events` is
// ALREADY persist-redacted by the writer (ExchangeService.redactText, spec Phase 2 Step 2.4/2.5 —
// "deliver raw, persist redacted"). This module treats that as an assumption to defend, not a
// guarantee to trust blindly: every text field is re-redacted here too (`redactSecrets` is pure and
// idempotent, so a double-scrub is a no-op on already-clean text and a real scrub on anything that
// slipped through). The delivered instruction gets the strictest treatment of all: this module NEVER
// emits its text, redacted or not — only `hashText(distilled_instruction)` — so a replay consumer can
// correlate "was this the same instruction as that other exchange" without ever seeing the content.
//
// RETENTION DEGRADATION (task D): `exchange_events` is bounded, TTL-pruned retention (schema v12,
// src/store/retention.ts — default 30 days, same posture as action_log/cortex_decision). A replay
// for an old exchange may find some or all of its early events gone. This module never treats that
// as an error: `detectDegradation` below flags it (`degraded: true` + a `degradationNote`) and the
// timeline is built from whatever survives — a partial, honestly-labeled history beats either a
// crash or a silently-incomplete-looking one.
import type { AgentExchange, ContextDelivery, ExchangeEvent, ExchangeEventType } from "./types";
import type { StoredPendingApproval } from "../store/types";
import { redactSecrets } from "../terminal";
import { hashText } from "../memory/contextTelemetry";

/** Structural read surface this module needs — mirrors ContextMetricsSource's convention (a small
 *  interface, not a full JanusStore import) so a hand-built test double can satisfy it. `JanusStore`
 *  satisfies this directly. The two joins (`listContextDeliveries`, `listPendingApprovalsByExchange`)
 *  are OPTIONAL: their absence degrades that one section of the timeline to empty, never a throw —
 *  the same posture `ContextMetricsSource.getContextDeliveries` already established. */
export interface ReplaySource {
  getExchange(exchangeId: string): AgentExchange | null;
  listExchangeEvents(exchangeId: string): ExchangeEvent[];
  listContextDeliveries?(sessionId: string): ContextDelivery[];
  listPendingApprovalsByExchange?(exchangeId: string): StoredPendingApproval[];
}

export interface ExchangeCore {
  exchange: AgentExchange;
  events: ExchangeEvent[];
}

/**
 * The shared read: one exchange row + its ordered event timeline. `resumeInspectExchange`
 * (src/exchanges/recoveryActions.ts) and `buildReplayTimeline` below both start from exactly this
 * pair — this is the "share the joiner" seam the task asked for, factored out so neither module
 * re-implements the other's "does this exchange exist, and what's its history" read. `null` when the
 * exchange id does not exist.
 */
export function fetchExchangeCore(store: ReplaySource, exchangeId: string): ExchangeCore | null {
  const exchange = store.getExchange(exchangeId);
  if (!exchange) return null;
  return { exchange, events: store.listExchangeEvents(exchangeId) };
}

// ── redaction helpers (defense in depth over already-redacted-at-rest columns) ────────────────────

function safeRedact(s: string | null | undefined, redact: (s: string) => string): string | null {
  if (s == null || s === "") return null;
  try {
    return redact(s);
  } catch {
    return "[REDACTED:error]";
  }
}

/** Parse one event's JSON payload and defensively re-redact every string leaf. Every payload this
 *  spine writes is a small, flat object (`{reason}`, `{detail}`, `{approval_id, draft_version}`,
 *  `{disposition, reason, from_state}`, …) — a top-level scrub is sufficient; nested objects are not
 *  part of this spine's payload vocabulary today. Never throws: a malformed/foreign payload yields
 *  `{}` rather than surfacing a parse error to a replay consumer. */
function redactedPayload(json: string, redact: (s: string) => string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json || "{}");
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    out[k] = typeof v === "string" ? redact(v) : v;
  }
  return out;
}

/** Pull the first present free-text field off a redacted event payload, trying the field names this
 *  spine's various writers actually use (`clarification`/`detail`/`question`/`summary`, plus
 *  `cause` — the `clarification_requested` payload key `ExchangeService.recordClarificationRequested`
 *  writes and metrics.ts's countClarificationCauses reads; Phase 5.5 fix — replay used to render
 *  those events with `text: null`, silently dropping the cause) in priority order. `null` when none
 *  are present as non-empty strings — never fabricated. */
function pickText(payload: Record<string, unknown>): string | null {
  for (const key of ["clarification", "detail", "question", "summary", "cause"]) {
    const v = payload[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function safeArrayLength(json: string): number {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.length : 0;
  } catch {
    return 0;
  }
}

// ── the flat, redacted event entry every bucket view below reads from ──────────────────────────────

export interface ReplayEventEntry {
  eventId: number;
  ts: number;
  eventType: ExchangeEventType;
  source: string;
  payload: Record<string, unknown>;
}

function buildReplayEventEntries(events: ExchangeEvent[], redact: (s: string) => string): ReplayEventEntry[] {
  return events.map((e) => ({
    eventId: e.event_id,
    ts: e.ts,
    eventType: e.event_type,
    source: e.source,
    payload: redactedPayload(e.payload_redacted_json, redact),
  }));
}

// ── bucket views (pure filters over the same entry list — never a separate store read) ────────────

export interface ReplayTargetResolution {
  ts: number;
  paneId: string | null;
  projectId: string | null;
}
export interface ReplayDraftRevision {
  ts: number;
  supersededApprovalId: string | null;
}
export interface ReplayQuestion {
  ts: number;
  eventType: ExchangeEventType;
  text: string | null;
}
export interface ReplayTerminalTransition {
  ts: number;
  eventType: ExchangeEventType;
  detail: string | null;
}
export interface ReplayResultSummary {
  ts: number;
  eventType: ExchangeEventType;
  summary: string | null;
}

function bucketTargetResolutions(entries: ReplayEventEntry[]): ReplayTargetResolution[] {
  return entries
    .filter((e) => e.eventType === "target_resolved")
    .map((e) => ({
      ts: e.ts,
      paneId: typeof e.payload.paneId === "string" ? e.payload.paneId : null,
      projectId: typeof e.payload.projectId === "string" ? e.payload.projectId : null,
    }));
}

function bucketDraftRevisions(entries: ReplayEventEntry[]): ReplayDraftRevision[] {
  return entries
    .filter((e) => e.eventType === "draft_revised")
    .map((e) => ({
      ts: e.ts,
      supersededApprovalId: typeof e.payload.superseded_approval_id === "string" ? e.payload.superseded_approval_id : null,
    }));
}

const QUESTION_EVENT_TYPES: ReadonlySet<ExchangeEventType> = new Set(["clarification_requested", "needs_input_detected"]);

function bucketQuestions(entries: ReplayEventEntry[]): ReplayQuestion[] {
  return entries
    .filter((e) => QUESTION_EVENT_TYPES.has(e.eventType))
    .map((e) => ({ ts: e.ts, eventType: e.eventType, text: pickText(e.payload) }));
}

const TERMINAL_TRANSITION_EVENT_TYPES: ReadonlySet<ExchangeEventType> = new Set([
  "terminal_running", "terminal_quiescing", "terminal_idle",
  "delivery_attempted", "delivery_succeeded", "delivery_failed", "retry_initiated",
]);

function bucketTerminalTransitions(entries: ReplayEventEntry[]): ReplayTerminalTransition[] {
  return entries
    .filter((e) => TERMINAL_TRANSITION_EVENT_TYPES.has(e.eventType))
    .map((e) => ({ ts: e.ts, eventType: e.eventType, detail: pickText(e.payload) }));
}

const RESULT_SUMMARY_EVENT_TYPES: ReadonlySet<ExchangeEventType> = new Set([
  "agent_completion_reported", "agent_failure_reported",
]);

function bucketResultSummaries(entries: ReplayEventEntry[]): ReplayResultSummary[] {
  return entries
    .filter((e) => RESULT_SUMMARY_EVENT_TYPES.has(e.eventType))
    .map((e) => ({ ts: e.ts, eventType: e.eventType, summary: pickText(e.payload) }));
}

// ── approval records (durable, exchange_id-stamped `pending_approvals` rows) ────────────────────

export interface ReplayApprovalRecord {
  approvalId: string;
  kind: string;
  rationale: string | null;
  claimed: boolean;
  timestamp: number;
  expiresAt: number;
}

function buildApprovalRecords(
  store: ReplaySource,
  exchangeId: string,
  redact: (s: string) => string,
): ReplayApprovalRecord[] {
  let rows: StoredPendingApproval[] = [];
  try {
    rows = store.listPendingApprovalsByExchange?.(exchangeId) ?? [];
  } catch {
    rows = [];
  }
  return rows.map((r) => ({
    approvalId: r.id,
    kind: r.kind,
    rationale: safeRedact(r.rationale, redact),
    claimed: r.claimed,
    timestamp: r.timestamp,
    expiresAt: r.expires_at,
  }));
}

// ── context deliveries for this exchange's (project, session, context_version) ────────────────────

export interface ReplayContextDelivery {
  deliveryId: string;
  contextVersion: string;
  trigger: string;
  snapshotHash: string | null;
  briefHash: string | null;
  includedSourceCount: number;
  droppedSourceCount: number;
  acknowledgedAt: number | null;
  ts: number;
}

function buildContextDeliveries(store: ReplaySource, exchange: AgentExchange): ReplayContextDelivery[] {
  if (!exchange.voice_session_id || !exchange.context_version) return [];
  let all: ContextDelivery[] = [];
  try {
    all = store.listContextDeliveries?.(exchange.voice_session_id) ?? [];
  } catch {
    all = [];
  }
  return all
    .filter((d) => d.context_version === exchange.context_version)
    .map((d) => ({
      deliveryId: d.delivery_id,
      contextVersion: d.context_version,
      trigger: d.trigger,
      snapshotHash: d.snapshot_hash,
      briefHash: d.brief_hash,
      includedSourceCount: safeArrayLength(d.included_sources_json),
      droppedSourceCount: safeArrayLength(d.dropped_sources_json),
      acknowledgedAt: d.acknowledged_at,
      ts: d.ts,
    }));
}

// ── retention degradation (task D) ──────────────────────────────────────────────────────────────

/** Every real exchange's very first durable event is `exchange_created`, stamped at `created_at`
 *  (`ExchangeService.persistCreate`, unconditionally — the one event with no CAS predicate). Its
 *  absence (missing entirely, or present but not first/not ts-matched) means the earliest history
 *  was pruned (retention TTL) or was never mirrored (no store attached at creation time) — either
 *  way, "the timeline below starts mid-history", never silently presented as complete. */
function detectDegradation(exchange: AgentExchange, events: ExchangeEvent[]): { degraded: boolean; note: string | null } {
  if (events.length === 0) {
    return {
      degraded: true,
      note: "no exchange_events rows survive for this exchange (pruned by retention, or the spine had " +
        "no durable store attached at creation time) — only the durable exchange row itself is available.",
    };
  }
  const first = events[0];
  if (first.event_type !== "exchange_created" || first.ts !== exchange.created_at) {
    return {
      degraded: true,
      note: "the earliest exchange_events row(s) for this exchange are missing (retention pruned events " +
        "older than the TTL) — the timeline below starts mid-history, not at exchange creation.",
    };
  }
  return { degraded: false, note: null };
}

// ── the timeline itself ─────────────────────────────────────────────────────────────────────────

export interface ReplayExchangeSummary {
  projectId: string;
  paneId: string;
  state: string;
  draftVersion: number;
  contextVersion: string | null;
  createdAt: number;
  updatedAt: number;
  deliveredAt: number | null;
  completedAt: number | null;
  terminalState: string | null;
  resultSummary: string | null;
}

export interface ReplayTimeline {
  exchangeId: string;
  exchange: ReplayExchangeSummary;
  /** Hash of the delivered instruction (`hashText`, never the raw text — see module doc). `null`
   *  when the exchange has no distilled instruction at all (a bare draft, never composed). */
  deliveredInstructionHash: string | null;
  /** Hash of the redacted instruction-envelope JSON, for the same "correlate without exposing
   *  content" reason as `deliveredInstructionHash`. `null` for the schema default (`'{}'`, no
   *  envelope was ever attached to this exchange). */
  instructionEnvelopeHash: string | null;
  events: ReplayEventEntry[];
  targetResolutions: ReplayTargetResolution[];
  draftRevisions: ReplayDraftRevision[];
  questions: ReplayQuestion[];
  terminalTransitions: ReplayTerminalTransition[];
  resultSummaries: ReplayResultSummary[];
  approvals: ReplayApprovalRecord[];
  contextDeliveries: ReplayContextDelivery[];
  degraded: boolean;
  degradationNote: string | null;
}

export type ReplayResult = { found: true; timeline: ReplayTimeline } | { found: false };

function buildExchangeSummary(exchange: AgentExchange, redact: (s: string) => string): ReplayExchangeSummary {
  return {
    projectId: exchange.project_id,
    paneId: exchange.pane_id,
    state: exchange.state,
    draftVersion: exchange.draft_version,
    contextVersion: exchange.context_version,
    createdAt: exchange.created_at,
    updatedAt: exchange.updated_at,
    deliveredAt: exchange.delivered_at,
    completedAt: exchange.completed_at,
    terminalState: safeRedact(exchange.terminal_state, redact),
    resultSummary: safeRedact(exchange.result_summary, redact),
  };
}

/**
 * Build the full redacted replay timeline for one exchange (task A). Deterministic given the same
 * DB: no wall-clock, no randomness. Never throws — an unknown exchange id yields `{ found: false }`
 * (a clean, typed "not found", never an exception a REST/CLI caller has to catch).
 */
export function buildReplayTimeline(
  store: ReplaySource,
  exchangeId: string,
  opts?: { redact?: (s: string) => string },
): ReplayResult {
  const core = fetchExchangeCore(store, exchangeId);
  if (!core) return { found: false };
  const redact = opts?.redact ?? redactSecrets;
  const { exchange, events } = core;
  const entries = buildReplayEventEntries(events, redact);
  const degradation = detectDegradation(exchange, events);
  const envelopeJson = exchange.instruction_envelope_json;

  const timeline: ReplayTimeline = {
    exchangeId,
    exchange: buildExchangeSummary(exchange, redact),
    deliveredInstructionHash: exchange.distilled_instruction ? hashText(exchange.distilled_instruction) : null,
    instructionEnvelopeHash: envelopeJson && envelopeJson !== "{}" ? hashText(envelopeJson) : null,
    events: entries,
    targetResolutions: bucketTargetResolutions(entries),
    draftRevisions: bucketDraftRevisions(entries),
    questions: bucketQuestions(entries),
    terminalTransitions: bucketTerminalTransitions(entries),
    resultSummaries: bucketResultSummaries(entries),
    approvals: buildApprovalRecords(store, exchangeId, redact),
    contextDeliveries: buildContextDeliveries(store, exchange),
    degraded: degradation.degraded,
    degradationNote: degradation.note,
  };
  return { found: true, timeline };
}
