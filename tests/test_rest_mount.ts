import { describe, it } from "node:test";
import assert from "node:assert";
import { z } from "zod";

import {
  mountRestRoutes,
  resultToHttp,
  findKnownRouteCollisions,
  normalizeRestPath,
  type RestApp,
  type RestHandler,
  type RestRequest,
  type RestResponse,
} from "../src/actions/rest";
import type { ActionContext, ActionDef, ActionResult } from "../src/actions/types";
import { REGISTRY } from "../src/actions/registry";
import { INLINE_EXCEPTIONS } from "../src/actions/inlineExceptions";

// ── Fakes ─────────────────────────────────────────────────────────────────────────────────────
// A tiny RestApp that records (method, path, handler) registrations so we can assert what mounted
// and later invoke a handler directly with a fake req/res.

interface Registration {
  method: "get" | "post" | "put" | "delete";
  path: string;
  handler: RestHandler;
}

function makeFakeApp(): { app: RestApp; regs: Registration[] } {
  const regs: Registration[] = [];
  const record =
    (method: Registration["method"]) =>
    (path: string, handler: RestHandler): unknown => {
      regs.push({ method, path, handler });
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

// A fake RestResponse that records the status code + json payload it was handed.
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

// A no-op ActionContext: the handlers under test never touch ctx, but runAction redacts readOnly
// results via ctx.redact, so supply an identity redactor. Cast through unknown — we only need the
// structural shape runAction reads.
const fakeCtx = { redact: (s: string) => s } as unknown as ActionContext;
const ctxFactory = (_req: RestRequest): ActionContext => fakeCtx;

// Minimal fake defs shaped like ActionDef, cast `as unknown as ActionDef`.
function makeDef(partial: {
  name: string;
  surfaces: string[];
  rest?: { method: "get" | "post" | "put" | "delete"; path: string };
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
    handler:
      partial.handler ??
      ((): ActionResult => ({ kind: "ok", output: partial.name })),
  };
  return def as unknown as ActionDef;
}

// ── (a) no `only` mounts every rest-surface def with a rest binding ─────────────────────────────
describe("mountRestRoutes — default (no `only`)", () => {
  it("registers every rest-surface def that has a rest binding", () => {
    const registry = [
      makeDef({ name: "x", surfaces: ["rest"], rest: { method: "get", path: "/x" } }),
      makeDef({ name: "y", surfaces: ["rest"], rest: { method: "post", path: "/y" } }),
      makeDef({ name: "z", surfaces: ["voice"] }), // not a rest surface -> skipped
    ];
    const { app, regs } = makeFakeApp();
    mountRestRoutes(app, registry, ctxFactory);

    assert.strictEqual(regs.length, 2);
    assert.deepStrictEqual(
      regs.map((r) => `${r.method} ${r.path}`).sort(),
      ["get /x", "post /y"]
    );
  });
});

// ── (b) `only` restricts to exactly the named defs ──────────────────────────────────────────────
describe("mountRestRoutes — `only` allow-filter", () => {
  it("mounts ONLY the named def and skips the rest", () => {
    const registry = [
      makeDef({ name: "x", surfaces: ["rest"], rest: { method: "get", path: "/x" } }),
      makeDef({ name: "y", surfaces: ["rest"], rest: { method: "post", path: "/y" } }),
      makeDef({ name: "w", surfaces: ["rest"], rest: { method: "put", path: "/w" } }),
    ];
    const { app, regs } = makeFakeApp();
    mountRestRoutes(app, registry, ctxFactory, { only: new Set(["x"]) });

    assert.strictEqual(regs.length, 1);
    assert.strictEqual(regs[0].method, "get");
    assert.strictEqual(regs[0].path, "/x");
  });
});

// ── (c) rest-surface def WITHOUT a rest binding is skipped (no crash) ────────────────────────────
describe("mountRestRoutes — rest surface without a rest binding", () => {
  it("skips the def defensively instead of crashing", () => {
    const registry = [
      makeDef({ name: "nobinding", surfaces: ["rest"] }), // surfaces has rest, but no def.rest
      makeDef({ name: "ok", surfaces: ["rest"], rest: { method: "get", path: "/ok" } }),
    ];
    const { app, regs } = makeFakeApp();
    assert.doesNotThrow(() => mountRestRoutes(app, registry, ctxFactory));

    assert.strictEqual(regs.length, 1);
    assert.strictEqual(regs[0].path, "/ok");
  });
});

// ── (d) query params are merged into rawArgs and reach the handler ───────────────────────────────
describe("mountRestRoutes — query-param merge", () => {
  it("merges req.query into the args the handler sees", async () => {
    let seen: unknown;
    const echo = makeDef({
      name: "echo",
      surfaces: ["rest"],
      rest: { method: "get", path: "/echo" },
      params: z.object({ limit: z.string() }).passthrough(),
      handler: (args): ActionResult => {
        seen = args;
        return { kind: "ok", output: args };
      },
    });
    const { app, regs } = makeFakeApp();
    mountRestRoutes(app, [echo], ctxFactory);

    assert.strictEqual(regs.length, 1);
    const { res, sent } = makeFakeRes();
    await regs[0].handler({ query: { limit: "5" } }, res);

    assert.deepStrictEqual(seen, { limit: "5" });
    assert.strictEqual(sent.status, 200);
    assert.deepStrictEqual(sent.json, { output: { limit: "5" } });
  });

  it("body wins over query on a key collision (precedence query < params < body)", async () => {
    let seen: Record<string, unknown> | undefined;
    const echo = makeDef({
      name: "echo2",
      surfaces: ["rest"],
      rest: { method: "post", path: "/echo2" },
      params: z.object({}).passthrough(),
      handler: (args): ActionResult => {
        seen = args as Record<string, unknown>;
        return { kind: "ok", output: args };
      },
    });
    const { app, regs } = makeFakeApp();
    mountRestRoutes(app, [echo], ctxFactory);

    const { res } = makeFakeRes();
    await regs[0].handler({ query: { limit: "5" }, body: { limit: "9" } }, res);
    assert.strictEqual(seen?.limit, "9");
  });
});

// ── (f) defense-in-depth: a thrown failure on the route seam responds 500, never hangs ───────────
describe("mountRestRoutes — defense-in-depth on an unexpected throw", () => {
  it("a handler that THROWS yields a 500 { error } response (not a hang / unhandled rejection)", async () => {
    // Today runAction is the never-throw choke-point: a throwing handler is caught INSIDE runAction
    // and surfaced as a typed { kind:"error" } -> resultToHttp 500. This asserts the end-to-end seam
    // answers 500 with an error field rather than hanging the request.
    const boom = makeDef({
      name: "boom",
      surfaces: ["rest"],
      rest: { method: "post", path: "/boom" },
      handler: (): ActionResult => {
        throw new Error("handler exploded");
      },
    });
    const { app, regs } = makeFakeApp();
    mountRestRoutes(app, [boom], ctxFactory);

    assert.strictEqual(regs.length, 1);
    const { res, sent } = makeFakeRes();
    await regs[0].handler({ body: {} }, res);

    assert.strictEqual(sent.status, 500);
    assert.ok(
      sent.json && typeof sent.json === "object" && "error" in (sent.json as Record<string, unknown>),
      "500 response json must carry an `error` field"
    );
    assert.strictEqual((sent.json as { error: unknown }).error, "handler exploded");
  });

  it("a throwing ctxFactory is caught by the route try/catch and answered 500 (belt-and-suspenders)", async () => {
    // This exercises the route-handler guard directly: if ctxFactory (or any future change to the
    // never-throw contract) throws BEFORE runAction is reached, the seam must still answer 500 and
    // never let an unhandled async rejection escape the Express handler.
    const ok = makeDef({
      name: "ctxboom",
      surfaces: ["rest"],
      rest: { method: "get", path: "/ctxboom" },
    });
    const { app, regs } = makeFakeApp();
    const throwingCtxFactory = (_req: RestRequest): ActionContext => {
      throw new Error("ctxFactory exploded");
    };
    mountRestRoutes(app, [ok], throwingCtxFactory);

    assert.strictEqual(regs.length, 1);
    const { res, sent } = makeFakeRes();
    await assert.doesNotReject(() => Promise.resolve(regs[0].handler({ query: {} }, res)));

    assert.strictEqual(sent.status, 500);
    assert.strictEqual((sent.json as { error: unknown }).error, "ctxFactory exploded");
  });
});

// ── (g) `only` with names absent from the registry registers zero routes (no crash) ──────────────
describe("mountRestRoutes — `only` names not in the registry", () => {
  it("skips every unknown name and mounts zero routes", () => {
    const registry = [
      makeDef({ name: "x", surfaces: ["rest"], rest: { method: "get", path: "/x" } }),
      makeDef({ name: "y", surfaces: ["rest"], rest: { method: "post", path: "/y" } }),
    ];
    const { app, regs } = makeFakeApp();
    assert.doesNotThrow(() =>
      mountRestRoutes(app, registry, ctxFactory, { only: new Set(["does_not_exist"]) })
    );

    assert.strictEqual(regs.length, 0);
  });
});

// ── (h) knownInlinePaths collision guard (wsm-e2e-pinned-lcc, remaining half) ────────────────────
// mountRestRoutes's `only` allow-filter used to be the SOLE guard against a registry-derived REST
// def colliding with a hand-written server.ts route; production now mounts every rest-surface def
// (opts.only retired, c55.16) and tests/test_no_inline_twins.ts is the authoritative CI gate. This
// runtime guard is defense-in-depth: it makes mountRestRoutes console.warn LOUDLY (never throw) at
// actual boot time if a def about to mount shares verb+normalized-path with a caller-supplied
// "known hand-written route" set.
describe("mountRestRoutes — knownInlinePaths collision guard", () => {
  function withCapturedWarn<T>(fn: () => T): { result: T; warnings: unknown[][] } {
    const warnings: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      return { result: fn(), warnings };
    } finally {
      console.warn = original;
    }
  }

  it("findKnownRouteCollisions reports a def whose path matches a known hand-written route", () => {
    const registry = [
      makeDef({ name: "x", surfaces: ["rest"], rest: { method: "get", path: "/api/settings" } }),
      makeDef({ name: "y", surfaces: ["rest"], rest: { method: "post", path: "/y" } }),
    ];
    const known = new Set(["get /api/settings"]);
    const collisions = findKnownRouteCollisions(registry, known);
    assert.strictEqual(collisions.length, 1);
    assert.match(collisions[0], /^get \/api\/settings\s+\[def=x\]$/);
  });

  it("findKnownRouteCollisions normalizes :param segments so name skew still collides", () => {
    const registry = [
      makeDef({ name: "x", surfaces: ["rest"], rest: { method: "put", path: "/api/panes/:paneId/draft" } }),
    ];
    const known = new Set([`put ${normalizeRestPath("/api/panes/:pane_id/draft")}`]);
    assert.strictEqual(findKnownRouteCollisions(registry, known).length, 1);
  });

  it("findKnownRouteCollisions respects the `only` filter (a skipped def can't collide)", () => {
    const registry = [
      makeDef({ name: "x", surfaces: ["rest"], rest: { method: "get", path: "/api/settings" } }),
    ];
    const known = new Set(["get /api/settings"]);
    assert.strictEqual(findKnownRouteCollisions(registry, known, new Set(["not_x"])).length, 0);
  });

  it("returns [] and does NOT warn when nothing collides", () => {
    const registry = [
      makeDef({ name: "x", surfaces: ["rest"], rest: { method: "get", path: "/x" } }),
    ];
    const { app } = makeFakeApp();
    const { result: collisions, warnings } = withCapturedWarn(() =>
      findKnownRouteCollisions(registry, new Set(["get /api/settings"]))
    );
    assert.deepStrictEqual(collisions, []);
    mountRestRoutes(app, registry, ctxFactory, { knownInlinePaths: new Set(["get /api/settings"]) });
    assert.deepStrictEqual(warnings, []);
  });

  it("mountRestRoutes console.warn's ONCE, loudly, listing the colliding path — and still mounts it (never throws)", () => {
    const registry = [
      makeDef({ name: "x", surfaces: ["rest"], rest: { method: "get", path: "/api/settings" } }),
    ];
    const { app, regs } = makeFakeApp();
    const { warnings } = withCapturedWarn(() =>
      mountRestRoutes(app, registry, ctxFactory, { knownInlinePaths: new Set(["get /api/settings"]) })
    );
    assert.strictEqual(warnings.length, 1);
    assert.match(String(warnings[0][0]), /collision guard/i);
    assert.match(String(warnings[0][0]), /get \/api\/settings/);
    // A false-positive collision is a WARNING, not a boot-bricking throw — the def still mounts.
    assert.strictEqual(regs.length, 1);
  });

  it("omitting knownInlinePaths never warns (opt-in, backward compatible)", () => {
    const registry = [
      makeDef({ name: "x", surfaces: ["rest"], rest: { method: "get", path: "/x" } }),
    ];
    const { app } = makeFakeApp();
    const { warnings } = withCapturedWarn(() => mountRestRoutes(app, registry, ctxFactory));
    assert.deepStrictEqual(warnings, []);
  });

  // The actual coverage assertion: run the PRODUCTION registry + the production INLINE_EXCEPTIONS
  // catalog through the exact runtime collision function server.ts's mountRestRoutes call uses. If a
  // future def's rest path is grown onto a still-hand-written route, this fails the suite instead of
  // silently double-registering (Express first-registration-wins) at boot.
  it("the CURRENT production registry has zero collisions against INLINE_EXCEPTIONS (real state)", () => {
    const knownInlinePaths = new Set(
      INLINE_EXCEPTIONS.filter((e) => e.category !== "infra").map(
        (e) => `${e.method} ${normalizeRestPath(e.path)}`
      )
    );
    const collisions = findKnownRouteCollisions(REGISTRY, knownInlinePaths);
    assert.deepStrictEqual(collisions, [], `Unexpected rest def / inline-route collision(s):\n  ${collisions.join("\n  ")}`);
  });
});

// ── (e) resultToHttp maps each ActionResult kind to its HTTP shape ───────────────────────────────
describe("resultToHttp — ActionResult -> HTTP mapping", () => {
  it("ok -> 200 { output }", () => {
    const { res, sent } = makeFakeRes();
    resultToHttp({ kind: "ok", output: "hi" }, res);
    assert.strictEqual(sent.status, 200);
    assert.deepStrictEqual(sent.json, { output: "hi" });
  });

  it("blocked -> 403 { error }", () => {
    const { res, sent } = makeFakeRes();
    resultToHttp({ kind: "blocked", reason: "gate off" }, res);
    assert.strictEqual(sent.status, 403);
    assert.deepStrictEqual(sent.json, { error: "gate off" });
  });

  it("clarify -> 409 { clarify }", () => {
    const { res, sent } = makeFakeRes();
    resultToHttp({ kind: "clarify", text: "which pane?" }, res);
    assert.strictEqual(sent.status, 409);
    assert.deepStrictEqual(sent.json, { clarify: "which pane?" });
  });

  it("pending -> 202 { status:'pending_approval', messageId }", () => {
    const { res, sent } = makeFakeRes();
    resultToHttp({ kind: "pending", messageId: "m1", summary: "s" }, res);
    assert.strictEqual(sent.status, 202);
    assert.deepStrictEqual(sent.json, { status: "pending_approval", messageId: "m1" });
  });

  it("error -> 500 { error }", () => {
    const { res, sent } = makeFakeRes();
    resultToHttp({ kind: "error", message: "boom" }, res);
    assert.strictEqual(sent.status, 500);
    assert.deepStrictEqual(sent.json, { error: "boom" });
  });
});
