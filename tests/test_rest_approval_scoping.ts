// BUG-017 (open, security) — REST approve/reject + GET /api/commands/pending must be SCOPED to the
// caller's workspace. Today approvePendingCommand.handler (src/actions/defs/approvals_rest.ts:217-224)
// resolves ANY messageId with no identity check, and listPendingCommands (:71-74) enumerates EVERY
// session/workspace's pendings. Any authenticated REST client can therefore list + approve/reject a
// FOREIGN pending by its messageId.
//
// REQUIRED POST-FIX BEHAVIOR pinned here:
//   (a) The store exposes a scope accessor: PendingApprovalStore.workspaceFor(messageId) -> the
//       add()-time workspace_id (undefined for an unknown id). It reads the existing private
//       `workspaceForId` map (src/pendingApprovals.ts:593) — no new state.
//   (b) The approve handler REJECTS a scope mismatch as not_found -> 404 (never confirm a foreign id)
//       with NO resolution side effect (no pane write, the pending stays). Caller scope reaches the
//       handler via ctx.callerWorkspaceId, threaded by buildRestActionContext from the request
//       (query `?workspaceId=` / body `workspaceId`). Enforcement ENGAGES only when the caller
//       supplies a scope AND the pending has a workspace -> back-compat: a request with no scope
//       (every existing test / single-workspace deployment) is byte-for-byte unchanged.
//   (c) GET /api/commands/pending filters foreign pendings out when a caller scope is supplied.
//   (d) Regression: same-scope approve still writes end-to-end; a no-scope approve is unchanged.
//
// Three layers, cheapest first:
//   1. STORE UNIT      — workspaceFor accessor (PendingApprovalStore over an in-memory JanusStore).
//   2. HANDLER UNIT    — runAction over approve_pending_command / list_pending_commands with a
//                        call-recording ctx (the tests/test_c55_15_approvals.ts idiom) — proves the
//                        decision + the 404/omit projection with no server boot.
//   3. LIVE SERVER E2E — the REAL POST/GET path (proves buildRestActionContext threads the scope).
//
// Runner: npx tsx --test --test-force-exit tests/test_rest_approval_scoping.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";

import type { ActionContext, ActionDef } from "../src/actions/types";
import { REGISTRY } from "../src/actions/registry";
import { runAction } from "../src/actions/gemini";
import { applyResultToHttp, type RestResponse } from "../src/actions/rest";
import { PendingApprovalStore } from "../src/pendingApprovals";
import { JanusStore } from "../src/store/sqliteStore";
import type { MockLiveHandle, MockLiveSession } from "./helpers/mockLive";
import { teardownServerSuite } from "./helpers/teardown";
import type { RunningServer } from "../server";

// ════════════════════════════════════════════════════════════════════════════════════════════════
// LAYER 1 — store scope accessor (requirement a). RED: `workspaceFor` does not exist yet.
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("BUG-017 (a) — PendingApprovalStore.workspaceFor scope accessor", () => {
  const fakeSession = { sendClientContent() {} };

  it("workspaceFor(messageId) returns the add()-time workspace; unknown id -> undefined", () => {
    const backing = new JanusStore(":memory:");
    backing.init();
    const store = new PendingApprovalStore(backing);
    store.add(
      { messageId: "m1", instruction: "ls", kind: "shell", terminalId: "t1", callId: "m1", timestamp: 1 } as any,
      fakeSession as any,
      { workspaceId: "ws_alpha" },
    );

    // RED: the accessor is not implemented yet, so this typeof check fails.
    assert.strictEqual(typeof (store as any).workspaceFor, "function", "store must expose a workspaceFor(messageId) accessor");
    assert.strictEqual((store as any).workspaceFor("m1"), "ws_alpha", "returns the pending's captured workspace scope");
    assert.strictEqual((store as any).workspaceFor("ghost"), undefined, "unknown messageId -> undefined (no scope)");
    backing.close();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// LAYER 2 — handler-level scope enforcement (requirements b + c), via runAction. The ctx carries the
// NEW `callerWorkspaceId` field + a pendingApprovals stub exposing all/has/workspaceFor. Mirrors the
// call-recording doctrine of tests/test_c55_15_approvals.ts.
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

interface ScopeCtxOpts {
  callerWorkspaceId?: string;
  approvalsList?: Array<Record<string, unknown>>;
  approvalsHas?: (messageId: string) => boolean;
  workspaceFor?: (messageId: string) => string | undefined;
  applyResolution?: () => { reason: string; doWrite: boolean };
}

function makeScopeCtx(opts: ScopeCtxOpts = {}): { ctx: ActionContext; rec: { resolutionCalls: string[] } } {
  const rec = { resolutionCalls: [] as string[] };
  const ctx = {
    callerWorkspaceId: opts.callerWorkspaceId,
    pendingApprovals: {
      all: () => opts.approvalsList ?? [],
      has: (messageId: string) => (opts.approvalsHas ? opts.approvalsHas(messageId) : true),
      workspaceFor: (messageId: string) => (opts.workspaceFor ? opts.workspaceFor(messageId) : undefined),
    },
    applyResolution: (messageId: string, _mode: string) => {
      rec.resolutionCalls.push(messageId);
      return opts.applyResolution ? opts.applyResolution() : { reason: "approved", doWrite: true };
    },
    broadcast: () => {},
  } as unknown as ActionContext;
  return { ctx, rec };
}

describe("BUG-017 (b) — approve_pending_command handler scope enforcement", () => {
  it("FOREIGN scope -> 404 (not_found) AND applyResolution is NEVER called (no side effect)", async () => {
    // caller is in ws_alpha; the pending lives in ws_beta.
    const { ctx, rec } = makeScopeCtx({ callerWorkspaceId: "ws_alpha", workspaceFor: () => "ws_beta" });
    const result = await runAction(REGISTRY, "approve_pending_command", { messageId: "m1", approved: true }, ctx);

    // RED: today the handler ignores scope and calls applyResolution unconditionally.
    assert.strictEqual(rec.resolutionCalls.length, 0, "a scope mismatch must NOT resolve the pending (no pane write / no delete)");
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("approve_pending_command"), result, { messageId: "m1", approved: true }, res);
    assert.strictEqual(sent.status, 404, "a scope mismatch surfaces as 404 not_found (never confirm a foreign id)");
  });

  it("MATCHING scope -> applyResolution runs, 200 (regression: same-scope approve still works)", async () => {
    const { ctx, rec } = makeScopeCtx({ callerWorkspaceId: "ws_alpha", workspaceFor: () => "ws_alpha" });
    const result = await runAction(REGISTRY, "approve_pending_command", { messageId: "m1", approved: true }, ctx);
    assert.deepStrictEqual(rec.resolutionCalls, ["m1"], "same-scope approve resolves the pending");
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("approve_pending_command"), result, { messageId: "m1", approved: true }, res);
    assert.strictEqual(sent.status, 200);
  });

  it("NO caller scope -> applyResolution runs even though the pending has a workspace (back-compat)", async () => {
    // Enforcement engages ONLY when the caller supplies a scope. A scopeless request (every existing
    // test / single-workspace deployment) is unchanged.
    const { ctx, rec } = makeScopeCtx({ callerWorkspaceId: undefined, workspaceFor: () => "ws_beta" });
    const result = await runAction(REGISTRY, "approve_pending_command", { messageId: "m1", approved: true }, ctx);
    assert.deepStrictEqual(rec.resolutionCalls, ["m1"], "no caller scope -> legacy unconditional resolve");
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("approve_pending_command"), result, { messageId: "m1", approved: true }, res);
    assert.strictEqual(sent.status, 200);
  });
});

describe("BUG-017 (c) — list_pending_commands handler scope filtering", () => {
  const twoPendings = [
    { messageId: "mA", instruction: "ls", kind: "shell", terminalId: "tA", timestamp: Date.now() },
    { messageId: "mB", instruction: "pwd", kind: "shell", terminalId: "tB", timestamp: Date.now() },
  ];
  const wsForId = (id: string) => (id === "mA" ? "ws_alpha" : "ws_beta");

  it("with a caller scope, FOREIGN-workspace pendings are omitted from the list", async () => {
    const { ctx } = makeScopeCtx({ callerWorkspaceId: "ws_alpha", approvalsList: twoPendings, workspaceFor: wsForId });
    const result = await runAction(REGISTRY, "list_pending_commands", {}, ctx);
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("list_pending_commands"), result, {}, res);
    const arr = sent.json as Array<{ messageId: string }>;
    assert.ok(arr.some((p) => p.messageId === "mA"), "own-workspace pending is listed");
    // RED: today list_pending_commands returns ALL pendings unfiltered.
    assert.ok(!arr.some((p) => p.messageId === "mB"), "foreign-workspace pending is omitted when a caller scope is supplied");
  });

  it("with NO caller scope, all pendings are listed (back-compat)", async () => {
    const { ctx } = makeScopeCtx({ callerWorkspaceId: undefined, approvalsList: twoPendings, workspaceFor: wsForId });
    const result = await runAction(REGISTRY, "list_pending_commands", {}, ctx);
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("list_pending_commands"), result, {}, res);
    const arr = sent.json as Array<{ messageId: string }>;
    assert.ok(arr.some((p) => p.messageId === "mA") && arr.some((p) => p.messageId === "mB"), "scopeless list is unfiltered");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// LAYER 3 — live-server end-to-end (proves buildRestActionContext threads the request scope into
// ctx.callerWorkspaceId). Mirrors the tests/test_approval_resolved_broadcast.ts harness.
// ════════════════════════════════════════════════════════════════════════════════════════════════
class StubTerminal {
  status: "Running" | "Exited" | "Idle" = "Running";
  permissionsMode: "Full Auto" | "Human-in-the-Loop" | "Read-Only" = "Human-in-the-Loop";
  toolPreset = "Custom";
  sessionId = "";
  contextSize = 0;
  cwd = ".";
  shellCmd = "bash";
  public writes: string[] = [];
  constructor(public terminalId: string) {}
  getRawBackfill() { return ""; }
  getRecentOutput() { return ""; }
  writeInput(s: string) { this.writes.push(s); }
  async stop() { this.status = "Exited"; }
}

describe("BUG-017 — live REST approve/list are workspace-scoped", () => {
  let startServer: (opts?: any) => Promise<RunningServer>;
  let apiToken: string;
  let installMockLive: () => MockLiveHandle;
  let running: RunningServer;
  let client: WebSocket;
  let base: string;
  let tmpDir: string;
  let prevCwd: string;

  const fakeSession = { sendClientContent() {} };

  const api = (pathname: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${base}${pathname}`, {
      ...init,
      headers: { "x-api-token": apiToken, "content-type": "application/json", ...(init.headers || {}) },
    });

  function addPane(paneId: string): StubTerminal {
    const t = new StubTerminal(paneId);
    (running.manager.terminals as any)[paneId] = t;
    return t;
  }
  function injectPending(messageId: string, terminalId: string, instruction: string, workspaceId?: string) {
    running._testPendingApprovals!().add(
      { messageId, instruction, kind: "agent_instruction", terminalId, callId: messageId, timestamp: Date.now() } as any,
      fakeSession as any,
      workspaceId ? ({ workspaceId } as any) : undefined,
    );
  }

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";
    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-approval-scope-"));
    process.chdir(tmpDir);

    ({ installMockLive } = await import("./helpers/mockLive"));
    const serverMod = await import("../server");
    startServer = serverMod.startServer;
    apiToken = serverMod.API_AUTH_TOKEN;

    installMockLive();
    running = await startServer({ port: 0, enableVite: false });
    base = `http://127.0.0.1:${running.port}`;
    client = new WebSocket(`ws://127.0.0.1:${running.port}/live`, { headers: { Cookie: `auth_token=${apiToken}` } });
    await new Promise<void>((resolve, reject) => { client.on("open", () => resolve()); client.on("error", reject); });
  });

  after(async () => {
    if (client && client.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => { client.once("close", () => resolve()); try { client.terminate(); } catch { resolve(); } });
    }
    await teardownServerSuite(running);
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("a caller in ws_alpha approving a ws_beta pending gets 404, NO pane write, and the pending survives", async () => {
    const paneB = addPane("pane_scope_b");
    injectPending("msg_scope_b", "pane_scope_b", "rm -rf build", "ws_beta");

    const res = await api("/api/commands/approve", {
      method: "POST",
      body: JSON.stringify({ messageId: "msg_scope_b", approved: true, workspaceId: "ws_alpha" }),
    });

    // RED: today the handler resolves it -> 200, writes the command, deletes the pending.
    assert.strictEqual(res.status, 404, "foreign-scope approve is refused as 404 (avoids confirming the id)");
    assert.strictEqual(paneB.writes.length, 0, "foreign-scope approve writes NOTHING to the target pane");
    assert.strictEqual(running._testPendingApprovals!().has("msg_scope_b"), true, "the foreign pending is left intact");
  });

  it("GET /api/commands/pending?workspaceId=ws_alpha omits a foreign (ws_beta) pending", async () => {
    addPane("pane_list_a");
    addPane("pane_list_b");
    injectPending("msg_list_a", "pane_list_a", "echo a", "ws_alpha");
    injectPending("msg_list_b", "pane_list_b", "echo b", "ws_beta");

    const body = (await (await api("/api/commands/pending?workspaceId=ws_alpha")).json()) as Array<{ messageId: string }>;
    assert.ok(body.some((p) => p.messageId === "msg_list_a"), "own-workspace pending is present");
    // RED: today GET returns every workspace's pendings.
    assert.ok(!body.some((p) => p.messageId === "msg_list_b"), "foreign-workspace pending is omitted");
  });

  it("regression: a SAME-scope approve still executes end-to-end (pane write + pending consumed)", async () => {
    const paneOk = addPane("pane_scope_ok");
    injectPending("msg_scope_ok", "pane_scope_ok", "echo hello", "ws_alpha");

    const res = await api("/api/commands/approve", {
      method: "POST",
      body: JSON.stringify({ messageId: "msg_scope_ok", approved: true, workspaceId: "ws_alpha" }),
    });
    assert.strictEqual(res.status, 200, "matching-scope approve succeeds");
    assert.deepStrictEqual(paneOk.writes, ["echo hello"], "the approved instruction is written to the pane");
    assert.strictEqual(running._testPendingApprovals!().has("msg_scope_ok"), false, "the pending was consumed exactly once");
  });

  it("regression: a NO-scope approve is unchanged (single-workspace back-compat)", async () => {
    const paneNc = addPane("pane_scope_nc");
    injectPending("msg_scope_nc", "pane_scope_nc", "echo world"); // no workspace meta -> default_project

    const res = await api("/api/commands/approve", {
      method: "POST",
      body: JSON.stringify({ messageId: "msg_scope_nc", approved: true }), // no workspaceId
    });
    assert.strictEqual(res.status, 200, "scopeless approve behaves exactly as today");
    assert.deepStrictEqual(paneNc.writes, ["echo world"], "scopeless approve still writes the instruction");
  });
});
