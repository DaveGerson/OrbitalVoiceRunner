// src/exchanges/types.ts
//
// AgentExchange spine — STORAGE-LAYER types only (Phase 1, Step 1.2). Column-for-column with
// schema v12 (src/store/schema.ts) — see docs/superpowers/specs/2026-07-09-agent-exchange-spine.md
// for the full design contract (states, transitions, idempotency, correlation).
//
// This module is pure types + cheap deterministic ID minting, mirroring the placement of
// src/memory/contextTelemetry.ts (types + hashing helpers, no store I/O, no lifecycle logic).
// The actual state machine (legal-transition guard, ExchangeMachine, ExchangeService) is Phase 1
// Step 1.3 — src/exchanges/lifecycle.ts / src/exchanges/service.ts, which do NOT exist yet
// (tests/test_exchange_lifecycle.ts and tests/test_exchange_correlation.ts stay RED until then).

/** The 12 lifecycle states (spec §1.1). Terminal: agent_complete / agent_failed / cancelled.
 *  Semi-terminal: interrupted (its only outgoing edge is -> cancelled; never auto-resumed). */
export type ExchangeState =
  | "draft"
  | "awaiting_clarification"
  | "awaiting_approval"
  | "staged"
  | "delivered"
  | "running"
  | "needs_input"
  | "terminal_idle"
  | "agent_complete"
  | "agent_failed"
  | "interrupted"
  | "cancelled";

/** Where an exchange_events row originated (spec §1.4's "source" column). */
export type ExchangeEventSource = "voice" | "rest" | "ws" | "terminal" | "cortex" | "system";

/** Event types -> transitions (spec §1.4, normative table). */
export type ExchangeEventType =
  | "exchange_created"
  | "target_resolved"
  | "clarification_requested"
  | "draft_revised"
  | "approval_requested"
  | "approval_confirmed"
  | "delivery_attempted"
  | "delivery_succeeded"
  | "delivery_failed"
  | "terminal_running"
  | "terminal_quiescing"
  | "terminal_idle"
  | "needs_input_detected"
  | "agent_completion_reported"
  | "agent_failure_reported"
  | "exchange_cancelled"
  | "exchange_recovered"
  | "context_version_delivered";

/**
 * Row shape for `agent_exchanges` (schema v12). One durable record per operator communication:
 * draft -> target resolution -> approval -> delivery -> terminal observation -> result/interruption.
 * `approval_draft_version` is the one canonical-model deviation (spec §9.1): it exists so the §3
 * draft-version binding is a SQL CAS predicate, not a JSON-parsed check inside a transaction.
 */
export interface AgentExchange {
  exchange_id: string;
  project_id: string;
  pane_id: string;
  /** Ephemeral, re-bindable; NEVER a recovery correlation key (spec §4). */
  voice_session_id: string | null;
  interaction_id: string | null;
  /** Redacted at the boundary by the caller — this layer never redacts. */
  operator_utterance: string;
  /** RAW — replays verbatim, mirrors the pending_approvals.command rule. */
  distilled_instruction: string;
  /** Redacted JSON (dispatch_group_id, template refs, …). Raw string — callers parse/stringify. */
  instruction_envelope_json: string;
  draft_version: number;
  context_version: string | null;
  state: ExchangeState;
  approval_id: string | null;
  /** §3 binding: the draft_version an outstanding approval_id was bound to. */
  approval_draft_version: number | null;
  delivery_attempt: number;
  terminal_state: string | null;
  /** Redacted; the agent's REPORT, not a verification (spec §9.3). */
  result_summary: string | null;
  result_envelope_json: string | null;
  created_at: number;
  updated_at: number;
  delivered_at: number | null;
  completed_at: number | null;
}

/**
 * Row shape for `exchange_events` (schema v12). Append-only audit spine — the exchange row is the
 * mutable head, this table is the immutable timeline (mirrors the events/`handoff_id` precedent,
 * schema v2). `event_id` is the AUTOINCREMENT PK, so insertion order is always recoverable even
 * for same-millisecond bursts.
 */
export interface ExchangeEvent {
  event_id: number;
  exchange_id: string;
  project_id: string | null;
  pane_id: string | null;
  event_type: ExchangeEventType;
  /** Redacted JSON payload — callers redact before passing in (the audit-seam convention). */
  payload_redacted_json: string;
  source: ExchangeEventSource;
  interaction_id: string | null;
  ts: number;
}

/**
 * Row shape for `context_deliveries` (schema v12). One row per delivered context-brief version,
 * joining the v10 `context_injections` telemetry spine by `snapshot_hash`/`brief_hash`
 * (hashSnapshot/hashText, src/memory/contextTelemetry.ts) so both id families stay byte-compatible.
 */
export interface ContextDelivery {
  delivery_id: string;
  project_id: string | null;
  voice_session_id: string | null;
  context_version: string;
  /** ContextInjectionTrigger vocabulary (contextTelemetry.ts) — kept as a raw string here so this
   *  storage layer never depends on the memory module's trigger union. */
  trigger: string;
  snapshot_hash: string | null;
  brief_hash: string | null;
  included_sources_json: string;
  dropped_sources_json: string;
  acknowledged_at: number | null;
  ts: number;
}

// ── ID minting (spec §2, "ID minting") ──────────────────────────────────────────────────────────
// Mirrors the established idiom verbatim: `dispatch_<epoch36>_<seq36>` (src/dispatch/joinTracker.ts),
// `ixn_<epoch36>_<seq36>` (src/interactionLog.ts), `inj-<ts>-<seq>` (src/voice/index.ts),
// `ctxevt-<ts>-<seq>` (src/memory/contextTelemetry.ts). Module-scope monotonic counters keep both
// families cheap, collision-free, and sortable without a UUID dependency.

let exchangeSeq = 0;
/** Mint a fresh exchange id: `exch_<epoch36>_<seq36>` (spec §2, "ID minting"). */
export function mintExchangeId(now: number = Date.now()): string {
  return `exch_${now.toString(36)}_${(exchangeSeq++).toString(36)}`;
}

let contextDeliverySeq = 0;
/** Mint a fresh context-delivery id, mirroring the `ctxevt-<ts>-<seq>` shape (spec §2). */
export function mintContextDeliveryId(now: number = Date.now()): string {
  return `ctxdel-${now}-${++contextDeliverySeq}`;
}
