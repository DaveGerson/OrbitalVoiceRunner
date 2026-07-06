/**
 * src/actions/defs/watch_rules.ts — c55 Batch G (wsm-e2e-pinned-c55.7).
 *
 * Four NEW rest-only ActionDefs that converge inline watch-rule / plan-delete routes which have NO
 * voice twin today. surfaces = {'rest'} ONLY (so they never force a Gemini voice-tool description),
 * and each replicates its inline server.ts route logic FAITHFULLY. The UI clients read only res.ok
 * (writes) and repaint off the plans_updated WS frame the plan-delete handler fans out.
 * wsm-e2e-pinned-33c.4: the watch_rules_updated WS frame these handlers used to also broadcast is
 * PRUNED — no client has consumed it since the classic UI's Alerts/Orchestrate tabs were removed
 * (d858e5e), and the Orbital Kitchen UI has no watch-rule surface at all. The persist effect (the
 * REST backend) is unchanged; only the now-unconsumed broadcast frame is gone.
 *
 * Routes converged (the inline app.* twins are deleted in the SAME change — never both, or Express
 * keeps the first-registered handler and silently masks the cutover):
 *   - list_watch_rules         GET    /api/watch-rules        (server.ts ~919)
 *   - add_watch_rule           POST   /api/watch-rules        (server.ts ~923)
 *   - remove_watch_rule        DELETE /api/watch-rules/:id     (server.ts ~944)
 *   - delete_orchestrator_plan DELETE /api/plans/:id           (server.ts ~1001)
 *
 * GATING (Decision 3 + the c55.10 gate-tightening of the cutover ALWAYS_ALLOWED defs per the P2 taxonomy):
 *   - list_watch_rules: a READ. ALWAYS_ALLOWED, readOnly:false — the inline route returned the RAW,
 *     UN-redacted array; the registry's readOnly-redaction would scrub string leaves and also requires a
 *     read_* capability (§8.1), so we keep it ungated/unredacted to stay byte-identical to the legacy body.
 *   - add_watch_rule: GATED (add_watch_rule, default Ask) via ctx.gateOrDefer — c55.10 UN-RESERVES the
 *     EXISTING matrix row (it was reserved for a future voice tool, Decision 8) and wires this def to it.
 *     Creating an autonomous rule that fires a command on a pane transition is a safety-config/automation
 *     change. No new cap id (reuses the existing row). Off->blocked->403, Ask->pending->202, Auto->200.
 *   - remove_watch_rule: GATED (remove_watch_rule, NEW row, default Ask) — the mirror safety-config change
 *     to add_watch_rule (symmetry). Unknown id -> 200 ok narration resolved BEFORE the gate.
 *   - delete_orchestrator_plan: GATED (delete_orchestrator_plan, NEW row, default Ask) — destructive
 *     (permanently removes a plan; mirrors c55.14's gating of delete_pane/delete_project). Unknown id ->
 *     200 ok narration resolved BEFORE the gate.
 *   All three gated defs stay rest-only (surfaces:{rest}); a voice yes/no twin remains DEFERRED.
 *   DURABLE cross-restart Ask-replay (c55.16 tech_debt_buildactionrun): remove_watch_rule and
 *   delete_orchestrator_plan ARE now replayable — the intent bag is WIDENED with ruleId/planId and
 *   src/actionEffects.ts carries a byte-identical rebuild case (in LOCKSTEP with removeEffect/
 *   deleteEffect). A confirm-after-restart now splices the correct rule/plan, not a no-op. (send_keys
 *   in panes_rest.ts remains the one accepted scope-out — it re-fires the live PTY; see its header.)
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
// add_watch_rule — POST /api/watch-rules (GATED add_watch_rule, default Ask — c55.10; was ungated).
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
 * force-persist — now ROUTED THROUGH ctx.gateOrDefer("add_watch_rule", ...). wsm-e2e-pinned-33c.4: the
 * watch_rules_updated BROADCAST is pruned (no client consumes that frame post d858e5e); the persist
 * effect is unchanged. c55.10 UN-RESERVES the EXISTING `add_watch_rule` matrix row
 * (default Ask): creating an autonomous rule is a safety-config/automation change. The side effects are
 * wrapped in ONE synchronous effect closure (serves Auto-run-now AND the in-process Ask->confirm replay).
 * The gate is keyed on the trigger terminal id (the rule's natural scope). The inline presence-check 400
 * is replaced by the zod-required fields (a missing field -> 500). Off->blocked->403, Ask->pending->202,
 * Auto->run-now->200.
 */
export const addWatchRule: ActionDef<typeof AddWatchRuleParams> = {
  name: "add_watch_rule",
  description: "Create a watch-automation rule that fires a command on another pane when a trigger pane transitions. GATED (add_watch_rule, default Ask). REST/UI surface only.",
  params: AddWatchRuleParams,
  capability: "add_watch_rule",
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: { method: "post", path: "/api/watch-rules" },
  handler: (args, ctx): ActionResult => {
    // ONE synchronous gated effect closure (serves Auto-run-now AND the in-process Ask->confirm replay).
    const addEffect = (): string => {
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
      return `Watch rule ${newRule.id} created.`;
    };
    const g = ctx.gateOrDefer(
      "add_watch_rule",
      args.triggerTerminalId,
      `Add watch rule on pane ${args.triggerTerminalId}`,
      addEffect,
      { ...(ctx.versionStamp ?? {}), origin: "rest", paneId: args.triggerTerminalId }
    );
    if (g.disposition === "forbidden") {
      return { kind: "blocked", reason: "Error: the 'add_watch_rule' capability is gated Off; creating automation rules is forbidden by policy." };
    }
    if (g.disposition === "deferred") {
      return { kind: "pending", messageId: g.actionId, summary: g.summary };
    }
    return { kind: "ok", output: addEffect() };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// remove_watch_rule — DELETE /api/watch-rules/:id (GATED remove_watch_rule, default Ask — c55.10).
// ─────────────────────────────────────────────────────────────────────────────

const RemoveWatchRuleParams = z.object({
  id: z.string(),
});

/**
 * remove_watch_rule — FAITHFUL PORT of inline app.delete("/api/watch-rules/:id") (server.ts ~944): find
 * the rule by id, splice it, force-persist — now ROUTED THROUGH ctx.gateOrDefer("remove_watch_rule",
 * ...). wsm-e2e-pinned-33c.4: the watch_rules_updated BROADCAST is pruned (no client consumes that
 * frame post d858e5e); the persist effect is unchanged. c55.10 adds a NEW matrix row (default Ask): the mirror
 * safety-config change to add_watch_rule. Unknown id -> ok narration resolved BEFORE the gate (inline 404
 * -> 200, Decision 2): NO mutation, NO persist, NO broadcast, gate NOT consulted (a stale client deleting
 * an already-gone rule must not error, spuriously repaint, OR stage/forbid a no-op). The side effects are
 * wrapped in ONE synchronous effect closure. Off->blocked->403, Ask->pending->202, Auto->run-now->200.
 */
export const removeWatchRule: ActionDef<typeof RemoveWatchRuleParams> = {
  name: "remove_watch_rule",
  description: "Delete a watch-automation rule by its id. GATED (remove_watch_rule, default Ask). REST/UI surface only.",
  params: RemoveWatchRuleParams,
  capability: "remove_watch_rule",
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: { method: "delete", path: "/api/watch-rules/:id" },
  handler: (args, ctx): ActionResult => {
    const idx = ctx.manager.ledger.watchRules.findIndex((r) => r.id === args.id);
    if (idx === -1) {
      // Inline 404 -> 200 ok narration (Decision 2), resolved BEFORE the gate. No persist / no repaint /
      // no stage/forbid when nothing changed.
      return { kind: "ok", output: `Watch rule ${args.id} not found.` };
    }
    // ONE synchronous gated effect closure (serves Auto-run-now AND the in-process Ask->confirm replay).
    const removeEffect = (): string => {
      const i = ctx.manager.ledger.watchRules.findIndex((r) => r.id === args.id);
      if (i !== -1) {
        ctx.manager.ledger.watchRules.splice(i, 1);
        ctx.manager.ledger["save"](true);
      }
      return `Watch rule ${args.id} removed.`;
    };
    const g = ctx.gateOrDefer(
      "remove_watch_rule",
      null,
      `Remove watch rule ${args.id}`,
      removeEffect,
      // c55.16 tech_debt_buildactionrun: WIDEN the persisted intent with `ruleId` so a confirm-AFTER-
      // restart can rebuild removeEffect via buildActionRun (it splices exactly this rule). Keep this
      // key in LOCKSTEP with RemoveWatchRuleParams in src/actionEffects.ts (the durable-replay header).
      { ...(ctx.versionStamp ?? {}), origin: "rest", ruleId: args.id }
    );
    if (g.disposition === "forbidden") {
      return { kind: "blocked", reason: "Error: the 'remove_watch_rule' capability is gated Off; removing automation rules is forbidden by policy." };
    }
    if (g.disposition === "deferred") {
      return { kind: "pending", messageId: g.actionId, summary: g.summary };
    }
    return { kind: "ok", output: removeEffect() };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// delete_orchestrator_plan — DELETE /api/plans/:plan_id (GATED delete_orchestrator_plan, Ask — c55.10).
// ─────────────────────────────────────────────────────────────────────────────

/** Route param is snake_case (:plan_id) so Express injects it directly onto the snake_case zod key. */
const DeleteOrchestratorPlanParams = z.object({
  plan_id: z.string(),
});

/**
 * delete_orchestrator_plan — FAITHFUL PORT of inline app.delete("/api/plans/:id") (server.ts ~1001):
 * find the plan by id, splice it off the board, force-persist, broadcast plans_updated — now ROUTED
 * THROUGH ctx.gateOrDefer("delete_orchestrator_plan", ...). c55.10 adds a NEW matrix row (default Ask):
 * permanently removing a plan is DESTRUCTIVE (mirrors c55.14's gating of delete_pane/delete_project).
 * Unknown id -> ok narration resolved BEFORE the gate (inline 404 -> 200, Decision 2): NO mutation, NO
 * persist, NO broadcast, gate NOT consulted. The side effects are wrapped in ONE synchronous effect
 * closure. The rest.path uses :plan_id (snake_case) so it lands directly on the zod key.
 * Off->blocked->403, Ask->pending->202, Auto->run-now->200.
 */
export const deleteOrchestratorPlan: ActionDef<typeof DeleteOrchestratorPlanParams> = {
  name: "delete_orchestrator_plan",
  description: "Delete a multi-step orchestrator plan by its id, removing it from the plan board. GATED (delete_orchestrator_plan, default Ask). REST/UI surface only.",
  params: DeleteOrchestratorPlanParams,
  capability: "delete_orchestrator_plan",
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: { method: "delete", path: "/api/plans/:plan_id" },
  handler: (args, ctx): ActionResult => {
    const idx = ctx.manager.ledger.plans.findIndex((p) => p.id === args.plan_id);
    if (idx === -1) {
      // Inline 404 -> 200 ok narration (Decision 2), resolved BEFORE the gate. No persist / no repaint /
      // no stage/forbid when nothing changed.
      return { kind: "ok", output: `Plan ${args.plan_id} not found.` };
    }
    // ONE synchronous gated effect closure (serves Auto-run-now AND the in-process Ask->confirm replay).
    const deleteEffect = (): string => {
      const i = ctx.manager.ledger.plans.findIndex((p) => p.id === args.plan_id);
      if (i !== -1) {
        ctx.manager.ledger.plans.splice(i, 1);
        ctx.manager.ledger["save"](true);
        ctx.broadcast({ type: "plans_updated", plans: ctx.manager.ledger.plans });
      }
      return `Plan ${args.plan_id} deleted.`;
    };
    const g = ctx.gateOrDefer(
      "delete_orchestrator_plan",
      null,
      `Delete plan ${args.plan_id}`,
      deleteEffect,
      // c55.16 tech_debt_buildactionrun: WIDEN the persisted intent with `planId` so a confirm-AFTER-
      // restart can rebuild deleteEffect via buildActionRun. Keep this key in LOCKSTEP with
      // DeleteOrchestratorPlanParams in src/actionEffects.ts (the durable-replay header).
      { ...(ctx.versionStamp ?? {}), origin: "rest", planId: args.plan_id }
    );
    if (g.disposition === "forbidden") {
      return { kind: "blocked", reason: "Error: the 'delete_orchestrator_plan' capability is gated Off; deleting plans is forbidden by policy." };
    }
    if (g.disposition === "deferred") {
      return { kind: "pending", messageId: g.actionId, summary: g.summary };
    }
    return { kind: "ok", output: deleteEffect() };
  },
};

/** The c55 Batch G rest-only registry slice. */
export const WATCH_RULES_ACTIONS: ActionDef[] = [
  listWatchRules,
  addWatchRule,
  removeWatchRule,
  deleteOrchestratorPlan,
];
