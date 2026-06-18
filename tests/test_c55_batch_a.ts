/**
 * tests/test_c55_batch_a.ts — c55 Batch A (wsm-e2e-pinned-c55.1) contract + cutover guard.
 *
 * Batch A cuts over 5 registry twins that ALREADY exist and ALREADY broadcast their WS frame, from
 * hand-written inline `app.<verb>('/api/…')` blocks in server.ts to the registry-derived REST mount
 * (the `opts.only` allow-set + `resultToHttp`). The client ignores the HTTP body; the live WS feed
 * repaints. So this batch is a pure delete-inline-and-point-at-registry.
 *
 *   stop_all                 POST /api/stop-all
 *   confirm_stop_all         POST /api/stop-all/confirm
 *   release_stop_all         POST /api/stop-all/release
 *   dismiss_attention        POST /api/attention/:id/dismiss
 *   create_orchestrator_plan POST /api/plans
 *
 * Two assertion layers (per the c55 verification doctrine):
 *
 *   (1) DEF-LEVEL CONTRACT — deterministic. For each action: build a fake ActionContext, call the
 *       SAME runAction choke-point the voice + REST paths use, assert the ActionResult is kind:"ok",
 *       assert resultToHttp maps it to 200 { output }, AND assert the action still broadcasts its WS
 *       frame (directly via ctx.broadcast, or — for the brake trio — via the injected ctx.stopAll /
 *       ctx.releaseStopAll closures that own the frame). This is the durable regression guard: it
 *       pins that the registry twin reproduces the target contract.
 *
 *   (2) CUTOVER GUARD — reads server.ts as text. Asserts every Batch-A name is in the mountRestRoutes
 *       `only` set AND the matching inline route literal is GONE. This is the test that DRIVES the
 *       change: it fails before the cutover (names absent / inline blocks present) and passes after,
 *       and it structurally catches double-registration (add-name-without-deleting-block leaves both
 *       an inline route and a mounted route; Express silently keeps the first-registered handler).
 *
 * Recorded behavior deltas (client-invisible, accepted — see the c55 spec Open Decision #2):
 *   - confirm_stop_all while NOT frozen: inline returned 409; the def returns kind:"ok" -> 200.
 *   - dismiss_attention with an unknown id: inline returned 404; the def returns kind:"ok" -> 200.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { REGISTRY } from "../src/actions/registry";
import { runAction } from "../src/actions/gemini";
import { resultToHttp, type RestResponse } from "../src/actions/rest";
import type { ActionContext, ActionResult } from "../src/actions/types";

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

// ── fake ActionContext ──────────────────────────────────────────────────────────────────────────
// Records every broadcast frame AND every injected-closure brake call, so a test can assert the WS
// repaint side effect that the converged route relies on (the client ignores the HTTP body). The
// brake trio broadcasts INSIDE ctx.stopAll / ctx.releaseStopAll (server.ts closures), so we record
// those calls as the brake's "frame" equivalent.
interface CtxProbe {
  broadcasts: unknown[];
  stopAllCalls: boolean[]; // one entry per ctx.stopAll(kill) call, value = kill
  releaseCalls: number;
  saveCalls: boolean[]; // ledger["save"](force) calls
}

function makeCtx(opts?: {
  frozen?: boolean;
  running?: string[]; // panes ctx.stopAll resolves with
  attentionQueue?: Array<{ id: string; dismissed: boolean }>;
}): { ctx: ActionContext; probe: CtxProbe } {
  const probe: CtxProbe = { broadcasts: [], stopAllCalls: [], releaseCalls: 0, saveCalls: [] };
  const attentionQueue = opts?.attentionQueue ?? [];
  const plans: unknown[] = [];
  const ctx = {
    redact: (s: string) => s,
    broadcast: (msg: unknown) => {
      probe.broadcasts.push(msg);
    },
    stopAll: async (kill: boolean): Promise<string[]> => {
      probe.stopAllCalls.push(kill);
      // The real brake closure broadcasts the `frozen` / kill frame itself; mirror that so the
      // def-level contract test can assert a repaint fired from the brake path.
      probe.broadcasts.push({ type: kill ? "stop_all_killed" : "frozen" });
      return opts?.running ?? [];
    },
    releaseStopAll: (): void => {
      probe.releaseCalls += 1;
      probe.broadcasts.push({ type: "stop_all_released" });
    },
    isFrozen: (): boolean => !!opts?.frozen,
    pruneAttention: (): void => {},
    // PHASE 2: dismiss_attention now Off-vetoes on its veto-class capability; default Auto = no change.
    effectiveCapabilityGateFor: () => "Auto",
    manager: {
      attentionQueue,
      ledger: {
        plans,
        save: (force: boolean): void => {
          probe.saveCalls.push(force);
        },
      },
    },
  } as unknown as ActionContext;
  return { ctx, probe };
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
describe("c55 Batch A — def-level contract (runAction -> ok -> 200 + WS frame)", () => {
  it("stop_all: ok -> 200 { output }; fires the freeze frame via ctx.stopAll(false)", async () => {
    const { ctx, probe } = makeCtx({ running: ["pane-a", "pane-b"] });
    const { result, status, json } = await runToHttp("stop_all", {}, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(status, 200);
    assert.ok(json && typeof json === "object" && "output" in (json as Record<string, unknown>));
    assert.deepStrictEqual(probe.stopAllCalls, [false]); // Stage-1 freeze, no kill
    assert.ok(
      probe.broadcasts.some((m) => (m as { type?: string }).type === "frozen"),
      "stop_all must broadcast the freeze frame"
    );
  });

  it("confirm_stop_all (frozen): ok -> 200; fires the kill frame via ctx.stopAll(true)", async () => {
    const { ctx, probe } = makeCtx({ frozen: true, running: ["pane-a"] });
    const { result, status } = await runToHttp("confirm_stop_all", {}, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(probe.stopAllCalls, [true]); // Stage-2 kill
  });

  it("confirm_stop_all (NOT frozen): ok -> 200 narration, NO kill (delta: inline 409 -> 200)", async () => {
    const { ctx, probe } = makeCtx({ frozen: false });
    const { result, status } = await runToHttp("confirm_stop_all", {}, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(status, 200); // <- the accepted behavior delta vs the inline 409
    assert.deepStrictEqual(probe.stopAllCalls, []); // guard: no kill when not frozen
  });

  it("release_stop_all (frozen): ok -> 200; fires the unfreeze frame via ctx.releaseStopAll()", async () => {
    const { ctx, probe } = makeCtx({ frozen: true });
    const { result, status } = await runToHttp("release_stop_all", {}, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(status, 200);
    assert.strictEqual(probe.releaseCalls, 1);
    assert.ok(
      probe.broadcasts.some((m) => (m as { type?: string }).type === "stop_all_released"),
      "release_stop_all must broadcast the unfreeze frame"
    );
  });

  it("dismiss_attention (known id): ok -> 200; dismisses + broadcasts attention_updated", async () => {
    const queue = [{ id: "att-1", dismissed: false }];
    const { ctx, probe } = makeCtx({ attentionQueue: queue });
    const { result, status } = await runToHttp("dismiss_attention", { id: "att-1" }, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(status, 200);
    assert.strictEqual(queue[0].dismissed, true);
    assert.ok(
      probe.broadcasts.some((m) => (m as { type?: string }).type === "attention_updated"),
      "dismiss_attention must broadcast attention_updated"
    );
  });

  it("dismiss_attention (unknown id): ok -> 200 narration (delta: inline 404 -> 200), still broadcasts", async () => {
    const { ctx, probe } = makeCtx({ attentionQueue: [{ id: "other", dismissed: false }] });
    const { result, status } = await runToHttp("dismiss_attention", { id: "nope" }, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(status, 200); // <- the accepted behavior delta vs the inline 404
    assert.ok(
      probe.broadcasts.some((m) => (m as { type?: string }).type === "attention_updated"),
      "dismiss_attention must broadcast attention_updated even on an unknown id"
    );
  });

  it("create_orchestrator_plan: ok -> 200; persists + broadcasts plans_updated", async () => {
    const { ctx, probe } = makeCtx();
    const { result, status } = await runToHttp(
      "create_orchestrator_plan",
      { name: "deploy", steps: [{ terminalId: "t1", command: "ls", expectedTransition: "idle" }] },
      ctx
    );
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(status, 200);
    assert.ok(probe.saveCalls.length >= 1, "create_orchestrator_plan must persist the ledger");
    assert.ok(
      probe.broadcasts.some((m) => (m as { type?: string }).type === "plans_updated"),
      "create_orchestrator_plan must broadcast plans_updated"
    );
  });
});

// ── registry bindings (the rest.path / method the cutover relies on) ────────────────────────────
describe("c55 Batch A — registry rest bindings", () => {
  const want: Record<string, { method: string; path: string }> = {
    stop_all: { method: "post", path: "/api/stop-all" },
    confirm_stop_all: { method: "post", path: "/api/stop-all/confirm" },
    release_stop_all: { method: "post", path: "/api/stop-all/release" },
    dismiss_attention: { method: "post", path: "/api/attention/:id/dismiss" },
    create_orchestrator_plan: { method: "post", path: "/api/plans" },
  };
  for (const [name, binding] of Object.entries(want)) {
    it(`${name} binds ${binding.method.toUpperCase()} ${binding.path} on the 'rest' surface`, () => {
      const def = REGISTRY.find((d) => d.name === name);
      assert.ok(def, `registry must contain ${name}`);
      assert.ok(def!.surfaces.has("rest"), `${name} must expose the rest surface`);
      assert.deepStrictEqual(def!.rest, binding);
    });
  }
});

// ── (2) cutover guard — server.ts is text-inspected for the mount + the absent inline twins ──────
describe("c55 Batch A — server.ts cutover guard (no double-registration)", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const serverSrc = readFileSync(path.join(here, "..", "server.ts"), "utf8");

  // The mountRestRoutes `only` set must now include all 5 Batch-A names.
  const onlyNames = [
    "stop_all",
    "confirm_stop_all",
    "release_stop_all",
    "dismiss_attention",
    "create_orchestrator_plan",
  ];
  // c55.16: the mountRestRoutes(...) `only:` allow-filter was RETIRED — the registry now auto-serves
  // every rest-surface def. The cutover proof is no longer "the name is in the only-set text" but
  // "the def is rest-mounted in the REGISTRY" (surfaces:rest && def.rest). Server.ts still calls
  // mountRestRoutes (filterless); registry membership is the durable membership oracle.
  const mountIdx = serverSrc.indexOf("mountRestRoutes(");
  const mountedNames = new Set(
    REGISTRY.filter((d) => d.surfaces.has("rest") && !!d.rest).map((d) => d.name),
  );

  for (const name of onlyNames) {
    it(`mountRestRoutes auto-serves "${name}" (rest-surfaced in REGISTRY)`, () => {
      assert.ok(mountIdx >= 0, "server.ts must call mountRestRoutes");
      assert.ok(
        mountedNames.has(name),
        `"${name}" must be a rest-mounted REGISTRY def (surfaces:rest && def.rest) after the Batch-A cutover`
      );
    });
  }

  // Every Batch-A inline route literal must be GONE (deleted in the same change that added the name).
  // Each entry is the exact app.<verb>('<literal>' prefix the inline twin used.
  const goneLiterals: Array<{ label: string; needle: RegExp }> = [
    { label: "POST /api/stop-all (Stage 1)", needle: /app\.post\(\s*["']\/api\/stop-all["']/ },
    { label: "POST /api/stop-all/confirm", needle: /app\.post\(\s*["']\/api\/stop-all\/confirm["']/ },
    { label: "POST /api/stop-all/release", needle: /app\.post\(\s*["']\/api\/stop-all\/release["']/ },
    {
      label: "POST /api/attention/:id/dismiss",
      needle: /app\.post\(\s*["']\/api\/attention\/:id\/dismiss["']/,
    },
    { label: "POST /api/plans (create)", needle: /app\.post\(\s*["']\/api\/plans["']/ },
  ];
  for (const { label, needle } of goneLiterals) {
    it(`inline route is deleted: ${label}`, () => {
      assert.ok(
        !needle.test(serverSrc),
        `inline ${label} must be deleted (double-registration masks the cutover)`
      );
    });
  }

  // Guard the OUT-OF-SCOPE reads stayed inline (this batch must NOT touch them). NOTE: GET
  // /api/stop-all/status was a Batch-A out-of-scope neighbor, but c55 Batch F intentionally converges
  // it (get_stop_all_status) — so it is no longer asserted here; the Batch F cutover guard
  // (test_c55_batch_f.ts) now asserts that inline route is DELETED.
  // SAME PATTERN: GET /api/attention (get_attention_queue) and GET /api/plans (list_orchestrator_plans)
  // were Batch-A out-of-scope neighbors, but c55.11 intentionally converges them — so they are no
  // longer asserted here; the c55.11 cutover guard (test_c55_11_reads.ts) now asserts those inline
  // routes are DELETED. POST /api/attention/clear remains genuinely inline / out of scope.
  const keptLiterals: Array<{ label: string; needle: RegExp }> = [
    { label: "POST /api/attention/clear", needle: /app\.post\(\s*["']\/api\/attention\/clear["']/ },
  ];
  for (const { label, needle } of keptLiterals) {
    it(`out-of-scope inline route is preserved: ${label}`, () => {
      assert.ok(needle.test(serverSrc), `${label} must remain inline this batch (out of scope)`);
    });
  }
});
