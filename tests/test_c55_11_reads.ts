/**
 * tests/test_c55_11_reads.ts — c55.11 (wsm-e2e-pinned-c55.11): converge the 4 inline GET reads.
 *
 * Each inline read (`res.json(<value>)`) becomes a rest-only ActionDef returning <value> off ctx and
 * riding rest.toHttp to emit it TOP-LEVEL (byte-identical to the legacy body, NOT wrapped in {output}).
 * ALWAYS_ALLOWED + readOnly:false (system-state plumbing read, never gated, no egress redaction —
 * faithful to the inline routes). Same doctrine as Batch F: run the real choke-point with a fake ctx,
 * assert the ActionResult, then assert applyResultToHttp maps it to {status, body}.
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

async function runToHttp(name: string, ctx: ActionContext): Promise<{ result: ActionResult; status?: number; json?: unknown }> {
  const def = findDef(name);
  const result = await runAction(REGISTRY, name, {}, ctx);
  const { res, sent } = makeFakeRes();
  applyResultToHttp(def, result, {}, res);
  return { result, status: sent.status, json: sent.json };
}

// A fake ctx seeded with the 4 data sources the defs read. Sentinels so a wrong source fails loudly.
function makeCtx(over: {
  workspaces?: unknown; attentionQueue?: unknown; plans?: unknown; recipes?: unknown;
} = {}): ActionContext {
  const manager: any = {
    ledger: { workspaces: over.workspaces ?? [], plans: over.plans ?? [] },
    attentionQueue: over.attentionQueue ?? [],
  };
  return {
    manager,
    recipes: over.recipes ?? [],
    session: null,
    surface: "rest",
    redact: (s: string) => s,
    isFrozen: () => false,
    effectiveCapabilityGateFor: () => "Auto",
  } as unknown as ActionContext;
}

// name -> { path, ctxKey seed, expected body }
const READS: Array<{ name: string; path: string; seed: () => ActionContext; expect: unknown }> = [
  {
    name: "get_ledger", path: "/api/ledger",
    seed: () => makeCtx({ workspaces: [{ id: "ws1", projects: [] }] }),
    expect: [{ id: "ws1", projects: [] }],
  },
  {
    name: "get_attention_queue", path: "/api/attention",
    seed: () => makeCtx({ attentionQueue: [{ terminalId: "p1", type: "error", message: "boom" }] }),
    expect: [{ terminalId: "p1", type: "error", message: "boom" }],
  },
  {
    name: "list_orchestrator_plans", path: "/api/plans",
    seed: () => makeCtx({ plans: [{ id: "plan1", status: "idle", steps: [] }] }),
    expect: [{ id: "plan1", status: "idle", steps: [] }],
  },
  {
    name: "list_orchestration_recipes", path: "/api/recipes",
    seed: () => makeCtx({ recipes: [{ id: "full-stack-web", name: "X", panes: [] }] }),
    expect: [{ id: "full-stack-web", name: "X", panes: [] }],
  },
];

describe("c55.11 — 4 rest-only read defs (shape + asymmetry)", () => {
  for (const { name, path: routePath } of READS) {
    it(`${name} is rest-only ALWAYS_ALLOWED readOnly:false, binds GET ${routePath}, declares toHttp, is allow-listed`, () => {
      const def = findDef(name);
      assert.strictEqual(def.capability, "ALWAYS_ALLOWED", `${name} is an ungated plumbing read`);
      assert.strictEqual(def.readOnly, false, `${name}: §8.1 binds readOnly to read_pane/read_notes only`);
      assert.deepStrictEqual([...def.surfaces], ["rest"], `${name} is rest-only (no voice twin)`);
      assert.deepStrictEqual(def.rest?.method, "get");
      assert.deepStrictEqual(def.rest?.path, routePath);
      assert.ok(typeof def.rest?.toHttp === "function", `${name} must declare a rest.toHttp translator`);
      assert.deepStrictEqual(INTENTIONAL_ASYMMETRY[name], new Set(["rest"]), `${name} must be allow-listed rest-only in INTENTIONAL_ASYMMETRY`);
    });
  }
});

describe("c55.11 — fidelity: toHttp emits the value TOP-LEVEL (byte-identical to the legacy res.json body)", () => {
  for (const { name, seed, expect } of READS) {
    it(`${name} -> HTTP 200, body is the bare value (not wrapped in {output})`, async () => {
      const { result, status, json } = await runToHttp(name, seed());
      assert.strictEqual(result.kind, "ok");
      assert.strictEqual(status, 200);
      assert.deepStrictEqual(json, expect, `${name} body must equal the seeded source value, emitted top-level`);
      assert.ok(!(json && typeof json === "object" && !Array.isArray(json) && "output" in (json as object)),
        `${name} must NOT wrap the body in {output}`);
    });
  }
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// cutover guard — server.ts inline GET routes deleted + names added to the only-set
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("c55.11 — server.ts cutover guard (no double-registration)", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const serverSrc = readFileSync(path.join(here, "..", "server.ts"), "utf8");

  // c55.16: the `only:` allow-filter was RETIRED; registry auto-serves every rest-surface def.
  // Cutover proof = registry membership (surfaces:rest && def.rest), not only-set text.
  const mountIdx = serverSrc.indexOf("mountRestRoutes(");
  const mountedNames = new Set(
    REGISTRY.filter((d) => d.surfaces.has("rest") && !!d.rest).map((d) => d.name),
  );

  for (const name of ["get_ledger", "get_attention_queue", "list_orchestrator_plans", "list_orchestration_recipes"]) {
    it(`mountRestRoutes auto-serves "${name}" (rest-surfaced in REGISTRY)`, () => {
      assert.ok(mountIdx >= 0, "server.ts must call mountRestRoutes");
      assert.ok(mountedNames.has(name), `"${name}" must be a rest-mounted REGISTRY def after the c55.11 cutover`);
    });
  }

  const goneLiterals: Array<{ label: string; needle: RegExp }> = [
    { label: "GET /api/ledger", needle: /app\.get\(\s*["']\/api\/ledger["']/ },
    { label: "GET /api/attention", needle: /app\.get\(\s*["']\/api\/attention["']/ },
    { label: "GET /api/plans", needle: /app\.get\(\s*["']\/api\/plans["']/ },
    { label: "GET /api/recipes", needle: /app\.get\(\s*["']\/api\/recipes["']/ },
  ];
  for (const { label, needle } of goneLiterals) {
    it(`inline route is deleted: ${label}`, () => {
      assert.ok(!needle.test(serverSrc), `inline ${label} must be deleted (converged to the registry)`);
    });
  }
});
