/**
 * tests/test_dispatchgroup_complexity_refactor.ts — PINNING harness for the
 * src/actions/defs/dispatch_group.ts complexity burndown.
 *
 * Exercises dispatchToPanes.handler DIRECTLY (no runAction, no PTY, no server boot) through a
 * stub ActionContext, pinning EVERY branch of the ~18-CC handler before extraction so the
 * verbatim, behavior-preserving refactor cannot drift:
 *   - instruction path: text/label resolution, label fallback to text.slice(0,40)
 *   - template path: unknown template -> ok narration (no dispatch/group); missing slots ->
 *     clarify (no dispatch); instantiated text reaches dispatchProposal.instruction; label
 *     falls back to the template name only when name is absent
 *   - explicit `name` wins over template name and over text-slice
 *   - dedup of pane_ids; synthetic per-pane pendingId (distinct, carries paneId, no callId collide)
 *   - forceStage:true + capability "write_to_pane" on EVERY call
 *   - outcome mapping: pending/executed -> staged member + staged list; blocked/error -> refused
 *     list + recorded member status (blocked vs error) with detail
 *   - callId fallback to group.id for pendingId base
 *   - narration assembly: staged-only / refused-only / mixed / none-staged
 *   - dispatch_updated broadcast always fires
 *
 * Runner: npx tsx --test --test-force-exit tests/test_dispatchgroup_complexity_refactor.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert";

import { dispatchToPanes } from "../src/actions/defs/dispatch_group";
import { dispatchJoinTracker } from "../src/dispatch/joinTracker";
import type {
  ActionContext,
  ActionResult,
  DispatchOutcome,
  DispatchProposalArgs,
} from "../src/actions/types";
import type { PromptTemplate } from "../src/types";

interface Probe {
  calls: DispatchProposalArgs[];
  broadcasts: Array<Record<string, unknown>>;
}

function makeCtx(opts?: {
  templates?: PromptTemplate[];
  outcomes?: Record<string, DispatchOutcome>;
  callId?: string | undefined;
  userUtterance?: string;
}): { ctx: ActionContext; probe: Probe } {
  const probe: Probe = { calls: [], broadcasts: [] };
  const ctx = {
    manager: { ledger: { promptTemplates: opts?.templates ?? [] } },
    session: null,
    callId: opts && "callId" in opts ? opts.callId : "call-1",
    userUtterance: opts?.userUtterance ?? "fan it out",
    broadcast: (msg: unknown): void => {
      probe.broadcasts.push(msg as Record<string, unknown>);
    },
    dispatchProposal: (args: DispatchProposalArgs): DispatchOutcome => {
      probe.calls.push(args);
      return opts?.outcomes?.[args.targetId] ?? { kind: "pending", text: `staged ${args.targetId}` };
    },
  } as unknown as ActionContext;
  return { ctx, probe };
}

// The handler registers into the module SINGLETON tracker. Diff the list to find OUR group.
function run(ctx: ActionContext, args: Record<string, unknown>): { result: ActionResult; group: ReturnType<typeof dispatchJoinTracker.list>[number] | undefined } {
  const before = dispatchJoinTracker.list().length;
  const result = dispatchToPanes.handler(args as never, ctx) as ActionResult;
  const after = dispatchJoinTracker.list();
  return { result, group: after.length > before ? after[after.length - 1] : undefined };
}

function out(r: ActionResult): string {
  return String((r as { output: unknown }).output);
}

const tpl = (over: Partial<PromptTemplate> = {}): PromptTemplate => ({
  id: "tpl_1",
  name: "reviewer",
  body: "Review {{branch}}.",
  created_at: 1,
  updated_at: 1,
  ...over,
});

describe("dispatch_group pinning — instruction path", () => {
  it("staged pending outcomes: members staged, narration counts, label = text.slice(0,40)", () => {
    const { ctx, probe } = makeCtx();
    const { result, group } = run(ctx, { pane_ids: ["p1", "p2"], instruction: "run the suite" });
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(probe.calls.length, 2);
    for (const c of probe.calls) {
      assert.strictEqual(c.forceStage, true);
      assert.strictEqual(c.capability, "write_to_pane");
      assert.strictEqual(c.instruction, "run the suite");
      assert.strictEqual(c.trigger, "fan it out");
    }
    assert.ok(group);
    assert.strictEqual(group!.name, "run the suite", "label falls back to text slice");
    assert.deepStrictEqual(
      group!.members.map((m) => ({ paneId: m.paneId, status: m.status })),
      [{ paneId: "p1", status: "staged" }, { paneId: "p2", status: "staged" }]
    );
    assert.ok(out(result).includes("staged 2 approval(s)"));
    assert.ok(probe.broadcasts.some((b) => b.type === "dispatch_updated"));
  });

  it("long instruction: label is truncated to 40 chars", () => {
    const longText = "x".repeat(80);
    const { ctx } = makeCtx();
    const { group } = run(ctx, { pane_ids: ["p1"], instruction: longText });
    assert.strictEqual(group!.name.length, 40);
    assert.strictEqual(group!.name, "x".repeat(40));
  });

  it("explicit name wins over the text slice", () => {
    const { ctx } = makeCtx();
    const { group } = run(ctx, { pane_ids: ["p1"], instruction: "do stuff", name: "MyGroup" });
    assert.strictEqual(group!.name, "MyGroup");
  });

  it("synthetic per-pane pendingId: distinct, carries paneId, no callId collision", () => {
    const { ctx, probe } = makeCtx();
    run(ctx, { pane_ids: ["p1", "p2"], instruction: "go" });
    const ids = probe.calls.map((c) => c.pendingId!);
    assert.strictEqual(new Set(ids).size, 2);
    assert.ok(ids[0].includes("p1") && ids[1].includes("p2"));
    assert.ok(ids.every((i) => i.startsWith("call-1__")), "base is callId");
  });

  it("dedupes pane_ids preserving first-seen order", () => {
    const { ctx, probe } = makeCtx();
    const { group } = run(ctx, { pane_ids: ["p1", "p1", "p2", "p1"], instruction: "go" });
    assert.deepStrictEqual(probe.calls.map((c) => c.targetId), ["p1", "p2"]);
    assert.strictEqual(group!.members.length, 2);
  });
});

describe("dispatch_group pinning — outcome mapping", () => {
  it("executed outcome records as running but counts as staged in narration", () => {
    const { ctx, probe } = makeCtx({ outcomes: { p1: { kind: "executed", text: "ran" } } });
    const { result, group } = run(ctx, { pane_ids: ["p1"], instruction: "go" });
    assert.strictEqual(probe.calls.length, 1);
    assert.strictEqual(group!.members[0].status, "running");
    assert.ok(out(result).includes("staged 1 approval(s)"));
  });

  it("blocked outcome: member blocked+detail, refused narration, attempted anyway", () => {
    const { ctx, probe } = makeCtx({ outcomes: { p2: { kind: "blocked", text: "gated Off" } } });
    const { result, group } = run(ctx, { pane_ids: ["p1", "p2"], instruction: "go" });
    assert.strictEqual(probe.calls.length, 2);
    const p2 = group!.members.find((m) => m.paneId === "p2")!;
    assert.strictEqual(p2.status, "blocked");
    assert.strictEqual(p2.detail, "gated Off");
    assert.strictEqual(group!.members.find((m) => m.paneId === "p1")!.status, "staged");
    assert.ok(out(result).includes("Not staged: p2 (blocked)"));
    assert.ok(out(result).includes("staged 1 approval(s)"));
  });

  it("error outcome: member error+detail, refused narration", () => {
    const { ctx } = makeCtx({ outcomes: { p1: { kind: "error", text: "boom" } } });
    const { result, group } = run(ctx, { pane_ids: ["p1"], instruction: "go" });
    const m = group!.members[0];
    assert.strictEqual(m.status, "error");
    assert.strictEqual(m.detail, "boom");
    assert.ok(out(result).includes("Not staged: p1 (error)"));
    assert.ok(out(result).includes("No writes were staged."));
  });

  it("clarify outcome routes through the refused (error) arm of the else branch", () => {
    // clarify is neither pending nor executed -> the else branch records non-blocked => "error"
    const { ctx } = makeCtx({ outcomes: { p1: { kind: "clarify", text: "huh" } } });
    const { result, group } = run(ctx, { pane_ids: ["p1"], instruction: "go" });
    assert.strictEqual(group!.members[0].status, "error");
    assert.ok(out(result).includes("Not staged: p1 (clarify)"));
  });

  it("all blocked: none-staged narration only", () => {
    const { ctx } = makeCtx({
      outcomes: { p1: { kind: "blocked", text: "a" }, p2: { kind: "blocked", text: "b" } },
    });
    const { result } = run(ctx, { pane_ids: ["p1", "p2"], instruction: "go" });
    const o = out(result);
    assert.ok(o.includes("Not staged: p1 (blocked); p2 (blocked)"));
    assert.ok(o.includes("No writes were staged."));
    assert.ok(!o.includes("staged 2 approval"));
  });
});

describe("dispatch_group pinning — template path", () => {
  it("unknown template -> ok narration, no dispatch, no group", () => {
    const { ctx, probe } = makeCtx();
    const { result, group } = run(ctx, { pane_ids: ["p1"], template_id: "ghost" });
    assert.strictEqual(result.kind, "ok");
    assert.ok(out(result).includes("not found"));
    assert.strictEqual(probe.calls.length, 0);
    assert.strictEqual(group, undefined);
  });

  it("missing slots -> clarify listing names, no dispatch, no group", () => {
    const { ctx, probe } = makeCtx({ templates: [tpl({ body: "Review {{branch}} for {{focus}}." })] });
    const { result, group } = run(ctx, {
      pane_ids: ["p1"],
      template_id: "tpl_1",
      values: [{ name: "branch", value: "main" }],
    });
    assert.strictEqual(result.kind, "clarify");
    assert.ok((result as { text: string }).text.includes("focus"));
    assert.strictEqual(probe.calls.length, 0);
    assert.strictEqual(group, undefined);
  });

  it("instantiated text reaches dispatchProposal; label defaults to template name", () => {
    const { ctx, probe } = makeCtx({ templates: [tpl()] });
    const { group } = run(ctx, {
      pane_ids: ["p1"],
      template_id: "tpl_1",
      values: [{ name: "branch", value: "auth-fix" }],
    });
    assert.strictEqual(probe.calls[0].instruction, "Review auth-fix.");
    assert.strictEqual(group!.name, "reviewer");
    assert.strictEqual(group!.instruction, "Review auth-fix.");
  });

  it("explicit name overrides the template name", () => {
    const { ctx } = makeCtx({ templates: [tpl()] });
    const { group } = run(ctx, {
      pane_ids: ["p1"],
      template_id: "tpl_1",
      values: [{ name: "branch", value: "x" }],
      name: "Override",
    });
    assert.strictEqual(group!.name, "Override");
  });

  it("template lookup matches by name as well as id", () => {
    const { ctx, probe } = makeCtx({ templates: [tpl({ body: "static body" })] });
    const { result } = run(ctx, { pane_ids: ["p1"], template_id: "reviewer" });
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(probe.calls[0].instruction, "static body");
  });
});

describe("dispatch_group pinning — callId fallback", () => {
  it("absent callId: trigger uses utterance, pendingId base falls back to group.id", () => {
    const { ctx, probe } = makeCtx({ callId: undefined, userUtterance: "" });
    const { group } = run(ctx, { pane_ids: ["p1"], instruction: "go", name: "L" });
    // trigger: userUtterance empty -> `Dispatch group 'L'`
    assert.strictEqual(probe.calls[0].trigger, "Dispatch group 'L'");
    // pendingId base is group.id (the callId ?? group.id fallback)
    assert.ok(probe.calls[0].pendingId!.startsWith(group!.id + "__"));
  });
});
