/**
 * tests/test_dispatch_join.ts — MULTI-PANE DISPATCH + JOIN (journey-expansion work item B, spec §7).
 *
 * Three layers, all PTY-free / no server boot / no Gemini:
 *   (1) DispatchJoinTracker lifecycle (fresh instances, pure bookkeeping): create -> members staged;
 *       noteRunning flips staged->running ONLY; noteTransition idle settles running->done and returns
 *       the group EXACTLY once (the second idle returns []); error/build-failed/exited settle as
 *       error; prompt is NOT a settle edge; a mixed blocked+done group completes on the last settle;
 *       settledAtDispatch is true when every write was refused; the registry is a bounded ring of 50.
 *   (2) dispatch_to_panes handler (stub ctx through the real runAction choke-point): every
 *       ctx.dispatchProposal call carries forceStage:true with a DISTINCT synthetic pendingId per
 *       pane; pending outcomes record as staged, blocked outcomes record + narrate as not staged;
 *       the template path resolves/instantiates (unknown template -> ok narration, missing slot
 *       values -> clarify, the instantiated text reaches dispatchProposal.instruction); duplicate
 *       pane_ids are deduped; dispatch_updated is broadcast.
 *   (3) applyDispatchDecision forceStage semantics (fixture shape follows test_c55_9_execute_plan):
 *       with forceStage=true an auto_execute decision STAGES a pending approval (pendingApprovals.add
 *       + approval_pending notify + kind pending) even on the VOICE binding (enforceActivePaneGuard
 *       =true) targeting a NON-active pane; with forceStage=false the SAME setup returns kind clarify
 *       — the active-pane guard is intact.
 *
 * Runner: npx tsx --test --test-force-exit tests/test_dispatch_join.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert";

import { DispatchJoinTracker, dispatchJoinTracker } from "../src/dispatch/joinTracker";
import { applyDispatchDecision, type DispatchDeps, type DispatchConn } from "../src/dispatch/paneWrite";
import { inferKind } from "../src/pendingApprovals";
import { isPaneActiveForWrite } from "../src/activePane";
import { REGISTRY } from "../src/actions/registry";
import { runAction } from "../src/actions/gemini";
import type { ActionContext, DispatchOutcome, DispatchProposalArgs } from "../src/actions/types";
import type { PromptTemplate, CapabilityGate, GateValue } from "../src/types";

// ════════════════════════════════════════════════════════════════════════════════════════════════
// (1) DispatchJoinTracker lifecycle — fresh instances, pure bookkeeping
// ════════════════════════════════════════════════════════════════════════════════════════════════

describe("DispatchJoinTracker — member lifecycle", () => {
  it("create: every member starts staged; group is listed and findable", () => {
    const t = new DispatchJoinTracker();
    const g = t.create("brief", "do the thing", ["p1", "p2"]);
    assert.deepStrictEqual(
      g.members.map((m) => ({ paneId: m.paneId, status: m.status })),
      [
        { paneId: "p1", status: "staged" },
        { paneId: "p2", status: "staged" },
      ]
    );
    assert.strictEqual(g.completed, false);
    assert.strictEqual(t.get(g.id), g);
    assert.strictEqual(t.list().length, 1);
  });

  it("noteRunning flips staged->running ONLY (settled members are untouched)", () => {
    const t = new DispatchJoinTracker();
    const g = t.create("brief", "x", ["p1", "p2"]);
    t.recordOutcome(g.id, "p2", "blocked", "policy");
    t.noteRunning("p1");
    t.noteRunning("p2"); // blocked must NOT flip
    assert.strictEqual(g.members[0].status, "running");
    assert.strictEqual(g.members[1].status, "blocked");
    // a done member never re-runs either
    t.noteTransition("p1", "idle");
    assert.strictEqual(g.members[0].status, "done");
    t.noteRunning("p1");
    assert.strictEqual(g.members[0].status, "done", "done is terminal — noteRunning must not resurrect it");
  });

  it("idle settles running->done and returns the newly-completed group EXACTLY once", () => {
    const t = new DispatchJoinTracker();
    const g = t.create("brief", "x", ["p1"]);
    t.noteRunning("p1");
    const first = t.noteTransition("p1", "idle");
    assert.deepStrictEqual(first.map((x) => x.id), [g.id], "the completing edge returns the group");
    assert.strictEqual(g.completed, true);
    assert.strictEqual(g.members[0].status, "done");
    assert.ok(typeof g.completedAt === "number");
    const second = t.noteTransition("p1", "idle");
    assert.deepStrictEqual(second, [], "a second idle returns [] — completion announces once");
  });

  it("idle does NOT settle a still-staged member (only running settles)", () => {
    const t = new DispatchJoinTracker();
    const g = t.create("brief", "x", ["p1"]);
    const out = t.noteTransition("p1", "idle"); // member is staged (approval unresolved)
    assert.deepStrictEqual(out, []);
    assert.strictEqual(g.members[0].status, "staged", "a staged member must survive an idle edge");
    assert.strictEqual(g.completed, false);
  });

  for (const edge of ["error", "build-failed", "exited"] as const) {
    it(`${edge} settles running->error (with the pane-edge detail)`, () => {
      const t = new DispatchJoinTracker();
      const g = t.create("brief", "x", ["p1"]);
      t.noteRunning("p1");
      const out = t.noteTransition("p1", edge);
      assert.strictEqual(g.members[0].status, "error");
      assert.strictEqual(g.members[0].detail, `pane ${edge}`);
      assert.deepStrictEqual(out.map((x) => x.id), [g.id], "an all-error group still completes");
    });
  }

  it("prompt is IGNORED (not a settle edge)", () => {
    const t = new DispatchJoinTracker();
    const g = t.create("brief", "x", ["p1"]);
    t.noteRunning("p1");
    const out = t.noteTransition("p1", "prompt");
    assert.deepStrictEqual(out, []);
    assert.strictEqual(g.members[0].status, "running", "prompt must leave the member in flight");
    assert.strictEqual(g.completed, false);
  });

  it("mixed blocked + done: the group completes when the LAST in-flight member settles", () => {
    const t = new DispatchJoinTracker();
    const g = t.create("brief", "x", ["p1", "p2"]);
    t.recordOutcome(g.id, "p1", "blocked", "gated Off");
    t.noteRunning("p2");
    assert.strictEqual(g.completed, false, "still one running member");
    const out = t.noteTransition("p2", "idle");
    assert.deepStrictEqual(out.map((x) => x.id), [g.id]);
    assert.strictEqual(g.completed, true);
    assert.deepStrictEqual(
      g.members.map((m) => m.status),
      ["blocked", "done"]
    );
  });

  it("settledAtDispatch: true when ALL writes were refused, false while anything is staged/running", () => {
    const t = new DispatchJoinTracker();
    const g = t.create("brief", "x", ["p1", "p2"]);
    assert.strictEqual(t.settledAtDispatch(g), false, "freshly staged members are not settled");
    t.recordOutcome(g.id, "p1", "blocked");
    assert.strictEqual(t.settledAtDispatch(g), false, "one member still staged");
    t.recordOutcome(g.id, "p2", "error", "pane offline");
    assert.strictEqual(t.settledAtDispatch(g), true, "every member refused -> settled at dispatch");
  });

  it("bounded ring: the registry keeps at most 50 groups (oldest evicted)", () => {
    const t = new DispatchJoinTracker();
    const ids: string[] = [];
    for (let i = 0; i < 55; i++) ids.push(t.create(`g${i}`, "x", ["p1"], 1000 + i).id);
    assert.strictEqual(t.list().length, 50, "ring capped at 50");
    for (let i = 0; i < 5; i++) {
      assert.strictEqual(t.get(ids[i]), undefined, `oldest group ${ids[i]} must be evicted`);
    }
    assert.ok(t.get(ids[54]), "the newest group survives");
    assert.ok(t.get(ids[5]), "the 6th-oldest (now the ring head) survives");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// (2) dispatch_to_panes handler — stub ctx, real runAction; the module SINGLETON tracker registers
// ════════════════════════════════════════════════════════════════════════════════════════════════

interface DispatchProbe {
  calls: DispatchProposalArgs[];
  broadcasts: Array<Record<string, unknown>>;
}

function makeDispatchCtx(opts?: {
  templates?: PromptTemplate[];
  /** Outcome per paneId; default pending (the forceStage steady state). */
  outcomes?: Record<string, DispatchOutcome>;
}): { ctx: ActionContext; probe: DispatchProbe } {
  const probe: DispatchProbe = { calls: [], broadcasts: [] };
  const ctx = {
    manager: { ledger: { promptTemplates: opts?.templates ?? [] } },
    session: null,
    callId: "call-1",
    userUtterance: "fan it out",
    redact: (s: string) => s,
    broadcast: (msg: unknown): void => {
      probe.broadcasts.push(msg as Record<string, unknown>);
    },
    dispatchProposal: (args: DispatchProposalArgs): DispatchOutcome => {
      probe.calls.push(args);
      return opts?.outcomes?.[args.targetId] ?? { kind: "pending", text: `staged on ${args.targetId}` };
    },
  } as unknown as ActionContext;
  return { ctx, probe };
}

/** The singleton tracker is module-shared — diff group count around the call to find OUR group. */
async function runDispatch(
  ctx: ActionContext,
  args: Record<string, unknown>
): Promise<{ result: Awaited<ReturnType<typeof runAction>>; group: ReturnType<typeof dispatchJoinTracker.list>[number] | undefined }> {
  const before = dispatchJoinTracker.list().length;
  const result = await runAction(REGISTRY, "dispatch_to_panes", args, ctx);
  const after = dispatchJoinTracker.list();
  return { result, group: after.length > before ? after[after.length - 1] : undefined };
}

describe("dispatch_to_panes — the forceStage fan-out", () => {
  it("every dispatchProposal call carries forceStage:true and a DISTINCT per-pane pendingId", async () => {
    const { ctx, probe } = makeDispatchCtx();
    const { result, group } = await runDispatch(ctx, { pane_ids: ["p1", "p2"], instruction: "run the suite" });
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(probe.calls.length, 2);
    for (const call of probe.calls) {
      assert.strictEqual(call.forceStage, true, "the fan-out invariant: EVERY write is forceStage:true");
      assert.strictEqual(call.instruction, "run the suite");
      assert.strictEqual(call.capability, "write_to_pane");
    }
    const pendingIds = probe.calls.map((c) => c.pendingId);
    assert.strictEqual(new Set(pendingIds).size, 2, "pendingIds must be distinct per pane (no callId collision)");
    assert.ok(pendingIds[0]!.includes("p1") && pendingIds[1]!.includes("p2"), "pendingId carries its paneId");
    // pending outcomes record as staged on the group
    assert.ok(group, "a group was registered");
    assert.deepStrictEqual(
      group!.members.map((m) => ({ paneId: m.paneId, status: m.status })),
      [
        { paneId: "p1", status: "staged" },
        { paneId: "p2", status: "staged" },
      ]
    );
    const out = String((result as { output: unknown }).output);
    assert.ok(out.includes("staged 2 approval(s)"), `narration counts the staged approvals (got: ${out})`);
    assert.ok(probe.broadcasts.some((b) => b.type === "dispatch_updated"), "dispatch_updated broadcast");
  });

  it("blocked outcome: recorded on the group + narrated as not staged", async () => {
    const { ctx, probe } = makeDispatchCtx({
      outcomes: { p2: { kind: "blocked", text: "gated Off" } },
    });
    const { result, group } = await runDispatch(ctx, { pane_ids: ["p1", "p2"], instruction: "go" });
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(probe.calls.length, 2, "the blocked pane was still attempted (per-target gating)");
    assert.ok(group);
    const p2 = group!.members.find((m) => m.paneId === "p2")!;
    assert.strictEqual(p2.status, "blocked");
    assert.strictEqual(p2.detail, "gated Off");
    assert.strictEqual(group!.members.find((m) => m.paneId === "p1")!.status, "staged");
    const out = String((result as { output: unknown }).output);
    assert.ok(out.includes("Not staged: p2 (blocked)"), `refusals are narrated (got: ${out})`);
    assert.ok(out.includes("staged 1 approval(s)"), `the staged half is still narrated (got: ${out})`);
  });

  it("dedupes pane_ids: duplicates collapse to ONE dispatch + ONE member", async () => {
    const { ctx, probe } = makeDispatchCtx();
    const { group } = await runDispatch(ctx, { pane_ids: ["p1", "p1", "p2", "p1"], instruction: "go" });
    assert.strictEqual(probe.calls.length, 2, "duplicate pane ids must not double-dispatch");
    assert.deepStrictEqual(probe.calls.map((c) => c.targetId), ["p1", "p2"]);
    assert.strictEqual(group!.members.length, 2, "the group has one member per UNIQUE pane");
  });

  it("template path: the INSTANTIATED text reaches dispatchProposal.instruction; label defaults to the template name", async () => {
    const tpl: PromptTemplate = {
      id: "tpl_1",
      name: "reviewer",
      body: "Review the {{branch}} branch.",
      created_at: 1,
      updated_at: 1,
    };
    const { ctx, probe } = makeDispatchCtx({ templates: [tpl] });
    const { result, group } = await runDispatch(ctx, {
      pane_ids: ["p1"],
      template_id: "tpl_1",
      values: [{ name: "branch", value: "auth-fix" }],
    });
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(probe.calls.length, 1);
    assert.strictEqual(probe.calls[0].instruction, "Review the auth-fix branch.");
    assert.ok(group);
    assert.strictEqual(group!.name, "reviewer", "the group label falls back to the template name");
    assert.strictEqual(group!.instruction, "Review the auth-fix branch.");
  });

  it("template path: unknown template -> ok narration, NO dispatch, NO group", async () => {
    const { ctx, probe } = makeDispatchCtx();
    const { result, group } = await runDispatch(ctx, { pane_ids: ["p1"], template_id: "tpl_ghost" });
    assert.strictEqual(result.kind, "ok");
    assert.ok(String((result as { output: unknown }).output).includes("not found"));
    assert.strictEqual(probe.calls.length, 0, "no write attempt on an unknown template");
    assert.strictEqual(group, undefined, "no group is registered for a refused dispatch");
  });

  it("template path: missing slot values -> kind clarify LISTING the names, NO dispatch", async () => {
    const tpl: PromptTemplate = {
      id: "tpl_1",
      name: "reviewer",
      body: "Review {{branch}} for {{focus}}.",
      created_at: 1,
      updated_at: 1,
    };
    const { ctx, probe } = makeDispatchCtx({ templates: [tpl] });
    const { result, group } = await runDispatch(ctx, {
      pane_ids: ["p1"],
      template_id: "tpl_1",
      values: [{ name: "branch", value: "main" }],
    });
    assert.strictEqual(result.kind, "clarify");
    assert.ok((result as { text: string }).text.includes("focus"), "clarify lists the missing slot names");
    assert.strictEqual(probe.calls.length, 0, "never dispatches a half-filled template");
    assert.strictEqual(group, undefined);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// (3) applyDispatchDecision — the forceStage engine semantics (fixture: test_c55_9_execute_plan)
// ════════════════════════════════════════════════════════════════════════════════════════════════

interface Recorded {
  writes: Array<{ paneId: string; cmd: string }>;
  broadcasts: Array<Record<string, unknown>>;
  notifies: Array<Record<string, unknown>>;
  announcements: Array<Record<string, unknown>>;
  pendingAdds: Array<{ record: unknown; sess: unknown; opts: unknown }>;
}

function freshRec(): Recorded {
  return { writes: [], broadcasts: [], notifies: [], announcements: [], pendingAdds: [] };
}

function makeDeps(
  rec: Recorded,
  opts: { targetId: string; instruction: string; activePaneId: string | null; forceStage?: boolean }
): DispatchDeps {
  return {
    manager: { ledger: { activeProjectId: "default_project" } } as unknown as DispatchDeps["manager"],
    // a probing stub store — the pending arm calls ONLY add() here
    pendingApprovals: {
      add: (record: unknown, sess: unknown, addOpts: unknown): void => {
        rec.pendingAdds.push({ record, sess, opts: addOpts });
      },
    } as unknown as DispatchDeps["pendingApprovals"],
    broadcast: (msg: any) => rec.broadcasts.push(msg as Record<string, unknown>),
    addCommand: () => {},
    redactSecrets: (s: string) => s,
    getPaneSummary: () => "pane summary",
    posturePayloadForPane: (id: string) => ({
      id,
      effective_gates: {} as Record<CapabilityGate, GateValue>,
      posture: "auto",
    }),
    announcementBus: { enqueue: (item: any) => rec.announcements.push(item as Record<string, unknown>) },
    approvalTtlMs: 5 * 60 * 1000,
    getActivePaneId: () => opts.activePaneId,
    isPaneActiveForWrite,
    targetId: opts.targetId,
    instruction: opts.instruction,
    capability: "write_to_pane",
    kind: inferKind(undefined, undefined),
    trigger: "Dispatch group 'brief'",
    effectiveMode: "Full Auto",
    pendingId: "call-1__dispatch_x__p_target",
    callId: "call-1",
    term: { writeInput: (s: string) => rec.writes.push({ paneId: opts.targetId, cmd: s }) },
    forceStage: opts.forceStage,
  };
}

// The VOICE conn binding — guard ON (the binding under which forceStage must matter).
function voiceConn(rec: Recorded): DispatchConn {
  return {
    sess: { sendToolResponse: () => {} },
    notifyPending: (frame: any) => rec.notifies.push(frame as Record<string, unknown>),
    enforceActivePaneGuard: true,
    origin: "voice",
  };
}

describe("applyDispatchDecision — forceStage downgrades auto_execute and bypasses ONLY the clarify", () => {
  it("forceStage=true: auto_execute on a NON-active pane (voice guard ON) STAGES a pending approval", () => {
    const rec = freshRec();
    const deps = makeDeps(rec, {
      targetId: "p_target",
      instruction: "go",
      activePaneId: "p_other", // NOT the target — the guard would clarify on the default path
      forceStage: true,
    });
    const out = applyDispatchDecision({ type: "auto_execute" }, deps, voiceConn(rec));
    assert.strictEqual(out.kind, "pending", "auto_execute must be DOWNGRADED to a staged approval");
    assert.strictEqual(rec.pendingAdds.length, 1, "pendingApprovals.add was called");
    assert.strictEqual(
      (rec.pendingAdds[0].record as { messageId: string }).messageId,
      "call-1__dispatch_x__p_target",
      "the synthetic per-pane pendingId is the staged record's messageId"
    );
    const notify = rec.notifies.find((n) => n.type === "approval_pending");
    assert.ok(notify, "an approval_pending frame reached the notify sink");
    assert.strictEqual(notify!.terminalId, "p_target");
    assert.strictEqual(rec.writes.length, 0, "NOTHING lands on the pane — the operator approves first");
    assert.ok(
      rec.announcements.some((a) => a.kind === "approval_pending"),
      "the approval rides the announcement bus"
    );
  });

  it("forceStage=false: the SAME setup returns kind clarify (the active-pane guard is intact)", () => {
    const rec = freshRec();
    const deps = makeDeps(rec, {
      targetId: "p_target",
      instruction: "go",
      activePaneId: "p_other",
      forceStage: false,
    });
    const out = applyDispatchDecision({ type: "auto_execute" }, deps, voiceConn(rec));
    assert.strictEqual(out.kind, "clarify", "without forceStage the guard refuses the off-focus write");
    assert.strictEqual(rec.pendingAdds.length, 0, "nothing staged");
    assert.strictEqual(rec.notifies.length, 0, "no approval frame");
    assert.strictEqual(rec.writes.length, 0, "no write");
  });

  it("forceStage=true on the ACTIVE pane: auto_execute STILL stages (never silently lands)", () => {
    const rec = freshRec();
    const deps = makeDeps(rec, {
      targetId: "p_target",
      instruction: "go",
      activePaneId: "p_target", // even the focused pane gets the downgrade
      forceStage: true,
    });
    const out = applyDispatchDecision({ type: "auto_execute" }, deps, voiceConn(rec));
    assert.strictEqual(out.kind, "pending", "the fan-out can never silently land a write, focused or not");
    assert.strictEqual(rec.writes.length, 0);
    assert.strictEqual(rec.pendingAdds.length, 1);
  });
});
