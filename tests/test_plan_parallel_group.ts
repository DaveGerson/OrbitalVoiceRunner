// tests/test_plan_parallel_group.ts — BUG-011 (residual): execute_plan must support a PARALLEL
// step group. Today execute_plan (src/actions/defs/orchestration.ts:172-225) dispatches ONLY
// plan.steps[0] and PlanStep (src/types.ts:582-596) has no parallel-group marker, so
// "run tests on all three panes at once" runs strictly serially.
//
// REQUIRED post-fix behavior this suite pins (all PTY-free / no server boot / no Gemini):
//   (a) PlanStep gains an OPTIONAL `group?: string` marker. Consecutive leading steps that share the
//       same non-undefined group value form ONE parallel group.
//   (b) When execute_plan's leading step(s) form a parallel group, ALL members dispatch in that ONE
//       invocation (one ctx.dispatchProposal per member) and a join group is registered in the shared
//       dispatchJoinTracker with one member per group pane.
//   (c) currentStepIndex stays at the group start (0) — the group has NOT advanced yet; advancement
//       past the group is the observe layer's job once every member reaches its expectedTransition.
//   (d) GUARD: a plan with NO parallel-group marker still dispatches EXACTLY step 0 and registers NO
//       join group (the sequential path is byte-identical).
//
// These assertions are deliberately implementation-agnostic about HOW each member is dispatched
// (direct per-member ctx.dispatchProposal vs the stageDispatchGroup kernel) and about the join
// group's name/instruction — they pin only the observable fan-out (N dispatches, N join members,
// N leading steps marked running, index unchanged). See scratchpad/design/W6-plans-context-mock.md.
//
// Runner: npx tsx --test --test-force-exit tests/test_plan_parallel_group.ts

import { describe, it } from "node:test";
import assert from "node:assert";

import { REGISTRY } from "../src/actions/registry";
import { runAction } from "../src/actions/gemini";
import { dispatchJoinTracker } from "../src/dispatch/joinTracker";
import type { ActionContext, DispatchOutcome } from "../src/actions/types";

// ── observe-layer harness (join-gated advancement suite at the bottom) — idiom lifted verbatim from
//    tests/test_observe_pipeline.ts so handlePlansTrigger's group-awareness (design §c) is driven E2E. ──
import { attachObserve } from "../src/observe";
import { AnnouncementBus, DEFAULT_ANNOUNCEMENT_TEMPLATES } from "../src/announcementBus";
import { PaneSignalBus } from "../src/paneSignalBus";
import { InteractionLogger } from "../src/interactionLog";
import type { OrchestratorManager } from "../src/terminal";

// ── A step in a fake plan, optionally carrying the new parallel-group marker. ──────────────────────
interface FakeStep {
  id: string;
  terminalId: string;
  command: string;
  expectedTransition: "idle" | "prompt";
  status: "pending" | "running" | "completed" | "failed";
  /** BUG-011 fix: the parallel-group marker under test. */
  group?: string;
}

interface DispatchRec {
  targetId: string;
  instruction: string;
  pendingId: string | undefined;
}

/**
 * A fake ctx for the execute_plan handler (shape follows test_c55_9_execute_plan.ts's makePlanCtx):
 * a ledger with the supplied plan, a dispatchProposal stub that RECORDS every call and returns the
 * per-target outcome (default: executed), plus save/broadcast recorders. No PTY, no real gate.
 */
function makePlanCtx(
  steps: FakeStep[],
  outcomes: Record<string, DispatchOutcome> = {},
): { ctx: ActionContext; plan: { steps: FakeStep[]; currentStepIndex: number; status: string }; rec: { dispatched: DispatchRec[]; saves: number; broadcasts: Array<Record<string, unknown>> } } {
  const rec = { dispatched: [] as DispatchRec[], saves: 0, broadcasts: [] as Array<Record<string, unknown>> };
  const plan = { id: "plan_1", name: "P", steps, currentStepIndex: 0, status: "idle" };
  const ctx = {
    session: null,
    callId: "call",
    manager: {
      ledger: {
        plans: [plan],
        save: (_force?: boolean): void => { rec.saves++; },
      },
    },
    dispatchProposal: (opts: { targetId: string; instruction: string; pendingId?: string }): DispatchOutcome => {
      rec.dispatched.push({ targetId: opts.targetId, instruction: opts.instruction, pendingId: opts.pendingId });
      return outcomes[opts.targetId] ?? { kind: "executed", text: "ran" };
    },
    broadcast: (msg: unknown): void => { rec.broadcasts.push(msg as Record<string, unknown>); },
    redact: (s: string) => s,
  } as unknown as ActionContext;
  return { ctx, plan, rec };
}

/** Run execute_plan and return the newly-registered dispatchJoinTracker group (diffing the shared
 *  singleton around the call, like test_dispatch_join.ts's runDispatch). */
async function runExecutePlan(ctx: ActionContext): Promise<{ result: Awaited<ReturnType<typeof runAction>>; group: ReturnType<typeof dispatchJoinTracker.list>[number] | undefined }> {
  const before = dispatchJoinTracker.list().length;
  const result = await runAction(REGISTRY, "execute_plan", { plan_id: "plan_1" }, ctx);
  const after = dispatchJoinTracker.list();
  return { result, group: after.length > before ? after[after.length - 1] : undefined };
}

function parallelStep(idx: number, group: string): FakeStep {
  return { id: `step_${idx}`, terminalId: `p${idx + 1}`, command: `cmd${idx}`, expectedTransition: "idle", status: "pending", group };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Parallel group: a plan whose leading 3 steps share a group -> all 3 dispatch + a join is tracked
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("execute_plan — leading parallel group (BUG-011)", () => {
  // 3 parallel members (group "g1") on p1/p2/p3, then ONE trailing sequential step (no group) on p4.
  function threeParallelPlusTail(): FakeStep[] {
    return [
      parallelStep(0, "g1"),
      parallelStep(1, "g1"),
      parallelStep(2, "g1"),
      { id: "step_3", terminalId: "p4", command: "cmd3", expectedTransition: "idle", status: "pending" },
    ];
  }

  it("dispatches ALL 3 group members in ONE invocation (not just step 0)", async () => {
    const { ctx, rec } = makePlanCtx(threeParallelPlusTail());
    const { result } = await runExecutePlan(ctx);
    assert.strictEqual(result.kind, "ok", "execute_plan still answers kind:ok");
    assert.strictEqual(rec.dispatched.length, 3, "one dispatchProposal per parallel-group member (was 1 — only step 0)");
    assert.deepStrictEqual(
      rec.dispatched.map((d) => d.targetId).sort(),
      ["p1", "p2", "p3"],
      "every group member's pane was dispatched",
    );
    // the trailing sequential step (no group marker) must NOT dispatch in this invocation.
    assert.ok(!rec.dispatched.some((d) => d.targetId === "p4"), "the post-group sequential step does not fan out");
    // distinct synthetic pendingIds per member (no functionCall-id collision).
    const ids = rec.dispatched.map((d) => d.pendingId);
    assert.strictEqual(new Set(ids).size, 3, "each group member gets a DISTINCT synthetic pendingId");
  });

  it("registers a dispatchJoinTracker group with one member per group pane", async () => {
    const { ctx } = makePlanCtx(threeParallelPlusTail());
    const { group } = await runExecutePlan(ctx);
    assert.ok(group, "a join group is registered for the parallel plan group (none today)");
    assert.deepStrictEqual(
      group!.members.map((m) => m.paneId).sort(),
      ["p1", "p2", "p3"],
      "the join group tracks exactly the 3 parallel members",
    );
    assert.strictEqual(group!.completed, false, "the freshly-staged join group is not yet complete");
  });

  it("marks every leading-group step running; the post-group step stays pending; index stays at 0", async () => {
    const { ctx, plan } = makePlanCtx(threeParallelPlusTail());
    await runExecutePlan(ctx);
    assert.deepStrictEqual(
      plan.steps.map((s) => s.status),
      ["running", "running", "running", "pending"],
      "all 3 group members go running together; the trailing sequential step remains pending",
    );
    assert.strictEqual(plan.currentStepIndex, 0, "the group has not advanced — index stays at the group start");
    assert.strictEqual(plan.status, "running", "the plan is running");
  });

  // GATING GUARD (BUG-011): every member — including a refused one — must be routed through the SAME
  // gated choke-point ctx.dispatchProposal. This pins that a lazy fan-out can't silently write a
  // member around the gate, AND that a per-member refusal (Off pane -> blocked) is HONORED: the
  // member's step is failed (not left running forever) and the join records it blocked. Mirrors the
  // single-step handler's blocked->failed mapping (orchestration.ts) and the per-target gating idiom
  // from tests/test_dispatch_join.ts / test_c55_9_execute_plan.ts's Off->blocked case. Deliberately
  // mechanism-agnostic (no capability-string assertion — the design leaves that a free choice).
  it("routes a gated-Off member through the choke-point and honors its refusal (blocked -> step failed)", async () => {
    const { ctx, plan, rec } = makePlanCtx(threeParallelPlusTail(), { p2: { kind: "blocked", text: "gated Off" } });
    const { result, group } = await runExecutePlan(ctx);
    assert.strictEqual(result.kind, "ok");
    // All 3 members attempted through the gate — the Off pane is REFUSED there, never written around it.
    assert.strictEqual(rec.dispatched.length, 3, "every member (incl. the Off pane) is routed through ctx.dispatchProposal");
    assert.ok(rec.dispatched.some((d) => d.targetId === "p2"), "the Off pane member went through the gated choke-point");
    // The refusal is honored on the plan board: p2's step is failed, NOT left sitting 'running'
    // (a member stuck 'running' would make the join wait forever); the other two run.
    assert.deepStrictEqual(
      plan.steps.map((s) => s.status),
      ["running", "failed", "running", "pending"],
      "blocked member's step is failed; the two auto-executed members run; the tail stays pending",
    );
    // And the join group records the member as blocked (per-target gating, like dispatch_to_panes).
    assert.ok(group, "a join group is registered even with a blocked member");
    const m2 = group!.members.find((m) => m.paneId === "p2");
    assert.strictEqual(m2!.status, "blocked", "the join group records the Off member as blocked");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// GUARD: a plan with NO parallel-group marker is byte-identical to today — exactly step 0, no join
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("execute_plan — sequential guard (no group marker: unchanged)", () => {
  function threeSequential(): FakeStep[] {
    return [
      { id: "step_0", terminalId: "p1", command: "cmd0", expectedTransition: "idle", status: "pending" },
      { id: "step_1", terminalId: "p2", command: "cmd1", expectedTransition: "idle", status: "pending" },
      { id: "step_2", terminalId: "p3", command: "cmd2", expectedTransition: "idle", status: "pending" },
    ];
  }

  it("dispatches EXACTLY step 0 and registers NO join group", async () => {
    const { ctx, rec } = makePlanCtx(threeSequential());
    const { result, group } = await runExecutePlan(ctx);
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(rec.dispatched.length, 1, "sequential plan dispatches only step 0");
    assert.strictEqual(rec.dispatched[0].targetId, "p1", "step 0's pane");
    assert.strictEqual(group, undefined, "no fan-out -> no join group for a sequential plan");
  });

  it("marks only step 0 running; the rest stay pending; index stays at 0", async () => {
    const { ctx, plan } = makePlanCtx(threeSequential());
    await runExecutePlan(ctx);
    assert.deepStrictEqual(plan.steps.map((s) => s.status), ["running", "pending", "pending"]);
    assert.strictEqual(plan.currentStepIndex, 0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// JOIN-GATED ADVANCEMENT (observe layer, BUG-011 design §c): execute_plan (above) only DISPATCHES the
// group and pins index==0; the advancement authority lives in src/observe/index.ts's handlePlansTrigger.
// The REQUIRED post-fix behavior: a plan advances PAST a leading parallel group ONLY once EVERY member
// has reached its expectedTransition — never on the first member's edge. Without this, the cheap fake
// the campaign warns about (advance the moment the first member completes) would pass the dispatch-side
// suite above. Drives the REAL attachObserve pipeline (harness idiom: tests/test_observe_pipeline.ts).
//
// Hermetic pane ids (obs1..obs4) so the module-singleton dispatchJoinTracker (which the execute_plan
// suite above populates on p1/p2/p3) can never settle a lingering group on this suite's edges.
// ════════════════════════════════════════════════════════════════════════════════════════════════

interface ObservePlan {
  id: string;
  name: string;
  steps: FakeStep[];
  currentStepIndex: number;
  status: string;
}

/** A plan whose leading 3 steps form parallel group "g1" (obs1/obs2/obs3), then one sequential tail. */
function groupPlan(): ObservePlan {
  return {
    id: "plan_obs",
    name: "P",
    currentStepIndex: 0,
    status: "running",
    steps: [
      { id: "step_0", terminalId: "obs1", command: "c0", expectedTransition: "idle", status: "running", group: "g1" },
      { id: "step_1", terminalId: "obs2", command: "c1", expectedTransition: "idle", status: "running", group: "g1" },
      { id: "step_2", terminalId: "obs3", command: "c2", expectedTransition: "idle", status: "running", group: "g1" },
      { id: "step_3", terminalId: "obs4", command: "c3", expectedTransition: "idle", status: "pending" },
    ],
  };
}

function makeObserveManager(plan: ObservePlan): OrchestratorManager {
  // Idle, NON-shell panes so a benign chunk classifies as a plain "idle" edge (classifyIdleRefinement:
  // a non-shell pane is always "idle", never the shell-prompt "prompt" refinement).
  const term = () => ({ status: "Idle", runtimeType: "claude", lastCommand: "" });
  const attentionQueue: unknown[] = [];
  return {
    terminals: { obs1: term(), obs2: term(), obs3: term(), obs4: term() },
    attentionQueue,
    // W5: observe push sites route through manager.pushAttention now (mirror the in-memory append).
    pushAttention: (item: unknown) => attentionQueue.push(item),
    settings: { secrets: {} },
    ledger: {
      watchRules: [] as unknown[],
      plans: [plan],
      activeProjectId: "proj_test",
      save: () => {},
    },
  } as unknown as OrchestratorManager;
}

function makeObserveDeps(broadcast: (msg: unknown) => void) {
  return {
    broadcast,
    announcementBus: new AnnouncementBus({ broadcast: () => {}, getTemplates: () => DEFAULT_ANNOUNCEMENT_TEMPLATES }),
    paneSignalBus: new PaneSignalBus(0),
    pruneAttention: () => {},
    interactionLog: new InteractionLogger({ sink: () => {} }),
    getLastInteractionId: () => null,
    setLastInteractionId: (_v: string | null) => {},
    redact: (s: string) => s,
    historyManager: { loadHistory: () => [], saveHistory: () => {}, appendOutputToLastCommand: () => {} },
    ai: {} as never,
  };
}

/** Feed one benign 'idle' transition edge for `paneId` through the real observe pipeline. */
function idleEdge(onOutput: (t: string, c: string) => void, paneId: string): void {
  onOutput(paneId, "tests passed\n");
}

describe("execute_plan parallel group — join-gated advancement (observe layer, BUG-011)", () => {
  it("does NOT advance past the group on the FIRST member's idle edge (still joining)", () => {
    const plan = groupPlan();
    const { onOutput } = attachObserve(makeObserveManager(plan), makeObserveDeps(() => {}) as never);
    idleEdge(onOutput, "obs1");
    assert.strictEqual(plan.currentStepIndex, 0, "one member done is NOT the whole group — index must stay at the group start");
    assert.strictEqual(plan.status, "running", "the plan is still running (the group is joining), not paused/advanced");
    assert.strictEqual(plan.steps[0].status, "completed", "the settled member is marked completed");
    assert.strictEqual(plan.steps[1].status, "running", "the not-yet-settled members stay running");
    assert.strictEqual(plan.steps[2].status, "running");
  });

  it("advances past the whole group ONLY after the LAST member settles", () => {
    const plan = groupPlan();
    const { onOutput } = attachObserve(makeObserveManager(plan), makeObserveDeps(() => {}) as never);
    idleEdge(onOutput, "obs1");
    idleEdge(onOutput, "obs2");
    assert.strictEqual(plan.currentStepIndex, 0, "two of three members done still does NOT advance the group");
    idleEdge(onOutput, "obs3");
    assert.strictEqual(plan.currentStepIndex, 3, "once every member settles, advance PAST the group to the first post-group step");
    assert.deepStrictEqual(
      plan.steps.map((s) => s.status),
      ["completed", "completed", "completed", "pending"],
      "all 3 members completed; the post-group step is surfaced (pending) — never auto-run",
    );
  });
});
