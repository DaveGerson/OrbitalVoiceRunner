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
import type { ActionContext, ActionDef, ActionResult, DispatchOutcome } from "../types";
import type { OrchestrationRecipe } from "../types";
import { presetCommand, normalizePreset } from "../../terminal";
import { planRecipeApply, type RecipeApplyPlan } from "../../recipeApply";
import { dispatchJoinTracker } from "../../dispatch/joinTracker";

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
      // BUG-011: optional parallel-group marker (consecutive leading steps sharing it run concurrently).
      // Absent for ordinary sequential plans — copied through ONLY when supplied (byte-identical otherwise).
      group: z.string().optional(),
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
      // BUG-011: thread the parallel-group marker through ONLY when supplied, so a plan without groups
      // is byte-identical to the pre-BUG-011 shape (no spurious `group: undefined` key).
      ...(s.group !== undefined ? { group: s.group } : {}),
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

/**
 * HTTP status map for execute_plan's rest.toHttp — verbatim extraction of the inline ternary chain
 * (c55.9 §6). A plain object lookup carries zero cognitive complexity; the 200 defensive default
 * is expressed via the `?? 200` fallback in toHttp for un-stamped outcomes. Values are IDENTICAL
 * to the original ternary branches.
 */
const EXECUTE_PLAN_HTTP_STATUS: Record<ExecutePlanOutcome, number> = {
  executed:       200,
  pending:        202,
  blocked:        403,
  pane_offline:   400,
  plan_not_found: 404,
  clarify:        409,
};

// ─────────────────────────────────────────────────────────────────────────────
// BUG-011: leading parallel-group dispatch. Consecutive LEADING steps that share a non-undefined
// `group` marker fan out CONCURRENTLY in one execute_plan invocation (one gated ctx.dispatchProposal
// per member, a DISTINCT synthetic pendingId each), and a dispatchJoinTracker group is registered so
// the operator gets ONE "all done" join later (settled by the observe layer). A plan with no group
// marker is a group of ONE — the byte-identical sequential path (dispatchSingleStep below).
// ─────────────────────────────────────────────────────────────────────────────

/** The LEADING group at index 0: the maximal run of consecutive steps sharing steps[0].group. A step
 *  with no `group` marker is a group of one (the sequential path). Pure; mutates nothing. */
function leadingPlanGroup(steps: any[]): any[] {
  const first = steps[0];
  if (!first) return [];
  if (first.group === undefined) return [first];
  const group: any[] = [];
  for (const step of steps) {
    if (step.group !== first.group) break;
    group.push(step);
  }
  return group;
}

/** Map a per-member DispatchOutcome to the execute_plan HTTP-outcome vocabulary (blocked = gate Off /
 *  read-only; pane_offline = inert pane / no live term; clarify = shell re-route; pending = staged
 *  approval; executed = landed). */
function memberOutcome(out: DispatchOutcome): ExecutePlanOutcome {
  if (out.kind === "executed") return "executed";
  if (out.kind === "pending") return "pending";
  if (out.kind === "clarify") return "clarify";
  return out.kind === "blocked" ? "blocked" : "pane_offline";
}

/** Refusals dominate the group's aggregate outcome (worst-of), which drives execute_plan's REST status. */
const OUTCOME_SEVERITY: Record<ExecutePlanOutcome, number> = {
  executed: 0, pending: 1, clarify: 2, pane_offline: 3, blocked: 4, plan_not_found: 5,
};

/** Reflect ONE member's dispatch outcome onto the plan board + the join tracker. executed/pending keep
 *  the member RUNNING on the board (the write landed, or is staged for approval); a refusal
 *  (blocked/clarify/error) FAILS that member's step so the join can't hang on it — but, unlike the
 *  single-step handler, does NOT pause the whole plan (its siblings keep running). */
function applyMemberOutcome(joinId: string, index: number, step: any, out: DispatchOutcome): void {
  if (out.kind === "executed") {
    step.status = "running";
    dispatchJoinTracker.recordOutcomeAt(joinId, index, "running");
  } else if (out.kind === "pending") {
    step.status = "running";
    dispatchJoinTracker.recordOutcomeAt(joinId, index, "staged");
  } else if (out.kind === "blocked") {
    step.status = "failed";
    dispatchJoinTracker.recordOutcomeAt(joinId, index, "blocked");
  } else {
    step.status = "failed";
    dispatchJoinTracker.recordOutcomeAt(joinId, index, "error");
  }
}

/** The single-step dispatch path — VERBATIM extraction of the pre-BUG-011 handler body (a lone plan
 *  step routed through ctx.dispatchProposal with the synthetic `${callId}__${planId}__step0` pendingId
 *  + capability "execute_plan"). Mutates plan/step exactly as before; returns the spoken read-back plus
 *  the stamped outcome. A group of one (incl. a plan with no group marker) takes this path, so the
 *  sequential contract is byte-identical. */
function dispatchSingleStep(ctx: ActionContext, plan: any): { resp: string; outcome: ExecutePlanOutcome } {
  const currentStep = plan.steps[0];
  const stepOutcome = ctx.dispatchProposal({
    sess: ctx.session,
    callId: ctx.callId ?? "",
    pendingId: `${ctx.callId ?? ""}__${plan.id}__step0`,
    targetId: currentStep.terminalId,
    instruction: currentStep.command,
    trigger: `Plan '${plan.name}' step 1`,
    capability: "execute_plan",
  });
  if (stepOutcome.kind === "executed") {
    return { resp: `Started execution of plan '${plan.name}'! Running step 1 on '${currentStep.terminalId}'.`, outcome: "executed" };
  }
  if (stepOutcome.kind === "pending") {
    return { resp: `Plan '${plan.name}' step 1 needs approval: ${stepOutcome.text}`, outcome: "pending" };
  }
  if (stepOutcome.kind === "clarify") {
    plan.status = "paused";
    currentStep.status = "failed";
    return { resp: `Plan '${plan.name}' step 1 paused: ${stepOutcome.text}`, outcome: "clarify" };
  }
  plan.status = "paused";
  currentStep.status = "failed";
  return {
    resp: `Could not start plan '${plan.name}': ${stepOutcome.text}`,
    // §6: "blocked" (gate Off / read-only) -> 403; "error" (no live term / inert pane) -> 400.
    outcome: stepOutcome.kind === "blocked" ? "blocked" : "pane_offline",
  };
}

/** Per-member dispatch tally for the HONEST parallel-group read-back (BUG-011): how many members
 *  actually started (executed -> running), how many are staged awaiting approval (pending), and how
 *  many were refused at the gate (blocked / clarify / error). Mirrors narrateDispatch's
 *  staged-vs-refused split so an eyes-off operator hears what really got off the ground. */
interface GroupDispatchTally {
  running: number;
  staged: number;
  refused: number;
}

/** Fold ONE member's dispatch outcome into the tally (executed=running, pending=staged, everything
 *  else — blocked/clarify/error — refused, matching applyMemberOutcome's failed-step mapping). */
function tallyMember(tally: GroupDispatchTally, out: DispatchOutcome): void {
  if (out.kind === "executed") tally.running++;
  else if (out.kind === "pending") tally.staged++;
  else tally.refused++;
}

/** Honest spoken read-back for a fanned-out parallel group — reflects the ACTUAL dispatch outcomes
 *  (started / awaiting approval / blocked) instead of blindly claiming every member is "running
 *  concurrently". When nothing got off the ground it mirrors the single-step path's "Could not start
 *  plan" refusal wording; a clean fan-out keeps the original happy-path sentence byte-identical. */
function narrateParallelGroup(planName: string, total: number, tally: GroupDispatchTally): string {
  const started = tally.running + tally.staged;
  if (started === 0) {
    return `Could not start plan '${planName}': all ${total} parallel steps were blocked.`;
  }
  if (tally.staged === 0 && tally.refused === 0) {
    return `Started parallel execution of plan '${planName}': ${total} steps running concurrently.`;
  }
  const parts = [`Started ${started} of ${total} steps of plan '${planName}'`];
  if (tally.staged > 0) parts.push(`${tally.staged} awaiting approval`);
  if (tally.refused > 0) parts.push(`${tally.refused} blocked`);
  return parts.join("; ") + ".";
}

/** Fan a LEADING parallel group out through the SAME gated pane-write choke-point — one
 *  ctx.dispatchProposal per member (each gating exactly as a lone plan step: capability "execute_plan",
 *  a DISTINCT synthetic pendingId), registering a dispatchJoinTracker group for the later "all done"
 *  join. Deliberately NOT stageDispatchGroup: its forceStage would turn every member into a pending
 *  approval even under Full Auto, diverging from the single-step gating contract. Plan advancement stays
 *  the observe layer's job (currentStepIndex is NOT touched here) — EXCEPT the all-refused case, which
 *  settled at dispatch (no pane edge is coming to settle the join), so it pauses here for parity with
 *  dispatchSingleStep's blocked branch. */
function dispatchParallelGroup(ctx: ActionContext, plan: any, group: any[]): { resp: string; outcome: ExecutePlanOutcome } {
  // The join name is wrapped by the completion narration as `Dispatch '<name>' complete`
  // (src/observe/index.ts), so keep the label unquoted here — `Plan '<name>'` would read back as the
  // doubled-quote "Dispatch 'Plan 'X'' complete". `Plan <name>` narrates cleanly as "Dispatch 'Plan X' complete".
  const join = dispatchJoinTracker.create(`Plan ${plan.name}`, group[0].command, group.map((s) => s.terminalId));
  let worst: ExecutePlanOutcome = "executed";
  const tally: GroupDispatchTally = { running: 0, staged: 0, refused: 0 };
  group.forEach((step, i) => {
    const stepOutcome = ctx.dispatchProposal({
      sess: ctx.session,
      callId: ctx.callId ?? "",
      // DISTINCT synthetic pendingId per member (no functionCall-id / step collision).
      pendingId: `${ctx.callId ?? ""}__${plan.id}__step${i}`,
      targetId: step.terminalId,
      instruction: step.command,
      trigger: `Plan '${plan.name}' step ${i + 1}`,
      capability: "execute_plan",
    });
    applyMemberOutcome(join.id, i, step, stepOutcome);
    tallyMember(tally, stepOutcome);
    const mo = memberOutcome(stepOutcome);
    if (OUTCOME_SEVERITY[mo] > OUTCOME_SEVERITY[worst]) worst = mo;
  });
  ctx.broadcast({ type: "dispatch_updated", dispatches: dispatchJoinTracker.list() });
  // BUG-011: when NOTHING got off the ground (every member refused at the gate), the group settled at
  // dispatch — there is no pane edge coming to settle the join, so the plan would sit "running" forever
  // (a zombie). Pause it right here, mirroring dispatchSingleStep's blocked branch. A group with any
  // member running/staged stays "running" and settles later in the observe layer (isGroupSettled),
  // which pauses the plan if any member ended up failed.
  if (tally.running === 0 && tally.staged === 0) plan.status = "paused";
  return {
    resp: narrateParallelGroup(plan.name, group.length, tally),
    outcome: worst,
  };
}

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
      const status = outcome !== undefined ? (EXECUTE_PLAN_HTTP_STATUS[outcome] ?? 200) : 200;
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
      // BUG-011: a LEADING parallel group (consecutive steps sharing a group marker) fans out together;
      // a plan with no group marker is a group of ONE (the byte-identical sequential path). Mark every
      // group member running and everything AFTER the group pending (identical to the old idx===0 rule
      // when the group is a single step).
      const group = leadingPlanGroup(plan.steps);
      plan.steps.forEach((s, idx) => (s.status = idx < group.length ? "running" : "pending"));
      // R4: route each member's pane write through the SAME effective-mode gate + pending-approval path
      // (INSIDE dispatchProposal, capability "execute_plan"; no central gate). A single step keeps the
      // exact pre-BUG-011 path; a group fans out + registers a join.
      const dispatched = group.length > 1 ? dispatchParallelGroup(ctx, plan, group) : dispatchSingleStep(ctx, plan);
      resp = dispatched.resp;
      outcome = dispatched.outcome;
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
