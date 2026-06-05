/**
 * tests/test_c55_batch_e.ts — Batch E (c55.5): the rest.toHttp primitive.
 *
 * INFRASTRUCTURE only — no routes move. This pins the new OPTIONAL per-action response translator
 * `ActionDef.rest.toHttp` and the `applyResultToHttp(def, result, args, res)` dispatcher that
 * mountRestRoutes routes through.
 *
 * Contract (spec §"The One New Primitive — rest.toHttp"):
 *   (a) NO-REGRESSION — a def WITHOUT a `toHttp` hook produces a BYTE-IDENTICAL response to the
 *       pre-change `resultToHttp(result, res)` for EVERY ActionResult kind (ok/pending/clarify/
 *       blocked/error). The default map is untouched.
 *   (b) ESCAPE HATCH — a toy def WITH a `toHttp` hook emits its EXACT { status, body }, bypassing the
 *       default map. The hook receives (result, args).
 *   (c) VOICE ISOLATION — the voice path (resultToToolResponse, in gemini.ts) never imports or
 *       consults `toHttp`. Asserted structurally: gemini.ts does not reference `toHttp` and does not
 *       import from ./rest.
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";

import {
  mountRestRoutes,
  applyResultToHttp,
  resultToHttp,
  type RestApp,
  type RestHandler,
  type RestResponse,
  type RestRequest,
} from "../src/actions/rest";
import type { ActionContext, ActionDef, ActionResult } from "../src/actions/types";

// ── Fakes (mirrors tests/test_rest_mount.ts) ───────────────────────────────────────────────────

interface Registration {
  method: "get" | "post" | "put" | "delete";
  path: string;
  handler: RestHandler;
}

function makeFakeApp(): { app: RestApp; regs: Registration[] } {
  const regs: Registration[] = [];
  const record =
    (method: Registration["method"]) =>
    (p: string, handler: RestHandler): unknown => {
      regs.push({ method, path: p, handler });
      return undefined;
    };
  const app: RestApp = {
    get: record("get"),
    post: record("post"),
    put: record("put"),
    delete: record("delete"),
  };
  return { app, regs };
}

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

const fakeCtx = { redact: (s: string) => s } as unknown as ActionContext;
const ctxFactory = (_req: RestRequest): ActionContext => fakeCtx;

function makeDef(partial: {
  name: string;
  surfaces: string[];
  rest?: ActionDef["rest"];
  params?: z.ZodTypeAny;
  handler?: ActionDef["handler"];
}): ActionDef {
  const def = {
    name: partial.name,
    description: partial.name,
    params: partial.params ?? z.object({}).passthrough(),
    capability: "ALWAYS_ALLOWED",
    readOnly: true,
    surfaces: new Set(partial.surfaces),
    rest: partial.rest,
    handler: partial.handler ?? ((): ActionResult => ({ kind: "ok", output: partial.name })),
  };
  return def as unknown as ActionDef;
}

// All five ActionResult kinds, each as a representative value.
const ALL_KINDS: ActionResult[] = [
  { kind: "ok", output: "hi" },
  { kind: "pending", messageId: "m1", summary: "s" },
  { kind: "clarify", text: "which pane?" },
  { kind: "blocked", reason: "gate off" },
  { kind: "error", message: "boom" },
];

// ── (a) NO-REGRESSION: a def WITHOUT toHttp is byte-identical to legacy resultToHttp ─────────────
describe("Batch E — applyResultToHttp default path (no toHttp)", () => {
  for (const result of ALL_KINDS) {
    it(`def without toHttp -> identical to resultToHttp for kind=${result.kind}`, () => {
      const def = makeDef({ name: "plain", surfaces: ["rest"], rest: { method: "get", path: "/plain" } });

      const viaApply = makeFakeRes();
      applyResultToHttp(def, result, { any: "args" }, viaApply.res);

      const viaLegacy = makeFakeRes();
      resultToHttp(result, viaLegacy.res);

      assert.strictEqual(viaApply.sent.status, viaLegacy.sent.status, "status must match the legacy map");
      assert.deepStrictEqual(viaApply.sent.json, viaLegacy.sent.json, "body must match the legacy map byte-for-byte");
    });
  }

  it("a def with rest binding but no toHttp still routes through the default map end-to-end", async () => {
    const def = makeDef({
      name: "plain_route",
      surfaces: ["rest"],
      rest: { method: "get", path: "/plain_route" },
      handler: (): ActionResult => ({ kind: "ok", output: "value" }),
    });
    const { app, regs } = makeFakeApp();
    mountRestRoutes(app, [def], ctxFactory);

    const { res, sent } = makeFakeRes();
    await regs[0].handler({ query: {} }, res);
    assert.strictEqual(sent.status, 200);
    assert.deepStrictEqual(sent.json, { output: "value" });
  });
});

// ── (b) ESCAPE HATCH: a def WITH toHttp emits its exact { status, body } ─────────────────────────
describe("Batch E — applyResultToHttp escape hatch (with toHttp)", () => {
  it("dispatches through def.rest.toHttp and emits its exact { status, body }", () => {
    const def = makeDef({
      name: "rich",
      surfaces: ["rest"],
      rest: {
        method: "get",
        path: "/rich",
        toHttp: (result: ActionResult): { status: number; body: unknown } => {
          // Re-project the typed output into a bespoke structured body the flat {output} cannot carry.
          const rows = result.kind === "ok" ? (result.output as unknown[]) : [];
          return { status: 207, body: { rows, count: rows.length } };
        },
      },
    });

    const { res, sent } = makeFakeRes();
    applyResultToHttp(def, { kind: "ok", output: [1, 2, 3] }, {}, res);

    assert.strictEqual(sent.status, 207);
    assert.deepStrictEqual(sent.json, { rows: [1, 2, 3], count: 3 });
  });

  it("passes BOTH (result, args) to the toHttp hook", () => {
    let seenResult: ActionResult | undefined;
    let seenArgs: Record<string, unknown> | undefined;
    const def = makeDef({
      name: "spyhook",
      surfaces: ["rest"],
      rest: {
        method: "get",
        path: "/spyhook",
        toHttp: (result: ActionResult, args: Record<string, unknown>): { status: number; body: unknown } => {
          seenResult = result;
          seenArgs = args;
          return { status: 200, body: { ok: true } };
        },
      },
    });

    const { res } = makeFakeRes();
    const result: ActionResult = { kind: "ok", output: "x" };
    applyResultToHttp(def, result, { id: "p1", limit: "20" }, res);

    assert.strictEqual(seenResult, result, "the raw ActionResult must reach the hook");
    assert.deepStrictEqual(seenArgs, { id: "p1", limit: "20" }, "the resolved args must reach the hook");
  });

  it("routes a toHttp def through the seam end-to-end (mountRestRoutes -> applyResultToHttp)", async () => {
    const def = makeDef({
      name: "rich_route",
      surfaces: ["rest"],
      rest: {
        method: "get",
        path: "/rich_route",
        toHttp: (result: ActionResult): { status: number; body: unknown } => {
          const out = result.kind === "ok" ? result.output : null;
          return { status: 200, body: { wrapped: out } };
        },
      },
      handler: (): ActionResult => ({ kind: "ok", output: { a: 1 } }),
    });
    const { app, regs } = makeFakeApp();
    mountRestRoutes(app, [def], ctxFactory);

    const { res, sent } = makeFakeRes();
    await regs[0].handler({ query: {} }, res);
    assert.strictEqual(sent.status, 200);
    assert.deepStrictEqual(sent.json, { wrapped: { a: 1 } });
  });

  it("toHttp may set ANY status independent of the ActionResult kind", () => {
    const def = makeDef({
      name: "status304",
      surfaces: ["rest"],
      rest: {
        method: "get",
        path: "/status304",
        toHttp: (): { status: number; body: unknown } => ({ status: 304, body: { cached: true } }),
      },
    });
    const { res, sent } = makeFakeRes();
    // Even an `ok` (which the legacy map sends as 200) is overridden by the hook.
    applyResultToHttp(def, { kind: "ok", output: "ignored" }, {}, res);
    assert.strictEqual(sent.status, 304);
    assert.deepStrictEqual(sent.json, { cached: true });
  });
});

// ── (c) VOICE ISOLATION: the voice path never imports or consults toHttp ─────────────────────────
describe("Batch E — voice path does not consult toHttp", () => {
  it("gemini.ts (resultToToolResponse host) references neither `toHttp` nor an import of ./rest", () => {
    const geminiPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../src/actions/gemini.ts"
    );
    const src = readFileSync(geminiPath, "utf8");

    assert.ok(
      src.includes("resultToToolResponse"),
      "sanity: gemini.ts is the host of the voice projection resultToToolResponse"
    );
    assert.ok(
      !/\btoHttp\b/.test(src),
      "the voice path must NEVER reference toHttp — it projects ActionResult via resultToToolResponse only"
    );
    assert.ok(
      !/from\s+["']\.\/rest["']/.test(src),
      "gemini.ts must not import from ./rest — voice and REST projections are independent"
    );
  });
});
