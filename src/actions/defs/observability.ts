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
        memory: { synthesizer: ctx.memorySynthesizerState?.() ?? "fallback" },
      },
    };
  },
};

/** The OBSERVABILITY group registry slice (Wave D). */
export const OBSERVABILITY_ACTIONS: ActionDef[] = [getActionLog, getHealth];
