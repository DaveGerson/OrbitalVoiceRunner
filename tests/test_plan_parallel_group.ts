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
