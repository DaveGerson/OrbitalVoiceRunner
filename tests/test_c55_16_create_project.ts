/**
 * tests/test_c55_16_create_project.ts — c55.16 create_project (the post-create RENAME 2nd-mutation).
 *
 * c55.16 converges the inline `app.post("/api/projects", …)` (server.ts) onto the EXISTING
 * create_project registry def. The blocker was the inline route's OPTIONAL post-create rename — a
 * SECOND ledger mutation (`renameProject(id, name)`) the def never ported. Both mutations
 * (`addProject` then, iff a truthy `name`, `renameProject`) are PURE ledger ops (no connection
 * scope), so the registry handler can run both — see the design doc
 * (docs/superpowers/specs/2026-06-05-c55-16-create-project-2nd-mutation-design.md).
 *
 * The convergence:
 *   1. `CreateProjectParams` gains `name: z.string().optional()` (WITHOUT the schema field the
 *      default strict-strip object drops `name` before the handler sees it → the 2nd mutation never
 *      fires even with coerceArgs).
 *   2. A `coerceArgs` shim aliases the CLIENT body skew onto the snake_case zod keys, but ONLY when
 *      the snake key is ABSENT: `if (out.project_id == null && out.id != null) out.project_id = out.id`
 *      etc. coerceArgs runs BEFORE params.parse (gemini.ts), and the "only when absent" guard means a
 *      VOICE call carrying project_id/key_terms is never clobbered — so the create_project /
 *      create_project.bad_dir goldens (which send snake_case, never id/name) stay byte-identical.
 *   3. The handler runs `addProject(...)` then `if (name) renameProject(project_id, name)` BEFORE the
 *      single `broadcastLedgerUpdate()` — one `ledger_updated` frame, exactly as the inline route.
 *
 * Recorded behavior deltas (client-invisible — App.tsx:1762-1773 awaits the fetch but reads NO field
 * of the response, then repaints via handleSwitchProject -> fetchLedger/fetchTerminals + the live
 * ledger_updated WS frame):
 *   - happy path: inline returned 200 { success:true }; the registry twin returns
 *     200 { output: "Project context <id> created successfully." } (same accepted class as Batch B).
 *   - malformed direct call (no id): inline 400 { error:"Missing required field: id" } → zod 500
 *     (project_id Required) — same accepted class as create_pane's inline-400 → zod-500 delta.
 *
 * Assertion layers (mirrors tests/test_c55_batch_b.ts):
 *   (1) DEF-LEVEL CONTRACT — runAction choke-point → kind:"ok" → resultToHttp 200 { output }, plus
 *       the ledger mutation(s) + EXACTLY ONE ledger_updated broadcast.
 *   (2) CLIENT-BODY-SKEW — feed the RAW client body {id,name,keyTerms,directory} through coerceArgs;
 *       both addProject + renameProject must run (this is the test that FAILS today: project_id
 *       undefined → zod 500).
 *   (3) ROUTE-FLOW — through the REAL mountRestRoutes({only:new Set(["create_project"])}) seam.
 *   (4) REGISTRY BINDING — surfaces.has("rest") + rest === { post, /api/projects }.
 *   (5) CUTOVER GUARD — server.ts text: only-set INCLUDES "create_project" AND the inline
 *       app.post("/api/projects" literal is GONE (regex trailing-comma anchored so it does NOT match
 *       /api/projects/:id/switch etc.).
 *   (6) CATALOG GUARD — INLINE_EXCEPTIONS no longer contains { post, /api/projects }.
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
import { INLINE_EXCEPTIONS } from "../src/actions/inlineExceptions";
import type { ActionContext, ActionResult } from "../src/actions/types";

// A directory guaranteed NOT to exist — drives the G5 bad-dir branch (mirrors the golden string).
const BAD_DIR = "/definitely/not/a/real/dir/xyzzy";

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
// Faithful to the surface the create_project handler touches:
//   ledger.addProject(id, directory, summary, keyTerms)  [no-op if id exists]
//   ledger.renameProject(id, name)                       [no-op if id unknown]
//   broadcastLedgerUpdate()
interface SeedProject {
  id: string;
  name: string;
  directory: string;
  summary: string;
  keyTerms: string[];
}
interface AddProjectCall {
  id: string;
  directory: string;
  summary: string;
  keyTerms: string[];
}
interface RenameProjectCall {
  id: string;
  name: string;
}
interface CtxProbe {
  broadcasts: unknown[];
  ledgerUpdates: number;
  addCalls: AddProjectCall[];
  renameCalls: RenameProjectCall[];
  // ordered log of mutation kinds to assert addProject THEN renameProject sequencing
  order: Array<"add" | "rename">;
}

function makeCtx(): {
  ctx: ActionContext;
  probe: CtxProbe;
  projects: Record<string, SeedProject>;
} {
  const probe: CtxProbe = {
    broadcasts: [],
    ledgerUpdates: 0,
    addCalls: [],
    renameCalls: [],
    order: [],
  };
  const projects: Record<string, SeedProject> = {};
  const ledger = {
    workspaces: projects,
    addProject: (id: string, directory: string, summary = "", keyTerms: string[] = []): void => {
      probe.addCalls.push({ id, directory, summary, keyTerms });
      probe.order.push("add");
      if (!projects[id]) {
        projects[id] = { id, name: id, directory, summary, keyTerms }; // name initializes to id (faithful)
      }
    },
    renameProject: (id: string, name: string): void => {
      probe.renameCalls.push({ id, name });
      probe.order.push("rename");
      if (projects[id]) projects[id].name = name; // silent no-op on unknown id (faithful)
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
    session: null,
    callId: "call-test",
    manager: { ledger },
  } as unknown as ActionContext;
  return { ctx, probe, projects };
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
describe("c55.16 create_project — def-level contract (runAction -> ok -> 200 + ledger mutation + WS frame)", () => {
  it("happy path, NO name: ok -> 200 { output }; addProject('p1'..) only; renameProject NOT called; ONE ledger_updated", async () => {
    const { ctx, probe } = makeCtx();
    const { result, status, json } = await runToHttp(
      "create_project",
      { project_id: "p1", directory: "" }, // blank dir -> resolves to server cwd (exists)
      ctx
    );
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(json, { output: "Project context p1 created successfully." });
    assert.strictEqual(probe.addCalls.length, 1, "addProject must be called once");
    assert.strictEqual(probe.addCalls[0].id, "p1");
    assert.strictEqual(probe.renameCalls.length, 0, "renameProject must NOT be called without a name");
    assert.strictEqual(probe.ledgerUpdates, 1, "exactly one ledger_updated broadcast");
  });

  it("happy path WITH name: addProject('p2'..) THEN renameProject('p2','My Proj') in ORDER; seeded name set; ONE broadcast", async () => {
    const { ctx, probe, projects } = makeCtx();
    const { result, status, json } = await runToHttp(
      "create_project",
      { project_id: "p2", name: "My Proj", directory: "" },
      ctx
    );
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(json, { output: "Project context p2 created successfully." });
    // ORDER: addProject must run before renameProject (the rename targets the just-created id).
    assert.deepStrictEqual(probe.order, ["add", "rename"], "addProject must precede renameProject");
    assert.strictEqual(probe.addCalls.length, 1);
    assert.strictEqual(probe.addCalls[0].id, "p2");
    assert.deepStrictEqual(probe.renameCalls, [{ id: "p2", name: "My Proj" }]);
    assert.strictEqual(projects.p2.name, "My Proj", "the 2nd mutation must set the display name");
    assert.strictEqual(probe.ledgerUpdates, 1, "still exactly one ledger_updated broadcast (after BOTH mutations)");
  });

  it("empty name string does NOT trigger the 2nd mutation (falsy guard)", async () => {
    const { ctx, probe } = makeCtx();
    const { result, status } = await runToHttp(
      "create_project",
      { project_id: "p1b", name: "", directory: "" },
      ctx
    );
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(status, 200);
    assert.strictEqual(probe.renameCalls.length, 0, "an empty-string name is falsy -> no renameProject");
  });

  it("bad-dir branch unchanged: ok -> 200 { output: starts-with 'Error: the directory' }; addProject NOT called", async () => {
    const { ctx, probe } = makeCtx();
    const { result, status, json } = await runToHttp(
      "create_project",
      { project_id: "p4", directory: BAD_DIR },
      ctx
    );
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(status, 200);
    const out = (json as { output?: unknown }).output;
    assert.ok(
      typeof out === "string" && out.startsWith("Error: the directory"),
      `bad-dir branch must narrate the rejection (got: ${String(out)})`
    );
    assert.strictEqual(probe.addCalls.length, 0, "a bad directory must NOT persist a project");
    assert.strictEqual(probe.renameCalls.length, 0);
    assert.strictEqual(probe.ledgerUpdates, 0, "no ledger_updated on a rejected create");
  });
});

// ── (2) client-body-skew via coerceArgs — the highest-value test (fails today) ──────────────────────
describe("c55.16 create_project — coerceArgs absorbs the RAW client body skew", () => {
  it("RAW client body {id,name,keyTerms,directory} -> addProject('p3',<dir>,'',['a']) + renameProject('p3','C') both run", async () => {
    const { ctx, probe } = makeCtx();
    // The EXACT shape the UI POSTs (App.tsx:1762-1773): camelCase `id`/`keyTerms` + `name`.
    const { result, status } = await runToHttp(
      "create_project",
      { id: "p3", name: "C", keyTerms: ["a"], directory: "", summary: "" },
      ctx
    );
    assert.strictEqual(result.kind, "ok", "without coerceArgs, project_id is undefined -> zod 500 (the bug)");
    assert.strictEqual(status, 200);
    assert.strictEqual(probe.addCalls.length, 1, "addProject must run with the aliased id");
    assert.strictEqual(probe.addCalls[0].id, "p3", "client `id` must alias onto project_id");
    assert.deepStrictEqual(probe.addCalls[0].keyTerms, ["a"], "client `keyTerms` must alias onto key_terms");
    assert.deepStrictEqual(probe.renameCalls, [{ id: "p3", name: "C" }], "the post-create rename must run");
  });

  it("voice-shape body {project_id,key_terms} is NOT clobbered (goldens stay byte-identical)", async () => {
    const { ctx, probe } = makeCtx();
    // A snake_case voice call must pass through untouched (alias ONLY when the snake key is absent).
    const { result, status } = await runToHttp(
      "create_project",
      { project_id: "vp", key_terms: ["k1", "k2"], summary: "voice", directory: "" },
      ctx
    );
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(status, 200);
    assert.strictEqual(probe.addCalls[0].id, "vp", "snake_case project_id is preserved");
    assert.deepStrictEqual(probe.addCalls[0].keyTerms, ["k1", "k2"], "snake_case key_terms is preserved");
    assert.strictEqual(probe.renameCalls.length, 0, "no name -> no rename (golden parity)");
  });

  it("both project_id AND id present -> project_id wins (never clobbered)", async () => {
    const { ctx, probe } = makeCtx();
    const { result } = await runToHttp(
      "create_project",
      { project_id: "snake", id: "camel", directory: "" },
      ctx
    );
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(probe.addCalls[0].id, "snake", "alias only when snake key absent -> project_id wins");
  });
});

// ── (3) route-flow through the REAL mountRestRoutes seam ────────────────────────────────────────────
describe("c55.16 create_project — route-flow through mountRestRoutes only-set", () => {
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

  it("POST /api/projects — raw client body {id,name,directory} reaches the handler; seeds p5 named R", async () => {
    const { ctx, projects } = makeCtx();
    const route = mountOne("create_project", ctx);
    assert.strictEqual(route.method, "post");
    assert.strictEqual(route.path, "/api/projects");
    const { status } = await route.invoke({ body: { id: "p5", name: "R", directory: "" } });
    assert.strictEqual(status, 200);
    assert.ok(projects.p5, "the body must reach the handler through mountRestRoutes end-to-end");
    assert.strictEqual(projects.p5.name, "R", "the post-create rename must run through the real seam");
  });
});

// ── (4) registry binding ────────────────────────────────────────────────────────────────────────
describe("c55.16 create_project — registry rest binding", () => {
  it("create_project binds POST /api/projects on the 'rest' surface", () => {
    const def = REGISTRY.find((d) => d.name === "create_project");
    assert.ok(def, "registry must contain create_project");
    assert.ok(def!.surfaces.has("rest"), "create_project must expose the rest surface");
    assert.deepStrictEqual(def!.rest, { method: "post", path: "/api/projects" });
  });
});

// ── (5) cutover guard — server.ts text-inspected for the mount + the absent inline twin ─────────────
describe("c55.16 create_project — server.ts cutover guard (no double-registration)", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const serverSrc = readFileSync(path.join(here, "..", "server.ts"), "utf8");

  const mountIdx = serverSrc.indexOf("mountRestRoutes(");
  const onlyOpenIdx = mountIdx >= 0 ? serverSrc.indexOf("only: new Set([", mountIdx) : -1;
  const onlyCloseIdx = onlyOpenIdx >= 0 ? serverSrc.indexOf("])", onlyOpenIdx) : -1;
  const mountBlock =
    onlyOpenIdx >= 0 && onlyCloseIdx >= 0 ? serverSrc.slice(onlyOpenIdx, onlyCloseIdx + 2) : "";

  it('mountRestRoutes only-set includes "create_project"', () => {
    assert.ok(mountIdx >= 0, "server.ts must call mountRestRoutes");
    assert.ok(
      /["']create_project["']/.test(mountBlock),
      'mountRestRoutes only-set must include "create_project" after the c55.16 cutover'
    );
  });

  // The inline EXACT-path literal must be GONE. The trailing-comma anchor keeps this from matching
  // sibling sub-routes like POST /api/projects/:id/switch or PUT /api/projects/:project_id/rename.
  it('inline route is deleted: app.post("/api/projects", …)', () => {
    assert.ok(
      !/app\.post\(\s*["']\/api\/projects["']\s*,/.test(serverSrc),
      'inline app.post("/api/projects", …) must be deleted (double-registration masks the cutover)'
    );
  });
});

// ── (6) catalog guard — the held INLINE_EXCEPTIONS row is removed ───────────────────────────────────
describe("c55.16 create_project — inlineExceptions catalog guard", () => {
  it("INLINE_EXCEPTIONS no longer contains { post, /api/projects }", () => {
    const held = INLINE_EXCEPTIONS.find((e) => e.method === "post" && e.path === "/api/projects");
    assert.strictEqual(held, undefined, "the held create_project catalog row must be deleted (no-twin lockstep)");
  });
});
