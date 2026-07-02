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

/** Structural read surface this report needs. `JanusStore.getContextInjections` satisfies this
 *  directly; tests may pass a lighter fake with the same method. */
export interface ContextMetricsSource {
  getContextInjections(filter?: { since?: number; sessionId?: string; limit?: number }): ContextInjectionEvent[];
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
  notes: string[];
}

/** Count rows per trigger value. Unknown/future trigger strings (spec §18.2 keeps unused values in
 *  the type union) are counted under their own literal key rather than dropped or throwing. */
function countByTrigger(rows: ContextInjectionEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.trigger] = (out[r.trigger] ?? 0) + 1;
  return out;
}

/** Count non-"injected" rows per disposition. */
function countSkippedByDisposition(rows: ContextInjectionEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (r.disposition === "injected") continue;
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

/** Among INJECTED rows only (the only rows where a brief was actually sent), the fraction whose
 *  active_pane_id matches the pane the synthesized brief was actually for. Null when there are no
 *  injected rows in the window — "correctness of zero injections" is undefined, not 1 or 0. */
function computeFocusCorrectnessRate(injected: ContextInjectionEvent[]): number | null {
  if (injected.length === 0) return null;
  const correct = injected.filter((r) => r.active_pane_id === r.brief_active_pane_id).length;
  return correct / injected.length;
}

/** Sum of estimated_tokens across INJECTED rows only — skipped/failed attempts never reached
 *  Gemini, so they carry no input-token cost regardless of how big the assembled brief was. */
function sumEstimatedInputTokens(injected: ContextInjectionEvent[]): number {
  return injected.reduce((sum, r) => sum + (r.estimated_tokens || 0), 0);
}

function countDistinctSessions(rows: ContextInjectionEvent[]): number {
  const s = new Set<string>();
  for (const r of rows) if (r.session_id) s.add(r.session_id);
  return s.size;
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
  "sessions reflects only rows with a non-null session_id. The live injectMemoryBrief choke point " +
  "does not yet stamp a per-connection session id (matches captureTurnUsage's own null), so this is " +
  "commonly 0 today even with many injections.";

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
  const injected = rows.filter((r) => r.disposition === ("injected" satisfies ContextInjectionDisposition));

  const estimatedInputTokens = sumEstimatedInputTokens(injected);
  const skippedByDisposition = countSkippedByDisposition(rows);
  const skippedCount = Object.values(skippedByDisposition).reduce((a, b) => a + b, 0);

  return {
    sinceMs,
    rowCount: rows.length,
    sessions: countDistinctSessions(rows),
    contextInjectionCount: injected.length,
    injectionsByTrigger: countByTrigger(rows),
    skippedCount,
    skippedByDisposition,
    briefHashRepeatRate: computeBriefHashRepeatRate(rows),
    estimatedInputTokens,
    estimatedTextInputCostUsd: (estimatedInputTokens / 1_000_000) * costConfig.textInputUsdPer1M,
    focusCorrectnessRate: computeFocusCorrectnessRate(injected),
    durableDuplicatePaneCount: null,
    wrongPaneRefusals: null,
    approvalExactlyOnceSuccessRate: null,
    notes: [DEDUPE_NOTE, SESSION_ID_NOTE, NOT_DERIVABLE_NOTE],
  };
}
