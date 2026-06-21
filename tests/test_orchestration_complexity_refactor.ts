// tests/test_orchestration_complexity_refactor.ts
//
// CC-burndown PIN: src/actions/defs/orchestration.ts.
// Pins the CURRENT behavior of applyOrchestrationRecipe.handler (the flagged CC=16 function) across
// EVERY branch BEFORE a verbatim, behavior-preserving extraction. Also lightly pins the two sibling
// handlers (createOrchestratorPlan, executePlan) so an accidental cross-edit is caught. Def-level
// deterministic doctrine: drive the handler with a fake ActionContext; no server boot, no PTY.
//
// Branch coverage of applyOrchestrationRecipe.handler:
//   - no active project (proj === null) -> "no active project context" string, kind:ok
//   - recipe not found -> "Template recipe <id> not found" string, kind:ok
//   - layoutForbidden -> kind:'blocked' with the apply_recipe-gated-Off reason; NO spawn
//   - per-pane dispositions: skip-existing (skip), block (counted blocked), defer->forbidden,
//     defer->deferred, defer->run (spawns), and the AUTO ("spawn") path (spawns)
//   - the response string assembly (spawned/deferred/blocked clauses + trailing ".")
//   - startupCommand recorded as a pane note (never auto-run)
//   - gateCapability("apply_recipe", null) audit call fires; broadcasts inside spawnPane

import { describe, it } from "node:test";
import assert from "node:assert";

import {
  applyOrchestrationRecipe,
  createOrchestratorPlan,
  executePlan,
} from "../src/actions/defs/orchestration";
import type { ActionContext, ActionResult, GateDisposition } from "../src/actions/types";

// ── probe + fake ctx ──────────────────────────────────────────────────────────────────────────────
interface Probe {
  broadcasts: unknown[];
  ledgerSaves: number;
  ledgerUpdates: number;
  terminalsUpdated: number;
  gateCapabilityCalls: Array<{ capability: string; paneId: string | null }>;
  gateOrDeferCalls: Array<{ capability: string; paneId: string | null; summary: string; params?: Record<string, unknown> }>;
  addTerminalCalls: unknown[][];
  paneNotes: Array<{ projectId: string; paneId: string; note: string }>;
}

interface CtxOpts {
  projects?: Record<string, { directory?: string }>;
  activeProjectId?: string | null;
  existingTerminals?: Record<string, unknown>;
  recipes?: Array<{ id: string; name: string; panes: Array<{ id: string; name: string; startupCommand: string; preset: "Custom"; permissionsMode: string }> }>;
  layoutGate?: "Auto" | "Ask" | "Off";
  paneGate?: "Auto" | "Ask" | "Off";
  // gateOrDefer disposition for the per-pane create_pane defer path.
  gateDisposition?: GateDisposition;
}

function makeCtx(opts: CtxOpts = {}): { ctx: ActionContext; probe: Probe } {
  const probe: Probe = {
    broadcasts: [], ledgerSaves: 0, ledgerUpdates: 0, terminalsUpdated: 0,
    gateCapabilityCalls: [], gateOrDeferCalls: [], addTerminalCalls: [], paneNotes: [],
  };
  const activeProjectId = opts.activeProjectId === undefined ? "default_project" : opts.activeProjectId;
  const projects = opts.projects ?? {};
  const manager: any = {
    terminals: opts.existingTerminals ?? {},
    settings: { presets: undefined, advanced: { defaultShellCommand: "" } },
    addTerminal: (...a: unknown[]): string => { probe.addTerminalCalls.push(a); return "created"; },
    ledger: {
      activeProjectId,
      getProject: (id: string) => projects[id] ?? null,
      plans: [] as unknown[],
      addPaneNote: (projectId: string, paneId: string, note: string) => {
        probe.paneNotes.push({ projectId, paneId, note });
      },
    },
  };
  manager.ledger["save"] = (_force?: boolean) => { probe.ledgerSaves++; };

  const ctx = {
    manager,
    session: null,
    callId: "call-test",
    redact: (s: string) => s,
    broadcast: (m: unknown) => { probe.broadcasts.push(m); },
    broadcastLedgerUpdate: () => { probe.ledgerUpdates++; probe.broadcasts.push({ type: "ledger_updated" }); },
    gateCapability: (capability: string, paneId: string | null) => {
      probe.gateCapabilityCalls.push({ capability, paneId });
      return { forbidden: false, gate: "Auto" as const };
    },
    gateOrDefer: (capability: string, paneId: string | null, summary: string, run: () => string, params?: Record<string, unknown>): GateDisposition => {
      probe.gateOrDeferCalls.push({ capability, paneId, summary, params });
      void run; // gateOrDefer never runs the closure here; the handler runs it on "run".
      return opts.gateDisposition ?? { disposition: "run" as const };
    },
    effectiveCapabilityGateFor: (_paneId: unknown, capability: string) => {
      if (capability === "apply_recipe") return opts.layoutGate ?? "Auto";
      return opts.paneGate ?? "Auto";
    },
    recipes: opts.recipes ?? [],
  } as unknown as ActionContext;
  return { ctx, probe };
}

const RECIPE_ONE = {
  id: "full-stack",
  name: "Full Stack",
  panes: [{ id: "web", name: "Web", startupCommand: "npm run dev", preset: "Custom" as const, permissionsMode: "Human-in-the-Loop" }],
};

function run(ctx: ActionContext, args: { recipe_id: string }): ActionResult {
  return applyOrchestrationRecipe.handler(args as any, ctx) as ActionResult;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("CC-pin: applyOrchestrationRecipe.handler — guard branches", () => {
  it("no active project -> ok with 'no active project context' narration; nothing gated/spawned", () => {
    const { ctx, probe } = makeCtx({ activeProjectId: "missing", projects: {}, recipes: [RECIPE_ONE] });
    const res = run(ctx, { recipe_id: "full-stack" });
    assert.strictEqual(res.kind, "ok");
    assert.match((res as { output: string }).output, /no active project context/i);
    assert.strictEqual(probe.gateCapabilityCalls.length, 0);
    assert.strictEqual(probe.addTerminalCalls.length, 0);
  });

  it("activeProjectId null -> falls back to 'default_project'; still no project -> not-found narration", () => {
    const { ctx } = makeCtx({ activeProjectId: null, projects: {}, recipes: [RECIPE_ONE] });
    const res = run(ctx, { recipe_id: "full-stack" });
    assert.strictEqual(res.kind, "ok");
    assert.match((res as { output: string }).output, /no active project context/i);
  });

  it("recipe not found -> ok with 'Template recipe <id> not found'; no gate, no spawn", () => {
    const { ctx, probe } = makeCtx({
      activeProjectId: "proj", projects: { proj: { directory: "/p" } }, recipes: [RECIPE_ONE],
    });
    const res = run(ctx, { recipe_id: "no-such" });
    assert.strictEqual(res.kind, "ok");
    assert.match((res as { output: string }).output, /Template recipe no-such not found/);
    assert.strictEqual(probe.gateCapabilityCalls.length, 0);
    assert.strictEqual(probe.addTerminalCalls.length, 0);
  });
});

describe("CC-pin: applyOrchestrationRecipe.handler — layout veto", () => {
  it("layout apply_recipe=Off -> kind:'blocked' with the policy reason; NO pane spawned", () => {
    const { ctx, probe } = makeCtx({
      activeProjectId: "proj", projects: { proj: { directory: "/p" } },
      recipes: [RECIPE_ONE], layoutGate: "Off", paneGate: "Auto",
    });
    const res = run(ctx, { recipe_id: "full-stack" });
    assert.strictEqual(res.kind, "blocked");
    assert.match((res as { reason: string }).reason, /'apply_recipe' capability is gated Off/);
    assert.strictEqual(probe.addTerminalCalls.length, 0, "no spawn on layout Off");
    // the audit-only gateCapability("apply_recipe", null) still fired before the planner.
    assert.deepStrictEqual(probe.gateCapabilityCalls, [{ capability: "apply_recipe", paneId: null }]);
  });
});

describe("CC-pin: applyOrchestrationRecipe.handler — per-pane dispositions", () => {
  it("Auto layout + Auto pane -> spawns now; records startup note; broadcasts; ledger NOT saved", () => {
    const { ctx, probe } = makeCtx({
      activeProjectId: "proj", projects: { proj: { directory: "/dir" } },
      recipes: [RECIPE_ONE], layoutGate: "Auto", paneGate: "Auto",
    });
    const res = run(ctx, { recipe_id: "full-stack" });
    assert.strictEqual(res.kind, "ok");
    assert.match((res as { output: string }).output, /spawned 1 pane\(s\)\.$/);
    assert.strictEqual(probe.addTerminalCalls.length, 1);
    // addTerminal(id, cwd, command, preset, permsMode, "", projectId)
    const call = probe.addTerminalCalls[0];
    assert.strictEqual(call[0], "web");
    assert.strictEqual(call[1], "/dir");
    assert.strictEqual(call[6], "proj");
    // startupCommand becomes an auditable pane note (never auto-run).
    assert.strictEqual(probe.paneNotes.length, 1);
    assert.match(probe.paneNotes[0].note, /Suggested startup command: npm run dev/);
    assert.ok(probe.broadcasts.some((m) => (m as { type?: string }).type === "ledger_updated"));
    assert.ok(probe.broadcasts.some((m) => (m as { type?: string }).type === "terminals_updated"));
    assert.strictEqual(probe.ledgerSaves, 0, "handler does not call ledger.save (spawnPane broadcasts only)");
    // gateOrDefer is NOT called on the Auto pane path (planner classified 'spawn').
    assert.strictEqual(probe.gateOrDeferCalls.length, 0);
  });

  it("paneGate=Ask -> defer path through gateOrDefer; disposition 'deferred' -> counted deferred, NOT spawned", () => {
    const { ctx, probe } = makeCtx({
      activeProjectId: "proj", projects: { proj: { directory: "/dir" } },
      recipes: [RECIPE_ONE], layoutGate: "Auto", paneGate: "Ask",
      gateDisposition: { disposition: "deferred", actionId: "act1", summary: "Create pane web" },
    });
    const res = run(ctx, { recipe_id: "full-stack" });
    assert.strictEqual(res.kind, "ok");
    assert.match((res as { output: string }).output, /spawned 0 pane\(s\), 1 awaiting your confirmation \(create_pane=Ask: web\)\.$/);
    assert.strictEqual(probe.addTerminalCalls.length, 0, "deferred pane is not spawned now");
    assert.strictEqual(probe.gateOrDeferCalls.length, 1);
    assert.strictEqual(probe.gateOrDeferCalls[0].capability, "create_pane");
    assert.strictEqual(probe.gateOrDeferCalls[0].paneId, "web");
    // durable-restart intent keys present (origin recipe, the create_pane intent shape).
    const params = probe.gateOrDeferCalls[0].params!;
    assert.strictEqual(params.origin, "recipe");
    assert.strictEqual(params.paneId, "web");
    assert.strictEqual(params.projectId, "proj");
  });

  it("paneGate=Ask + gateOrDefer 'forbidden' -> counted blocked, NOT spawned", () => {
    const { ctx, probe } = makeCtx({
      activeProjectId: "proj", projects: { proj: { directory: "/dir" } },
      recipes: [RECIPE_ONE], layoutGate: "Auto", paneGate: "Ask",
      gateDisposition: { disposition: "forbidden" },
    });
    const res = run(ctx, { recipe_id: "full-stack" });
    assert.strictEqual(res.kind, "ok");
    assert.match((res as { output: string }).output, /spawned 0 pane\(s\), 1 blocked by create_pane=Off \(web\)\.$/);
    assert.strictEqual(probe.addTerminalCalls.length, 0);
  });

  it("paneGate=Ask + gateOrDefer 'run' -> handler spawns now and counts spawned", () => {
    const { ctx, probe } = makeCtx({
      activeProjectId: "proj", projects: { proj: { directory: "/dir" } },
      recipes: [RECIPE_ONE], layoutGate: "Auto", paneGate: "Ask",
      gateDisposition: { disposition: "run" },
    });
    const res = run(ctx, { recipe_id: "full-stack" });
    assert.strictEqual(res.kind, "ok");
    assert.match((res as { output: string }).output, /spawned 1 pane\(s\)\.$/);
    assert.strictEqual(probe.addTerminalCalls.length, 1, "gateOrDefer 'run' -> spawn now");
    assert.strictEqual(probe.gateOrDeferCalls.length, 1);
  });

  it("paneGate=Off -> planner 'block' disposition -> counted blocked WITHOUT calling gateOrDefer", () => {
    const { ctx, probe } = makeCtx({
      activeProjectId: "proj", projects: { proj: { directory: "/dir" } },
      recipes: [RECIPE_ONE], layoutGate: "Auto", paneGate: "Off",
    });
    const res = run(ctx, { recipe_id: "full-stack" });
    assert.strictEqual(res.kind, "ok");
    assert.match((res as { output: string }).output, /spawned 0 pane\(s\), 1 blocked by create_pane=Off \(web\)\.$/);
    assert.strictEqual(probe.addTerminalCalls.length, 0);
    assert.strictEqual(probe.gateOrDeferCalls.length, 0, "Off is classified by the planner; no gateOrDefer call");
  });

  it("existing pane -> planner 'skip-existing' -> not spawned, not counted; narrates 0 spawned", () => {
    const { ctx, probe } = makeCtx({
      activeProjectId: "proj", projects: { proj: { directory: "/dir" } },
      existingTerminals: { web: {} },
      recipes: [RECIPE_ONE], layoutGate: "Auto", paneGate: "Auto",
    });
    const res = run(ctx, { recipe_id: "full-stack" });
    assert.strictEqual(res.kind, "ok");
    assert.match((res as { output: string }).output, /spawned 0 pane\(s\)\.$/);
    assert.strictEqual(probe.addTerminalCalls.length, 0, "existing pane is skipped");
  });

  it("mixed multi-pane recipe: spawn + defer + block clauses all present in one narration", () => {
    const recipe = {
      id: "mix", name: "Mix",
      panes: [
        { id: "a", name: "A", startupCommand: "", preset: "Custom" as const, permissionsMode: "Full Auto" },
        { id: "b", name: "B", startupCommand: "echo b", preset: "Custom" as const, permissionsMode: "Human-in-the-Loop" },
      ],
    };
    // Pane "a": Auto (spawn). Pane "b": gate per-pane = Off so it is classified 'block'.
    const { ctx, probe } = makeCtx({
      activeProjectId: "proj", projects: { proj: { directory: "/dir" } },
      recipes: [recipe], layoutGate: "Auto",
    });
    // Per-pane gate: a=Auto, b=Off via a custom effectiveCapabilityGateFor override.
    (ctx as any).effectiveCapabilityGateFor = (paneId: unknown, capability: string) => {
      if (capability === "apply_recipe") return "Auto";
      return paneId === "b" ? "Off" : "Auto";
    };
    const res = run(ctx, { recipe_id: "mix" });
    assert.strictEqual(res.kind, "ok");
    const out = (res as { output: string }).output;
    assert.match(out, /spawned 1 pane\(s\)/);
    assert.match(out, /1 blocked by create_pane=Off \(b\)/);
    assert.match(out, /\.$/);
    assert.strictEqual(probe.addTerminalCalls.length, 1, "only pane a spawned");
    // pane a has empty startupCommand -> no pane note recorded.
    assert.strictEqual(probe.paneNotes.length, 0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Light sibling pins (cross-edit tripwire) — not the flagged function, but in the same file.
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("CC-pin: createOrchestratorPlan.handler (sibling tripwire)", () => {
  it("pushes a plan, saves, broadcasts plans_updated, returns the fixed template", () => {
    const plans: any[] = [];
    let saved = false;
    const broadcasts: any[] = [];
    const ledger: any = { plans, save: undefined };
    ledger["save"] = (_f?: boolean) => { saved = true; };
    const ctx = {
      manager: { ledger },
      broadcast: (m: unknown) => broadcasts.push(m),
    } as unknown as ActionContext;
    const res = createOrchestratorPlan.handler(
      { name: "P", steps: [{ terminalId: "t1", command: "ls", expectedTransition: "" }] } as any,
      ctx,
    ) as ActionResult;
    assert.strictEqual(res.kind, "ok");
    assert.match((res as { output: string }).output, /Multi-pane plan 'P' created\. Contains 1 steps\./);
    assert.strictEqual(plans.length, 1);
    assert.strictEqual(plans[0].steps[0].expectedTransition, "idle", "empty expectedTransition falls back to idle");
    assert.strictEqual(plans[0].steps[0].id, "step_0");
    assert.ok(saved);
    assert.ok(broadcasts.some((m) => m.type === "plans_updated"));
  });
});

describe("CC-pin: executePlan.handler (sibling tripwire)", () => {
  function executeCtx(dispatchOutcome: { kind: string; text?: string }, plan: any) {
    const plans = plan ? [plan] : [];
    const broadcasts: any[] = [];
    let saved = false;
    const ledger: any = { plans };
    ledger["save"] = () => { saved = true; };
    const ctx = {
      manager: { ledger },
      session: null,
      callId: "cid",
      broadcast: (m: unknown) => broadcasts.push(m),
      dispatchProposal: () => dispatchOutcome,
    } as unknown as ActionContext;
    return { ctx, broadcasts, savedRef: () => saved };
  }

  it("plan not found -> ok + meta.outcome plan_not_found", () => {
    const { ctx } = executeCtx({ kind: "executed", text: "x" }, null);
    const res = executePlan.handler({ plan_id: "nope" } as any, ctx) as ActionResult;
    assert.strictEqual(res.kind, "ok");
    assert.strictEqual((res as any).meta.outcome, "plan_not_found");
    assert.match((res as { output: string }).output, /Plan 'nope' not found/);
  });

  it("executed dispatch -> outcome executed; plan running", () => {
    const plan = { id: "pl", name: "Plan", status: "idle", currentStepIndex: 9, steps: [{ terminalId: "t1", command: "ls", status: "pending" }] };
    const { ctx } = executeCtx({ kind: "executed", text: "ok" }, plan);
    const res = executePlan.handler({ plan_id: "pl" } as any, ctx) as ActionResult;
    assert.strictEqual((res as any).meta.outcome, "executed");
    assert.strictEqual(plan.status, "running");
    assert.strictEqual(plan.steps[0].status, "running");
  });

  it("pending dispatch -> outcome pending", () => {
    const plan = { id: "pl", name: "Plan", status: "idle", currentStepIndex: 0, steps: [{ terminalId: "t1", command: "ls", status: "pending" }] };
    const { ctx } = executeCtx({ kind: "pending", text: "needs ok" }, plan);
    const res = executePlan.handler({ plan_id: "pl" } as any, ctx) as ActionResult;
    assert.strictEqual((res as any).meta.outcome, "pending");
    assert.match((res as { output: string }).output, /needs approval: needs ok/);
  });

  it("clarify dispatch -> outcome clarify; plan paused, step failed", () => {
    const plan = { id: "pl", name: "Plan", status: "idle", currentStepIndex: 0, steps: [{ terminalId: "t1", command: "ls", status: "pending" }] };
    const { ctx } = executeCtx({ kind: "clarify", text: "huh" }, plan);
    const res = executePlan.handler({ plan_id: "pl" } as any, ctx) as ActionResult;
    assert.strictEqual((res as any).meta.outcome, "clarify");
    assert.strictEqual(plan.status, "paused");
    assert.strictEqual(plan.steps[0].status, "failed");
  });

  it("blocked dispatch -> outcome blocked; error dispatch -> outcome pane_offline", () => {
    const plan1 = { id: "pl", name: "Plan", status: "idle", currentStepIndex: 0, steps: [{ terminalId: "t1", command: "ls", status: "pending" }] };
    const r1 = executePlan.handler({ plan_id: "pl" } as any, executeCtx({ kind: "blocked", text: "off" }, plan1).ctx) as ActionResult;
    assert.strictEqual((r1 as any).meta.outcome, "blocked");

    const plan2 = { id: "pl", name: "Plan", status: "idle", currentStepIndex: 0, steps: [{ terminalId: "t1", command: "ls", status: "pending" }] };
    const r2 = executePlan.handler({ plan_id: "pl" } as any, executeCtx({ kind: "error", text: "offline" }, plan2).ctx) as ActionResult;
    assert.strictEqual((r2 as any).meta.outcome, "pane_offline");
  });
});
