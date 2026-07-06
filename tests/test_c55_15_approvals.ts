// c55.15 — APPROVALS/PENDING HiTL convergence tests.
//
// Task 1 (this file, initial): the ActionContext SHAPE extension. The 5 converged approvals/pending
// REST defs (Task 2) reference `ctx.pendingActions` (the non-PTY deferred-action store) and
// `ctx.pendingApprovals.all()` — neither was on ActionContext before c55.15. This suite asserts the
// ADDITIVE extension is in place: a ctx can carry a real PendingActionStore exposing all/has/
// confirm/cancel, and pendingApprovals exposes all(). Task 2 extends this file with the toHttp
// status-contract coverage (the real behavior tests).
//
// Runner: npx tsx --test --test-force-exit tests/test_c55_15_approvals.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import type { ActionContext, ActionDef } from "../src/actions/types";
import { ALWAYS_ALLOWED } from "../src/actions/types";
import { PendingActionStore } from "../src/pendingActions";
import { PendingApprovalStore } from "../src/pendingApprovals";
import { REGISTRY } from "../src/actions/registry";
import { runAction } from "../src/actions/gemini";
import { applyResultToHttp, type RestResponse } from "../src/actions/rest";
import { INTENTIONAL_ASYMMETRY } from "../src/actions/coverage";
import type { ActionResolveResult } from "../src/pendingActions";
import type { ResolveAction } from "../src/pendingApprovals";

// A minimal ctx slice carrying ONLY the two surfaces this task extends. Typed against the real
// ActionContext (via Pick) so it fails to typecheck until the fields are additively declared.
function ctxShape(): Pick<ActionContext, "pendingActions" | "pendingApprovals"> {
  return {
    pendingActions: new PendingActionStore(null),
    pendingApprovals: new PendingApprovalStore(null),
  };
}

describe("c55.15 — ActionContext extension (pendingActions + pendingApprovals.all)", () => {
  it("exposes pendingActions with all/has/confirm/cancel", () => {
    const ctx = ctxShape();
    assert.strictEqual(typeof ctx.pendingActions.all, "function", "pendingActions.all()");
    assert.strictEqual(typeof ctx.pendingActions.has, "function", "pendingActions.has()");
    assert.strictEqual(typeof ctx.pendingActions.confirm, "function", "pendingActions.confirm()");
    assert.strictEqual(typeof ctx.pendingActions.cancel, "function", "pendingActions.cancel()");
    // all() on an empty store is the [] the GET /api/actions/pending def maps over.
    assert.deepStrictEqual(ctx.pendingActions.all(), [], "empty pendingActions.all() -> []");
    assert.strictEqual(ctx.pendingActions.has("nope"), false, "unknown id -> not present");
  });

  it("exposes pendingApprovals.all() for the GET /api/commands/pending def", () => {
    const ctx = ctxShape();
    assert.strictEqual(typeof ctx.pendingApprovals.all, "function", "pendingApprovals.all()");
    assert.deepStrictEqual(ctx.pendingApprovals.all(), [], "empty pendingApprovals.all() -> []");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Task 2 — the 5 rest-only ALWAYS_ALLOWED defs + the toHttp 404/422/200/500 status contract.
//
// DOCTRINE (mirrors test_c55_14_lifecycle.ts): call runAction with a CALL-RECORDING fake ctx that
// drives each store branch, assert the ActionResult.output discriminant, then assert
// applyResultToHttp(def, result, args, res) maps it to {status, body}. No server boot, no PTY.
// ════════════════════════════════════════════════════════════════════════════════════════════════

function findDef(name: string): ActionDef {
  const def = REGISTRY.find((d) => d.name === name);
  assert.ok(def, `registry must contain a def named '${name}'`);
  return def!;
}

function makeFakeRes(): { res: RestResponse; sent: { status?: number; json?: unknown } } {
  const sent: { status?: number; json?: unknown } = {};
  const res: RestResponse = {
    status(code: number) { sent.status = code; return res; },
    json(payload: unknown) { sent.json = payload; return undefined; },
  };
  return { res, sent };
}

// A staged pending action shaped exactly like the GET /api/actions/pending projection needs.
interface FakePendingAction { id: string; capability: string; summary: string; timestamp: number; }

interface ApprovalsCtxOpts {
  // pendingActions store knobs
  actionsList?: FakePendingAction[];
  has?: (id: string) => boolean;
  confirm?: (id: string) => ActionResolveResult;
  cancel?: (id: string) => ActionResolveResult;
  // pendingApprovals store knobs
  approvalsList?: Array<Record<string, unknown>>;
  approvalsHas?: (messageId: string) => boolean;
  applyResolution?: (messageId: string, mode: string) => ResolveAction;
}

interface ApprovalsRecorded {
  broadcasts: Array<Record<string, unknown>>;
  confirmCalls: string[];
  cancelCalls: string[];
  resolutionCalls: Array<{ messageId: string; mode: string }>;
}

function makeApprovalsCtx(opts: ApprovalsCtxOpts = {}): { ctx: ActionContext; rec: ApprovalsRecorded } {
  const rec: ApprovalsRecorded = { broadcasts: [], confirmCalls: [], cancelCalls: [], resolutionCalls: [] };
  const ctx = {
    pendingActions: {
      all: () => opts.actionsList ?? [],
      has: (id: string) => (opts.has ? opts.has(id) : false),
      confirm: (id: string) => { rec.confirmCalls.push(id); return opts.confirm ? opts.confirm(id) : { reason: "not_found" as const }; },
      cancel: (id: string) => { rec.cancelCalls.push(id); return opts.cancel ? opts.cancel(id) : { reason: "cancelled" as const }; },
    },
    pendingApprovals: {
      all: () => opts.approvalsList ?? [],
      has: (messageId: string) => (opts.approvalsHas ? opts.approvalsHas(messageId) : false),
    },
    applyResolution: (messageId: string, mode: string) => {
      rec.resolutionCalls.push({ messageId, mode });
      return opts.applyResolution ? opts.applyResolution(messageId, mode) : { reason: "not_found" as const, doWrite: false };
    },
    broadcast: (msg: unknown) => { rec.broadcasts.push(msg as Record<string, unknown>); },
  } as unknown as ActionContext;
  return { ctx, rec };
}

// ─────────────────────────────────────────────────────────────────────────────
// (a) SHAPE — all five defs present, rest-only, ALWAYS_ALLOWED, route + asymmetry + toHttp.
// ─────────────────────────────────────────────────────────────────────────────
describe("c55.15 — shape", () => {
  const cases: Array<{ name: string; method: string; path: string }> = [
    { name: "list_pending_commands", method: "get", path: "/api/commands/pending" },
    { name: "list_pending_actions", method: "get", path: "/api/actions/pending" },
    { name: "confirm_pending_action", method: "post", path: "/api/actions/:id/confirm" },
    { name: "cancel_pending_action", method: "post", path: "/api/actions/:id/cancel" },
    { name: "approve_pending_command", method: "post", path: "/api/commands/approve" },
  ];
  for (const { name, method, path } of cases) {
    it(`${name} is a rest-only ALWAYS_ALLOWED def: ${method.toUpperCase()} ${path}, allow-listed, declares toHttp`, () => {
      const def = findDef(name);
      assert.deepStrictEqual([...def.surfaces].sort(), ["rest"], `${name} surfaces must be exactly {rest}`);
      assert.strictEqual(def.capability, ALWAYS_ALLOWED, `${name} capability must be ALWAYS_ALLOWED`);
      assert.strictEqual(def.readOnly, false, `${name} readOnly:false`);
      assert.ok(def.rest, `${name} must declare a rest binding`);
      assert.strictEqual(def.rest!.method, method, `${name} rest method`);
      assert.strictEqual(def.rest!.path, path, `${name} rest path`);
      assert.strictEqual(typeof def.rest!.toHttp, "function", `${name} must declare rest.toHttp`);
      assert.deepStrictEqual(INTENTIONAL_ASYMMETRY[name], new Set(["rest"]), `${name} must be allow-listed rest-only`);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) GET fidelity — both reads emit their array TOP-LEVEL at 200.
// ─────────────────────────────────────────────────────────────────────────────
describe("c55.15 — GET fidelity (array top-level at 200)", () => {
  it("list_pending_commands -> pendingApprovals.all().map(serializePending) top-level array", async () => {
    const approvalsList = [{ messageId: "m1", instruction: "ls", kind: "shell", terminalId: "t1", rationale: "r", timestamp: Date.now() }];
    const { ctx } = makeApprovalsCtx({ approvalsList });
    const result = await runAction(REGISTRY, "list_pending_commands", {}, ctx);
    assert.strictEqual(result.kind, "ok");
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("list_pending_commands"), result, {}, res);
    assert.strictEqual(sent.status, 200);
    assert.ok(Array.isArray(sent.json), "body is a TOP-LEVEL array (not wrapped in {output})");
    const arr = sent.json as Array<Record<string, unknown>>;
    assert.strictEqual(arr.length, 1);
    assert.strictEqual(arr[0].messageId, "m1", "serializePending projected the record");
    assert.strictEqual(arr[0].cmd, "ls", "serializePending emits the back-compat cmd alias");
  });

  it("list_pending_commands -> empty store yields []", async () => {
    const { ctx } = makeApprovalsCtx({ approvalsList: [] });
    const result = await runAction(REGISTRY, "list_pending_commands", {}, ctx);
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("list_pending_commands"), result, {}, res);
    assert.strictEqual(sent.status, 200);
    assert.deepStrictEqual(sent.json, []);
  });

  it("list_pending_actions -> {id,capability,summary,ageSeconds} array; ageSeconds>=0", async () => {
    const actionsList: FakePendingAction[] = [
      { id: "a1", capability: "delete_pane", summary: "Delete pane x", timestamp: Date.now() - 5000 },
      { id: "a2", capability: "write_to_pane", summary: "Write y", timestamp: Date.now() + 9999 }, // future ts -> clamped to 0
    ];
    const { ctx } = makeApprovalsCtx({ actionsList });
    const result = await runAction(REGISTRY, "list_pending_actions", {}, ctx);
    assert.strictEqual(result.kind, "ok");
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("list_pending_actions"), result, {}, res);
    assert.strictEqual(sent.status, 200);
    assert.ok(Array.isArray(sent.json), "body is a TOP-LEVEL array");
    const arr = sent.json as Array<{ id: string; capability: string; summary: string; ageSeconds: number }>;
    assert.strictEqual(arr.length, 2);
    assert.deepStrictEqual(Object.keys(arr[0]).sort(), ["ageSeconds", "capability", "id", "summary"], "exact projection keys");
    assert.strictEqual(arr[0].id, "a1");
    assert.ok(arr[0].ageSeconds >= 0, "ageSeconds is non-negative");
    assert.ok(arr[0].ageSeconds >= 4 && arr[0].ageSeconds <= 7, "5s-old record => ~5 ageSeconds");
    assert.strictEqual(arr[1].ageSeconds, 0, "a future timestamp clamps ageSeconds to 0 (Math.max(0,...))");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) POST status matrix — drive each branch; assert BOTH the result.output discriminant
//     AND applyResultToHttp(...).status (+ broadcast on confirm/cancel success).
// ─────────────────────────────────────────────────────────────────────────────
describe("c55.15 — confirm_pending_action status matrix", () => {
  it("missing id -> 404 {error}; confirm NOT called, no broadcast", async () => {
    const { ctx, rec } = makeApprovalsCtx({ has: () => false });
    const result = await runAction(REGISTRY, "confirm_pending_action", { id: "ghost" }, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(rec.confirmCalls.length, 0, "missing -> confirm() never called");
    assert.strictEqual(rec.broadcasts.length, 0, "no broadcast on the 404 path");
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("confirm_pending_action"), result, { id: "ghost" }, res);
    assert.strictEqual(sent.status, 404);
    assert.ok((sent.json as { error: string }).error, "404 body carries {error}");
  });

  it("confirm -> lost_race -> 200 {success:true,already:true}; no broadcast", async () => {
    const { ctx, rec } = makeApprovalsCtx({ has: () => true, confirm: () => ({ reason: "lost_race" }) });
    const result = await runAction(REGISTRY, "confirm_pending_action", { id: "a1" }, ctx);
    assert.strictEqual(rec.broadcasts.length, 0, "lost_race does not broadcast");
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("confirm_pending_action"), result, { id: "a1" }, res);
    assert.strictEqual(sent.status, 200);
    assert.deepStrictEqual(sent.json, { success: true, already: true });
  });

  it("confirm -> not_found (race between has() and confirm()) -> 404; no broadcast", async () => {
    const { ctx, rec } = makeApprovalsCtx({ has: () => true, confirm: () => ({ reason: "not_found" }) });
    const result = await runAction(REGISTRY, "confirm_pending_action", { id: "a1" }, ctx);
    assert.strictEqual(rec.broadcasts.length, 0, "not_found does not broadcast");
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("confirm_pending_action"), result, { id: "a1" }, res);
    assert.strictEqual(sent.status, 404);
    assert.ok((sent.json as { error: string }).error);
  });

  it("confirm -> confirmed -> 200 {success:true,output}; broadcasts action_resolved/confirmed", async () => {
    const { ctx, rec } = makeApprovalsCtx({ has: () => true, confirm: () => ({ reason: "confirmed", output: "ran-it" }) });
    const result = await runAction(REGISTRY, "confirm_pending_action", { id: "a1" }, ctx);
    assert.strictEqual(rec.broadcasts.length, 1, "the confirmed path broadcasts exactly once");
    assert.deepStrictEqual(rec.broadcasts[0], { type: "action_resolved", actionId: "a1", outcome: "confirmed" });
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("confirm_pending_action"), result, { id: "a1" }, res);
    assert.strictEqual(sent.status, 200);
    assert.deepStrictEqual(sent.json, { success: true, output: "ran-it" });
  });

  it("confirm throws -> 500 {success:false,error}; no broadcast", async () => {
    const { ctx, rec } = makeApprovalsCtx({ has: () => true, confirm: () => { throw new Error("boom"); } });
    const result = await runAction(REGISTRY, "confirm_pending_action", { id: "a1" }, ctx);
    assert.strictEqual(rec.broadcasts.length, 0, "a throwing confirm does not broadcast");
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("confirm_pending_action"), result, { id: "a1" }, res);
    assert.strictEqual(sent.status, 500);
    assert.deepStrictEqual(sent.json, { success: false, error: "boom" });
  });
});

describe("c55.15 — cancel_pending_action status matrix", () => {
  it("missing id -> 404 {error}; cancel NOT called, no broadcast", async () => {
    const { ctx, rec } = makeApprovalsCtx({ has: () => false });
    const result = await runAction(REGISTRY, "cancel_pending_action", { id: "ghost" }, ctx);
    assert.strictEqual(rec.cancelCalls.length, 0, "missing -> cancel() never called");
    assert.strictEqual(rec.broadcasts.length, 0);
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("cancel_pending_action"), result, { id: "ghost" }, res);
    assert.strictEqual(sent.status, 404);
    assert.ok((sent.json as { error: string }).error);
  });

  it("cancel -> cancelled -> 200 {success:true,already:false}; broadcasts action_resolved/cancelled", async () => {
    const { ctx, rec } = makeApprovalsCtx({ has: () => true, cancel: () => ({ reason: "cancelled" }) });
    const result = await runAction(REGISTRY, "cancel_pending_action", { id: "a1" }, ctx);
    assert.strictEqual(rec.broadcasts.length, 1);
    assert.deepStrictEqual(rec.broadcasts[0], { type: "action_resolved", actionId: "a1", outcome: "cancelled" });
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("cancel_pending_action"), result, { id: "a1" }, res);
    assert.strictEqual(sent.status, 200);
    assert.deepStrictEqual(sent.json, { success: true, already: false });
  });

  it("cancel -> lost_race -> 200 {success:true,already:true}; still broadcasts cancelled", async () => {
    const { ctx, rec } = makeApprovalsCtx({ has: () => true, cancel: () => ({ reason: "lost_race" }) });
    const result = await runAction(REGISTRY, "cancel_pending_action", { id: "a1" }, ctx);
    assert.strictEqual(rec.broadcasts.length, 1, "the inline route broadcasts cancelled unconditionally after has()");
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("cancel_pending_action"), result, { id: "a1" }, res);
    assert.strictEqual(sent.status, 200);
    assert.deepStrictEqual(sent.json, { success: true, already: true }, "already === (reason === lost_race)");
  });
});

describe("c55.15 — approve_pending_command status matrix", () => {
  it("missing messageId -> 404 {error}; applyResolution NOT called", async () => {
    const { ctx, rec } = makeApprovalsCtx({ approvalsHas: () => false });
    const result = await runAction(REGISTRY, "approve_pending_command", { messageId: "ghost", approved: true }, ctx);
    assert.strictEqual(rec.resolutionCalls.length, 0, "missing -> applyResolution never called");
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("approve_pending_command"), result, { messageId: "ghost", approved: true }, res);
    assert.strictEqual(sent.status, 404);
    assert.ok((sent.json as { error: string }).error);
  });

  it("applyResolution -> not_found -> 404 {error}", async () => {
    const { ctx } = makeApprovalsCtx({ approvalsHas: () => true, applyResolution: () => ({ reason: "not_found", doWrite: false }) });
    const result = await runAction(REGISTRY, "approve_pending_command", { messageId: "m1", approved: true }, ctx);
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("approve_pending_command"), result, { messageId: "m1", approved: true }, res);
    assert.strictEqual(sent.status, 404);
    assert.ok((sent.json as { error: string }).error);
  });

  it("applyResolution -> dead_pane -> 422 {success:false,error:'target pane missing'}", async () => {
    const { ctx } = makeApprovalsCtx({ approvalsHas: () => true, applyResolution: () => ({ reason: "dead_pane", doWrite: false }) });
    const result = await runAction(REGISTRY, "approve_pending_command", { messageId: "m1", approved: true }, ctx);
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("approve_pending_command"), result, { messageId: "m1", approved: true }, res);
    assert.strictEqual(sent.status, 422);
    assert.deepStrictEqual(sent.json, { success: false, error: "target pane missing" });
  });

  it("applyResolution -> lost_race -> 200 {success:true,already:true}", async () => {
    const { ctx } = makeApprovalsCtx({ approvalsHas: () => true, applyResolution: () => ({ reason: "lost_race", doWrite: false }) });
    const result = await runAction(REGISTRY, "approve_pending_command", { messageId: "m1", approved: true }, ctx);
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("approve_pending_command"), result, { messageId: "m1", approved: true }, res);
    assert.strictEqual(sent.status, 200);
    assert.deepStrictEqual(sent.json, { success: true, already: true });
  });

  it("applyResolution -> approved (default) -> 200 {success:true}; mode='approve' when approved:true", async () => {
    const { ctx, rec } = makeApprovalsCtx({ approvalsHas: () => true, applyResolution: () => ({ reason: "approved", doWrite: true }) });
    const result = await runAction(REGISTRY, "approve_pending_command", { messageId: "m1", approved: true }, ctx);
    assert.deepStrictEqual(rec.resolutionCalls, [{ messageId: "m1", mode: "approve" }], "approved:true -> mode 'approve'");
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("approve_pending_command"), result, { messageId: "m1", approved: true }, res);
    assert.strictEqual(sent.status, 200);
    assert.deepStrictEqual(sent.json, { success: true });
  });

  it("approved:false -> applyResolution mode 'reject' -> default 200 {success:true}", async () => {
    const { ctx, rec } = makeApprovalsCtx({ approvalsHas: () => true, applyResolution: () => ({ reason: "rejected", doWrite: false }) });
    const result = await runAction(REGISTRY, "approve_pending_command", { messageId: "m1", approved: false }, ctx);
    assert.deepStrictEqual(rec.resolutionCalls, [{ messageId: "m1", mode: "reject" }], "approved:false -> mode 'reject'");
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("approve_pending_command"), result, { messageId: "m1", approved: false }, res);
    assert.strictEqual(sent.status, 200);
    assert.deepStrictEqual(sent.json, { success: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (d) wsm-e2e-pinned-wqk — malformed-body parity. approved is required boolean (ApproveParams);
// a malformed body fails zod validation BEFORE the handler runs, so runAction returns a top-level
// {kind:'error', message, cause:'validation'}. The def-local toHttp must special-case that (via
// errorToHttp) — NOT fold it into the def's own not_found/[] default (which used to yield a spurious
// 404 for approve/confirm/cancel, or a silent 200 [] for the two GET reads). applyResolution must
// never be called on this path (no silent-reject side effect on bad input), and the well-formed
// matrix above stays byte-identical.
//
// wsm-e2e-pinned-f9ne — cause discriminator: runAction now stamps kind:'error' with
// cause:'validation'|'handler'|'timeout' at its four construction sites, so a client-fault (bad args /
// unknown action) maps to 400 while a server-fault (uncaught handler throw / deadline timeout, or a
// legacy handler-constructed error with no cause) maps to 500 — no longer folded into the same 400.
// ─────────────────────────────────────────────────────────────────────────────
describe("c55.15 — wsm-e2e-pinned-wqk / wsm-e2e-pinned-f9ne: kind:'error' -> 400 (validation) or 500 (handler/timeout), not folded into 404/[]", () => {
  it("approve_pending_command: approved missing -> 400 {error}; applyResolution NOT called (no silent reject)", async () => {
    const { ctx, rec } = makeApprovalsCtx({ approvalsHas: () => true });
    const args = { messageId: "m1" }; // 'approved' missing -> fails ApproveParams (z.boolean())
    const result = await runAction(REGISTRY, "approve_pending_command", args, ctx);
    assert.strictEqual(result.kind, "error", "malformed body -> top-level ActionResult.kind 'error'");
    assert.strictEqual(rec.resolutionCalls.length, 0, "malformed body -> applyResolution never called");
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("approve_pending_command"), result, args, res);
    assert.strictEqual(sent.status, 400, "malformed body -> 400, NOT 404");
    assert.ok((sent.json as { error: string }).error, "400 body carries {error}");
  });

  it("approve_pending_command: approved non-boolean -> 400 {error}; applyResolution NOT called", async () => {
    const { ctx, rec } = makeApprovalsCtx({ approvalsHas: () => true });
    const args = { messageId: "m1", approved: "yes" }; // wrong type -> fails z.boolean()
    const result = await runAction(REGISTRY, "approve_pending_command", args, ctx);
    assert.strictEqual(result.kind, "error");
    assert.strictEqual(rec.resolutionCalls.length, 0);
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("approve_pending_command"), result, args, res);
    assert.strictEqual(sent.status, 400);
    assert.ok((sent.json as { error: string }).error);
  });

  it("approve_pending_command: well-formed body is unaffected (regression guard for this bead's fix)", async () => {
    const { ctx, rec } = makeApprovalsCtx({ approvalsHas: () => true, applyResolution: () => ({ reason: "approved", doWrite: true }) });
    const result = await runAction(REGISTRY, "approve_pending_command", { messageId: "m1", approved: true }, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.deepStrictEqual(rec.resolutionCalls, [{ messageId: "m1", mode: "approve" }]);
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("approve_pending_command"), result, { messageId: "m1", approved: true }, res);
    assert.strictEqual(sent.status, 200);
    assert.deepStrictEqual(sent.json, { success: true });
  });

  it("confirm_pending_action: a top-level kind:'error' with cause:'validation' maps to 400, not 404", async () => {
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("confirm_pending_action"), { kind: "error", message: "boom", cause: "validation" }, { id: "a1" }, res);
    assert.strictEqual(sent.status, 400);
    assert.deepStrictEqual(sent.json, { error: "boom" });
  });

  it("confirm_pending_action: a top-level kind:'error' with cause:'handler' maps to 500, not 404", async () => {
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("confirm_pending_action"), { kind: "error", message: "boom", cause: "handler" }, { id: "a1" }, res);
    assert.strictEqual(sent.status, 500);
    assert.deepStrictEqual(sent.json, { error: "boom" });
  });

  it("confirm_pending_action: a top-level kind:'error' with NO cause (legacy shape) defaults to 500, not 400", async () => {
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("confirm_pending_action"), { kind: "error", message: "boom" }, { id: "a1" }, res);
    assert.strictEqual(sent.status, 500);
    assert.deepStrictEqual(sent.json, { error: "boom" });
  });

  it("cancel_pending_action: a top-level kind:'error' with cause:'validation' maps to 400, not 404", async () => {
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("cancel_pending_action"), { kind: "error", message: "boom", cause: "validation" }, { id: "a1" }, res);
    assert.strictEqual(sent.status, 400);
    assert.deepStrictEqual(sent.json, { error: "boom" });
  });

  it("cancel_pending_action: a top-level kind:'error' with cause:'timeout' maps to 500, not 404", async () => {
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("cancel_pending_action"), { kind: "error", message: "boom", cause: "timeout" }, { id: "a1" }, res);
    assert.strictEqual(sent.status, 500);
    assert.deepStrictEqual(sent.json, { error: "boom" });
  });

  it("list_pending_commands: a top-level kind:'error' with cause:'validation' maps to 400, not a silent 200 []", async () => {
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("list_pending_commands"), { kind: "error", message: "boom", cause: "validation" }, {}, res);
    assert.strictEqual(sent.status, 400);
    assert.deepStrictEqual(sent.json, { error: "boom" });
  });

  it("list_pending_commands: a top-level kind:'error' with cause:'handler' maps to 500, not a silent 200 []", async () => {
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("list_pending_commands"), { kind: "error", message: "boom", cause: "handler" }, {}, res);
    assert.strictEqual(sent.status, 500);
    assert.deepStrictEqual(sent.json, { error: "boom" });
  });

  it("list_pending_actions: a top-level kind:'error' with cause:'validation' maps to 400, not a silent 200 []", async () => {
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("list_pending_actions"), { kind: "error", message: "boom", cause: "validation" }, {}, res);
    assert.strictEqual(sent.status, 400);
    assert.deepStrictEqual(sent.json, { error: "boom" });
  });

  it("list_pending_actions: a top-level kind:'error' with NO cause (legacy shape) defaults to 500, not a silent 200 []", async () => {
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("list_pending_actions"), { kind: "error", message: "boom" }, {}, res);
    assert.strictEqual(sent.status, 500);
    assert.deepStrictEqual(sent.json, { error: "boom" });
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Task 3 — cutover guard. (Clone of the c55.14 guard in tests/test_c55_14_lifecycle.ts.) Slices the
// mountRestRoutes only:new Set([...]) block from server.ts-as-text and asserts the 5 approvals/pending
// names are NOW in the only-set AND the 5 inline route literals are GONE (method-anchored + quote-
// terminated regexes so a longer path that CONTAINS one of these prefixes can never false-match).
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("c55.15 — server.ts cutover guard (no double-registration)", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const serverSrc = readFileSync(path.join(here, "..", "server.ts"), "utf8");
  // c55.16: the `only:` allow-filter was RETIRED; registry auto-serves every rest-surface def.
  // Cutover proof = registry membership (surfaces:rest && def.rest), not only-set text.
  const mountIdx = serverSrc.indexOf("mountRestRoutes(");
  const mountedNames = new Set(
    REGISTRY.filter((d) => d.surfaces.has("rest") && !!d.rest).map((d) => d.name),
  );

  for (const name of ["list_pending_commands", "list_pending_actions", "confirm_pending_action", "cancel_pending_action", "approve_pending_command"]) {
    it(`mountRestRoutes auto-serves "${name}" (rest-surfaced in REGISTRY)`, () => {
      assert.ok(mountIdx >= 0, "server.ts must call mountRestRoutes");
      assert.ok(mountedNames.has(name), `"${name}" must be a rest-mounted REGISTRY def after the c55.15 cutover`);
    });
  }

  const goneLiterals: Array<{ label: string; needle: RegExp }> = [
    { label: "GET /api/commands/pending", needle: /app\.get\(\s*["']\/api\/commands\/pending["']/ },
    { label: "GET /api/actions/pending", needle: /app\.get\(\s*["']\/api\/actions\/pending["']/ },
    { label: "POST /api/actions/:id/confirm", needle: /app\.post\(\s*["']\/api\/actions\/:id\/confirm["']/ },
    { label: "POST /api/actions/:id/cancel", needle: /app\.post\(\s*["']\/api\/actions\/:id\/cancel["']/ },
    { label: "POST /api/commands/approve", needle: /app\.post\(\s*["']\/api\/commands\/approve["']/ },
  ];
  for (const { label, needle } of goneLiterals) {
    it(`inline route is deleted: ${label}`, () => {
      assert.ok(!needle.test(serverSrc), `inline ${label} must be deleted (converged to the registry)`);
    });
  }
});
