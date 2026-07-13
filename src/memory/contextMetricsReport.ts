// src/memory/contextMetricsReport.ts
// Cortex context-injection metrics report — Phase C (spec 2026-07-02-cortex-context-telemetry.md
// §10, §11, §18.6). Pure aggregation over the schema-v10 `context_injections` table (written by
// src/voice/index.ts's injectMemoryBrief, see src/memory/contextTelemetry.ts). NO store I/O of its
// own beyond one bounded read call, NO wall-clock in the output (same DB in -> same JSON out), and
// NO network/process side effects — this module is unit-testable against a seeded in-memory store.
//
// Read surface is deliberately narrow: `context_injections` (this PR's table). The v9 spine
// (`cortex_decision`, `gemini_turn_usage`) joins on `inject_id` for future deeper metrics, but this
// first report does not need it — every field below is derivable from `context_injections` alone.
// Metrics the doc's §11 shape wants that are NOT derivable from that one table (durable pane
// duplication lives in the separate pre-existing `panes` table; wrong-pane-write refusals and
// approval exactly-once success are tracked by the gating/approvals subsystem, not this telemetry
// table) are emitted as `null` with an explanatory `notes[]` entry — never faked.

import type { ContextInjectionDisposition, ContextInjectionEvent } from "./contextTelemetry";
import type { ContextDelivery } from "../exchanges/types";

/** Structural read surface this report needs. `JanusStore.getContextInjections` satisfies this
 *  directly; tests may pass a lighter fake with the same method. `getContextDeliveries` (Phase 2
 *  Step 2.2) is OPTIONAL so a pre-existing fake store that only ever implemented
 *  `getContextInjections` still satisfies this interface unchanged — its absence degrades the new
 *  delivery/acknowledgment/version-advance stats to their empty-set values (never a throw). */
export interface ContextMetricsSource {
  getContextInjections(filter?: { since?: number; sessionId?: string; limit?: number }): ContextInjectionEvent[];
  getContextDeliveries?(filter?: { since?: number; limit?: number }): ContextDelivery[];
}

/** Configurable price table (spec §6.4) — do not hard-code provider assumptions in logic. Defaults
 *  are a DELIBERATELY CONSERVATIVE (i.e. higher than typical list price) placeholder for a
 *  Flash-tier text-input rate, meant for trend/cost-COMPARISON, not billing reconciliation. Override
 *  via `ContextMetricsReportOptions.costConfig` or the CLI's price flags. */
export interface ContextCostConfig {
  textInputUsdPer1M: number;
  audioInputUsdPerMinute?: number;
  audioOutputUsdPerMinute?: number;
}

export const DEFAULT_CONTEXT_COST_CONFIG: ContextCostConfig = {
  textInputUsdPer1M: 0.5,
};

/** Query cap for the underlying store read — large enough to be "effectively all rows" for any
 *  smoke-journey or single-day operator DB, while still bounding memory on a pathological input. */
const DEFAULT_QUERY_LIMIT = 1_000_000;

export interface ContextMetricsReportOptions {
  /** Only rows with ts >= sinceMs are included. Default 0 (all time). NOT a wall-clock read here —
   *  the caller supplies it (CLI: --since-ms, or a test's own fixed `bootTs`). */
  sinceMs?: number;
  /** Max rows the underlying store read may return. Default DEFAULT_QUERY_LIMIT. */
  limit?: number;
  /** Partial override merged onto DEFAULT_CONTEXT_COST_CONFIG. */
  costConfig?: Partial<ContextCostConfig>;
}

export interface ContextMetricsReport {
  sinceMs: number;
  rowCount: number;
  /** Distinct non-null `session_id` values seen. As of this PR the live choke point always records
   *  `session_id: null` (no per-connection session id concept exists yet — see notes[]), so this is
   *  commonly 0; the field is kept for forward compatibility once a session id is threaded through. */
  sessions: number;
  contextInjectionCount: number;
  injectionsByTrigger: Record<string, number>;
  skippedCount: number;
  skippedByDisposition: Record<string, number>;
  briefHashRepeatRate: number;
  estimatedInputTokens: number;
  estimatedTextInputCostUsd: number;
  focusCorrectnessRate: number | null;
  durableDuplicatePaneCount: number | null;
  wrongPaneRefusals: number | null;
  approvalExactlyOnceSuccessRate: number | null;
  /** Wave 4 (D6, docs/superpowers/specs/2026-07-02-cortex-cutover-design.md): the fraction of the
   *  INJECTED SET (disposition "injected" OR "cortex-miss" — see injectedSetNote below) whose
   *  `source` is "cortex-primary". Null when the injected set is empty ("primacy of zero
   *  injections" is undefined, same convention as focusCorrectnessRate). */
  cortexPrimaryRate: number | null;
  /** Wave 4 (D6): the fraction of the injected set whose disposition is "cortex-miss" — an
   *  injected-at-the-floor brief because primary mode's cortex.decide missed (timeout/error/
   *  off-schema/daemon dead). Null when the injected set is empty. Post-land health check target
   *  (spec D5): <1% on a warm daemon. */
  cortexFallbackRate: number | null;
  /** Phase 2 Step 2.2: total `context_deliveries` rows in the window (one per actual
   *  sendClientContent delivery ATTEMPT — a gate skip/stale/empty brief never reaches this table
   *  at all, so this is strictly a subset of contextInjectionCount's universe, not equal to it). */
  contextDeliveryCount: number;
  /** Phase 2 Step 2.2: of those, how many were ACKNOWLEDGED (send succeeded) vs left hanging (send
   *  threw, or the process died between record and ack — the "uncertain delivery" signature). */
  contextDeliveryAcknowledgedCount: number;
  contextDeliveryUnacknowledgedCount: number;
  /** Phase 2 Step 2.2: per-(project,session) version-advance stats over the window — how far the
   *  context_version counter climbed for each pair that had at least one delivery. Null when the
   *  window has zero delivery rows (same "undefined, not zero" convention as focusCorrectnessRate). */
  contextVersionAdvanceStats: {
    pairs: number;
    maxVersionSeen: number;
    averageVersionsPerPair: number;
  } | null;
  notes: string[];
}

/** Count rows per trigger value. Unknown/future trigger strings (spec §18.2 keeps unused values in
 *  the type union) are counted under their own literal key rather than dropped or throwing. */
function countByTrigger(rows: ContextInjectionEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.trigger] = (out[r.trigger] ?? 0) + 1;
  return out;
}

/** Wave 4 (D6): a row counts as "the operator got a brief" when its disposition is "injected" OR
 *  "cortex-miss" (an injected-at-the-floor brief — see ContextInjectionDisposition's Wave 4 doc
 *  comment in ./contextTelemetry). Every downstream metric that used to range over "injected" rows
 *  only (tokens, cost, focus correctness, count) now ranges over this wider injected SET. */
function isInjectedSetMember(r: ContextInjectionEvent): boolean {
  return r.disposition === "injected" || r.disposition === ("cortex-miss" satisfies ContextInjectionDisposition);
}

/** Count non-injected-set rows per disposition (everything the operator did NOT get a brief for —
 *  including the D2 inject-gate's own "unchanged-brief"/"debounce" skips, recorded before any
 *  Python round-trip). */
function countSkippedByDisposition(rows: ContextInjectionEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (isInjectedSetMember(r)) continue;
    out[r.disposition] = (out[r.disposition] ?? 0) + 1;
  }
  return out;
}

/** Fraction of hashed rows whose brief_hash was seen more than once in the window. Order-independent
 *  (repeats = total - distinctCount), so it does not depend on the store's row ordering. */
function computeBriefHashRepeatRate(rows: ContextInjectionEvent[]): number {
  const counts = new Map<string, number>();
  let total = 0;
  for (const r of rows) {
    if (!r.brief_hash) continue;
    total++;
    counts.set(r.brief_hash, (counts.get(r.brief_hash) ?? 0) + 1);
  }
  if (total === 0) return 0;
  return (total - counts.size) / total;
}

/** Among the INJECTED SET only (rows where a brief actually reached Gemini — "injected" or the
 *  Wave 4 "cortex-miss" floor-injected variant), the fraction whose active_pane_id matches the
 *  pane the synthesized brief was actually for. Null when the set is empty — "correctness of zero
 *  injections" is undefined, not 1 or 0. */
function computeFocusCorrectnessRate(injectedSet: ContextInjectionEvent[]): number | null {
  if (injectedSet.length === 0) return null;
  const correct = injectedSet.filter((r) => r.active_pane_id === r.brief_active_pane_id).length;
  return correct / injectedSet.length;
}

/** Sum of estimated_tokens across the INJECTED SET only — skipped/failed attempts never reached
 *  Gemini, so they carry no input-token cost regardless of how big the assembled brief was. */
function sumEstimatedInputTokens(injectedSet: ContextInjectionEvent[]): number {
  return injectedSet.reduce((sum, r) => sum + (r.estimated_tokens || 0), 0);
}

/** Wave 4 (D6): fraction of the injected set curated by the cortex (source === "cortex-primary").
 *  Null when the injected set is empty. */
function computeCortexPrimaryRate(injectedSet: ContextInjectionEvent[]): number | null {
  if (injectedSet.length === 0) return null;
  const primary = injectedSet.filter((r) => r.source === "cortex-primary").length;
  return primary / injectedSet.length;
}

/** Wave 4 (D6): fraction of the injected set that fell to the floor (disposition "cortex-miss").
 *  Null when the injected set is empty. Post-land health check target (spec D5): <1% on a warm
 *  daemon. */
function computeCortexFallbackRate(injectedSet: ContextInjectionEvent[]): number | null {
  if (injectedSet.length === 0) return null;
  const missed = injectedSet.filter((r) => r.disposition === ("cortex-miss" satisfies ContextInjectionDisposition)).length;
  return missed / injectedSet.length;
}

function countDistinctSessions(rows: ContextInjectionEvent[]): number {
  const s = new Set<string>();
  for (const r of rows) if (r.session_id) s.add(r.session_id);
  return s.size;
}

/** Phase 2 Step 2.2: acknowledged vs unacknowledged counts over the delivery rows in the window.
 *  A row's `acknowledged_at` is non-null iff `ContextVersionRegistry.acknowledgeDelivery` actually
 *  ran for it (i.e. sendClientContent succeeded) — see src/memory/contextVersions.ts. */
function computeDeliveryAckCounts(deliveries: ContextDelivery[]): { acknowledged: number; unacknowledged: number } {
  let acknowledged = 0;
  for (const d of deliveries) if (d.acknowledged_at != null) acknowledged++;
  return { acknowledged, unacknowledged: deliveries.length - acknowledged };
}

/** Phase 2 Step 2.2: per-(project_id, voice_session_id) highest context_version reached in the
 *  window, aggregated into pair count / max / average. Non-numeric context_version strings are
 *  ignored (defensive — the registry always mints stringified integers, but this report must never
 *  throw on a malformed row). Null when there are no deliveries at all (undefined, not zero). */
function computeVersionAdvanceStats(deliveries: ContextDelivery[]): ContextMetricsReport["contextVersionAdvanceStats"] {
  if (deliveries.length === 0) return null;
  const maxByPair = new Map<string, number>();
  for (const d of deliveries) {
    const n = Number(d.context_version);
    if (!Number.isFinite(n)) continue;
    const key = `${d.project_id ?? ""}::${d.voice_session_id ?? ""}`;
    const cur = maxByPair.get(key) ?? 0;
    if (n > cur) maxByPair.set(key, n);
  }
  if (maxByPair.size === 0) return null;
  const values = [...maxByPair.values()];
  return {
    pairs: maxByPair.size,
    maxVersionSeen: Math.max(...values),
    averageVersionsPerPair: values.reduce((a, b) => a + b, 0) / values.length,
  };
}

export const NOT_DERIVABLE_NOTE =
  "durableDuplicatePaneCount, wrongPaneRefusals, and approvalExactlyOnceSuccessRate are null: " +
  "this report's read surface is context_injections only, and none of the three is recorded there. " +
  "Durable pane identity lives in the store's panes table (PRIMARY KEY (pane_id, workspace_id) " +
  "prevents duplication by construction — behavioral coverage: tests/test_memory_refocus.ts). " +
  "Wrong-pane-write refusal is a gating-layer decision, not a context-injection event (coverage: " +
  "tests/test_memory_injector_guard.ts). Approval exactly-once is tracked by the approvals subsystem " +
  "(coverage: tests/test_approval_dupsend.ts, tests/test_pendingApprovals_durable.ts). None are faked here.";

export const DEDUPE_NOTE =
  "Dedupe is metric-only in this PR; repeated brief hashes are expected baseline observations, not a bug.";

export const SESSION_ID_NOTE =
  "sessions reflects only rows with a non-null session_id. Phase 2 Step 2.2: the live " +
  "injectMemoryBrief choke point now stamps each connection's real voice_session_id (mintVoiceSessionId, " +
  "src/voice/index.ts) on every context_injections/cortex_decision/gemini_turn_usage row it writes, so " +
  "this is non-zero whenever at least one live voice connection has produced rows in the window. A row " +
  "with session_id=null means it was written by a path with no live connection in scope (a REST-only " +
  "caller, or a hand-seeded test fixture), not a gap in the choke point's own instrumentation.";

/** Build the spec-§11-shaped metrics report from `context_injections` rows in `[sinceMs, +inf)`.
 *  Deterministic: given the same rows, always returns the same JSON (no Date.now(), no randomness). */
export function buildContextMetricsReport(
  store: ContextMetricsSource,
  options: ContextMetricsReportOptions = {}
): ContextMetricsReport {
  const sinceMs = options.sinceMs ?? 0;
  const limit = options.limit ?? DEFAULT_QUERY_LIMIT;
  const costConfig: ContextCostConfig = { ...DEFAULT_CONTEXT_COST_CONFIG, ...options.costConfig };

  const rows = store.getContextInjections({ since: sinceMs, limit });
  // Wave 4 (D6): the injected SET — "injected" plus the floor-injected "cortex-miss" variant. Every
  // metric below that used to range over "injected" rows only now ranges over this wider set (see
  // isInjectedSetMember's doc comment).
  const injectedSet = rows.filter(isInjectedSetMember);

  const estimatedInputTokens = sumEstimatedInputTokens(injectedSet);
  const skippedByDisposition = countSkippedByDisposition(rows);
  const skippedCount = Object.values(skippedByDisposition).reduce((a, b) => a + b, 0);

  // Phase 2 Step 2.2: the context_deliveries read surface is optional (see ContextMetricsSource's
  // doc comment) — an absent method or a store read fault degrades to "no deliveries observed",
  // never a throw.
  let deliveries: ContextDelivery[] = [];
  try {
    deliveries = store.getContextDeliveries?.({ since: sinceMs, limit }) ?? [];
  } catch {
    deliveries = [];
  }
  const deliveryAckCounts = computeDeliveryAckCounts(deliveries);

  return {
    sinceMs,
    rowCount: rows.length,
    sessions: countDistinctSessions(rows),
    contextInjectionCount: injectedSet.length,
    injectionsByTrigger: countByTrigger(rows),
    skippedCount,
    skippedByDisposition,
    briefHashRepeatRate: computeBriefHashRepeatRate(rows),
    estimatedInputTokens,
    estimatedTextInputCostUsd: (estimatedInputTokens / 1_000_000) * costConfig.textInputUsdPer1M,
    focusCorrectnessRate: computeFocusCorrectnessRate(injectedSet),
    durableDuplicatePaneCount: null,
    wrongPaneRefusals: null,
    approvalExactlyOnceSuccessRate: null,
    cortexPrimaryRate: computeCortexPrimaryRate(injectedSet),
    cortexFallbackRate: computeCortexFallbackRate(injectedSet),
    contextDeliveryCount: deliveries.length,
    contextDeliveryAcknowledgedCount: deliveryAckCounts.acknowledged,
    contextDeliveryUnacknowledgedCount: deliveryAckCounts.unacknowledged,
    contextVersionAdvanceStats: computeVersionAdvanceStats(deliveries),
    notes: [DEDUPE_NOTE, SESSION_ID_NOTE, NOT_DERIVABLE_NOTE],
  };
}
