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
import type { ActionDef, ActionResult } from "../types";
import { presetCommand, normalizePreset } from "../../terminal";
import { planRecipeApply } from "../../recipeApply";

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
 */
export const executePlan: ActionDef<typeof ExecutePlanParams> = {
  name: "execute_plan",
  description: "Starts running a synthesized multi-step plan recipe.",
  params: ExecutePlanParams,
  capability: "execute_plan",
  readOnly: false,
  surfaces: new Set(["voice", "rest"]),
  rest: { method: "post", path: "/api/plans/:id/execute" },
  handler: (args, ctx): ActionResult => {
    const { plan_id } = args;
    const plan = ctx.manager.ledger.plans.find((p) => p.id === plan_id);
    let resp = "";
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
      } else if (stepOutcome.kind === "pending") {
        resp = `Plan '${plan.name}' step 1 needs approval: ${stepOutcome.text}`;
      } else if (stepOutcome.kind === "clarify") {
        plan.status = "paused";
        currentStep.status = "failed";
        resp = `Plan '${plan.name}' step 1 paused: ${stepOutcome.text}`;
      } else {
        plan.status = "paused";
        currentStep.status = "failed";
        resp = `Could not start plan '${plan.name}': ${stepOutcome.text}`;
      }
      // Persist + broadcast ONCE, inside the plan-found block only (server.ts:2984-2985).
      ctx.manager.ledger["save"](true);
      ctx.broadcast({ type: "plans_updated", plans: ctx.manager.ledger.plans });
    } else {
      resp = `Error: Plan '${plan_id}' not found.`;
    }
    return { kind: "ok", output: resp };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// apply_orchestration_recipe — server.ts:2992 (planRecipeApply + per-pane gateOrDefer)
// ─────────────────────────────────────────────────────────────────────────────

/** apply_orchestration_recipe params (server.ts:3842 declaration). */
const ApplyOrchestrationRecipeParams = z.object({
  recipe_id: z.string(),
});

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
  handler: (args, ctx): ActionResult => {
    const { recipe_id } = args;
    const activeProjectId = ctx.manager.ledger.activeProjectId || "default_project";
    const proj = ctx.manager.ledger.getProject(activeProjectId);
    let resp = "";
    if (!proj) {
      resp = "Error: There is no active project context synchronized to apply templates under.";
    } else {
      const recipe = ctx.recipes.find((r) => r.id === recipe_id);
      if (!recipe) {
        resp = `Error: Template recipe ${recipe_id} not found.`;
      } else {
        // One gateCapability call for the layout-level `apply_recipe` audit row (the planner is pure
        // and emits none); the veto is authoritative via plan.layoutForbidden. Return is ignored.
        ctx.gateCapability("apply_recipe", null);
        const plan = planRecipeApply(
          recipe.panes,
          new Set(Object.keys(ctx.manager.terminals)),
          () => ctx.effectiveCapabilityGateFor(null, "apply_recipe"),
          (id) => ctx.effectiveCapabilityGateFor(id, "create_pane"),
        );
        if (plan.layoutForbidden) {
          resp = `Error: the 'apply_recipe' capability is gated Off; spawning template layouts is forbidden by policy.`;
        } else {
          const paneById = new Map(recipe.panes.map((p) => [p.id, p]));
          const spawned: string[] = [];
          const deferred: string[] = [];
          const blocked: string[] = [];
          for (const planned of plan.panes) {
            if (planned.disposition === "skip-existing") continue;
            if (planned.disposition === "block") {
              blocked.push(planned.paneId);
              continue;
            }
            const p = paneById.get(planned.paneId)!;
            // KS (§5.4): same spawn closure shape as REST, launch DERIVED from the pane's preset via
            // the SAME single home presetCommand(normalizePreset(...)). startupCommand stays an
            // auditable note (never auto-run); broadcasts INSIDE so a deferred-confirm repaints.
            const panePreset = normalizePreset(p.preset);
            const paneCommand = presetCommand(
              panePreset,
              ctx.manager.settings.presets,
              ctx.manager.settings.advanced?.defaultShellCommand,
            );
            const spawnPane = (): string => {
              ctx.manager.addTerminal(
                p.id,
                proj.directory || process.cwd(),
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
            if (planned.disposition === "defer") {
              // Route through gateOrDefer so the audit row + action_pending broadcast +
              // pendingActions.add fire identically to REST. (The planner already classified Ask, so
              // this stages.) kzt: same create_pane intent shape as the REST recipe path
              // (origin:"recipe" -> rebuild returns the bare pane id) — keys in lockstep with
              // src/actionEffects.ts buildActionRun create_pane case.
              const g = ctx.gateOrDefer(
                "create_pane",
                p.id,
                `Create pane ${p.id} (recipe ${recipe.id})`,
                spawnPane,
                {
                  origin: "recipe",
                  paneId: p.id,
                  cwd: proj.directory || process.cwd(),
                  command: paneCommand,
                  toolPreset: panePreset,
                  permissionsMode: p.permissionsMode,
                  startupCommand: p.startupCommand,
                  projectId: activeProjectId,
                },
              );
              if (g.disposition === "forbidden") blocked.push(p.id);
              else if (g.disposition === "deferred") deferred.push(p.id);
              else {
                spawnPane();
                spawned.push(p.id);
              }
            } else {
              // Auto -> spawn now.
              spawnPane();
              spawned.push(p.id);
            }
          }
          resp =
            `Template recipe layout '${recipe.name}': spawned ${spawned.length} pane(s)` +
            (deferred.length
              ? `, ${deferred.length} awaiting your confirmation (create_pane=Ask: ${deferred.join(", ")})`
              : "") +
            (blocked.length
              ? `, ${blocked.length} blocked by create_pane=Off (${blocked.join(", ")})`
              : "") +
            ".";
        }
      }
    }
    return { kind: "ok", output: resp };
  },
};

/** The ORCH group registry array. */
export const ORCH_ACTIONS: ActionDef[] = [
  createOrchestratorPlan,
  executePlan,
  applyOrchestrationRecipe,
];
