/**
 * tests/test_c55_batch_b.ts — c55 Batch B (wsm-e2e-pinned-c55.2) contract + cutover guard.
 *
 * Batch B converges 3 registry twins that ALREADY exist and ALREADY broadcast their WS frame, from
 * hand-written inline `app.<verb>('/api/…')` blocks in server.ts to the registry-derived REST mount
 * (the `opts.only` allow-set + `resultToHttp`). UNLIKE Batch A, each twin's `rest.path` carries
 * ROUTE PARAMS, and the inline twins used camelCase param segments (`:id` / `:projectId` / `:paneId`)
 * that would NOT land on the snake_case zod keys the handler reads. So Batch B ALSO rewrites each
 * `rest.path` to SNAKE_CASE segments so Express route params populate the snake_case args directly:
 *
 *   rename_project   PUT  /api/projects/:project_id/rename
 *   rename_pane      PUT  /api/projects/:project_id/panes/:pane_id/rename
 *   switch_context   POST /api/projects/:project_id/switch
 *
 * execute_plan is HELD from this cutover (4th planned twin). Its registry handler routes step 1
 * through ctx.dispatchProposal, which buildRestActionContext injects as a REFUSING STUB ("pane-write
 * is not available on the REST surface" — voice/index.ts:21-22 keeps dispatchProposal connection-
 * scoped). Converging it would make the UI "Run plan" button (App.tsx handleExecutePlan -> POST
 * /api/plans/:id/execute) ALWAYS refuse instead of dispatching step 1 — a real functional regression,
 * not a client-invisible body delta. It needs a REST-capable pane-write path (an architectural
 * decision). So Batch B HOLDS execute_plan inline; the test below PINS that hold + the blocker.
 *
 * Assertion layers (per the c55 verification doctrine):
 *
 *   (1) DEF-LEVEL CONTRACT — deterministic. For each action: build a fake ActionContext, call the
 *       SAME runAction choke-point the voice + REST paths use, assert the ActionResult is kind:"ok",
 *       assert resultToHttp maps it to 200 { output }, AND assert the action still mutates the ledger
 *       + broadcasts its WS frame (ledger_updated for the renames/switch via broadcastLedgerUpdate).
 *       The execute_plan handler is exercised here too (with a WORKING fake dispatchProposal) to
 *       document that the HANDLER is correct — the blocker is the REST ctx stub, not the handler.
 *
 *   (2) ROUTE-PARAM-FLOW CONTRACT — the Batch-B-specific risk. Drive each CONVERGED action through the
 *       REAL mountRestRoutes seam with a fake Express app + a fake req carrying ONLY route `params`
 *       (the snake_case path segments), no body. Assert the snake_case param ACTUALLY reaches the
 *       handler (a seeded id is renamed / switched), proving the `:project_id` segment populates
 *       `project_id` in args. This is the assertion that fails if the rest.path keeps the camelCase
 *       `:projectId` segment (the param would arrive as `projectId`, the handler reads `project_id`
 *       -> undefined -> a silent no-op rename of an unknown id).
 *
 *   (3) REST-STUB BLOCKER (execute_plan) — pins WHY execute_plan is held: mount it against a ctx whose
 *       dispatchProposal is the SAME refusing stub buildRestActionContext uses, and assert the route
 *       refuses the pane write (the handler narrates "Could not start …: pane-write is not available
 *       on the REST surface" and NEVER actually dispatches). This is the regression that justifies the
 *       hold; it locks the decision until a REST-capable pane-write path is authored.
 *
 *   (4) CUTOVER GUARD — reads server.ts as text. Asserts each CONVERGED Batch-B name is in the
 *       mountRestRoutes `only` set AND its inline camelCase-segment twin is GONE; asserts execute_plan
 *       is ABSENT from the only-set AND its inline twin is PRESERVED (held). Structurally catches
 *       double-registration (Express keeps the first-registered handler).
 *
 * Recorded behavior deltas (see the c55 spec Open Decision #2):
 *   - rename_project / rename_pane: inline returned { success:true }; the registry twin returns
 *     200 { output: "Project renamed to …" / "Pane renamed to …" } (client ignores the body, repaints
 *     off ledger_updated).
 *   - switch_context: inline returned { success:true, activeProjectId }; the registry twin returns
 *     200 { output: <project briefing> } (client ignores the body, repaints off ledger_updated).
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { REGISTRY } from "../src/actions/registry";
import { runAction } from "../src/actions/gemini";
import {
  resultToHttp,
  mountRestRoutes,
  type RestApp,
  type RestHandler,
  type RestRequest,
  type RestResponse,
} from "../src/actions/rest";
import type { ActionContext, ActionResult, DispatchOutcome } from "../src/actions/types";

// ── fake response (records status + json) ───────────────────────────────────────────────────────
function makeFakeRes(): { res: RestResponse; sent: { status?: number; json?: unknown } } {
  const sent: { status?: number; json?: unknown } = {};
  const res: RestResponse = {
    status(code: number) {
      sent.status = code;
      return res;
    },
    json(payload: unknown) {
      sent.json = payload;
      return undefined;
    },
  };
  return { res, sent };
}

// ── seedable fake ledger + ActionContext ──────────────────────────────────────────────────────────
// Faithful to the surface the 4 Batch-B handlers touch:
//   rename_project  -> ledger.renameProject(project_id, name); broadcastLedgerUpdate()
//   rename_pane     -> ledger.renamePane(project_id, pane_id, name); broadcastLedgerUpdate()
//   switch_context  -> ledger.switchContext(id); settings.projects.{activeContext,localWorkspacePath};
//                      saveSettings(); broadcastLedgerUpdate(); ledger.getProjectBriefing(id)
//   execute_plan    -> ledger.plans.find(); dispatchProposal(...); ledger.save(true);
//                      broadcast({type:'plans_updated'})
interface SeedProject {
  name: string;
  directory: string;
  panes: Record<string, { name: string }>;
}
interface SeedPlan {
  id: string;
  name: string;
  status: string;
  currentStepIndex: number;
  steps: Array<{ terminalId: string; command: string; status: string }>;
}

interface CtxProbe {
  broadcasts: unknown[];
  ledgerUpdates: number;
  saveCalls: boolean[];
  settingsSaves: number;
  dispatchArgs: Array<Record<string, unknown>>;
  switched: string[]; // project ids passed to ledger.switchContext
}

function makeCtx(opts?: {
  projects?: Record<string, SeedProject>;
  plans?: SeedPlan[];
  dispatchOutcome?: DispatchOutcome; // what the injected dispatchProposal returns for execute_plan
}): { ctx: ActionContext; probe: CtxProbe; projects: Record<string, SeedProject>; plans: SeedPlan[] } {
  const probe: CtxProbe = {
    broadcasts: [],
    ledgerUpdates: 0,
    saveCalls: [],
    settingsSaves: 0,
    dispatchArgs: [],
    switched: [],
  };
  const projects = opts?.projects ?? {};
  const plans = opts?.plans ?? [];
  const settings = {
    projects: { activeContext: "", localWorkspacePath: "" },
  };
  const ledger = {
    workspaces: projects,
    plans,
    renameProject: (id: string, name: string): void => {
      if (projects[id]) projects[id].name = name; // silent no-op on unknown id (faithful)
    },
    renamePane: (projectId: string, paneId: string, name: string): void => {
      const pane = projects[projectId]?.panes?.[paneId];
      if (pane) pane.name = name; // silent no-op if missing (faithful)
    },
    switchContext: (id: string): void => {
      probe.switched.push(id);
    },
    getProjectBriefing: (id: string): unknown =>
      projects[id] ? { project_id: id, summary: `briefing:${projects[id].name}` } : null,
    save: (force: boolean): void => {
      probe.saveCalls.push(force);
    },
  };
  const ctx = {
    redact: (s: string) => s,
    broadcast: (msg: unknown) => {
      probe.broadcasts.push(msg);
    },
    broadcastLedgerUpdate: (): void => {
      probe.ledgerUpdates += 1;
      probe.broadcasts.push({ type: "ledger_updated" });
    },
    saveSettings: (): void => {
      probe.settingsSaves += 1;
    },
    dispatchProposal: (args: Record<string, unknown>): DispatchOutcome => {
      probe.dispatchArgs.push(args);
      return opts?.dispatchOutcome ?? { kind: "executed", text: "ran" };
    },
    session: null,
    callId: "call-test",
    manager: {
      ledger,
      settings,
      saveSettings: (): void => {
        probe.settingsSaves += 1;
      },
    },
  } as unknown as ActionContext;
  // switch_context calls ctx.manager.saveSettings(); rename/switch call ctx.broadcastLedgerUpdate();
  // the manager.saveSettings closure above shares the same probe counter as ctx.saveSettings.
  return { ctx, probe, projects, plans };
}

// helper: run an action through the real choke-point, then map to HTTP exactly as the REST seam does.
async function runToHttp(
  name: string,
  rawArgs: Record<string, unknown>,
  ctx: ActionContext
): Promise<{ result: ActionResult; status?: number; json?: unknown }> {
  const result = await runAction(REGISTRY, name, rawArgs, ctx);
  const { res, sent } = makeFakeRes();
  resultToHttp(result, res);
  return { result, status: sent.status, json: sent.json };
}

// ── (1) def-level contract ────────────────────────────────────────────────────────────────────────
describe("c55 Batch B — def-level contract (runAction -> ok -> 200 + ledger mutation + WS frame)", () => {
  it("rename_project: ok -> 200 { output }; renames seeded id + broadcasts ledger_updated", async () => {
    const { ctx, probe, projects } = makeCtx({
      projects: { p1: { name: "old", directory: "/p1", panes: {} } },
    });
    const { result, status, json } = await runToHttp(
      "rename_project",
      { project_id: "p1", name: "fresh" },
      ctx
    );
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(json, { output: "Project renamed to fresh" });
    assert.strictEqual(projects.p1.name, "fresh"); // the snake_case arg reached the handler
    assert.strictEqual(probe.ledgerUpdates, 1);
    assert.ok(
      probe.broadcasts.some((m) => (m as { type?: string }).type === "ledger_updated"),
      "rename_project must broadcast ledger_updated"
    );
  });

  it("rename_pane: ok -> 200 { output }; renames seeded pane + broadcasts ledger_updated", async () => {
    const { ctx, probe, projects } = makeCtx({
      projects: { p1: { name: "p", directory: "/p1", panes: { pane9: { name: "old-pane" } } } },
    });
    const { result, status, json } = await runToHttp(
      "rename_pane",
      { project_id: "p1", pane_id: "pane9", name: "fresh-pane" },
      ctx
    );
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(json, { output: "Pane renamed to fresh-pane" });
    assert.strictEqual(projects.p1.panes.pane9.name, "fresh-pane");
    assert.ok(
      probe.broadcasts.some((m) => (m as { type?: string }).type === "ledger_updated"),
      "rename_pane must broadcast ledger_updated"
    );
  });

  it("switch_context: ok -> 200 { output:<briefing> }; switches + saves settings + broadcasts", async () => {
    const { ctx, probe } = makeCtx({
      projects: { p2: { name: "Proj Two", directory: "/p2", panes: {} } },
    });
    const { result, status, json } = await runToHttp("switch_context", { project_id: "p2" }, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(json, { output: { project_id: "p2", summary: "briefing:Proj Two" } });
    assert.deepStrictEqual(probe.switched, ["p2"]); // the snake_case arg reached ledger.switchContext
    assert.ok(probe.settingsSaves >= 1, "switch_context must persist settings");
    assert.ok(
      probe.broadcasts.some((m) => (m as { type?: string }).type === "ledger_updated"),
      "switch_context must broadcast ledger_updated"
    );
  });

  it("switch_context (unknown id): ok -> 200 with the not-found briefing fallback (faithful)", async () => {
    const { ctx, probe } = makeCtx({ projects: {} });
    const { result, status, json } = await runToHttp("switch_context", { project_id: "ghost" }, ctx);
    assert.strictEqual(result.kind, "ok"); // briefing fallback is still kind:"ok" on the wire
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(json, { output: { error: "Project not found" } });
    assert.deepStrictEqual(probe.switched, ["ghost"]); // unconditional switch (asymmetry hazard, preserved)
  });

  // NOTE: execute_plan is HELD inline this batch (see the REST-stub blocker section). These two
  // def-level tests use a WORKING fake dispatchProposal to document that the HANDLER is correct — the
  // blocker is the REST ctx's refusing stub, NOT the handler. They are not a convergence claim.
  it("execute_plan (handler, working dispatch): ok -> 200; runs step 1 + saves + broadcasts plans_updated", async () => {
    const { ctx, probe } = makeCtx({
      plans: [
        {
          id: "plan-1",
          name: "Deploy",
          status: "pending",
          currentStepIndex: -1,
          steps: [{ terminalId: "t1", command: "ls", status: "pending" }],
        },
      ],
      dispatchOutcome: { kind: "executed", text: "ran" },
    });
    const { result, status, json } = await runToHttp("execute_plan", { plan_id: "plan-1" }, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(status, 200);
    assert.ok(
      typeof (json as { output?: unknown }).output === "string" &&
        ((json as { output: string }).output.includes("Started execution") ||
          (json as { output: string }).output.includes("Deploy")),
      "execute_plan ok branch narrates the started-plan read-back"
    );
    // the snake_case plan_id reached the handler -> step 1 dispatched + persisted + broadcast
    assert.strictEqual(probe.dispatchArgs.length, 1, "execute_plan must route step 1 through dispatchProposal");
    assert.strictEqual(
      (probe.dispatchArgs[0] as { capability?: string }).capability,
      "execute_plan",
      "execute_plan step 1 must ride the execute_plan capability (enforces the gate the inline path skipped)"
    );
    assert.ok(probe.saveCalls.includes(true), "execute_plan must persist the ledger (save(true))");
    assert.ok(
      probe.broadcasts.some((m) => (m as { type?: string }).type === "plans_updated"),
      "execute_plan must broadcast plans_updated"
    );
  });

  it("execute_plan (unknown plan_id): ok -> 200 not-found narration (delta: inline 404 -> 200)", async () => {
    const { ctx, probe } = makeCtx({ plans: [] });
    const { result, status, json } = await runToHttp("execute_plan", { plan_id: "nope" }, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(status, 200); // <- accepted behavior delta vs the inline 404
    assert.ok(
      typeof (json as { output?: unknown }).output === "string" &&
        (json as { output: string }).output.includes("not found"),
      "execute_plan unknown id narrates a not-found string"
    );
    assert.strictEqual(probe.dispatchArgs.length, 0, "no dispatch on an unknown plan id");
  });
});

// ── (2) route-param-flow contract — the Batch-B-specific risk, driven through the real seam ────────
// Build the registry-derived route via mountRestRoutes with a fake Express app, then invoke the
// captured handler with a req carrying ONLY route `params` (the snake_case path segments). This proves
// the snake_case route param actually populates the snake_case zod key on the way into the handler.
describe("c55 Batch B — route-param flow through mountRestRoutes (snake_case segments)", () => {
  // Mount one named def with a captured-handler app + a provided ctx, and return the invoker.
  function mountOne(
    name: string,
    ctx: ActionContext
  ): { method: string; path: string; invoke: (req: RestRequest) => Promise<{ status?: number; json?: unknown }> } {
    let captured: { method: string; path: string; handler: RestHandler } | undefined;
    const fakeApp = {
      get: (p: string, h: RestHandler) => { captured = { method: "get", path: p, handler: h }; },
      post: (p: string, h: RestHandler) => { captured = { method: "post", path: p, handler: h }; },
      put: (p: string, h: RestHandler) => { captured = { method: "put", path: p, handler: h }; },
      delete: (p: string, h: RestHandler) => { captured = { method: "delete", path: p, handler: h }; },
    } as unknown as RestApp;
    mountRestRoutes(fakeApp, REGISTRY, () => ctx, { only: new Set([name]) });
    assert.ok(captured, `mountRestRoutes must register a route for ${name} (rest surface + binding)`);
    return {
      method: captured!.method,
      path: captured!.path,
      invoke: async (req: RestRequest) => {
        const { res, sent } = makeFakeRes();
        await captured!.handler(req, res);
        return { status: sent.status, json: sent.json };
      },
    };
  }

  it("rename_project: PUT /api/projects/:project_id/rename — :project_id segment reaches project_id", async () => {
    const { ctx, projects } = makeCtx({ projects: { px: { name: "old", directory: "/px", panes: {} } } });
    const route = mountOne("rename_project", ctx);
    assert.strictEqual(route.method, "put");
    assert.strictEqual(route.path, "/api/projects/:project_id/rename");
    // req carries the route param under the SNAKE_CASE key (Express injects by exact segment name).
    const { status } = await route.invoke({ params: { project_id: "px" }, body: { name: "via-route" } });
    assert.strictEqual(status, 200);
    assert.strictEqual(projects.px.name, "via-route", "the :project_id route segment must rename the seeded project");
  });

  it("rename_pane: PUT /api/projects/:project_id/panes/:pane_id/rename — both snake segments flow", async () => {
    const { ctx, projects } = makeCtx({
      projects: { px: { name: "p", directory: "/px", panes: { pz: { name: "old" } } } },
    });
    const route = mountOne("rename_pane", ctx);
    assert.strictEqual(route.method, "put");
    assert.strictEqual(route.path, "/api/projects/:project_id/panes/:pane_id/rename");
    const { status } = await route.invoke({
      params: { project_id: "px", pane_id: "pz" },
      body: { name: "via-route-pane" },
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(projects.px.panes.pz.name, "via-route-pane", "both route segments must reach the handler");
  });

  it("switch_context: POST /api/projects/:project_id/switch — :project_id segment reaches the handler", async () => {
    const { ctx, probe } = makeCtx({ projects: { pq: { name: "Q", directory: "/pq", panes: {} } } });
    const route = mountOne("switch_context", ctx);
    assert.strictEqual(route.method, "post");
    assert.strictEqual(route.path, "/api/projects/:project_id/switch");
    const { status, json } = await route.invoke({ params: { project_id: "pq" } });
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(probe.switched, ["pq"], "the :project_id route segment must reach ledger.switchContext");
    assert.deepStrictEqual(json, { output: { project_id: "pq", summary: "briefing:Q" } });
  });

});

// ── (3) REST-STUB BLOCKER — pins WHY execute_plan is held inline this batch ──────────────────────────
// execute_plan's handler routes step 1 through ctx.dispatchProposal. buildRestActionContext injects a
// REFUSING STUB for dispatchProposal on the REST surface (pane-write is connection-scoped — see
// voice/index.ts:21-22). Drive execute_plan through the SAME refusing stub and assert the route does
// NOT actually dispatch the pane write: the handler narrates the pane-write-unavailable error and
// never runs the step. This is the regression that would break the UI "Run plan" button if we
// converged the route — it justifies holding execute_plan inline until a REST-capable pane-write path
// is authored (an architectural decision, surfaced for ratification).
describe("c55 Batch B — execute_plan held: the REST dispatchProposal stub refuses the pane write", () => {
  // The EXACT stub buildRestActionContext (server.ts) injects for the REST surface.
  const REST_DISPATCH_REFUSAL = "pane-write is not available on the REST surface";

  it("execute_plan via the REST refusing-stub dispatchProposal narrates the refusal, never dispatches", async () => {
    const { ctx, probe } = makeCtx({
      plans: [
        {
          id: "plan-z",
          name: "ZPlan",
          status: "pending",
          currentStepIndex: -1,
          steps: [{ terminalId: "t1", command: "go", status: "pending" }],
        },
      ],
      // Mirror the REST surface: dispatchProposal ALWAYS refuses (kind:"error").
      dispatchOutcome: { kind: "error", text: REST_DISPATCH_REFUSAL },
    });
    const { result, status, json } = await runToHttp("execute_plan", { plan_id: "plan-z" }, ctx);
    // The handler still answers kind:"ok" -> 200, but the OUTPUT is the could-not-start refusal —
    // the plan step was NOT run. On the real REST surface there is no terminal write at all.
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(status, 200);
    const out = (json as { output?: unknown }).output;
    assert.ok(
      typeof out === "string" && out.includes(REST_DISPATCH_REFUSAL),
      `execute_plan over the REST stub must narrate the pane-write-unavailable refusal (got: ${String(out)})`
    );
    // dispatchProposal was CALLED (the handler tried), but it refused — so no real write happened. The
    // handler's plan-found branch still dispatched once and got the refusal back.
    assert.strictEqual(probe.dispatchArgs.length, 1, "the handler attempts the dispatch (which the stub refuses)");
  });
});

// ── registry bindings (the SNAKE_CASE rest.path / method the cutover relies on) ─────────────────────
describe("c55 Batch B — registry rest bindings (snake_case route params)", () => {
  // The 3 CONVERGED twins now bind snake_case route params.
  const want: Record<string, { method: string; path: string }> = {
    rename_project: { method: "put", path: "/api/projects/:project_id/rename" },
    rename_pane: { method: "put", path: "/api/projects/:project_id/panes/:pane_id/rename" },
    switch_context: { method: "post", path: "/api/projects/:project_id/switch" },
  };
  for (const [name, binding] of Object.entries(want)) {
    it(`${name} binds ${binding.method.toUpperCase()} ${binding.path} on the 'rest' surface`, () => {
      const def = REGISTRY.find((d) => d.name === name);
      assert.ok(def, `registry must contain ${name}`);
      assert.ok(def!.surfaces.has("rest"), `${name} must expose the rest surface`);
      assert.deepStrictEqual(def!.rest, binding);
    });
  }

  // execute_plan is HELD: its rest.path keeps the LEGACY camelCase `:id` segment (NOT rewritten),
  // because the route stays inline this batch. Pin that so a future batch that converges it must
  // ALSO flip this expectation deliberately (and author the snake_case path + a REST-capable
  // dispatchProposal at the same time).
  it("execute_plan rest binding is UNCHANGED (held inline; legacy :id segment)", () => {
    const def = REGISTRY.find((d) => d.name === "execute_plan");
    assert.ok(def, "registry must contain execute_plan");
    assert.deepStrictEqual(def!.rest, { method: "post", path: "/api/plans/:id/execute" });
  });
});

// ── (4) cutover guard — server.ts text-inspected for the mount + the absent inline twins ───────────
describe("c55 Batch B — server.ts cutover guard (no double-registration)", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const serverSrc = readFileSync(path.join(here, "..", "server.ts"), "utf8");

  // The 3 CONVERGED twins must be in the only-set.
  const onlyNames = ["rename_project", "rename_pane", "switch_context"];

  const mountIdx = serverSrc.indexOf("mountRestRoutes(");
  const onlyOpenIdx = mountIdx >= 0 ? serverSrc.indexOf("only: new Set([", mountIdx) : -1;
  const onlyCloseIdx = onlyOpenIdx >= 0 ? serverSrc.indexOf("])", onlyOpenIdx) : -1;
  const mountBlock =
    onlyOpenIdx >= 0 && onlyCloseIdx >= 0 ? serverSrc.slice(onlyOpenIdx, onlyCloseIdx + 2) : "";

  for (const name of onlyNames) {
    it(`mountRestRoutes only-set includes "${name}"`, () => {
      assert.ok(mountIdx >= 0, "server.ts must call mountRestRoutes");
      assert.ok(
        new RegExp(`["']${name}["']`).test(mountBlock),
        `mountRestRoutes only-set must include "${name}" after the Batch-B cutover`
      );
    });
  }

  // execute_plan must NOT be in the only-set (held inline). If a future batch adds it, this test must
  // be flipped deliberately together with the REST-capable pane-write fix.
  it("mountRestRoutes only-set does NOT include execute_plan (held inline this batch)", () => {
    assert.ok(mountIdx >= 0, "server.ts must call mountRestRoutes");
    assert.ok(
      !/["']execute_plan["']/.test(mountBlock),
      "execute_plan must stay OUT of the only-set until the REST dispatchProposal stub is replaced"
    );
  });

  // Every CONVERGED Batch-B inline route literal (the camelCase-segment twin) must be GONE.
  const goneLiterals: Array<{ label: string; needle: RegExp }> = [
    {
      label: "PUT /api/projects/:id/rename",
      needle: /app\.put\(\s*["']\/api\/projects\/:id\/rename["']/,
    },
    {
      label: "PUT /api/projects/:projectId/panes/:paneId/rename",
      needle: /app\.put\(\s*["']\/api\/projects\/:projectId\/panes\/:paneId\/rename["']/,
    },
    {
      label: "POST /api/projects/:id/switch",
      needle: /app\.post\(\s*["']\/api\/projects\/:id\/switch["']/,
    },
  ];
  for (const { label, needle } of goneLiterals) {
    it(`inline route is deleted: ${label}`, () => {
      assert.ok(
        !needle.test(serverSrc),
        `inline ${label} must be deleted (double-registration masks the cutover)`
      );
    });
  }

  // execute_plan's inline route is HELD (preserved) this batch — assert it is STILL present.
  it("inline route is PRESERVED (held): POST /api/plans/:id/execute (execute_plan)", () => {
    assert.ok(
      /app\.post\(\s*["']\/api\/plans\/:id\/execute["']/.test(serverSrc),
      "execute_plan inline route must remain inline until a REST-capable dispatchProposal is authored"
    );
  });

  // Guard the OUT-OF-SCOPE neighbors stayed inline (this batch must NOT touch them). These share the
  // `/api/projects/:id/...` and `/api/plans/:id/...` shape but are different paths / later batches.
  // NOTE: PUT /api/projects/:projectId/panes/:paneId/permissions was a Batch-B out-of-scope neighbor,
  // but c55 Batch D CONVERGED it (set_pane_permissions snake_case rest.path + permissions coerce), so it
  // is no longer asserted-preserved here — Batch D's own cutover guard asserts that inline twin is GONE.
  // NOTE: DELETE /api/plans/:id was likewise a Batch-B out-of-scope neighbor, but c55 Batch G CONVERGED
  // it (delete_orchestrator_plan, snake_case :plan_id rest.path), so it is no longer asserted-preserved
  // here — Batch G's own contract suite (test_watch_rules_c55.ts) pins the converged def + the WS frame.
  const keptLiterals: Array<{ label: string; needle: RegExp }> = [
    { label: "POST /api/projects/:id/notes", needle: /app\.post\(\s*["']\/api\/projects\/:id\/notes["']/ },
    { label: "DELETE /api/projects/:id", needle: /app\.delete\(\s*["']\/api\/projects\/:id["']/ },
  ];
  for (const { label, needle } of keptLiterals) {
    it(`out-of-scope inline route is preserved: ${label}`, () => {
      assert.ok(needle.test(serverSrc), `${label} must remain inline this batch (out of scope)`);
    });
  }
});
