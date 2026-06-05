/**
 * tests/test_c55_13_archive.ts — c55.13 (wsm-e2e-pinned-c55.13): converge the 3 inline archive routes.
 * Faithful ports: UNGATED (ALWAYS_ALLOWED), readOnly:false. list rides rest.toHttp to emit {archived:[…]}
 * top-level; restore/delete use the default {output} map (UI repaints off ledger_updated/terminals_updated).
 * Same doctrine as c55.11/c55.12: run the real choke-point with a fake ctx, assert the ActionResult,
 * then assert applyResultToHttp maps it to {status, body}.
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { REGISTRY } from "../src/actions/registry";
import { runAction } from "../src/actions/gemini";
import { applyResultToHttp, type RestResponse } from "../src/actions/rest";
import { INTENTIONAL_ASYMMETRY } from "../src/actions/coverage";
import type { ActionContext, ActionDef, ActionResult } from "../src/actions/types";

function makeFakeRes(): { res: RestResponse; sent: { status?: number; json?: unknown } } {
  const sent: { status?: number; json?: unknown } = {};
  const res: RestResponse = { status(c: number) { sent.status = c; return res; }, json(p: unknown) { sent.json = p; return undefined; } };
  return { res, sent };
}
function findDef(name: string): ActionDef {
  const def = REGISTRY.find((d) => d.name === name);
  assert.ok(def, `registry must contain a def named '${name}'`);
  return def!;
}
async function runToHttp(name: string, args: Record<string, unknown>, ctx: ActionContext) {
  const def = findDef(name);
  const result = await runAction(REGISTRY, name, args, ctx);
  const { res, sent } = makeFakeRes();
  applyResultToHttp(def, result, args, res);
  return { result, status: sent.status, json: sent.json };
}

// Fake ledger that records calls + a seeded archived list (projection sentinel).
function makeCtx(opts: { restoreOk?: boolean; deleteOk?: boolean } = {}): { ctx: ActionContext; calls: string[] } {
  const calls: string[] = [];
  const archivedRaw = [{
    pane: { pane_id: "p1", name: "Pane One", tool_preset: "Claude Code", last_command: "npm test" },
    project_id: "proj", archived_at: "2026-06-05T00:00:00Z",
  }];
  const ledger: any = {
    listArchived: () => { calls.push("listArchived"); return archivedRaw; },
    restoreArchivedPane: (id: string) => { calls.push(`restore:${id}`); return opts.restoreOk === false ? null : { pane_id: id }; },
    deleteArchivedPane: (id: string) => { calls.push(`delete:${id}`); return opts.deleteOk === false ? false : true; },
  };
  const ctx = {
    manager: { ledger }, session: null, surface: "rest",
    broadcastLedgerUpdate: () => { calls.push("ledger_broadcast"); },
    broadcastTerminalsUpdated: () => { calls.push("terminals_broadcast"); },
    redact: (s: string) => s, isFrozen: () => false, effectiveCapabilityGateFor: () => "Auto",
  } as unknown as ActionContext;
  return { ctx, calls };
}

const SHAPE: Array<{ name: string; method: string; path: string }> = [
  { name: "list_archived_panes", method: "get", path: "/api/archive" },
  { name: "restore_archived_pane", method: "post", path: "/api/archive/:pane_id/restore" },
  { name: "delete_archived_pane", method: "delete", path: "/api/archive/:pane_id" },
];

describe("c55.13 — 3 rest-only archive defs (shape + asymmetry)", () => {
  for (const { name, method, path: p } of SHAPE) {
    it(`${name} is rest-only ALWAYS_ALLOWED readOnly:false, binds ${method.toUpperCase()} ${p}, allow-listed`, () => {
      const def = findDef(name);
      assert.strictEqual(def.capability, "ALWAYS_ALLOWED");
      assert.strictEqual(def.readOnly, false);
      assert.deepStrictEqual([...def.surfaces], ["rest"]);
      assert.deepStrictEqual(def.rest?.method, method);
      assert.deepStrictEqual(def.rest?.path, p);
      assert.deepStrictEqual(INTENTIONAL_ASYMMETRY[name], new Set(["rest"]));
    });
  }
});

describe("c55.13 — fidelity", () => {
  it("list_archived_panes -> {archived:[projected]} TOP-LEVEL at 200", async () => {
    const { ctx } = makeCtx();
    const { status, json } = await runToHttp("list_archived_panes", {}, ctx);
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(json, { archived: [{
      pane_id: "p1", name: "Pane One", project_id: "proj", tool_preset: "Claude Code",
      last_command: "npm test", archived_at: "2026-06-05T00:00:00Z",
    }] }, "byte-identical to the inline {archived:[…]} projection, top-level (not {output})");
  });
  it("restore_archived_pane ok -> both broadcasts, 200", async () => {
    const { ctx, calls } = makeCtx();
    const { status } = await runToHttp("restore_archived_pane", { pane_id: "p1" }, ctx);
    assert.strictEqual(status, 200);
    assert.ok(calls.includes("restore:p1") && calls.includes("ledger_broadcast") && calls.includes("terminals_broadcast"));
  });
  it("restore_archived_pane not-found -> 200 ok-narration, NO broadcast (404→200 delta)", async () => {
    const { ctx, calls } = makeCtx({ restoreOk: false });
    const { status } = await runToHttp("restore_archived_pane", { pane_id: "nope" }, ctx);
    assert.strictEqual(status, 200);
    assert.ok(calls.includes("restore:nope") && !calls.includes("ledger_broadcast"));
  });
  it("delete_archived_pane ok -> ledger broadcast, 200", async () => {
    const { ctx, calls } = makeCtx();
    const { status } = await runToHttp("delete_archived_pane", { pane_id: "p1" }, ctx);
    assert.strictEqual(status, 200);
    assert.ok(calls.includes("delete:p1") && calls.includes("ledger_broadcast"));
  });
  it("delete_archived_pane not-found -> 200 ok-narration, NO broadcast", async () => {
    const { ctx, calls } = makeCtx({ deleteOk: false });
    const { status } = await runToHttp("delete_archived_pane", { pane_id: "nope" }, ctx);
    assert.strictEqual(status, 200);
    assert.ok(calls.includes("delete:nope") && !calls.includes("ledger_broadcast"));
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// cutover guard — server.ts inline routes deleted + names added to the only-set
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("c55.13 — server.ts cutover guard (no double-registration)", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const serverSrc = readFileSync(path.join(here, "..", "server.ts"), "utf8");
  const mountIdx = serverSrc.indexOf("mountRestRoutes(");
  const onlyOpenIdx = mountIdx >= 0 ? serverSrc.indexOf("only: new Set([", mountIdx) : -1;
  const onlyCloseIdx = onlyOpenIdx >= 0 ? serverSrc.indexOf("])", onlyOpenIdx) : -1;
  const mountBlock = onlyOpenIdx >= 0 && onlyCloseIdx >= 0 ? serverSrc.slice(onlyOpenIdx, onlyCloseIdx + 2) : "";

  for (const name of ["list_archived_panes", "restore_archived_pane", "delete_archived_pane"]) {
    it(`mountRestRoutes only-set includes "${name}"`, () => {
      assert.ok(mountIdx >= 0, "server.ts must call mountRestRoutes");
      assert.ok(new RegExp(`["']${name}["']`).test(mountBlock), `only-set must include "${name}" after the c55.13 cutover`);
    });
  }
  const goneLiterals: Array<{ label: string; needle: RegExp }> = [
    { label: "GET /api/archive", needle: /app\.get\(\s*["']\/api\/archive["']/ },
    { label: "POST /api/archive/:paneId/restore", needle: /app\.post\(\s*["']\/api\/archive\/:paneId\/restore["']/ },
    { label: "DELETE /api/archive/:paneId", needle: /app\.delete\(\s*["']\/api\/archive\/:paneId["']/ },
  ];
  for (const { label, needle } of goneLiterals) {
    it(`inline route is deleted: ${label}`, () => {
      assert.ok(!needle.test(serverSrc), `inline ${label} must be deleted (converged to the registry)`);
    });
  }
});
