/**
 * tests/test_dispatch_join_exchange.ts — dispatch-join EXCHANGE/MEMBER correlation (Phase 1,
 * Step 1.4; spec docs/superpowers/specs/2026-07-09-agent-exchange-spine.md §5).
 *
 * Pins the invariant this step adds on top of the pane-only join tracker (tests/test_dispatch_join.ts,
 * which stays green/untouched — flag-off / legacy-member behavior is byte-identical):
 *   - a Running or Idle edge may advance ONLY the member whose delivery marker (ExchangeService.
 *     activeExchangeForPane) is active — an unrelated exchange on the SAME pane, or an edge that
 *     fires before the marker is genuinely active (the begin/complete delivery gap), must NOT
 *     settle it;
 *   - two exchanges staged on one pane (a macro fanning multiple steps onto the same target) run
 *     and settle INDEPENDENTLY;
 *   - a member with NO exchangeId (legacy / flag off) keeps the original unconditional pane-scoped
 *     matching forever — mixed exchange + legacy members on one group/pane don't interfere;
 *   - the fan-out's forceStage safety invariant (every write forceStage:true, distinct synthetic
 *     pendingIds, one join group) is unchanged by the exchange-id thread-through.
 *
 * Runner: npx tsx --test --test-force-exit tests/test_dispatch_join_exchange.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert";

import { DispatchJoinTracker, dispatchJoinTracker } from "../src/dispatch/joinTracker";
import { stageDispatchGroup, type StageTarget } from "../src/actions/defs/dispatch_group";
import { ExchangeService } from "../src/exchanges/service";
import type { ActionContext, DispatchOutcome, DispatchProposalArgs } from "../src/actions/types";

// ════════════════════════════════════════════════════════════════════════════════════════════════
// (1) Pure DispatchJoinTracker correlation — the delivery-marker gate, exercised directly.
// ════════════════════════════════════════════════════════════════════════════════════════════════

describe("DispatchJoinTracker — exchange-marker-gated settlement", () => {
  it("noteRunning: an exchange-correlated staged member advances ONLY when it IS the active marker", () => {
    const t = new DispatchJoinTracker();
    const g = t.create("brief", "x", ["p1"]);
    t.recordOutcomeAt(g.id, 0, "staged", undefined, "exch-A");

    t.noteRunning("p1"); // no active marker at all (e.g. delivery attempted, not yet confirmed)
    assert.strictEqual(g.members[0].status, "staged", "no active marker -> never advance");

    t.noteRunning("p1", "exch-OTHER"); // a DIFFERENT exchange is active on this pane
    assert.strictEqual(g.members[0].status, "staged", "wrong marker -> never advance");

    t.noteRunning("p1", "exch-A"); // the genuine marker
    assert.strictEqual(g.members[0].status, "running", "the matching marker advances it");
  });

  it("noteTransition: settlement is gated the same way (idle only settles the marker-active member)", () => {
    const t = new DispatchJoinTracker();
    const g = t.create("brief", "x", ["p1"]);
    t.recordOutcomeAt(g.id, 0, "staged", undefined, "exch-A");
    t.noteRunning("p1", "exch-A");
    assert.strictEqual(g.members[0].status, "running");

    const settledWrong = t.noteTransition("p1", "idle", Date.now(), "exch-OTHER");
    assert.deepStrictEqual(settledWrong, [], "an unrelated exchange's edge must not settle it");
    assert.strictEqual(g.members[0].status, "running", "left in flight, not falsely completed");

    const settledRight = t.noteTransition("p1", "idle", Date.now(), "exch-A");
    assert.deepStrictEqual(settledRight.map((x) => x.id), [g.id]);
    assert.strictEqual(g.members[0].status, "done");
  });

  it("two exchanges staged on ONE pane (macro fan-out) run and settle INDEPENDENTLY", () => {
    const t = new DispatchJoinTracker();
    const g = t.create("brief", "x", ["p1", "p1"]); // same pane, two macro steps
    t.recordOutcomeAt(g.id, 0, "staged", undefined, "exch-A");
    t.recordOutcomeAt(g.id, 1, "staged", undefined, "exch-B");

    t.noteRunning("p1", "exch-A");
    assert.strictEqual(g.members[0].status, "running", "A advances");
    assert.strictEqual(g.members[1].status, "staged", "B is untouched by A's edge");

    t.noteRunning("p1", "exch-B");
    assert.strictEqual(g.members[1].status, "running", "B advances independently");

    const firstIdle = t.noteTransition("p1", "idle", Date.now(), "exch-A");
    assert.deepStrictEqual(firstIdle, [], "B still running -> group not yet complete");
    assert.strictEqual(g.members[0].status, "done", "A settles on ITS marker's edge");
    assert.strictEqual(g.members[1].status, "running", "B is untouched by A's settle");

    const secondIdle = t.noteTransition("p1", "idle", Date.now(), "exch-B");
    assert.deepStrictEqual(secondIdle.map((x) => x.id), [g.id], "the LAST settle completes the group");
    assert.strictEqual(g.members[1].status, "done");
  });

  it("mixed exchange-correlated + legacy members on one pane: legacy keeps the OLD unconditional match", () => {
    const t = new DispatchJoinTracker();
    const g = t.create("brief", "x", ["p1", "p1"]);
    t.recordOutcomeAt(g.id, 0, "staged", undefined, "exch-A"); // exchange-correlated
    t.recordOutcomeAt(g.id, 1, "staged"); // legacy: no exchangeId at all

    t.noteRunning("p1", "exch-OTHER"); // wrong marker for A; irrelevant to legacy member
    assert.strictEqual(g.members[0].status, "staged", "A gated off — wrong marker");
    assert.strictEqual(g.members[1].status, "running", "legacy member advances unconditionally, as before 1.4");

    t.noteRunning("p1", "exch-A");
    assert.strictEqual(g.members[0].status, "running", "A now advances on its own marker");

    const settled = t.noteTransition("p1", "error", Date.now(), "exch-A");
    assert.deepStrictEqual(settled.map((x) => x.id), [g.id], "both settled -> group completes");
    assert.strictEqual(g.members[0].status, "error");
    assert.strictEqual(g.members[1].status, "error", "the legacy member settled on the SAME edge, as before 1.4");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// (2) Realistic wiring: ExchangeService.activeExchangeForPane threaded through exactly as
//     src/observe/index.ts does — the delivery-marker gate end-to-end.
// ════════════════════════════════════════════════════════════════════════════════════════════════

describe("ExchangeService + DispatchJoinTracker — delivery-marker gating end-to-end", () => {
  it("a pane edge between beginDeliveryAttempt and completeDelivery does NOT settle the member (marker not yet active)", () => {
    const svc = new ExchangeService();
    const t = new DispatchJoinTracker();
    const g = t.create("brief", "x", ["p1"]);
    const ex = svc.createExchange({ projectId: "p", paneId: "p1", operatorUtterance: "u", distilledInstruction: "do it" });
    svc.stageForDelivery(ex.exchangeId);
    t.recordOutcomeAt(g.id, 0, "staged", undefined, ex.exchangeId);

    svc.beginDeliveryAttempt(ex.exchangeId); // durable intent recorded; write not yet confirmed
    // A manual command run on the same pane produces a running edge in this window.
    t.noteRunning("p1", svc.activeExchangeForPane("p1"));
    assert.strictEqual(g.members[0].status, "staged", "marker not active yet -> the edge must not settle it");

    svc.completeDelivery(ex.exchangeId); // NOW the marker is genuinely active
    t.noteRunning("p1", svc.activeExchangeForPane("p1"));
    assert.strictEqual(g.members[0].status, "running", "only now does the edge advance the member");
  });

  it("a later, unrelated exchange delivered on the same pane never settles the earlier member's join entry", () => {
    const svc = new ExchangeService();
    const t = new DispatchJoinTracker();
    const g = t.create("brief", "x", ["p1"]);
    const a = svc.createExchange({ projectId: "p", paneId: "p1", operatorUtterance: "u1", distilledInstruction: "first" });
    svc.stageForDelivery(a.exchangeId);
    svc.recordDelivery(a.exchangeId); // paneActive[p1] = a
    t.recordOutcomeAt(g.id, 0, "staged", undefined, a.exchangeId);
    t.noteRunning("p1", svc.activeExchangeForPane("p1"));
    assert.strictEqual(g.members[0].status, "running");

    // The operator dictates a second instruction on the SAME pane — a's own state is superseded
    // (interrupted), and b becomes the pane's active exchange, unrelated to g's member.
    const b = svc.createExchange({ projectId: "p", paneId: "p1", operatorUtterance: "u2", distilledInstruction: "second" });
    svc.stageForDelivery(b.exchangeId);
    svc.recordDelivery(b.exchangeId);
    assert.strictEqual(svc.get(a.exchangeId)!.state, "interrupted");

    const settled = t.noteTransition("p1", "idle", Date.now(), svc.activeExchangeForPane("p1"));
    assert.deepStrictEqual(settled, [], "b's idle edge must not settle a's join-tracker member");
    assert.strictEqual(g.members[0].status, "running", "a's member is left in flight, never falsely completed");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// (3) stageDispatchGroup wiring — exchangeId threaded from ctx.pendingApprovals, index-addressed
//     (so a macro fanning multiple steps onto the SAME pane gets DISTINCT correlation), and the
//     forceStage fan-out safety invariant preserved.
// ════════════════════════════════════════════════════════════════════════════════════════════════

interface Probe {
  calls: DispatchProposalArgs[];
  broadcasts: Array<Record<string, unknown>>;
}

/** A stub ActionContext whose dispatchProposal simulates the exchange spine binding an exchange_id
 *  to each pendingId (exactly what voice/index.ts's dispatchProposal does in shadow/primary mode),
 *  readable back via ctx.pendingApprovals.get(pendingId).exchangeId — the SAME seam
 *  exchangeIdForPending (src/actions/defs/dispatch_group.ts) reads. */
function makeExchangeAwareCtx(opts?: {
  outcomes?: Record<string, DispatchOutcome>;
  /** pendingId -> exchangeId to bind; a pendingId absent here simulates a legacy/uncorrelated write. */
  bind?: (pendingId: string, targetId: string) => string | undefined;
}): { ctx: ActionContext; probe: Probe } {
  const probe: Probe = { calls: [], broadcasts: [] };
  const approvals = new Map<string, { exchangeId?: string }>();
  const ctx = {
    manager: { ledger: { promptTemplates: [] } },
    session: null,
    callId: "call-1",
    userUtterance: "fan it out",
    redact: (s: string) => s,
    broadcast: (msg: unknown): void => {
      probe.broadcasts.push(msg as Record<string, unknown>);
    },
    dispatchProposal: (args: DispatchProposalArgs): DispatchOutcome => {
      probe.calls.push(args);
      const outcome = opts?.outcomes?.[args.targetId] ?? { kind: "pending", text: `staged on ${args.targetId}` };
      if (outcome.kind === "pending") {
        const exchangeId = opts?.bind?.(args.pendingId!, args.targetId);
        approvals.set(args.pendingId!, { exchangeId });
      }
      return outcome;
    },
    pendingApprovals: { get: (id: string) => approvals.get(id) },
  } as unknown as ActionContext;
  return { ctx, probe };
}

describe("stageDispatchGroup — exchange-id thread-through + forceStage safety", () => {
  it("macro-style fan-out onto the SAME pane: each member's exchangeId is INDEX-addressed, not paneId-looked-up", () => {
    const { ctx, probe } = makeExchangeAwareCtx({
      bind: (pendingId) => `exch_${pendingId}`,
    });
    const targets: StageTarget[] = [
      { key: "step0", paneId: "p1", instruction: "step 0" },
      { key: "step1", paneId: "p1", instruction: "step 1" },
    ];
    const { groupId } = stageDispatchGroup(ctx, "macro", "do things", targets, "trigger");
    const group = dispatchJoinTracker.get(groupId)!;

    assert.strictEqual(group.members.length, 2);
    assert.strictEqual(group.members[0].paneId, "p1");
    assert.strictEqual(group.members[1].paneId, "p1");
    assert.notStrictEqual(group.members[0].exchangeId, group.members[1].exchangeId,
      "each macro step gets its OWN exchange_id even though both target the same pane");
    assert.ok(group.members[0].exchangeId?.includes("step0"));
    assert.ok(group.members[1].exchangeId?.includes("step1"));

    // forceStage safety preserved: every call still carries forceStage:true + a distinct pendingId.
    assert.strictEqual(probe.calls.length, 2);
    for (const c of probe.calls) assert.strictEqual(c.forceStage, true);
    assert.strictEqual(new Set(probe.calls.map((c) => c.pendingId)).size, 2);
    assert.ok(probe.broadcasts.some((b) => b.type === "dispatch_updated"));

    // And the two members now settle independently through the join tracker, exactly like (1)/(2).
    dispatchJoinTracker.noteRunning("p1", group.members[0].exchangeId);
    assert.strictEqual(group.members[0].status, "running");
    assert.strictEqual(group.members[1].status, "staged", "step1 untouched by step0's marker");
  });

  it("mixed exchange-correlated + legacy (uncorrelated) members: legacy keeps unconditional pane-scoped settlement", () => {
    const { ctx } = makeExchangeAwareCtx({
      // Only p1 gets an exchange binding; p2's write is "legacy" (e.g. flag off / no binding).
      bind: (pendingId, targetId) => (targetId === "p1" ? `exch_${pendingId}` : undefined),
    });
    const targets: StageTarget[] = [
      { key: "p1", paneId: "p1", instruction: "go" },
      { key: "p2", paneId: "p2", instruction: "go" },
    ];
    const { groupId } = stageDispatchGroup(ctx, "mixed", "do things", targets, "trigger");
    const group = dispatchJoinTracker.get(groupId)!;
    assert.ok(group.members[0].exchangeId, "p1's member is exchange-correlated");
    assert.strictEqual(group.members[1].exchangeId, undefined, "p2's member stays legacy/uncorrelated");

    // p2 (legacy) advances on a bare pane edge with NO active-exchange argument at all — unchanged
    // from pre-1.4 behavior. p1 requires its own marker.
    dispatchJoinTracker.noteRunning("p2");
    assert.strictEqual(group.members[1].status, "running");
    dispatchJoinTracker.noteRunning("p1"); // no marker supplied -> exchange-correlated member gated off
    assert.strictEqual(group.members[0].status, "staged");
    dispatchJoinTracker.noteRunning("p1", group.members[0].exchangeId);
    assert.strictEqual(group.members[0].status, "running");
  });

  it("blocked/error outcomes still record correctly (no exchangeId — nothing was ever staged for approval)", () => {
    const { ctx } = makeExchangeAwareCtx({
      outcomes: { p2: { kind: "blocked", text: "gated Off" } },
      bind: (pendingId) => `exch_${pendingId}`,
    });
    const targets: StageTarget[] = [
      { key: "p1", paneId: "p1", instruction: "go" },
      { key: "p2", paneId: "p2", instruction: "go" },
    ];
    const { groupId, staged, refused } = stageDispatchGroup(ctx, "grp", "do things", targets, "trigger");
    assert.deepStrictEqual(staged, ["p1"]);
    assert.deepStrictEqual(refused, ["p2 (blocked)"]);
    const group = dispatchJoinTracker.get(groupId)!;
    assert.strictEqual(group.members[1].status, "blocked");
    assert.strictEqual(group.members[1].exchangeId, undefined, "a blocked write never bound an exchange");
    assert.ok(group.members[0].exchangeId, "the staged write IS exchange-correlated");
  });

  it("a ctx with no pendingApprovals wired at all degrades to legacy (uncorrelated) members — no throw", () => {
    const probe: Probe = { calls: [], broadcasts: [] };
    const ctx = {
      manager: { ledger: { promptTemplates: [] } },
      session: null,
      callId: "call-1",
      userUtterance: "fan it out",
      redact: (s: string) => s,
      broadcast: (msg: unknown) => probe.broadcasts.push(msg as Record<string, unknown>),
      dispatchProposal: (args: DispatchProposalArgs): DispatchOutcome => {
        probe.calls.push(args);
        return { kind: "pending", text: "staged" };
      },
      // pendingApprovals intentionally OMITTED — mirrors hand-built test contexts (test_dispatch_join.ts).
    } as unknown as ActionContext;
    const targets: StageTarget[] = [{ key: "p1", paneId: "p1", instruction: "go" }];
    assert.doesNotThrow(() => stageDispatchGroup(ctx, "grp", "do things", targets, "trigger"));
    const { groupId } = stageDispatchGroup(ctx, "grp2", "do things", targets, "trigger");
    const group = dispatchJoinTracker.get(groupId)!;
    assert.strictEqual(group.members[0].exchangeId, undefined);
    assert.strictEqual(group.members[0].status, "staged");
  });
});
