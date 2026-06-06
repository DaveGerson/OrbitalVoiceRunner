// c55.14 — rest-only project/pane LIFECYCLE ActionDefs contract suite.
//
// Four NEW rest-only defs that converge inline lifecycle routes with NO voice twin today:
//   update_project   PUT    /api/projects/:project_id                       (ALWAYS_ALLOWED — was ungated)
//   stop_pane        POST   /api/projects/:project_id/panes/:pane_id/stop    (ALWAYS_ALLOWED — was ungated)
//   delete_project   DELETE /api/projects/:project_id                       (GATED delete_project, default Ask — behaviorDelta)
//   delete_pane      DELETE /api/projects/:project_id/panes/:pane_id         (GATED delete_pane, default Ask — behaviorDelta)
//
// DOCTRINE (def-level deterministic): call runAction with a fake ctx + fake manager, assert the
// ActionResult kind/output, then assert applyResultToHttp maps it to {status,body}. No server boot, no PTY.
// Pins: each def is rest-only (surfaces === {'rest'}), readOnly:false, correct rest method/path, on the
// INTENTIONAL_ASYMMETRY allow-list; the two ungated defs reproduce their inline effect EXACTLY; the two
// deletes ride STATUS-VIA-KINDS (Off->blocked->403, Ask->pending->202, Auto->ok->200), gated via gateOrDefer.
//
// Runner: npx tsx --test --test-force-exit tests/test_c55_14_lifecycle.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { REGISTRY } from "../src/actions/registry";
import { runAction } from "../src/actions/gemini";
import { applyResultToHttp, type RestResponse } from "../src/actions/rest";
import { INTENTIONAL_ASYMMETRY } from "../src/actions/coverage";
import { ALWAYS_ALLOWED } from "../src/actions/types";
import type { ActionContext, ActionDef } from "../src/actions/types";
import type { GateDisposition } from "../src/actions/types";

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────

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

// A minimal Workspace stand-in carrying only the lifecycle fields the defs touch.
interface FakeWs {
  directory?: string;
  summary?: string;
  keyTerms?: string[];
  name?: string;
  panes: Record<string, unknown>;
}

interface FakeTerm { stopped: number; stop: () => void; }
function makeFakeTerm(): FakeTerm {
  const t: FakeTerm = { stopped: 0, stop: () => { t.stopped++; } };
  return t;
}

interface CtxOpts {
  workspaces?: Record<string, FakeWs>;
  activeProjectId?: string | null;
  terminals?: Record<string, FakeTerm>;
  gateDisposition?: GateDisposition;
  stopAndArchivePane?: (projectId: string, paneId: string) => Promise<boolean>;
}

interface Recorded {
  gateCalls: Array<{ capability: string; paneId: string | null; summary: string; params?: Record<string, unknown> }>;
  ledgerUpdates: number;
  terminalsUpdated: number;
  saves: boolean[];              // each ledger.save(immediate) call -> the immediate flag
  saveSettings: number;
  addProjectCalls: unknown[][];
  switchContextCalls: string[];
  stopArchiveCalls: Array<[string, string]>;
}

function makeCtx(opts: CtxOpts = {}): { ctx: ActionContext; rec: Recorded; manager: any } {
  const rec: Recorded = {
    gateCalls: [], ledgerUpdates: 0, terminalsUpdated: 0, saves: [],
    saveSettings: 0, addProjectCalls: [], switchContextCalls: [], stopArchiveCalls: [],
  };
  const workspaces = opts.workspaces ?? {};
  const terminals = opts.terminals ?? {};
  const manager: any = {
    terminals,
    settings: { projects: { activeContext: "", localWorkspacePath: "" } },
    saveSettings: () => { rec.saveSettings++; },
    stopAndArchivePane: async (projectId: string, paneId: string): Promise<boolean> => {
      rec.stopArchiveCalls.push([projectId, paneId]);
      return opts.stopAndArchivePane ? opts.stopAndArchivePane(projectId, paneId) : true;
    },
    ledger: {
      workspaces,
      activeProjectId: opts.activeProjectId ?? null,
      getProject: (id: string): FakeWs | null => workspaces[id] ?? null,
      addProject: (...a: unknown[]): void => { rec.addProjectCalls.push(a); },
      switchContext: (id: string): void => { rec.switchContextCalls.push(id); manager.ledger.activeProjectId = id; },
      save: (immediate?: boolean): void => { rec.saves.push(!!immediate); },
    },
  };
  const ctx = {
    manager,
    session: null,
    redact: (s: string) => s,
    broadcast: () => {},
    broadcastLedgerUpdate: () => { rec.ledgerUpdates++; },
    broadcastTerminalsUpdated: () => { rec.terminalsUpdated++; },
    // Mirrors the REAL gateOrDefer (src/gating): it STAGES `run` only on the deferred (Ask) path; on the
    // "run" (Auto) path it returns {disposition:"run"} WITHOUT invoking run — the CALLER runs the effect.
    gateOrDefer: (capability: string, paneId: string | null, summary: string, run: () => string, params?: Record<string, unknown>): GateDisposition => {
      rec.gateCalls.push({ capability, paneId, summary, params });
      const d = opts.gateDisposition ?? { disposition: "run" as const };
      void run; // referenced for parity; not invoked on the "run" path (handler runs the effect)
      return d;
    },
  } as unknown as ActionContext;
  return { ctx, rec, manager };
}

// ─────────────────────────────────────────────────────────────────────────────
// (a) SHAPE — all four defs present, rest-only, correct gate/route/asymmetry.
// ─────────────────────────────────────────────────────────────────────────────
describe("c55.14 — shape", () => {
  const cases: Array<{ name: string; capability: string; method: string; path: string }> = [
    { name: "update_project", capability: ALWAYS_ALLOWED, method: "put", path: "/api/projects/:project_id" },
    { name: "stop_pane", capability: ALWAYS_ALLOWED, method: "post", path: "/api/projects/:project_id/panes/:pane_id/stop" },
    { name: "delete_project", capability: "delete_project", method: "delete", path: "/api/projects/:project_id" },
    { name: "delete_pane", capability: "delete_pane", method: "delete", path: "/api/projects/:project_id/panes/:pane_id" },
  ];
  for (const { name, capability, method, path } of cases) {
    it(`${name} is a rest-only def: cap=${capability}, ${method.toUpperCase()} ${path}, allow-listed`, () => {
      const def = findDef(name);
      assert.deepStrictEqual([...def.surfaces].sort(), ["rest"], `${name} surfaces must be exactly {rest}`);
      assert.strictEqual(def.capability, capability, `${name} capability`);
      assert.strictEqual(def.readOnly, false, `${name} readOnly:false`);
      assert.ok(def.rest, `${name} must declare a rest binding`);
      assert.strictEqual(def.rest!.method, method, `${name} rest method`);
      assert.strictEqual(def.rest!.path, path, `${name} rest path`);
      assert.deepStrictEqual(INTENTIONAL_ASYMMETRY[name], new Set(["rest"]), `${name} must be allow-listed rest-only`);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) FIDELITY — the two UNGATED defs reproduce their inline effect EXACTLY.
// ─────────────────────────────────────────────────────────────────────────────
describe("c55.14 — update_project fidelity (ALWAYS_ALLOWED)", () => {
  it("applies the provided fields + ledger.save(true) + broadcastLedgerUpdate; ok -> 200", async () => {
    const ws: FakeWs = { directory: "old", summary: "old", keyTerms: ["a"], name: "Old", panes: {} };
    const { ctx, rec, manager } = makeCtx({ workspaces: { p1: ws } });
    const result = await runAction(REGISTRY, "update_project", {
      project_id: "p1", directory: "/new", summary: "new summary", keyTerms: ["x", "y"], name: "New Name",
    }, ctx);
    assert.strictEqual(result.kind, "ok");
    const updated = manager.ledger.workspaces["p1"] as FakeWs;
    assert.strictEqual(updated.directory, "/new");
    assert.strictEqual(updated.summary, "new summary");
    assert.deepStrictEqual(updated.keyTerms, ["x", "y"]);
    assert.strictEqual(updated.name, "New Name");
    assert.deepStrictEqual(rec.saves, [true], "ledger.save(true) — the immediate flag the inline route passed");
    assert.strictEqual(rec.ledgerUpdates, 1, "broadcastLedgerUpdate fired");
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("update_project"), result, {}, res);
    assert.strictEqual(sent.status, 200);
  });

  it("only the provided fields mutate (undefined fields left untouched)", async () => {
    const ws: FakeWs = { directory: "keep", summary: "keep", keyTerms: ["keep"], name: "Keep", panes: {} };
    const { ctx } = makeCtx({ workspaces: { p1: ws } });
    await runAction(REGISTRY, "update_project", { project_id: "p1", summary: "only-summary" }, ctx);
    assert.strictEqual(ws.directory, "keep", "directory untouched when omitted");
    assert.strictEqual(ws.summary, "only-summary", "summary updated");
    assert.deepStrictEqual(ws.keyTerms, ["keep"], "keyTerms untouched when omitted");
    assert.strictEqual(ws.name, "Keep", "name untouched when omitted");
  });

  it("missing project -> ok narration -> 200 (inline 404 -> 200 delta); no save", async () => {
    const { ctx, rec } = makeCtx({ workspaces: {} });
    const result = await runAction(REGISTRY, "update_project", { project_id: "ghost", summary: "x" }, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.deepStrictEqual(rec.saves, [], "no save for a missing project");
    assert.strictEqual(rec.ledgerUpdates, 0, "no broadcast for a missing project");
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("update_project"), result, {}, res);
    assert.strictEqual(sent.status, 200);
  });
});

describe("c55.14 — stop_pane fidelity (ALWAYS_ALLOWED)", () => {
  it("awaits stopAndArchivePane(project_id,pane_id) + both broadcasts; ok -> 200", async () => {
    const { ctx, rec } = makeCtx({ stopAndArchivePane: async () => true });
    const result = await runAction(REGISTRY, "stop_pane", { project_id: "proj", pane_id: "pane7" }, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.deepStrictEqual(rec.stopArchiveCalls, [["proj", "pane7"]], "stopAndArchivePane called with (project_id, pane_id)");
    assert.strictEqual(rec.ledgerUpdates, 1, "broadcastLedgerUpdate fired");
    assert.strictEqual(rec.terminalsUpdated, 1, "broadcastTerminalsUpdated fired");
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("stop_pane"), result, {}, res);
    assert.strictEqual(sent.status, 200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) GATING — status-via-kinds for EACH delete: forbidden->403, deferred->202, allowed->200.
// ─────────────────────────────────────────────────────────────────────────────
describe("c55.14 — delete_project gating (status-via-kinds)", () => {
  function seed(): CtxOpts {
    return { workspaces: { p1: { panes: {} }, p2: { panes: {} } }, activeProjectId: "other" };
  }

  it("Off -> blocked -> 403 {error}; no ledger mutation", async () => {
    const opts: CtxOpts = { ...seed(), gateDisposition: { disposition: "forbidden" } };
    const { ctx, rec, manager } = makeCtx(opts);
    const result = await runAction(REGISTRY, "delete_project", { project_id: "p1" }, ctx);
    assert.strictEqual(result.kind, "blocked");
    assert.strictEqual(rec.gateCalls[0].capability, "delete_project", "gated via the delete_project capability");
    assert.ok(manager.ledger.workspaces["p1"], "forbidden delete leaves the workspace intact");
    assert.deepStrictEqual(rec.saves, [], "forbidden delete performs no save");
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("delete_project"), result, {}, res);
    assert.strictEqual(sent.status, 403);
    assert.ok((sent.json as { error: string }).error);
  });

  it("Ask -> pending (messageId+summary) -> 202; effect deferred (not run)", async () => {
    const opts: CtxOpts = { ...seed(), gateDisposition: { disposition: "deferred", actionId: "act_dp", summary: "Delete project p1" } };
    const { ctx, manager } = makeCtx(opts);
    const result = await runAction(REGISTRY, "delete_project", { project_id: "p1" }, ctx);
    assert.strictEqual(result.kind, "pending");
    assert.ok(manager.ledger.workspaces["p1"], "deferred delete does NOT mutate yet");
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("delete_project"), result, {}, res);
    assert.strictEqual(sent.status, 202);
    assert.deepStrictEqual(sent.json, { status: "pending_approval", messageId: "act_dp" });
  });

  it("Auto -> ok -> 200; workspace deleted + broadcast (non-active id: no reassignment)", async () => {
    const { ctx, rec, manager } = makeCtx(seed());
    const result = await runAction(REGISTRY, "delete_project", { project_id: "p1" }, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.ok(!manager.ledger.workspaces["p1"], "Auto delete removes the workspace");
    assert.ok(manager.ledger.workspaces["p2"], "sibling workspace untouched");
    assert.strictEqual(rec.ledgerUpdates, 1, "broadcastLedgerUpdate fired");
    assert.strictEqual(rec.switchContextCalls.length, 0, "deleting a NON-active project does not reassign");
    assert.strictEqual(rec.saveSettings, 0, "no settings write for a non-active delete");
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("delete_project"), result, {}, res);
    assert.strictEqual(sent.status, 200);
  });

  it("Auto deleting the ACTIVE project -> reassigns to a remaining id (switchContext + saveSettings)", async () => {
    const opts: CtxOpts = { workspaces: { p1: { directory: "/p1", panes: {} }, p2: { directory: "/p2", panes: {} } }, activeProjectId: "p1" };
    const { ctx, rec, manager } = makeCtx(opts);
    const result = await runAction(REGISTRY, "delete_project", { project_id: "p1" }, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.ok(!manager.ledger.workspaces["p1"], "active workspace deleted");
    assert.strictEqual(rec.switchContextCalls.length, 1, "active delete switches context to a remaining id");
    assert.strictEqual(rec.switchContextCalls[0], "p2", "reassigned to the remaining workspace id");
    assert.strictEqual(manager.settings.projects.activeContext, "p2", "settings.activeContext reassigned");
    assert.strictEqual(manager.settings.projects.localWorkspacePath, "/p2", "settings.localWorkspacePath follows the new active dir");
    assert.strictEqual(rec.saveSettings, 1, "saveSettings persisted the reassignment");
    assert.strictEqual(rec.addProjectCalls.length, 0, "a remaining id exists -> no default_project created");
  });

  it("Auto deleting the LAST (active) project -> creates default_project then switches", async () => {
    const opts: CtxOpts = { workspaces: { p1: { panes: {} } }, activeProjectId: "p1" };
    const { ctx, rec, manager } = makeCtx(opts);
    const result = await runAction(REGISTRY, "delete_project", { project_id: "p1" }, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(rec.addProjectCalls.length, 1, "no remaining id -> addProject(default_project)");
    assert.strictEqual(rec.addProjectCalls[0][0], "default_project", "the fallback id is default_project");
    assert.strictEqual(rec.switchContextCalls[0], "default_project", "switched into the new default");
  });

  it("missing project -> ok narration -> 200; gate NOT consulted (resolve before gate)", async () => {
    const { ctx, rec } = makeCtx({ workspaces: {} });
    const result = await runAction(REGISTRY, "delete_project", { project_id: "ghost" }, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(rec.gateCalls.length, 0, "a non-existent project is never staged/forbidden");
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("delete_project"), result, {}, res);
    assert.strictEqual(sent.status, 200);
  });
});

describe("c55.14 — delete_pane gating (status-via-kinds)", () => {
  function seed(termStopped?: FakeTerm): CtxOpts {
    return {
      workspaces: { proj: { panes: { pane7: {} } } as FakeWs },
      activeProjectId: "proj",
      terminals: termStopped ? { pane7: termStopped } : {},
    };
  }

  it("Off -> blocked -> 403 {error}; no pane mutation, no term.stop()", async () => {
    const term = makeFakeTerm();
    const opts: CtxOpts = { ...seed(term), gateDisposition: { disposition: "forbidden" } };
    const { ctx, rec, manager } = makeCtx(opts);
    const result = await runAction(REGISTRY, "delete_pane", { project_id: "proj", pane_id: "pane7" }, ctx);
    assert.strictEqual(result.kind, "blocked");
    assert.strictEqual(rec.gateCalls[0].capability, "delete_pane", "gated via the delete_pane capability");
    assert.strictEqual(rec.gateCalls[0].paneId, "pane7", "gate keyed on the pane id");
    assert.strictEqual(term.stopped, 0, "forbidden delete does NOT stop the live terminal");
    assert.ok((manager.ledger.workspaces["proj"] as FakeWs).panes["pane7"], "forbidden delete leaves the pane record");
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("delete_pane"), result, {}, res);
    assert.strictEqual(sent.status, 403);
    assert.ok((sent.json as { error: string }).error);
  });

  it("Ask -> pending (messageId+summary) -> 202; effect deferred (not run)", async () => {
    const term = makeFakeTerm();
    const opts: CtxOpts = { ...seed(term), gateDisposition: { disposition: "deferred", actionId: "act_dpn", summary: "Delete pane pane7" } };
    const { ctx, manager } = makeCtx(opts);
    const result = await runAction(REGISTRY, "delete_pane", { project_id: "proj", pane_id: "pane7" }, ctx);
    assert.strictEqual(result.kind, "pending");
    assert.strictEqual(term.stopped, 0, "deferred delete does NOT stop the terminal yet");
    assert.ok((manager.ledger.workspaces["proj"] as FakeWs).panes["pane7"], "deferred delete leaves the pane record");
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("delete_pane"), result, {}, res);
    assert.strictEqual(sent.status, 202);
    assert.deepStrictEqual(sent.json, { status: "pending_approval", messageId: "act_dpn" });
  });

  it("Auto -> ok -> 200; term.stop()+drop, pane record deleted, ledger.save() + both broadcasts", async () => {
    const term = makeFakeTerm();
    const { ctx, rec, manager } = makeCtx(seed(term));
    const result = await runAction(REGISTRY, "delete_pane", { project_id: "proj", pane_id: "pane7" }, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(term.stopped, 1, "live terminal stopped");
    assert.ok(!manager.terminals["pane7"], "live terminal dropped from manager.terminals");
    assert.ok(!(manager.ledger.workspaces["proj"] as FakeWs).panes["pane7"], "pane record deleted from the ledger");
    assert.deepStrictEqual(rec.saves, [false], "ledger.save() — the inline pane-delete passed no immediate flag");
    assert.strictEqual(rec.ledgerUpdates, 1, "broadcastLedgerUpdate fired");
    assert.strictEqual(rec.terminalsUpdated, 1, "broadcastTerminalsUpdated fired");
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("delete_pane"), result, {}, res);
    assert.strictEqual(sent.status, 200);
  });

  it("Auto with NO live term (ledger-only pane) -> still deletes the record + save + broadcasts", async () => {
    const { ctx, rec, manager } = makeCtx(seed()); // no terminals
    const result = await runAction(REGISTRY, "delete_pane", { project_id: "proj", pane_id: "pane7" }, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.ok(!(manager.ledger.workspaces["proj"] as FakeWs).panes["pane7"], "ledger-only pane record deleted");
    assert.deepStrictEqual(rec.saves, [false], "ledger.save() fired for the ledger-only delete");
    assert.strictEqual(rec.terminalsUpdated, 1, "broadcastTerminalsUpdated fired");
  });

  it("missing pane (no live term AND no ledger record) -> ok narration -> 200; gate NOT consulted, no mutation/broadcast", async () => {
    // Workspace exists but has NO pane record, and there is no live terminal -> the pane is a ghost.
    const opts: CtxOpts = { workspaces: { proj: { panes: {} } as FakeWs }, activeProjectId: "proj", terminals: {} };
    const { ctx, rec, manager } = makeCtx(opts);
    const result = await runAction(REGISTRY, "delete_pane", { project_id: "proj", pane_id: "ghost_pane" }, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.match((result as { output?: string }).output ?? "", /not found/i, "narration says the pane was not found");
    assert.strictEqual(rec.gateCalls.length, 0, "a non-existent pane is never staged (Ask) or forbidden (Off) — gate NOT consulted");
    // No mutation / no broadcast: nothing to stop, nothing to delete, nothing to save or announce.
    assert.deepStrictEqual(rec.saves, [], "no ledger.save() for a ghost pane");
    assert.strictEqual(rec.ledgerUpdates, 0, "no broadcastLedgerUpdate for a ghost pane");
    assert.strictEqual(rec.terminalsUpdated, 0, "no broadcastTerminalsUpdated for a ghost pane");
    assert.deepStrictEqual((manager.ledger.workspaces["proj"] as FakeWs).panes, {}, "workspace pane map untouched");
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("delete_pane"), result, {}, res);
    assert.strictEqual(sent.status, 200);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// cutover guard — server.ts inline lifecycle routes deleted + names added to the only-set
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("c55.14 — server.ts cutover guard (no double-registration)", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const serverSrc = readFileSync(path.join(here, "..", "server.ts"), "utf8");
  const mountIdx = serverSrc.indexOf("mountRestRoutes(");
  const onlyOpenIdx = mountIdx >= 0 ? serverSrc.indexOf("only: new Set([", mountIdx) : -1;
  const onlyCloseIdx = onlyOpenIdx >= 0 ? serverSrc.indexOf("])", onlyOpenIdx) : -1;
  const mountBlock = onlyOpenIdx >= 0 && onlyCloseIdx >= 0 ? serverSrc.slice(onlyOpenIdx, onlyCloseIdx + 2) : "";

  for (const name of ["update_project", "stop_pane", "delete_project", "delete_pane"]) {
    it(`mountRestRoutes only-set includes "${name}"`, () => {
      assert.ok(mountIdx >= 0, "server.ts must call mountRestRoutes");
      assert.ok(new RegExp(`["']${name}["']`).test(mountBlock), `only-set must include "${name}" after the c55.14 cutover`);
    });
  }
  // method-anchored + quote-terminated so the HELD capability-gates PUT (whose path CONTAINS
  // /api/projects/:projectId/panes/:paneId) is never matched.
  const goneLiterals: Array<{ label: string; needle: RegExp }> = [
    { label: "PUT /api/projects/:id", needle: /app\.put\(\s*["']\/api\/projects\/:id["']/ },
    { label: "DELETE /api/projects/:id", needle: /app\.delete\(\s*["']\/api\/projects\/:id["']/ },
    { label: "DELETE /api/projects/:projectId/panes/:paneId", needle: /app\.delete\(\s*["']\/api\/projects\/:projectId\/panes\/:paneId["']/ },
    { label: "POST /api/projects/:projectId/panes/:paneId/stop", needle: /app\.post\(\s*["']\/api\/projects\/:projectId\/panes\/:paneId\/stop["']/ },
  ];
  for (const { label, needle } of goneLiterals) {
    it(`inline route is deleted: ${label}`, () => {
      assert.ok(!needle.test(serverSrc), `inline ${label} must be deleted (converged to the registry)`);
    });
  }
});
