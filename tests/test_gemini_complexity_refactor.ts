// tests/test_gemini_complexity_refactor.ts — CHARACTERIZATION tests for the cyclomatic-complexity
// burndown refactor of src/actions/gemini.ts. These pin the CURRENT observable outputs of the two
// over-limit functions so the behaviour-preserving refactor (typed dispatch table / extracted helpers)
// changes NO schema output, dispatch verdict, redaction, timeout, audit row, or error shape.
//
//   - leafToGemini (CC12, via zodToGeminiSchema): every supported zod leaf -> its Gemini scalar
//     (string/number/boolean/enum/array/nested-object), the array-without-element throw, and the
//     unsupported-type throw (R4).
//   - runAction (CC14): unknown action, coerceArgs, parse-error shape, the ALWAYS_ALLOWED timeout
//     exemption vs the deadline race, readOnly redaction, the audit() seam (called once, swallows
//     throws), and the throwing-handler -> typed error.
//
// Written GREEN against the UNREFACTORED code FIRST (D-6), then kept green. PURE: zod + the gemini
// module only.
//
// Runner: npx tsx --test --test-force-exit tests/test_gemini_complexity_refactor.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import { z } from "zod";
import { Type } from "@google/genai";
import { zodToGeminiSchema, runAction } from "../src/actions/gemini";
import { ALWAYS_ALLOWED } from "../src/actions/types";
import type { ActionContext, ActionDef, ActionResult } from "../src/actions/types";

// ═════════════════════════════════════════════════════════════════════════════
// leafToGemini (via zodToGeminiSchema) — CC12
// ═════════════════════════════════════════════════════════════════════════════
describe("gemini refactor — leafToGemini scalar/array/enum/object mapping", () => {
  it("string/number/boolean leaves", () => {
    const out = zodToGeminiSchema(z.object({ s: z.string(), n: z.number(), b: z.boolean() }));
    assert.deepStrictEqual(out.properties!.s, { type: Type.STRING });
    assert.deepStrictEqual(out.properties!.n, { type: Type.NUMBER });
    assert.deepStrictEqual(out.properties!.b, { type: Type.BOOLEAN });
    assert.deepStrictEqual(out.required, ["s", "n", "b"]);
  });

  it("enum -> STRING + enum values", () => {
    const out = zodToGeminiSchema(z.object({ mode: z.enum(["a", "b", "c"]) }));
    assert.deepStrictEqual(out.properties!.mode, { type: Type.STRING, enum: ["a", "b", "c"] });
  });

  it("array of string -> ARRAY with items STRING", () => {
    const out = zodToGeminiSchema(z.object({ terms: z.array(z.string()) }));
    assert.deepStrictEqual(out.properties!.terms, { type: Type.ARRAY, items: { type: Type.STRING } });
  });

  it("array of optional element -> unwrapped element item", () => {
    const out = zodToGeminiSchema(z.object({ xs: z.array(z.number().optional()) }));
    assert.deepStrictEqual(out.properties!.xs, { type: Type.ARRAY, items: { type: Type.NUMBER } });
  });

  it("nested object recurses", () => {
    const out = zodToGeminiSchema(z.object({ inner: z.object({ k: z.string() }) }));
    assert.deepStrictEqual(out.properties!.inner, {
      type: Type.OBJECT,
      properties: { k: { type: Type.STRING } },
      required: ["k"],
    });
  });

  it("optional field omitted from required", () => {
    const out = zodToGeminiSchema(z.object({ a: z.string(), b: z.string().optional() }));
    assert.deepStrictEqual(out.required, ["a"]);
  });

  it("empty object -> properties {} and no required key", () => {
    const out = zodToGeminiSchema(z.object({}));
    assert.deepStrictEqual(out, { type: Type.OBJECT, properties: {} });
  });

  it("unsupported leaf throws (R4)", () => {
    assert.throws(() => zodToGeminiSchema(z.object({ d: z.date() })), /unsupported zod type/);
  });

  it("non-object top level throws", () => {
    assert.throws(() => zodToGeminiSchema(z.string()), /top-level params must be a z\.object/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// runAction — CC14
// ═════════════════════════════════════════════════════════════════════════════
function makeCtx(over: Partial<ActionContext> = {}): ActionContext {
  return {
    redact: (s: string) => s.replace(/SECRET/g, "[X]"),
    session: null,
    ...over,
  } as unknown as ActionContext;
}

function def(over: Partial<ActionDef> & { name: string; handler: ActionDef["handler"] }): ActionDef {
  return {
    description: "d",
    params: z.object({ pane_id: z.string().optional() }),
    capability: "read_pane",
    readOnly: false,
    surfaces: new Set(["voice"]),
    ...over,
  } as ActionDef;
}

describe("gemini refactor — runAction dispatch contract", () => {
  it("unknown action -> typed error", async () => {
    const r = await runAction([], "nope", {}, makeCtx());
    assert.deepStrictEqual(r, { kind: "error", message: "unknown action nope" });
  });

  it("coerceArgs runs before parse", async () => {
    let seen: any;
    const d = def({
      name: "t",
      params: z.object({ x: z.string() }),
      coerceArgs: (raw) => ({ x: String(raw.legacy ?? "") }),
      handler: (a) => { seen = a; return { kind: "ok", output: "ok" }; },
    });
    const r = await runAction([d], "t", { legacy: 42 }, makeCtx());
    assert.deepStrictEqual(r, { kind: "ok", output: "ok" });
    assert.deepStrictEqual(seen, { x: "42" });
  });

  it("parse error -> invalid arguments error", async () => {
    const d = def({ name: "t", params: z.object({ x: z.string() }), handler: () => ({ kind: "ok", output: "" }) });
    const r = await runAction([d], "t", { x: 5 }, makeCtx());
    assert.strictEqual(r.kind, "error");
    assert.match((r as any).message, /^invalid arguments for t:/);
  });

  it("readOnly result is redacted", async () => {
    const d = def({ name: "t", readOnly: true, capability: "read_pane", handler: () => ({ kind: "ok", output: "a SECRET value" }) });
    const r = await runAction([d], "t", {}, makeCtx());
    assert.deepStrictEqual(r, { kind: "ok", output: "a [X] value" });
  });

  it("non-readOnly result NOT redacted", async () => {
    const d = def({ name: "t", readOnly: false, capability: "write_to_pane", handler: () => ({ kind: "ok", output: "a SECRET value" }) });
    const r = await runAction([d], "t", {}, makeCtx());
    assert.deepStrictEqual(r, { kind: "ok", output: "a SECRET value" });
  });

  it("audit() called once with the right shape; an audit throw is swallowed", async () => {
    const rows: any[] = [];
    const ctx = makeCtx({ audit: (row) => { rows.push(row); throw new Error("audit sink down"); }, surface: "voice" } as any);
    const d = def({ name: "t", capability: "read_pane", readOnly: true, handler: () => ({ kind: "ok", output: "x" }) });
    const r = await runAction([d], "t", {}, ctx);
    assert.strictEqual(r.kind, "ok");
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].name, "t");
    assert.strictEqual(rows[0].capability, "read_pane");
    assert.strictEqual(rows[0].resultKind, "ok");
    assert.strictEqual(rows[0].surface, "voice");
    assert.strictEqual(typeof rows[0].ms, "number");
  });

  it("surface fallback: no ctx.surface + a session -> 'voice'; no session -> 'rest'", async () => {
    const rowsV: any[] = [];
    const ctxV = makeCtx({ audit: (r) => rowsV.push(r), session: {} as any } as any);
    const d = def({ name: "t", handler: () => ({ kind: "ok", output: "x" }) });
    await runAction([d], "t", {}, ctxV);
    assert.strictEqual(rowsV[0].surface, "voice");

    const rowsR: any[] = [];
    const ctxR = makeCtx({ audit: (r) => rowsR.push(r), session: null } as any);
    await runAction([d], "t", {}, ctxR);
    assert.strictEqual(rowsR[0].surface, "rest");
  });

  it("ALWAYS_ALLOWED is EXEMPT from the deadline (slow handler still resolves)", async () => {
    const d = def({
      name: "brake",
      capability: ALWAYS_ALLOWED,
      timeoutMs: 5,
      handler: () => new Promise<ActionResult>((res) => setTimeout(() => res({ kind: "ok", output: "done" }), 30)),
    });
    const r = await runAction([d], "brake", {}, makeCtx());
    assert.deepStrictEqual(r, { kind: "ok", output: "done" });
  });

  it("non-ALWAYS_ALLOWED handler that exceeds its deadline -> typed timeout error", async () => {
    const d = def({
      name: "slow",
      capability: "read_pane",
      timeoutMs: 5,
      handler: () => new Promise<ActionResult>((res) => setTimeout(() => res({ kind: "ok", output: "late" }), 40)),
    });
    const r = await runAction([d], "slow", {}, makeCtx());
    assert.strictEqual(r.kind, "error");
    assert.match((r as any).message, /exceeded its 5ms deadline/);
  });

  it("throwing handler -> typed error answered once", async () => {
    const d = def({ name: "boom", handler: () => { throw new Error("kaboom"); } });
    const r = await runAction([d], "boom", {}, makeCtx());
    assert.deepStrictEqual(r, { kind: "error", message: "kaboom" });
  });
});
