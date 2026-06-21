/**
 * src/actions/defs/orchestration.ts — REG1 ORCH group (faithful ports of the orchestration
 * dispatch branches in server.ts).
 *
 * Three tools, each a near-verbatim port of its legacy `name === "..."` branch:
 *   - create_orchestrator_plan (server.ts:2925) — UNGATED pure ledger write: builds a Plan,
 *     pushes it, persists, broadcasts `plans_updated`, answers with a fixed template string.
 *     The handler does NOT gate (the legacy branch never calls any gate function).
 *   - execute_plan (server.ts:2947) — runs ONLY plan step 1 through ctx.dispatchProposal with a
 *     SYNTHETIC pendingId (`<callId>__<planId>__step0`) and capability "execute_plan". The gate
 *     lives INSIDE dispatchProposal (mirrors propose_command); the handler maps the DispatchOutcome
 *     into a plan-board status mutation + a spoken read-back STRING (every branch -> kind:"ok").
 *   - apply_orchestration_recipe (server.ts:2992) — materializes a template layout via the shared
 *     pure planner planRecipeApply + per-pane ctx.gateOrDefer("create_pane", …). One audit-only
 *     ctx.gateCapability("apply_recipe", null) call; layout Off-veto is authoritative via
 *     plan.layoutForbidden. Launch is DERIVED via presetCommand(normalizePreset(…)) — the single
 *     Wave-B launch-derivation home, reused (no new derivation).
 *
 * Gate model (handler-owned, Decision B): each handler calls the SAME ctx.* gate functions EXACTLY
 * where its legacy branch does — and does NOT add a gate where the legacy branch is ungated.
 */

import { z } from "zod";
import type { ActionContext, ActionDef, ActionResult } from "../types";
import type { OrchestrationRecipe } from "../types";
import { presetCommand, normalizePreset } from "../../terminal";
import { planRecipeApply, type RecipeApplyPlan } from "../../recipeApply";

// ─────────────────────────────────────────────────────────────────────────────
// create_orchestrator_plan — server.ts:2925 (UNGATED pure ledger write)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * create_orchestrator_plan params (server.ts:3808 declaration). `steps[].expectedTransition` is
 * REQUIRED in the live Gemini declaration; the handler still applies the `|| "idle"` runtime
 * fallback (faithfully preserved below), so we keep the schema field required-but-string.
 */
const CreateOrchestratorPlanParams = z.object({
  name: z.string(),
  steps: z.array(
    z.object({
      terminalId: z.string(),
      command: z.string(),
      expectedTransition: z.string(),
    }),
  ),
});

/**
 * create_orchestrator_plan — FAITHFUL PORT of server.ts:2925-2946. UNGATED: the legacy branch never
 * calls gateOrDefer / dispatchProposal / gateCapability — it pushes a Plan to the ledger
 * unconditionally, persists via the bracket-string `["save"](true)` call, and broadcasts the full
 * plan list. capability "execute_plan" is declared for matrix membership only (the handler does NOT
 * enforce it — matching the legacy ungated branch). readOnly:false (it mutates the ledger; the output
 * is a fixed template string with no secrets).
 */
export const createOrchestratorPlan: ActionDef<typeof CreateOrchestratorPlanParams> = {
  name: "create_orchestrator_plan",
  description:
    "Synthesize a multi-step sequence of chained commands spanning multiple panes that run sequentially with automatic state verification of previous outputs.",
  params: CreateOrchestratorPlanParams,
  capability: "execute_plan",
  readOnly: false,
  surfaces: new Set(["voice", "rest"]),
  rest: { method: "post", path: "/api/plans" },
  handler: (args, ctx): ActionResult => {
    const { name: planName, steps } = args;
    const formattedSteps = steps.map((s, idx) => ({
      id: "step_" + idx,
      terminalId: s.terminalId,
      command: s.command,
      // Preserve the runtime `|| "idle"` fallback (server.ts:2931). `expectedTransition` is typed
      // "idle"|"prompt" on PlanStep but the legacy branch stores the raw string — keep that.
      expectedTransition: (s.expectedTransition || "idle") as "idle" | "prompt",
      status: "pending" as const,
    }));
    const newPlan = {
      id: "plan_" + Math.random().toString(36).substring(2, 11),
      name: planName,
      steps: formattedSteps,
      currentStepIndex: 0,
      status: "idle" as const,
    };
    ctx.manager.ledger.plans.push(newPlan);
    // Bracket-string call into the ledger's save(force) — preserved verbatim (server.ts:2942).
    ctx.manager.ledger["save"](true);
    ctx.broadcast({ type: "plans_updated", plans: ctx.manager.ledger.plans });
    return {
      kind: "ok",
      output: `Multi-pane plan '${planName}' created. Contains ${steps.length} steps.`,
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// execute_plan — server.ts:2947 (GATED inside ctx.dispatchProposal)
// ─────────────────────────────────────────────────────────────────────────────

/** execute_plan params (server.ts:3831 declaration). */
const ExecutePlanParams = z.object({
  plan_id: z.string(),
});

/**
 * execute_plan — FAITHFUL PORT of server.ts:2947-2991. Runs ONLY plan step 1 through the shared
 * pane-WRITE choke-point ctx.dispatchProposal with capability "execute_plan" and the SYNTHETIC
 * pendingId `${callId}__${plan.id}__step0` (so a HiTL pending entry never collides with the
 * execute_plan functionCall id). The gate is enforced INSIDE dispatchProposal — the handler does NOT
 * add a central gate (mirrors propose_command). It maps the DispatchOutcome into a plan-board status
 * mutation + a spoken read-back STRING; EVERY branch answers via response.output, so every branch
 * maps to ActionResult kind:"ok" (the live wire shape is { output: resp }). Mapping pending/clarify
 * to ActionResult kind:"pending"/"clarify" would change the wire shape — do NOT.
 *
 * c55.9 REST CONVERGENCE: the inline `POST /api/plans/:id/execute` route is deleted; this def now
 * serves it. The §6 status map (executed->200 / pending->202 / blocked->403 / pane-offline->400 /
 * plan-not-found->404 / clarify->409) is expressed via `rest.toHttp` reading the OUTCOME stamped on the
 * `ok` result's OPTIONAL `meta` channel — NOT on `output` (which stays the unchanged spoken read-back,
 * per spec §9.2). `meta` is invisible to the voice path (voiceResponse reads only `output`), so the
 * voice wire shape is byte-identical.
 */
/** The dispatch outcome the handler stamps on `result.meta` for execute_plan's rest.toHttp (c55.9 §6). */
type ExecutePlanOutcome =
  | "executed"        // auto write landed       -> 200
  | "pending"         // Ask staged a pending    -> 202
  | "blocked"         // gate Off / read-only    -> 403
  | "pane_offline"    // no live term / no pane  -> 400 (parity with inline "node offline")
  | "plan_not_found"  // unknown plan id         -> 404
  | "clarify";        // shell re-route          -> 409
export const executePlan: ActionDef<typeof ExecutePlanParams> = {
  name: "execute_plan",
  description: "Starts running a synthesized multi-step plan recipe.",
  params: ExecutePlanParams,
  capability: "execute_plan",
  readOnly: false,
  surfaces: new Set(["voice", "rest"]),
  rest: {
    method: "post",
    // Route param is snake_case (:plan_id) so Express injects it directly onto the snake_case zod key
    // (ExecutePlanParams.plan_id) — matching the delete_orchestrator_plan precedent (DELETE
    // /api/plans/:plan_id). The client URL (POST /api/plans/<id>/execute) is unchanged (Express matches
    // :plan_id against the same URL position), and the no-twin guard scans server.ts text, not this path.
    path: "/api/plans/:plan_id/execute",
    // c55.9 §6: map the stamped dispatch outcome to the inline route's status contract WITHOUT
    // touching `result.output` (the spoken read-back). The default kind->status map cannot express
    // this (every branch is kind:"ok"), so toHttp re-projects the structured `meta.outcome`. The
    // body is not load-bearing — the React client repaints off the plans_updated/approval_pending WS
    // frames — so we echo the output string for parity/debuggability.
    toHttp: (result): { status: number; body: unknown } => {
      const outcome = (result.kind === "ok"
        ? (result.meta as { outcome?: ExecutePlanOutcome } | undefined)?.outcome
        : undefined) as ExecutePlanOutcome | undefined;
      const status =
        outcome === "executed" ? 200 :
        outcome === "pending" ? 202 :
        outcome === "blocked" ? 403 :
        outcome === "pane_offline" ? 400 :
        outcome === "plan_not_found" ? 404 :
        outcome === "clarify" ? 409 :
        200; // defensive default (an un-stamped ok)
      const body = result.kind === "ok" ? { output: result.output } : { error: "execute_plan failed" };
      return { status, body };
    },
  },
  handler: (args, ctx): ActionResult => {
    const { plan_id } = args;
    const plan = ctx.manager.ledger.plans.find((p) => p.id === plan_id);
    let resp = "";
    // c55.9: the dispatch outcome stamped on `meta` for execute_plan's rest.toHttp (§6). NEVER read on
    // voice (voiceResponse reads only `output`) — the spoken `resp` string below is UNCHANGED.
    let outcome: ExecutePlanOutcome = "plan_not_found";
    if (plan) {
      plan.status = "running";
      plan.currentStepIndex = 0;
      plan.steps.forEach((s, idx) => (s.status = idx === 0 ? "running" : "pending"));
      const currentStep = plan.steps[0];

      // R4: route step 1's pane write through the SAME effective-mode gate + pending-approval path.
      // The gate is applied INSIDE dispatchProposal (capability "execute_plan"); no central gate.
      const stepOutcome = ctx.dispatchProposal({
        sess: ctx.session,
        callId: ctx.callId ?? "",
        pendingId: `${ctx.callId ?? ""}__${plan.id}__step0`,
        targetId: currentStep.terminalId,
        instruction: currentStep.command,
        trigger: `Plan '${plan.name}' step 1`,
        // Ride the execute_plan capability (not the default write_to_pane) so
        // capabilityGates.execute_plan is actually enforced.
        capability: "execute_plan",
      });
      if (stepOutcome.kind === "executed") {
        resp = `Started execution of plan '${plan.name}'! Running step 1 on '${currentStep.terminalId}'.`;
        outcome = "executed";
      } else if (stepOutcome.kind === "pending") {
        resp = `Plan '${plan.name}' step 1 needs approval: ${stepOutcome.text}`;
        outcome = "pending";
      } else if (stepOutcome.kind === "clarify") {
        plan.status = "paused";
        currentStep.status = "failed";
        resp = `Plan '${plan.name}' step 1 paused: ${stepOutcome.text}`;
        outcome = "clarify";
      } else {
        plan.status = "paused";
        currentStep.status = "failed";
        resp = `Could not start plan '${plan.name}': ${stepOutcome.text}`;
        // §6: a "blocked" dispatch (gate Off / read-only) -> 403; an "error" dispatch is the no-live-
        // term / inert-pane case -> 400 (preserves the inline route's "node offline" status).
        outcome = stepOutcome.kind === "blocked" ? "blocked" : "pane_offline";
      }
      // Persist + broadcast ONCE, inside the plan-found block only (server.ts:2984-2985).
      ctx.manager.ledger["save"](true);
      ctx.broadcast({ type: "plans_updated", plans: ctx.manager.ledger.plans });
    } else {
      resp = `Error: Plan '${plan_id}' not found.`;
      outcome = "plan_not_found";
    }
    return { kind: "ok", output: resp, meta: { outcome } };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// apply_orchestration_recipe — server.ts:2992 (planRecipeApply + per-pane gateOrDefer)
// ─────────────────────────────────────────────────────────────────────────────

/** apply_orchestration_recipe params (server.ts:3842 declaration). */
const ApplyOrchestrationRecipeParams = z.object({
  recipe_id: z.string(),
});

/** The recipe-pane shape read out of the catalog (one element of OrchestrationRecipe.panes). */
type RecipePane = OrchestrationRecipe["panes"][number];

/** The three apply_orchestration_recipe outcome buckets, accumulated across the per-pane loop and
 *  rendered into the spoken read-back. Extracted VERBATIM from the handler's inline arrays — same
 *  semantics, same membership, same order of append. */
interface RecipeApplyBuckets {
  spawned: string[];
  deferred: string[];
  blocked: string[];
}

/**
 * Build the per-pane spawn closure — VERBATIM extraction of the handler's inline `spawnPane`. It
 * adds the terminal, records the (never-auto-run) startupCommand pane note, and broadcasts INSIDE so a
 * deferred-confirm repaints. Returns the bare pane id (the kzt create_pane rebuild shape). The launch
 * command + preset are passed in already-derived (single Wave-B home), so this helper does NOT re-derive.
 */
function makeSpawnPane(
  ctx: ActionContext,
  p: RecipePane,
  activeProjectId: string,
  cwd: string,
  paneCommand: string,
  panePreset: ReturnType<typeof normalizePreset>,
): () => string {
  return (): string => {
    ctx.manager.addTerminal(
      p.id,
      cwd,
      paneCommand,
      panePreset,
      p.permissionsMode as any,
      "",
      activeProjectId,
    );
    if (p.startupCommand) {
      ctx.manager.ledger.addPaneNote(
        activeProjectId,
        p.id,
        `Suggested startup command: ${p.startupCommand}`,
      );
    }
    ctx.broadcastLedgerUpdate();
    ctx.broadcast({ type: "terminals_updated" });
    return p.id;
  };
}

/**
 * Apply ONE planned recipe pane — VERBATIM extraction of the per-pane body of the handler's loop. It
 * derives the launch command (single Wave-B home), builds the spawn closure, and routes a `defer`
 * disposition through ctx.gateOrDefer (forbidden -> blocked, deferred -> deferred, run -> spawn-now);
 * a non-defer (Auto) disposition spawns now. Mutates the shared `buckets` exactly as the inline loop did.
 */
function applyRecipePane(
  ctx: ActionContext,
  planned: RecipeApplyPlan["panes"][number],
  p: RecipePane,
  recipe: OrchestrationRecipe,
  activeProjectId: string,
  cwd: string,
  buckets: RecipeApplyBuckets,
): void {
  // KS (§5.4): launch DERIVED from the pane's preset via the SAME single home
  // presetCommand(normalizePreset(...)). startupCommand stays an auditable note (never auto-run);
  // broadcasts INSIDE so a deferred-confirm repaints.
  const panePreset = normalizePreset(p.preset);
  const paneCommand = presetCommand(
    panePreset,
    ctx.manager.settings.presets,
    ctx.manager.settings.advanced?.defaultShellCommand,
  );
  const spawnPane = makeSpawnPane(ctx, p, activeProjectId, cwd, paneCommand, panePreset);
  if (planned.disposition === "defer") {
    // Route through gateOrDefer so the audit row + action_pending broadcast + pendingActions.add fire
    // identically to REST. (The planner already classified Ask, so this stages.) kzt: same create_pane
    // intent shape as the REST recipe path (origin:"recipe" -> rebuild returns the bare pane id) —
    // keys in lockstep with src/actionEffects.ts buildActionRun create_pane case.
    const g = ctx.gateOrDefer(
      "create_pane",
      p.id,
      `Create pane ${p.id} (recipe ${recipe.id})`,
      spawnPane,
      {
        // PLM3: stamp the version guard FIRST so a deferred voice-recipe create_pane survives a restart
        // instead of being quarantined on boot (the 7th staging site). Spread first so the create_pane
        // intent keys below always win on any collision (kzt lockstep).
        ...(ctx.versionStamp ?? {}),
        origin: "recipe",
        paneId: p.id,
        cwd,
        command: paneCommand,
        toolPreset: panePreset,
        permissionsMode: p.permissionsMode,
        startupCommand: p.startupCommand,
        projectId: activeProjectId,
      },
    );
    if (g.disposition === "forbidden") buckets.blocked.push(p.id);
    else if (g.disposition === "deferred") buckets.deferred.push(p.id);
    else {
      spawnPane();
      buckets.spawned.push(p.id);
    }
  } else {
    // Auto -> spawn now.
    spawnPane();
    buckets.spawned.push(p.id);
  }
}

/**
 * Render the spoken read-back string — VERBATIM extraction of the handler's `resp = ...` assembly.
 * Same clause order, same wording, same trailing ".".
 */
function renderRecipeResponse(recipe: OrchestrationRecipe, buckets: RecipeApplyBuckets): string {
  return (
    `Template recipe layout '${recipe.name}': spawned ${buckets.spawned.length} pane(s)` +
    (buckets.deferred.length
      ? `, ${buckets.deferred.length} awaiting your confirmation (create_pane=Ask: ${buckets.deferred.join(", ")})`
      : "") +
    (buckets.blocked.length
      ? `, ${buckets.blocked.length} blocked by create_pane=Off (${buckets.blocked.join(", ")})`
      : "") +
    "."
  );
}

/**
 * Materialize the recipe layout — VERBATIM extraction of the handler's `recipe`-found body (the
 * gateCapability audit row, planRecipeApply, the layout Off-veto, and the per-pane loop). Returns the
 * ActionResult (kind:"blocked" on layout Off, else kind:"ok" with the narration). Keeping this off the
 * handler is what brings the handler's cyclomatic complexity to <= 10.
 */
function materializeRecipe(
  ctx: ActionContext,
  recipe: OrchestrationRecipe,
  activeProjectId: string,
  cwd: string,
): ActionResult {
  // One gateCapability call for the layout-level `apply_recipe` audit row (the planner is pure and
  // emits none); the veto is authoritative via plan.layoutForbidden. Return is ignored.
  ctx.gateCapability("apply_recipe", null);
  const plan = planRecipeApply(
    recipe.panes,
    new Set(Object.keys(ctx.manager.terminals)),
    () => ctx.effectiveCapabilityGateFor(null, "apply_recipe"),
    (id) => ctx.effectiveCapabilityGateFor(id, "create_pane"),
  );
  if (plan.layoutForbidden) {
    // c55 Batch D — STATUS-VIA-KINDS: the layout-level apply_recipe Off-veto is a REFUSAL, so return
    // kind:"blocked" (was a kind:"ok" string). resultToHttp maps blocked -> 403, which the REST client
    // status-branches on for the refusal earcon (the inline twin emitted 403 too). The voice surface
    // still narrates from the same kind (voiceResponse blocked -> { output: reason }), so the spoken
    // refusal is byte-identical to the old ok-string. No toHttp hook needed.
    return {
      kind: "blocked",
      reason: `Error: the 'apply_recipe' capability is gated Off; spawning template layouts is forbidden by policy.`,
    };
  }
  const paneById = new Map(recipe.panes.map((p) => [p.id, p]));
  const buckets: RecipeApplyBuckets = { spawned: [], deferred: [], blocked: [] };
  for (const planned of plan.panes) {
    if (planned.disposition === "skip-existing") continue;
    if (planned.disposition === "block") {
      buckets.blocked.push(planned.paneId);
      continue;
    }
    const p = paneById.get(planned.paneId)!;
    applyRecipePane(ctx, planned, p, recipe, activeProjectId, cwd, buckets);
  }
  return { kind: "ok", output: renderRecipeResponse(recipe, buckets) };
}

/**
 * apply_orchestration_recipe — FAITHFUL PORT of server.ts:2992-3071. Materializes a template layout
 * via the shared pure planner planRecipeApply + per-pane ctx.gateOrDefer("create_pane", …). Gating is
 * fully INSIDE the handler (mirrors the legacy branch): one audit-only ctx.gateCapability("apply_recipe",
 * null) call (return ignored), planRecipeApply's resolveLayout = ctx.effectiveCapabilityGateFor(null,
 * "apply_recipe") for the layout Off-veto (authoritative via plan.layoutForbidden), and resolvePane =
 * ctx.effectiveCapabilityGateFor(id, "create_pane") per pane. The launch command is DERIVED via the
 * SINGLE Wave-B home presetCommand(normalizePreset(p.preset)) — reused, NOT re-derived. startupCommand
 * is NEVER auto-run (recorded only as a pane note). Broadcasts (broadcastLedgerUpdate + terminals_updated)
 * live INSIDE spawnPane so a deferred-confirm repaints. Every branch answers via response.output ->
 * ActionResult kind:"ok".
 */
export const applyOrchestrationRecipe: ActionDef<typeof ApplyOrchestrationRecipeParams> = {
  name: "apply_orchestration_recipe",
  description:
    "Apply a pre-configured template layout suite (such as full-stack-web or python-worker) to standard workspaces.",
  params: ApplyOrchestrationRecipeParams,
  capability: "apply_recipe",
  readOnly: false,
  surfaces: new Set(["voice", "rest"]),
  rest: { method: "post", path: "/api/recipes/apply" },
  // c55 Batch D: the UI POSTs { recipeId }; the voice schema key is recipe_id. Alias camel->snake
  // (only when the snake key is absent, so a voice call carrying recipe_id is never clobbered).
  coerceArgs: (raw) => {
    const out = { ...raw };
    if (out.recipe_id == null && out.recipeId != null) out.recipe_id = out.recipeId;
    delete out.recipeId;
    return out;
  },
  handler: (args, ctx): ActionResult => {
    const { recipe_id } = args;
    const activeProjectId = ctx.manager.ledger.activeProjectId || "default_project";
    const proj = ctx.manager.ledger.getProject(activeProjectId);
    if (!proj) {
      return {
        kind: "ok",
        output: "Error: There is no active project context synchronized to apply templates under.",
      };
    }
    const recipe = ctx.recipes.find((r) => r.id === recipe_id);
    if (!recipe) {
      return { kind: "ok", output: `Error: Template recipe ${recipe_id} not found.` };
    }
    // The recipe-found body (gateCapability audit + planRecipeApply + layout veto + per-pane loop) is
    // extracted VERBATIM into materializeRecipe (semantics identical). cwd is resolved here exactly as
    // the inline body did (`proj.directory || process.cwd()`) and threaded through.
    return materializeRecipe(ctx, recipe, activeProjectId, proj.directory || process.cwd());
  },
};

/** The ORCH group registry array. */
export const ORCH_ACTIONS: ActionDef[] = [
  createOrchestratorPlan,
  executePlan,
  applyOrchestrationRecipe,
];
