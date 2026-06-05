/**
 * src/actions/defs/watch_rules.ts — c55 Batch G (wsm-e2e-pinned-c55.7).
 *
 * Four NEW rest-only ActionDefs that converge inline watch-rule / plan-delete routes which have NO
 * voice twin today. surfaces = {'rest'} ONLY (so they never force a Gemini voice-tool description),
 * and each replicates its inline server.ts route logic FAITHFULLY. The UI clients read only res.ok
 * (writes) or setWatchRules()/the plan board (reads) and repaint off the watch_rules_updated /
 * plans_updated WS frames the handlers fan out.
 *
 * Routes converged (the inline app.* twins are deleted in the SAME change — never both, or Express
 * keeps the first-registered handler and silently masks the cutover):
 *   - list_watch_rules         GET    /api/watch-rules        (server.ts ~919)
 *   - add_watch_rule           POST   /api/watch-rules        (server.ts ~923)
 *   - remove_watch_rule        DELETE /api/watch-rules/:id     (server.ts ~944)
 *   - delete_orchestrator_plan DELETE /api/plans/:id           (server.ts ~1001)
 *
 * GATING / SAFE DEFAULTS (Decision 3 + the c55 safe-default policy — preserve current behavior):
 *   - list_watch_rules: a READ. ALWAYS_ALLOWED, readOnly:false — the inline route returned the RAW,
 *     UN-redacted array; the registry's readOnly-redaction would scrub string leaves and also requires a
 *     read_* capability (§8.1), so we keep it ungated/unredacted to stay byte-identical to the legacy body.
 *   - add_watch_rule: the inline route was UNGATED — creation was instant. The `add_watch_rule` capability
 *     LABEL exists in the matrix (default Ask) but is RESERVED for a future voice tool (Decision 8). To
 *     PRESERVE the current instant behavior we register ALWAYS_ALLOWED (recorded in appliedDefaults: the
 *     matrix could later tighten this to Ask + expose a voice yes/no — DEFERRED for ratification).
 *   - remove_watch_rule: NO capability exists -> ALWAYS_ALLOWED to preserve the ungated behavior (a
 *     dedicated gate row + voice exposure are DEFERRED).
 *   - delete_orchestrator_plan: NO twin/capability -> ALWAYS_ALLOWED, rest-only (gate row + voice DEFERRED).
 *
 * STATUS-CODE DELTAS (Decision 2 — the client ignores the body / does not status-branch on these):
 *   - inline 404 "Rule not found." (remove_watch_rule) -> 200 ok-narration.
 *   - inline 404 "Plan not found." (delete_orchestrator_plan) -> 200 ok-narration.
 *   - inline 400 "Missing required rule parameters." (add_watch_rule) -> zod-500 error (a valid client
 *     always sends the full body; the zod-required fields replace the manual presence check).
 */

import { z } from "zod";
import type { ActionDef, ActionResult } from "../types";
import type { WatchRule } from "../../types";

// ─────────────────────────────────────────────────────────────────────────────
// list_watch_rules — GET /api/watch-rules (readOnly READ; toHttp -> raw array).
// ─────────────────────────────────────────────────────────────────────────────

const ListWatchRulesParams = z.object({});

/**
 * list_watch_rules — FAITHFUL PORT of inline app.get("/api/watch-rules") (server.ts ~919):
 * `res.json(manager.ledger.watchRules)`. The structured WatchRule[] array the flat {output:string}
 * cannot carry rides the Batch-E rest.toHttp primitive, emitted TOP-LEVEL (NOT wrapped in {output}) —
 * byte-identical to the legacy body the client's setWatchRules() consumes on initial load.
 *
 * readOnly:false — the inline route returned the RAW array with no redaction; keeping readOnly:false
 * preserves that exactly (and lets the def stay ALWAYS_ALLOWED — the §8.1 readOnly invariant requires a
 * read_* capability, which would be a behavior change). The handler stuffs the array into result.output
 * (typed unknown) and toHttp re-projects it verbatim.
 */
export const listWatchRules: ActionDef<typeof ListWatchRulesParams> = {
  name: "list_watch_rules",
  description: "List all configured watch-automation rules. REST/UI surface only.",
  params: ListWatchRulesParams,
  capability: "ALWAYS_ALLOWED",
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: {
    method: "get",
    path: "/api/watch-rules",
    // The REST body is the RAW WatchRule[] array TOP-LEVEL (the shape setWatchRules() consumes), NOT the
    // default {output} wrapper. The handler already put that array into result.output, so re-project it.
    toHttp: (result): { status: number; body: unknown } => ({
      status: 200,
      body: result.kind === "ok" ? result.output : [],
    }),
  },
  handler: (_args, ctx): ActionResult => {
    return { kind: "ok", output: ctx.manager.ledger.watchRules };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// add_watch_rule — POST /api/watch-rules (ALWAYS_ALLOWED; was ungated/instant).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * add_watch_rule body params (the inline route reads these camelCase keys directly off req.body). They
 * already match the WatchRule field names, so no coerceArgs is needed. triggerTransition is the
 * WatchRule union; oneShot is OPTIONAL (the inline route defaulted it to true when undefined).
 */
const AddWatchRuleParams = z.object({
  triggerTerminalId: z.string(),
  triggerTransition: z.enum(["idle", "prompt", "error", "build-failed", "exited"]),
  actionTerminalId: z.string(),
  actionCommand: z.string(),
  oneShot: z.boolean().optional(),
});

/**
 * add_watch_rule — FAITHFUL PORT of inline app.post("/api/watch-rules") (server.ts ~923): build a new
 * rule (generated id, enabled:true, oneShot defaulting to true when omitted), push it onto the ledger,
 * force-persist, and broadcast watch_rules_updated with the CURRENT list. SAFE DEFAULT ALWAYS_ALLOWED
 * (was ungated — creation stays instant; the add_watch_rule matrix row stays reserved). The inline
 * presence-check 400 is replaced by the zod-required fields (a missing field -> 500). The {created.id …}
 * detail rides in the ok output; the client only needs res.ok and repaints off the WS frame.
 */
export const addWatchRule: ActionDef<typeof AddWatchRuleParams> = {
  name: "add_watch_rule",
  description: "Create a watch-automation rule that fires a command on another pane when a trigger pane transitions. REST/UI surface only.",
  params: AddWatchRuleParams,
  capability: "ALWAYS_ALLOWED",
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: { method: "post", path: "/api/watch-rules" },
  handler: (args, ctx): ActionResult => {
    const newRule: WatchRule = {
      id: "rule_" + Math.random().toString(36).substring(2, 11),
      triggerTerminalId: args.triggerTerminalId,
      triggerTransition: args.triggerTransition,
      actionTerminalId: args.actionTerminalId,
      actionCommand: args.actionCommand,
      enabled: true,
      // Inline: `oneShot !== undefined ? oneShot : true` — an omitted oneShot defaults to true.
      oneShot: args.oneShot !== undefined ? args.oneShot : true,
    };
    ctx.manager.ledger.watchRules.push(newRule);
    ctx.manager.ledger["save"](true);
    ctx.broadcast({ type: "watch_rules_updated", watchRules: ctx.manager.ledger.watchRules });
    return { kind: "ok", output: `Watch rule ${newRule.id} created.` };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// remove_watch_rule — DELETE /api/watch-rules/:id (ALWAYS_ALLOWED; was ungated).
// ─────────────────────────────────────────────────────────────────────────────

const RemoveWatchRuleParams = z.object({
  id: z.string(),
});

/**
 * remove_watch_rule — FAITHFUL PORT of inline app.delete("/api/watch-rules/:id") (server.ts ~944): find
 * the rule by id, splice it, force-persist, broadcast watch_rules_updated. Unknown id -> ok narration
 * (inline 404 -> 200, Decision 2): NO mutation, NO persist, NO broadcast (a stale client deleting an
 * already-gone rule must not error or spuriously repaint). SAFE DEFAULT ALWAYS_ALLOWED (no capability
 * exists; a dedicated gate row + voice exposure are DEFERRED for ratification).
 */
export const removeWatchRule: ActionDef<typeof RemoveWatchRuleParams> = {
  name: "remove_watch_rule",
  description: "Delete a watch-automation rule by its id. REST/UI surface only.",
  params: RemoveWatchRuleParams,
  capability: "ALWAYS_ALLOWED",
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: { method: "delete", path: "/api/watch-rules/:id" },
  handler: (args, ctx): ActionResult => {
    const idx = ctx.manager.ledger.watchRules.findIndex((r) => r.id === args.id);
    if (idx === -1) {
      // Inline 404 -> 200 ok narration (Decision 2). No persist / no repaint when nothing changed.
      return { kind: "ok", output: `Watch rule ${args.id} not found.` };
    }
    ctx.manager.ledger.watchRules.splice(idx, 1);
    ctx.manager.ledger["save"](true);
    ctx.broadcast({ type: "watch_rules_updated", watchRules: ctx.manager.ledger.watchRules });
    return { kind: "ok", output: `Watch rule ${args.id} removed.` };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// delete_orchestrator_plan — DELETE /api/plans/:plan_id (ALWAYS_ALLOWED; was ungated, no twin).
// ─────────────────────────────────────────────────────────────────────────────

/** Route param is snake_case (:plan_id) so Express injects it directly onto the snake_case zod key. */
const DeleteOrchestratorPlanParams = z.object({
  plan_id: z.string(),
});

/**
 * delete_orchestrator_plan — FAITHFUL PORT of inline app.delete("/api/plans/:id") (server.ts ~1001):
 * find the plan by id, splice it off the board, force-persist, broadcast plans_updated. Unknown id ->
 * ok narration (inline 404 -> 200, Decision 2): NO mutation, NO persist, NO broadcast. SAFE DEFAULT
 * ALWAYS_ALLOWED, rest-only — no twin/capability exists today; a gate row + a voice yes/no are DEFERRED
 * for ratification. The rest.path uses :plan_id (snake_case) so it lands directly on the zod key.
 */
export const deleteOrchestratorPlan: ActionDef<typeof DeleteOrchestratorPlanParams> = {
  name: "delete_orchestrator_plan",
  description: "Delete a multi-step orchestrator plan by its id, removing it from the plan board. REST/UI surface only.",
  params: DeleteOrchestratorPlanParams,
  capability: "ALWAYS_ALLOWED",
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: { method: "delete", path: "/api/plans/:plan_id" },
  handler: (args, ctx): ActionResult => {
    const idx = ctx.manager.ledger.plans.findIndex((p) => p.id === args.plan_id);
    if (idx === -1) {
      // Inline 404 -> 200 ok narration (Decision 2). No persist / no repaint when nothing changed.
      return { kind: "ok", output: `Plan ${args.plan_id} not found.` };
    }
    ctx.manager.ledger.plans.splice(idx, 1);
    ctx.manager.ledger["save"](true);
    ctx.broadcast({ type: "plans_updated", plans: ctx.manager.ledger.plans });
    return { kind: "ok", output: `Plan ${args.plan_id} deleted.` };
  },
};

/** The c55 Batch G rest-only registry slice. */
export const WATCH_RULES_ACTIONS: ActionDef[] = [
  listWatchRules,
  addWatchRule,
  removeWatchRule,
  deleteOrchestratorPlan,
];
