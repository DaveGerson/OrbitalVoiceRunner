// tests/test_c55_batch_d.ts — c55 Batch D (wsm-e2e-pinned-c55.4) contract + cutover guard.
//
// Batch D — "Easy aliasing + status-via-kinds". Converges five inline app.* twins to the
// registry-derived REST mount. The LOAD-BEARING risk is STATUS-VIA-KINDS: create_pane and
// apply_orchestration_recipe must status-branch (403 Off / 202 Ask) — a 403/202 must NOT collapse
// to 200. We assert the HTTP STATUS (not just the body) for every gate disposition.
//
//   set_pane_permissions  PUT  /api/projects/:project_id/panes/:pane_id/permissions
//                         coerceArgs maps body {permissions -> permissions_mode}. GATED twin: on
//                         Ask it STAGES a pending action (behaviorDelta vs the ungated inline route).
//   handoff_context_..    POST /api/handoff
//                         coerceArgs camel->snake {sourcePaneId->source_pane_id,
//                         targetPaneId->target_pane_id, contextNotes->context_notes}.
//   apply_orchestration_recipe POST /api/recipes/apply
//                         coerceArgs {recipeId->recipe_id}; handler now returns kind:'blocked' on
//                         layoutForbidden (was a kind:'ok' string) so resultToHttp emits 403.
//   create_pane           POST /api/terminals
//                         coerceArgs camel->snake {terminalId->pane_id, projectId->project_id,
//                         toolPreset->tool_preset, permissionsMode->permissions_mode}; handler now
//                         returns kind:'blocked' (Off->403) / kind:'pending' (Ask->202) instead of
//                         kind:'ok' strings, so the client's 403 (refusal) and 202 (queued) status
//                         branches SURVIVE. The voice surface still narrates from the same kinds.
//   attention/clear       POST /api/attention/clear — a THIN inline shim calling
//                         runAction('dismiss_attention', {}) (execution routes through the registry).
//
// DOCTRINE (def-level deterministic): call runAction with a fake ctx, assert the ActionResult
// kind/output, then assert resultToHttp maps it to {status,body}. No server boot, no PTY.

import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { REGISTRY } from "../src/actions/registry";
import { runAction } from "../src/actions/gemini";
import { resultToToolResponse } from "../src/actions/gemini";
import {
  resultToHttp,
  mountRestRoutes,
  type RestApp,
  type RestHandler,
  type RestRequest,
  type RestResponse,
} from "../src/actions/rest";
import type { ActionContext, ActionDef, ActionResult, GateDisposition } from "../src/actions/types";

// ── fake response (records status + json) ───────────────────────────────────────────────────────
function makeFakeRes(): { res: RestResponse; sent: { status?: number; json?: unknown } } {
  const sent: { status?: number; json?: unknown } = {};
  const res: RestResponse = {
    status(code: number) { sent.status = code; return res; },
    json(payload: unknown) { sent.json = payload; return undefined; },
  };
  return { res, sent };
}

function findDef(name: string): ActionDef {
  const def = REGISTRY.find((d) => d.name === name);
  assert.ok(def, `registry must contain a def named '${name}'`);
  return def!;
}

// Run an action through the real choke-point, then map to HTTP exactly as the REST seam does.
async function runToHttp(
  name: string,
  rawArgs: Record<string, unknown>,
  ctx: ActionContext,
): Promise<{ result: ActionResult; status?: number; json?: unknown }> {
  const result = await runAction(REGISTRY, name, rawArgs, ctx);
  const { res, sent } = makeFakeRes();
  resultToHttp(result, res);
  return { result, status: sent.status, json: sent.json };
}

// ── shared fake ctx ──────────────────────────────────────────────────────────────────────────────
interface CtxProbe {
  broadcasts: unknown[];
  ledgerUpdates: number;
  terminalsUpdated: number;
  gateCalls: Array<{ capability: string; paneId: string | null; summary: string; params?: Record<string, unknown> }>;
  addTerminalCalls: unknown[][];
  modelContexts: Array<{ projectId: string; paneId: string; note: string; kind: string }>;
  permModeSets: Array<{ paneId: string; mode: string }>;
  activated: Array<string | null>;
}

interface CtxOpts {
  terminals?: Record<string, { setPermissionsMode?: (m: string) => void }>;
  projects?: Record<string, { directory?: string; panes: Record<string, { permissions_mode?: string }> }>;
  activeProjectId?: string;
  gateDisposition?: GateDisposition;
  recipes?: Array<{ id: string; name: string; panes: Array<{ id: string; name: string; startupCommand: string; preset: "Custom"; permissionsMode: string }> }>;
  // resolveLayout return (apply_orchestration_recipe layout veto): "Off" forbids the whole layout.
  layoutGate?: "Auto" | "Ask" | "Off";
  paneGate?: "Auto" | "Ask" | "Off";
}

function makeCtx(opts: CtxOpts = {}): { ctx: ActionContext; probe: CtxProbe } {
  const probe: CtxProbe = {
    broadcasts: [], ledgerUpdates: 0, terminalsUpdated: 0, gateCalls: [],
    addTerminalCalls: [], modelContexts: [], permModeSets: [], activated: [],
  };
  const terminals = opts.terminals ?? {};
  const projects = opts.projects ?? {};
  const activeProjectId = opts.activeProjectId ?? "default_project";
  const manager: any = {
    terminals,
    settings: { presets: undefined, advanced: { defaultShellCommand: "" } },
    addTerminal: (...a: unknown[]): string => { probe.addTerminalCalls.push(a); return "created"; },
    ledger: {
      activeProjectId,
      workspaces: projects,
      getProject: (id: string) => projects[id] ?? null,
      getActiveProject: () => projects[activeProjectId] ?? null,
      addProject: () => {},
      addModelContext: (projectId: string, paneId: string, note: string, kind: string) => {
        probe.modelContexts.push({ projectId, paneId, note, kind });
      },
      addPaneNote: () => {},
      save: () => {},
    },
  };
  // ledger.save via bracket string (set_pane_permissions uses ctx.manager.ledger["save"]())
  manager.ledger["save"] = () => {};

  const ctx = {
    manager,
    session: null,
    callId: "call-d",
    redact: (s: string) => s,
    broadcast: (m: unknown) => { probe.broadcasts.push(m); },
    broadcastLedgerUpdate: () => { probe.ledgerUpdates++; probe.broadcasts.push({ type: "ledger_updated" }); },
    broadcastTerminalsUpdated: () => { probe.terminalsUpdated++; probe.broadcasts.push({ type: "terminals_updated" }); },
    setActivePane: (id: string | null) => { probe.activated.push(id); },
    getActivePaneId: () => probe.activated[probe.activated.length - 1] ?? null,
    // gateOrDefer: STAGES the run closure only on the deferred path; on "run" the CALLER runs it.
    gateOrDefer: (capability: string, paneId: string | null, summary: string, run: () => string, params?: Record<string, unknown>): GateDisposition => {
      probe.gateCalls.push({ capability, paneId, summary, params });
      void run;
      return opts.gateDisposition ?? { disposition: "run" as const };
    },
    // apply_orchestration_recipe: audit-only gateCapability + effectiveCapabilityGateFor for the
    // layout veto (apply_recipe) and per-pane create_pane resolution.
    gateCapability: () => ({ forbidden: false, gate: "Auto" as const }),
    effectiveCapabilityGateFor: (_paneId: unknown, capability: string) => {
      if (capability === "apply_recipe") return opts.layoutGate ?? "Auto";
      return opts.paneGate ?? "Auto";
    },
    recipes: opts.recipes ?? [],
  } as unknown as ActionContext;
  return { ctx, probe };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// set_pane_permissions — route-param alias + body {permissions -> permissions_mode}
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("c55 Batch D — set_pane_permissions (route-param alias + permissions coerce)", () => {
  it("binds PUT /api/projects/:project_id/panes/:pane_id/permissions on the rest surface", () => {
    const def = findDef("set_pane_permissions");
    assert.ok(def.surfaces.has("rest"), "set_pane_permissions must expose the rest surface");
    assert.deepStrictEqual(def.rest, {
      method: "put",
      path: "/api/projects/:project_id/panes/:pane_id/permissions",
    });
  });

  it("Auto repaint: ok -> 200 {output}; sets the live mode + broadcasts ledger + terminals", async () => {
    let setMode = "";
    const { ctx, probe } = makeCtx({
      terminals: { p1: { setPermissionsMode: (m: string) => { setMode = m; } } },
      projects: { proj: { directory: "/p", panes: { p1: { permissions_mode: "Human-in-the-Loop" } } } },
      activeProjectId: "proj",
    });
    const { result, status, json } = await runToHttp(
      "set_pane_permissions",
      { project_id: "proj", pane_id: "p1", permissions: "Read-Only" },
      ctx,
    );
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(status, 200);
    assert.match((json as { output: string }).output, /updated to Read-Only/);
    assert.strictEqual(setMode, "Read-Only", "the live terminal permission mode was set (permissions coerced to permissions_mode)");
    assert.strictEqual(probe.terminalsUpdated, 1, "broadcasts terminals_updated so chips repaint");
    assert.ok(probe.broadcasts.some((m) => (m as { type?: string }).type === "ledger_updated"));
  });

  it("body {permissions} reaches the handler as permissions_mode (coerceArgs)", () => {
    const def = findDef("set_pane_permissions");
    assert.ok(def.coerceArgs, "set_pane_permissions must declare coerceArgs (body permissions -> permissions_mode)");
    const out = def.coerceArgs!({ project_id: "proj", pane_id: "p1", permissions: "Full Auto" });
    assert.strictEqual(out.permissions_mode, "Full Auto", "permissions is aliased to permissions_mode");
  });

  it("GATED twin (behaviorDelta): Ask -> DEFERS (stages a pending action), live mode NOT changed", async () => {
    let setMode = "";
    const { ctx } = makeCtx({
      terminals: { p1: { setPermissionsMode: (m: string) => { setMode = m; } } },
      projects: { proj: { directory: "/p", panes: { p1: { permissions_mode: "Human-in-the-Loop" } } } },
      activeProjectId: "proj",
      gateDisposition: { disposition: "deferred", actionId: "act_perm", summary: "Set pane p1 permissions to Read-Only" },
    });
    const { result } = await runToHttp(
      "set_pane_permissions",
      { project_id: "proj", pane_id: "p1", permissions: "Read-Only" },
      ctx,
    );
    // Faithful to the existing def: deferred still answers a kind:"ok" narration ("needs operator
    // confirmation"), and the effect is NOT applied (the inline route applied unconditionally — delta).
    assert.strictEqual(result.kind, "ok");
    assert.match((result as { output: string }).output, /needs operator confirmation/i);
    assert.strictEqual(setMode, "", "gated Ask must NOT apply the permission change yet (behaviorDelta vs ungated inline)");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// handoff_context_between_panes — coerceArgs camel->snake
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("c55 Batch D — handoff_context_between_panes (camel->snake coerce)", () => {
  it("binds POST /api/handoff on the rest surface", () => {
    const def = findDef("handoff_context_between_panes");
    assert.ok(def.surfaces.has("rest"));
    assert.deepStrictEqual(def.rest, { method: "post", path: "/api/handoff" });
  });

  it("coerceArgs maps {sourcePaneId,targetPaneId,contextNotes} -> snake_case", () => {
    const def = findDef("handoff_context_between_panes");
    assert.ok(def.coerceArgs, "handoff_context_between_panes must declare coerceArgs");
    const out = def.coerceArgs!({ sourcePaneId: "src", targetPaneId: "tgt", contextNotes: "carry these" });
    assert.strictEqual(out.source_pane_id, "src");
    assert.strictEqual(out.target_pane_id, "tgt");
    assert.strictEqual(out.context_notes, "carry these");
  });

  it("camelCase body reaches the handler: records model context into the target; ok -> 200", async () => {
    const { ctx, probe } = makeCtx({
      terminals: { src: {}, tgt: {} },
      projects: { proj: { directory: "/p", panes: { src: {}, tgt: {} } } },
      activeProjectId: "proj",
    });
    const { result, status, json } = await runToHttp(
      "handoff_context_between_panes",
      { sourcePaneId: "src", targetPaneId: "tgt", contextNotes: "carry these learnings" },
      ctx,
    );
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(status, 200);
    assert.match((json as { output: string }).output, /recorded into \[tgt\]/);
    assert.strictEqual(probe.modelContexts.length, 1, "addModelContext fired for the target pane");
    assert.strictEqual(probe.modelContexts[0].paneId, "tgt", "the snake target_pane_id reached the handler");
    assert.match(probe.modelContexts[0].note, /carry these learnings/, "context_notes carried through");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// apply_orchestration_recipe — recipeId alias + kind:'blocked' on layout Off
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("c55 Batch D — apply_orchestration_recipe (recipeId alias + status-via-kinds 403)", () => {
  const RECIPE = {
    id: "full-stack", name: "Full Stack",
    panes: [{ id: "web", name: "Web", startupCommand: "npm run dev", preset: "Custom" as const, permissionsMode: "Human-in-the-Loop" }],
  };

  it("binds POST /api/recipes/apply on the rest surface", () => {
    const def = findDef("apply_orchestration_recipe");
    assert.ok(def.surfaces.has("rest"));
    assert.deepStrictEqual(def.rest, { method: "post", path: "/api/recipes/apply" });
  });

  it("coerceArgs maps {recipeId} -> recipe_id", () => {
    const def = findDef("apply_orchestration_recipe");
    assert.ok(def.coerceArgs, "apply_orchestration_recipe must declare coerceArgs");
    const out = def.coerceArgs!({ recipeId: "full-stack" });
    assert.strictEqual(out.recipe_id, "full-stack");
  });

  it("recipeId body + Auto layout -> spawns; ok -> 200 {output}", async () => {
    const { ctx, probe } = makeCtx({
      projects: { proj: { directory: "/p", panes: {} } },
      activeProjectId: "proj",
      recipes: [RECIPE],
      layoutGate: "Auto",
      paneGate: "Auto",
    });
    const { result, status, json } = await runToHttp("apply_orchestration_recipe", { recipeId: "full-stack" }, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(status, 200);
    assert.match((json as { output: string }).output, /spawned 1 pane/);
    assert.strictEqual(probe.addTerminalCalls.length, 1, "the recipe pane was spawned (recipe_id reached the handler)");
  });

  it("layout apply_recipe=Off -> kind:'blocked' -> 403 {error}; NO pane spawned", async () => {
    const { ctx, probe } = makeCtx({
      projects: { proj: { directory: "/p", panes: {} } },
      activeProjectId: "proj",
      recipes: [RECIPE],
      layoutGate: "Off",
      paneGate: "Auto",
    });
    const { result, status, json } = await runToHttp("apply_orchestration_recipe", { recipeId: "full-stack" }, ctx);
    // STATUS-VIA-KINDS: the client branches on res.status===403 for the refusal earcon. The handler
    // MUST return kind:'blocked' (was a kind:'ok' string) so resultToHttp emits 403, not 200.
    assert.strictEqual(result.kind, "blocked", "layout Off must be kind:'blocked' (status-via-kinds)");
    assert.strictEqual(status, 403, "layout Off must be HTTP 403, never collapse to 200");
    assert.match((json as { error: string }).error, /apply_recipe.*gated Off|gated Off.*template/i);
    assert.strictEqual(probe.addTerminalCalls.length, 0, "no pane spawned when the layout is forbidden");
  });

  it("unknown recipe -> ok narration -> 200 (faithful: not-found is not a gate refusal)", async () => {
    const { ctx } = makeCtx({
      projects: { proj: { directory: "/p", panes: {} } },
      activeProjectId: "proj",
      recipes: [RECIPE],
    });
    const { result, status } = await runToHttp("apply_orchestration_recipe", { recipeId: "no-such" }, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(status, 200);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// create_pane — camel->snake alias + status-via-kinds (Off->403, Ask->202, Auto->200)
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("c55 Batch D — create_pane (camel->snake alias + status-via-kinds 403/202/200)", () => {
  it("binds POST /api/terminals on the rest surface", () => {
    const def = findDef("create_pane");
    assert.ok(def.surfaces.has("rest"));
    assert.deepStrictEqual(def.rest, { method: "post", path: "/api/terminals" });
  });

  it("coerceArgs maps camelCase {terminalId,projectId,toolPreset,permissionsMode} -> snake_case", () => {
    const def = findDef("create_pane");
    assert.ok(def.coerceArgs, "create_pane must declare coerceArgs");
    const out = def.coerceArgs!({
      terminalId: "p1", projectId: "proj", toolPreset: "Custom", permissionsMode: "Full Auto",
    });
    assert.strictEqual(out.pane_id, "p1");
    assert.strictEqual(out.project_id, "proj");
    assert.strictEqual(out.tool_preset, "Custom");
    assert.strictEqual(out.permissions_mode, "Full Auto");
  });

  it("coerceArgs DROPS a client command for a NON-Custom preset (mirrors the inline ignore)", () => {
    const def = findDef("create_pane");
    // The inline route IGNORED a client command for an agent preset; the zod superRefine REJECTS it.
    // So coerceArgs must drop it for non-Custom so a camelCase REST body with a bogus command still
    // parses (REST/voice asymmetry: voice never sends a command for an agent preset).
    const out = def.coerceArgs!({
      terminalId: "p1", projectId: "proj", toolPreset: "Claude Code", command: "bogus-client-command",
    });
    assert.strictEqual(out.command, undefined, "a command for a non-Custom preset is dropped, not passed to zod");
  });

  it("coerceArgs KEEPS a client command for the Custom preset (the escape hatch)", () => {
    const def = findDef("create_pane");
    const out = def.coerceArgs!({ terminalId: "p1", projectId: "proj", toolPreset: "Custom", command: "htop" });
    assert.strictEqual(out.command, "htop", "Custom honors the free-form command");
  });

  it("Auto -> ok -> 200 {output}; spawns the pane (camelCase body coerced)", async () => {
    const { ctx, probe } = makeCtx({
      projects: { proj: { directory: "/p", panes: {} } },
      activeProjectId: "proj",
      gateDisposition: { disposition: "run" },
    });
    const { result, status, json } = await runToHttp(
      "create_pane",
      { terminalId: "p-auto", projectId: "proj", toolPreset: "Custom", permissionsMode: "Full Auto", command: "bash" },
      ctx,
    );
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(status, 200);
    assert.match((json as { output: string }).output, /^Pane p-auto created/);
    assert.strictEqual(probe.addTerminalCalls.length, 1, "Auto spawns the pane inline");
    assert.strictEqual(probe.addTerminalCalls[0][0], "p-auto", "the snake pane_id reached addTerminal");
  });

  it("Off -> kind:'blocked' -> 403 {error}; NO pane spawned (status-via-kinds)", async () => {
    const { ctx, probe } = makeCtx({
      projects: { proj: { directory: "/p", panes: {} } },
      activeProjectId: "proj",
      gateDisposition: { disposition: "forbidden" },
    });
    const { result, status, json } = await runToHttp(
      "create_pane",
      { terminalId: "p-off", projectId: "proj", toolPreset: "Custom", permissionsMode: "Full Auto" },
      ctx,
    );
    assert.strictEqual(result.kind, "blocked", "Off must be kind:'blocked' so the 403 refusal earcon survives");
    assert.strictEqual(status, 403, "Off must be HTTP 403, never collapse to 200");
    assert.match((json as { error: string }).error, /gated Off|forbidden by policy/i);
    assert.strictEqual(probe.addTerminalCalls.length, 0, "forbidden create spawns NO pane");
  });

  it("Ask -> kind:'pending' -> 202 {status:'pending_approval', messageId}; effect deferred", async () => {
    const { ctx, probe } = makeCtx({
      projects: { proj: { directory: "/p", panes: {} } },
      activeProjectId: "proj",
      gateDisposition: { disposition: "deferred", actionId: "act_create", summary: "Create pane p-ask" },
    });
    const { result, status, json } = await runToHttp(
      "create_pane",
      { terminalId: "p-ask", projectId: "proj", toolPreset: "Custom", permissionsMode: "Full Auto" },
      ctx,
    );
    assert.strictEqual(result.kind, "pending", "Ask must be kind:'pending' so the 202 queued branch survives");
    assert.strictEqual(status, 202, "Ask must be HTTP 202, never collapse to 200");
    assert.deepStrictEqual(json, { status: "pending_approval", messageId: "act_create" });
    assert.strictEqual(probe.addTerminalCalls.length, 0, "deferred create does NOT spawn yet");
  });

  // The voice surface must STILL narrate the refusal/queued message from the same kinds.
  it("voice narration survives the kind change: Off speaks the refusal, Ask speaks the queued message", async () => {
    // Off -> blocked -> voiceResponse { output: reason } -> responseFor reads reason (refusal narrates).
    const offCtx = makeCtx({
      projects: { proj: { directory: "/p", panes: {} } },
      activeProjectId: "proj",
      gateDisposition: { disposition: "forbidden" },
    }).ctx;
    const offResult = await runAction(REGISTRY, "create_pane",
      { terminalId: "v-off", projectId: "proj", toolPreset: "Custom", permissionsMode: "Full Auto" }, offCtx);
    let offSpoken: any;
    const offSession = { sendToolResponse: (p: any) => { offSpoken = p.functionResponses[0].response; } };
    resultToToolResponse(offResult, offSession as any, "create_pane", "cid-off");
    assert.match(String(offSpoken.output), /gated Off|forbidden by policy/i, "voice narrates the refusal from kind:'blocked'");

    // Ask -> pending -> voiceResponse { status, messageId, ...extra }. extra.output carries the queued
    // narration so the model still SPEAKS "needs operator confirmation".
    const askCtx = makeCtx({
      projects: { proj: { directory: "/p", panes: {} } },
      activeProjectId: "proj",
      gateDisposition: { disposition: "deferred", actionId: "act_v", summary: "Create pane v-ask" },
    }).ctx;
    const askResult = await runAction(REGISTRY, "create_pane",
      { terminalId: "v-ask", projectId: "proj", toolPreset: "Custom", permissionsMode: "Full Auto" }, askCtx);
    let askSpoken: any;
    const askSession = { sendToolResponse: (p: any) => { askSpoken = p.functionResponses[0].response; } };
    resultToToolResponse(askResult, askSession as any, "create_pane", "cid-ask");
    assert.strictEqual(askSpoken.status, "pending_approval", "voice pending status preserved");
    assert.match(String(askSpoken.output), /needs operator confirmation/i, "voice still SPEAKS the queued message (extra.output)");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// (route-param flow) — drive the converged routes through the REAL mountRestRoutes seam
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("c55 Batch D — route-param + body flow through mountRestRoutes", () => {
  function mountOne(name: string, ctx: ActionContext): {
    method: string; path: string; invoke: (req: RestRequest) => Promise<{ status?: number; json?: unknown }>;
  } {
    let captured: { method: string; path: string; handler: RestHandler } | undefined;
    const fakeApp = {
      get: (p: string, h: RestHandler) => { captured = { method: "get", path: p, handler: h }; },
      post: (p: string, h: RestHandler) => { captured = { method: "post", path: p, handler: h }; },
      put: (p: string, h: RestHandler) => { captured = { method: "put", path: p, handler: h }; },
      delete: (p: string, h: RestHandler) => { captured = { method: "delete", path: p, handler: h }; },
    } as unknown as RestApp;
    mountRestRoutes(fakeApp, REGISTRY, () => ctx, { only: new Set([name]) });
    assert.ok(captured, `mountRestRoutes must register a route for ${name}`);
    return {
      method: captured!.method, path: captured!.path,
      invoke: async (req: RestRequest) => {
        const { res, sent } = makeFakeRes();
        await captured!.handler(req, res);
        return { status: sent.status, json: sent.json };
      },
    };
  }

  it("set_pane_permissions: :project_id/:pane_id route segments + {permissions} body reach the handler", async () => {
    let setMode = "";
    const { ctx } = makeCtx({
      terminals: { px: { setPermissionsMode: (m: string) => { setMode = m; } } },
      projects: { pr: { directory: "/pr", panes: { px: { permissions_mode: "Human-in-the-Loop" } } } },
      activeProjectId: "pr",
    });
    const route = mountOne("set_pane_permissions", ctx);
    assert.strictEqual(route.method, "put");
    assert.strictEqual(route.path, "/api/projects/:project_id/panes/:pane_id/permissions");
    const { status } = await route.invoke({ params: { project_id: "pr", pane_id: "px" }, body: { permissions: "Read-Only" } });
    assert.strictEqual(status, 200);
    assert.strictEqual(setMode, "Read-Only", "route segments + permissions body flowed to the handler");
  });

  it("create_pane: camelCase body through the seam (Auto) -> 200; agent-preset bogus command ignored", async () => {
    const { ctx, probe } = makeCtx({
      projects: { proj: { directory: "/p", panes: {} } },
      activeProjectId: "proj",
      gateDisposition: { disposition: "run" },
    });
    const route = mountOne("create_pane", ctx);
    const { status } = await route.invoke({
      body: { terminalId: "p-seam", projectId: "proj", toolPreset: "Claude Code", permissionsMode: "Human-in-the-Loop", command: "bogus" },
    });
    assert.strictEqual(status, 200, "non-Custom create with a bogus client command still parses (command dropped)");
    assert.strictEqual(probe.addTerminalCalls.length, 1, "the pane spawned through the seam");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// cutover guard — server.ts text-inspected for the mount + the absent inline twins + the shim
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("c55 Batch D — server.ts cutover guard (no double-registration)", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const serverSrc = readFileSync(path.join(here, "..", "server.ts"), "utf8");

  const mountIdx = serverSrc.indexOf("mountRestRoutes(");
  const onlyOpenIdx = mountIdx >= 0 ? serverSrc.indexOf("only: new Set([", mountIdx) : -1;
  const onlyCloseIdx = onlyOpenIdx >= 0 ? serverSrc.indexOf("])", onlyOpenIdx) : -1;
  const mountBlock =
    onlyOpenIdx >= 0 && onlyCloseIdx >= 0 ? serverSrc.slice(onlyOpenIdx, onlyCloseIdx + 2) : "";

  const onlyNames = ["set_pane_permissions", "handoff_context_between_panes", "apply_orchestration_recipe", "create_pane"];
  for (const name of onlyNames) {
    it(`mountRestRoutes only-set includes "${name}"`, () => {
      assert.ok(mountIdx >= 0, "server.ts must call mountRestRoutes");
      assert.ok(new RegExp(`["']${name}["']`).test(mountBlock), `only-set must include "${name}" after the Batch-D cutover`);
    });
  }

  // The CONVERGED inline route literals must be GONE (double-registration masks the cutover).
  const goneLiterals: Array<{ label: string; needle: RegExp }> = [
    { label: "PUT /api/projects/:projectId/panes/:paneId/permissions", needle: /app\.put\(\s*["']\/api\/projects\/:projectId\/panes\/:paneId\/permissions["']/ },
    { label: "POST /api/handoff", needle: /app\.post\(\s*["']\/api\/handoff["']/ },
    { label: "POST /api/recipes/apply", needle: /app\.post\(\s*["']\/api\/recipes\/apply["']/ },
    { label: "POST /api/terminals (create_pane)", needle: /app\.post\(\s*["']\/api\/terminals["']/ },
  ];
  for (const { label, needle } of goneLiterals) {
    it(`inline route is deleted: ${label}`, () => {
      assert.ok(!needle.test(serverSrc), `inline ${label} must be deleted`);
    });
  }

  // attention/clear is a THIN inline SHIM: the inline route persists, but it routes execution through
  // runAction('dismiss_attention', ...) — the only inline part is the path alias (pending Batch H's
  // multi-path seam). dismiss_attention must NOT be re-added to the only-set (it is already there from
  // Batch A); the shim must call runAction.
  it("POST /api/attention/clear is a thin shim that calls runAction('dismiss_attention')", () => {
    const m = /app\.post\(\s*["']\/api\/attention\/clear["'][\s\S]{0,400}?\}\s*\)\s*;/.exec(serverSrc);
    assert.ok(m, "POST /api/attention/clear inline shim must still exist (path alias pending Batch H)");
    assert.ok(/runAction\(\s*REGISTRY\s*,\s*["']dismiss_attention["']/.test(m![0]), "the shim must route execution through runAction('dismiss_attention')");
  });

  // Guard out-of-scope neighbors stayed inline (this batch must NOT touch them). NOTE: GET
  // /api/terminals/:id/history was a Batch-D out-of-scope neighbor, but c55 Batch F intentionally
  // converges it (get_terminal_history) — so it is no longer asserted here; the Batch F cutover guard
  // (test_c55_batch_f.ts) now asserts that inline route is DELETED.
  const keptLiterals: Array<{ label: string; needle: RegExp }> = [
    { label: "PUT /api/projects/:projectId/panes/:paneId/capability-gates", needle: /app\.put\(\s*["']\/api\/projects\/:projectId\/panes\/:paneId\/capability-gates["']/ },
    { label: "POST /api/watch-rules", needle: /app\.post\(\s*["']\/api\/watch-rules["']/ },
  ];
  for (const { label, needle } of keptLiterals) {
    it(`out-of-scope inline route is preserved: ${label}`, () => {
      assert.ok(needle.test(serverSrc), `${label} must remain inline this batch (out of scope)`);
    });
  }
});
