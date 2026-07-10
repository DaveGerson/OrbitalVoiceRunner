/**
 * src/actions/defs/observability.ts — REG1 group OBSERVABILITY (Wave D / PLM2 + PLM5).
 *
 * Two READ-ONLY tools, born multi-surface (voice + REST), that expose the durable action_log and a
 * one-glance health snapshot. UNGATED reads (handler-owned gate model; faithful = ungated), readOnly
 * so runAction re-redacts string leaves on egress. capability "read_notes" is the matrix row (not an
 * enforced gate). The REST twins are mounted from these `rest` bindings by mountRestRoutes.
 */
import { z } from "zod";
import type { ActionDef, ActionResult } from "../types";
import type { ShadowStats } from "../../approvalShadow";
import { buildReplayTimeline } from "../../exchanges/replay";
import { buildExchangeMetricsReport } from "../../exchanges/metrics";

/**
 * Inc 2 task 2.2 observability: derive the additive `shadow` health block from the optional ctx getter.
 * Takes the GETTER (not its result) so the optional-call (`getter?.()`) branch lives HERE, not in the
 * health handler (which would otherwise tip over the CC<=10 gate). null when no recorder/getter is wired
 * (daemon off / memoryPythonEnabled false / voice+test ctx that omits the getter). match_rate divides by
 * `compared` (= match + mismatch), NOT compared+missing — `missing` is daemon-down noise, not a TS/Python
 * disagreement (mirrors recent.error_rate's derivation). CC=3.
 */
function shadowHealth(getter?: () => ShadowStats | null) {
  const s = getter?.();
  if (!s) return null;
  return { compared: s.compared, match: s.match, mismatch: s.mismatch, missing: s.missing, match_rate: s.compared ? s.match / s.compared : 0 };
}

/**
 * Inc 2 task 2.3 observability: derive the additive `daemon` health block from the optional ctx getter.
 * Takes the GETTER (not its result) so the optional-call (`getter?.()`) branch lives HERE, not in the
 * health handler (which would otherwise tip over the CC<=10 gate — mirrors shadowHealth above exactly).
 * null when no tracker is wired (voice/test ctx that omits the getter). The stats it surfaces are the
 * cumulative, warm-up-immune degradation counters (the retire-gate metric), NOT the instantaneous state.
 */
function daemonHealth(getter?: () => { transitions: number; msInFallback: number; currentlyFallback: boolean } | null) {
  return getter?.() ?? null;
}

/**
 * Seam Inc 4 task B-4 observability: merge the cortex FLIP fall-to-floor rate ONTO the daemon block so
 * the plan path `health.memory.daemon.cortexFallbackRate` resolves. Takes both GETTERS (not their
 * results) so the optional-call branches live HERE, keeping the health handler under the CC<=10 gate
 * (mirrors daemonHealth / shadowHealth exactly). When the daemon block is null (no tracker wired) but
 * the cortex getter is present, surface a minimal `{ cortexFallbackRate }` so the metric is never lost.
 */
function daemonHealthWithCortex(
  daemonGetter?: () => { transitions: number; msInFallback: number; currentlyFallback: boolean } | null,
  cortexGetter?: () => { fallbackRate: number } | null,
) {
  const daemon = daemonHealth(daemonGetter);
  const cortex = cortexGetter?.();
  if (!cortex) return daemon;
  return { ...(daemon ?? {}), cortexFallbackRate: cortex.fallbackRate };
}

// z.coerce.number so a REST query string ("?limit=50") coerces to a number; voice passes real numbers.
const ActionLogParams = z.object({
  limit: z.coerce.number().optional(),
  name: z.string().optional(),
  since: z.coerce.number().optional(),
});

export const getActionLog: ActionDef<typeof ActionLogParams> = {
  name: "get_action_log",
  description:
    "Read the unified action log: recent runAction invocations (name, capability, result kind, elapsed ms, surface), most-recent-first. Optional filters: limit (default 100), name (one action), since (epoch ms). Observability/audit read — answer 'what did you just do?' or diagnose a failure. Returns an empty list when no durable store is wired.",
  params: ActionLogParams,
  capability: "read_notes",
  readOnly: true,
  surfaces: new Set(["voice", "rest"]),
  rest: { method: "get", path: "/api/action-log" },
  handler: (args, ctx): ActionResult => {
    if (!ctx.store) return { kind: "ok", output: { rows: [], note: "no durable store wired" } };
    const rows = ctx.store.getActionLog({
      limit: typeof args.limit === "number" ? args.limit : undefined,
      name: args.name || undefined,
      since: typeof args.since === "number" ? args.since : undefined,
    });
    return { kind: "ok", output: { rows } };
  },
};

const HealthParams = z.object({});

export const getHealth: ActionDef<typeof HealthParams> = {
  name: "get_health",
  description:
    "Report a one-glance health snapshot: live pane counts (total/running/idle/exited), pending approvals, frozen (emergency-brake) state, and the recent action error-rate (from the action log). Cheap status read — answer 'are we healthy?' / 'what's the state right now?'.",
  params: HealthParams,
  capability: "read_notes",
  readOnly: true,
  surfaces: new Set(["voice", "rest"]),
  rest: { method: "get", path: "/api/health" },
  handler: (_args, ctx): ActionResult => {
    const terms = Object.values(ctx.manager.terminals) as Array<{ status?: string }>;
    const panes = { total: terms.length, running: 0, idle: 0, exited: 0 };
    for (const t of terms) {
      const s = String(t.status || "").toLowerCase();
      if (s === "running") panes.running++;
      else if (s === "exited") panes.exited++;
      else panes.idle++;
    }
    // pending approvals are session-scoped; on the REST surface (session null) report 0 rather than throw.
    const pendingApprovals = ctx.session ? ctx.pendingApprovals.forSession(ctx.session).length : 0;
    let recentTotal = 0, recentErrors = 0;
    if (ctx.store) {
      const rows = ctx.store.getActionLog({ limit: 100 });
      recentTotal = rows.length;
      recentErrors = rows.filter((r) => r.result_kind === "error").length;
    }
    return {
      kind: "ok",
      output: {
        frozen: ctx.isFrozen(),
        panes,
        pending_approvals: pendingApprovals,
        recent: { total: recentTotal, errors: recentErrors, error_rate: recentTotal ? recentErrors / recentTotal : 0 },
        memory: { synthesizer: ctx.memorySynthesizerState?.() ?? "fallback", shadow: shadowHealth(ctx.approvalShadowStats), daemon: daemonHealthWithCortex(ctx.daemonStateStats, ctx.cortexFallbackStats) },
      },
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5, Step 5.2 — exchange REPLAY + METRICS (communication-quality observability). Both are
// pure, deterministic reads over the AgentExchange spine's durable rows/events
// (src/exchanges/replay.ts / src/exchanges/metrics.ts do ALL the actual joining/math); these two
// defs are thin REST wrappers, mirroring get_action_log/get_health's own posture (UNGATED reads,
// readOnly so runAction re-redacts string leaves on egress — belt-and-suspenders on top of both
// modules' own defensive re-redaction). REST-ONLY (not voice): the task brief scoped this pass to
// "REST + CLI surfaces" for an audit/observability drill-down, and both outputs (a full timeline,
// a many-field metrics report) are read/inspected, not spoken — matching get_project_export's own
// rest-only precedent (see tests/test_live_harness.ts's golden voice-tool-count comment, which this
// module deliberately does NOT bump).
// ─────────────────────────────────────────────────────────────────────────────

const ReplayExchangeParams = z.object({ exchange_id: z.string() });

export const replayExchange: ActionDef<typeof ReplayExchangeParams> = {
  name: "replay_exchange",
  description:
    "Replay one exchange's full redacted communication timeline: state, ordered events, target " +
    "resolutions, draft revisions, questions, terminal transitions, result summaries, approval " +
    "records, context deliveries, and a hash of the delivered instruction (never the raw text). " +
    "Degrades gracefully (a 'degraded' flag + note) when exchange_events were pruned by retention.",
  params: ReplayExchangeParams,
  capability: "read_notes",
  readOnly: true,
  surfaces: new Set(["rest"]),
  rest: { method: "get", path: "/api/exchanges/:exchange_id/replay" },
  handler: (args, ctx): ActionResult => {
    if (!ctx.store) return { kind: "ok", output: { found: false, note: "no durable store wired" } };
    return { kind: "ok", output: buildReplayTimeline(ctx.store, args.exchange_id) };
  },
};

// z.coerce.number so a REST query string ("?since_ms=..&limit=..") coerces to a number; voice
// passes real numbers. Mirrors ActionLogParams's own coercion idiom above.
const ExchangeMetricsParams = z.object({
  since_ms: z.coerce.number().optional(),
  limit: z.coerce.number().optional(),
});

export const getExchangeMetrics: ActionDef<typeof ExchangeMetricsParams> = {
  name: "get_exchange_metrics",
  description:
    "Deterministic communication-quality metrics over the AgentExchange spine for a window " +
    "(since_ms epoch ms, default 0 = all time; optional row limit): wrong-target/duplicate " +
    "deliveries, clarification causes, draft-edit counts, speech-to-draft and delivery latency " +
    "percentiles (p50/p95), context-delivery cost, and recovery-state counts.",
  params: ExchangeMetricsParams,
  capability: "read_notes",
  readOnly: true,
  surfaces: new Set(["rest"]),
  rest: { method: "get", path: "/api/exchange-metrics" },
  handler: (args, ctx): ActionResult => {
    if (!ctx.store) return { kind: "ok", output: { note: "no durable store wired" } };
    return {
      kind: "ok",
      output: buildExchangeMetricsReport(ctx.store, { sinceMs: args.since_ms, limit: args.limit }),
    };
  },
};

/** The OBSERVABILITY group registry slice (Wave D + Phase 5.2). */
export const OBSERVABILITY_ACTIONS: ActionDef[] = [getActionLog, getHealth, replayExchange, getExchangeMetrics];
