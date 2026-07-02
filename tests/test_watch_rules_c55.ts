// c55 Batch G — net-new gated ActionDefs contract suite (wsm-e2e-pinned-c55.7).
//
// Four NEW rest-only defs that converge inline watch-rule / plan-delete routes with NO voice twin.
// c55.10 TIGHTENED the 3 mutators from ALWAYS_ALLOWED to GATED (default Ask) — this suite exercises
// the Auto (run) path by default (gateOrDefer stub returns {disposition:"run"}); the deferred/forbidden
// arms are pinned in tests/test_c55_10_gating.ts.
//   list_watch_rules        GET    /api/watch-rules        (readOnly ALWAYS_ALLOWED; toHttp -> raw array)
//   add_watch_rule          POST   /api/watch-rules        (GATED add_watch_rule, default Ask — c55.10)
//   remove_watch_rule       DELETE /api/watch-rules/:id     (GATED remove_watch_rule, default Ask — c55.10)
//   delete_orchestrator_plan DELETE /api/plans/:plan_id      (GATED delete_orchestrator_plan, Ask — c55.10)
//
// DOCTRINE (def-level deterministic): call runAction with a fake ctx (a fake manager.ledger holding
// watchRules[]/plans[] + a save spy + a broadcast capture), assert the ActionResult kind/output, then
// assert the HTTP projection — resultToHttp for the {output} writes, applyResultToHttp(def, …) for the
// list_watch_rules toHttp array. No server boot, no PTY.
//
// TARGET CONTRACTS (the spec §Batch G asserts):
//   - list_watch_rules body === the legacy raw WatchRule[] array (GET /api/watch-rules on load).
//   - add_watch_rule / remove_watch_rule persist (push/splice + force-save); wsm-e2e-pinned-33c.4:
//     the {type:'watch_rules_updated'} repaint broadcast they used to also fire is PRUNED — no client
//     has consumed that frame since the classic UI's Alerts/Orchestrate tabs were removed (d858e5e),
//     and Kitchen has no watch-rule surface at all.
//   - delete_orchestrator_plan removes from the board via {type:'plans_updated'}.
//   - writes return {output} (200) — the client only needs res.ok.
//   - unknown-id remove/delete -> 200 ok-narration (the inline 404 -> 200 Decision-2 collapse).

import { describe, it } from "node:test";
import assert from "node:assert";

import { REGISTRY } from "../src/actions/registry";
import { runAction } from "../src/actions/gemini";
import { applyResultToHttp, resultToHttp, type RestResponse } from "../src/actions/rest";
import type { ActionContext, ActionDef, ActionResult, GateDisposition } from "../src/actions/types";
import type { WatchRule, Plan } from "../src/types";

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

interface Recorded {
  saves: boolean[];                 // each ledger.save(force) call's force arg
  broadcasts: Array<Record<string, unknown>>;
  gateCalls: Array<{ capability: string; paneId: string | null; summary: string; params?: Record<string, unknown> }>;
}

interface CtxOpts {
  watchRules?: WatchRule[];
  plans?: Plan[];
  // c55.10: add_watch_rule / remove_watch_rule / delete_orchestrator_plan are now GATED via
  // ctx.gateOrDefer. Default disposition is "run" (Auto) so the existing fidelity assertions still
  // exercise the real effect; pass a disposition to test the deferred/forbidden arms.
  gateDisposition?: GateDisposition;
}

function makeCtx(opts: CtxOpts = {}): { ctx: ActionContext; rec: Recorded; watchRules: WatchRule[]; plans: Plan[] } {
  const rec: Recorded = { saves: [], broadcasts: [], gateCalls: [] };
  const watchRules: WatchRule[] = opts.watchRules ?? [];
  const plans: Plan[] = opts.plans ?? [];
  const manager: any = {
    ledger: {
      watchRules,
      plans,
      // The inline routes persist via the bracket-string ["save"](true) call — mirror that exact shape.
      save: (force?: boolean): void => { rec.saves.push(force ?? false); },
    },
  };
  const ctx = {
    manager,
    session: null,
    redact: (s: string) => s,
    broadcast: (msg: unknown) => { rec.broadcasts.push(msg as Record<string, unknown>); },
    // Mirrors the REAL gateOrDefer: STAGES `run` only on the deferred (Ask) path; on the "run" (Auto)
    // path it returns {disposition:"run"} WITHOUT invoking run — the CALLER runs the effect.
    gateOrDefer: (capability: string, paneId: string | null, summary: string, run: () => string, params?: Record<string, unknown>): GateDisposition => {
      rec.gateCalls.push({ capability, paneId, summary, params });
      const d = opts.gateDisposition ?? { disposition: "run" as const };
      void run;
      return d;
    },
  } as unknown as ActionContext;
  return { ctx, rec, watchRules, plans };
}

function sampleRuleBody(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    triggerTerminalId: "pane_a",
    triggerTransition: "exited",
    actionTerminalId: "pane_b",
    actionCommand: "npm run dev",
    oneShot: false,
    ...over,
  };
}

function samplePlan(id: string, name: string): Plan {
  return {
    id,
    name,
    steps: [{ id: "step_0", terminalId: "pane_a", command: "npm test", expectedTransition: "idle", status: "pending" }],
    currentStepIndex: 0,
    status: "idle",
  };
}

function sampleWatchRule(id: string): WatchRule {
  return {
    id,
    triggerTerminalId: "pane_a",
    triggerTransition: "exited",
    actionTerminalId: "pane_b",
    actionCommand: "npm run dev",
    enabled: true,
    oneShot: false,
  };
}

// ── registry shape: all four defs present, rest-only, with their rest bindings + safe-default gates ──
describe("c55 Batch G — registry shape", () => {
  const names = ["list_watch_rules", "add_watch_rule", "remove_watch_rule", "delete_orchestrator_plan"];
  for (const name of names) {
    it(`${name} is a rest-only def with a rest binding`, () => {
      const def = findDef(name);
      assert.deepStrictEqual([...def.surfaces].sort(), ["rest"], `${name} surfaces must be exactly {rest}`);
      assert.ok(def.rest, `${name} must declare a rest binding`);
    });
  }

  it("rest method + path match the inline routes they replace", () => {
    assert.deepStrictEqual([findDef("list_watch_rules").rest!.method, findDef("list_watch_rules").rest!.path], ["get", "/api/watch-rules"]);
    assert.deepStrictEqual([findDef("add_watch_rule").rest!.method, findDef("add_watch_rule").rest!.path], ["post", "/api/watch-rules"]);
    assert.deepStrictEqual([findDef("remove_watch_rule").rest!.method, findDef("remove_watch_rule").rest!.path], ["delete", "/api/watch-rules/:id"]);
    assert.deepStrictEqual([findDef("delete_orchestrator_plan").rest!.method, findDef("delete_orchestrator_plan").rest!.path], ["delete", "/api/plans/:plan_id"]);
  });

  it("gates: list_watch_rules stays ALWAYS_ALLOWED (a read); the 3 mutators are GATED (c55.10, default Ask)", () => {
    // c55.10 tightened the 3 mutating defs from ALWAYS_ALLOWED to their own/reused matrix rows (Ask).
    // list_watch_rules is a read and stays ungated (readOnly:false to preserve the raw un-redacted body).
    assert.strictEqual(findDef("list_watch_rules").capability, "ALWAYS_ALLOWED", "list_watch_rules stays ALWAYS_ALLOWED (read)");
    assert.strictEqual(findDef("add_watch_rule").capability, "add_watch_rule", "add_watch_rule rides its (un-reserved) matrix row");
    assert.strictEqual(findDef("remove_watch_rule").capability, "remove_watch_rule", "remove_watch_rule rides its NEW matrix row");
    assert.strictEqual(findDef("delete_orchestrator_plan").capability, "delete_orchestrator_plan", "delete_orchestrator_plan rides its NEW matrix row");
  });

  it("list_watch_rules declares a toHttp translator (its body is a raw array, not {output})", () => {
    assert.strictEqual(typeof findDef("list_watch_rules").rest!.toHttp, "function", "list_watch_rules needs a toHttp to emit the raw array top-level");
  });
});

// ── list_watch_rules — toHttp emits the raw WatchRule[] (== the legacy res.json(watchRules) body) ────
describe("c55 list_watch_rules", () => {
  it("returns the raw ledger.watchRules array; toHttp emits it TOP-LEVEL (200), byte-identical to legacy", async () => {
    const rules = [sampleWatchRule("rule_1"), sampleWatchRule("rule_2")];
    const { ctx, watchRules } = makeCtx({ watchRules: rules });
    const def = findDef("list_watch_rules");
    const result = await runAction(REGISTRY, "list_watch_rules", {}, ctx);
    assert.strictEqual(result.kind, "ok");

    const { res, sent } = makeFakeRes();
    applyResultToHttp(def, result, {}, res);
    assert.strictEqual(sent.status, 200, "list_watch_rules is a 200");
    // The legacy inline route did `res.json(manager.ledger.watchRules)` — a TOP-LEVEL array, NOT {output}.
    assert.deepStrictEqual(sent.json, watchRules, "body must be the raw WatchRule[] array setWatchRules() consumes");
    assert.ok(Array.isArray(sent.json), "body is a bare array, not an {output} wrapper");
  });

  it("empty ledger -> empty array body", async () => {
    const { ctx } = makeCtx({ watchRules: [] });
    const def = findDef("list_watch_rules");
    const result = await runAction(REGISTRY, "list_watch_rules", {}, ctx);
    const { res, sent } = makeFakeRes();
    applyResultToHttp(def, result, {}, res);
    assert.strictEqual(sent.status, 200);
    assert.deepStrictEqual(sent.json, []);
  });
});

// ── add_watch_rule — push + save; {output} 200 (wsm-e2e-pinned-33c.4: no watch_rules_updated broadcast) ──
describe("c55 add_watch_rule", () => {
  it("creates a rule (push + persist), no watch_rules_updated broadcast (no client consumes it); ok -> 200 {output}", async () => {
    const { ctx, rec, watchRules } = makeCtx({ watchRules: [] });
    const result = await runAction(REGISTRY, "add_watch_rule", sampleRuleBody(), ctx);
    assert.strictEqual(result.kind, "ok");

    // Effect: exactly one rule pushed, carrying the body's fields + enabled:true + a generated id.
    assert.strictEqual(watchRules.length, 1, "exactly one rule created");
    const created = watchRules[0];
    assert.match(created.id, /^rule_/, "generated rule id");
    assert.strictEqual(created.triggerTerminalId, "pane_a");
    assert.strictEqual(created.triggerTransition, "exited");
    assert.strictEqual(created.actionTerminalId, "pane_b");
    assert.strictEqual(created.actionCommand, "npm run dev");
    assert.strictEqual(created.enabled, true, "new rule defaults enabled:true (inline parity)");
    assert.strictEqual(created.oneShot, false, "oneShot honored from the body");

    // Persisted via the force-save (inline ledger["save"](true)).
    assert.deepStrictEqual(rec.saves, [true], "persisted with a force-save");

    // wsm-e2e-pinned-33c.4: the watch_rules_updated broadcast is PRUNED (no client consumes it) —
    // the force-save above is the durable effect this suite now pins.
    const frame = rec.broadcasts.find((b) => b.type === "watch_rules_updated");
    assert.ok(!frame, "watch_rules_updated broadcast is PRUNED");

    // Wire contract: writes are {output} 200 (the client only needs res.ok).
    const { res, sent } = makeFakeRes();
    resultToHttp(result, res);
    assert.strictEqual(sent.status, 200);
    assert.ok("output" in (sent.json as Record<string, unknown>), "write result is the default {output} body");
  });

  it("oneShot defaults to true when omitted (inline `oneShot !== undefined ? oneShot : true`)", async () => {
    const { ctx, watchRules } = makeCtx({ watchRules: [] });
    const body = sampleRuleBody();
    delete body.oneShot;
    const result = await runAction(REGISTRY, "add_watch_rule", body, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(watchRules[0].oneShot, true, "omitted oneShot defaults to true (faithful to inline)");
  });

  it("missing required field -> zod rejection (replaces the inline 400) — no rule created", async () => {
    const { ctx, watchRules } = makeCtx({ watchRules: [] });
    const body = sampleRuleBody();
    delete body.actionCommand; // required
    const result = await runAction(REGISTRY, "add_watch_rule", body, ctx);
    assert.strictEqual(result.kind, "error", "missing required field is a zod rejection");
    assert.strictEqual(watchRules.length, 0, "nothing created on a rejected request");
  });
});

// ── remove_watch_rule — splice by :id + save; unknown id -> 200 ok (404->200) (wsm-e2e-pinned-33c.4: no watch_rules_updated broadcast) ──
describe("c55 remove_watch_rule", () => {
  it("removes the matching rule (splice + persist), no watch_rules_updated broadcast (no client consumes it); ok -> 200", async () => {
    const { ctx, rec, watchRules } = makeCtx({ watchRules: [sampleWatchRule("keep_1"), sampleWatchRule("drop_2"), sampleWatchRule("keep_3")] });
    const result = await runAction(REGISTRY, "remove_watch_rule", { id: "drop_2" }, ctx);
    assert.strictEqual(result.kind, "ok");

    assert.deepStrictEqual(watchRules.map((r) => r.id), ["keep_1", "keep_3"], "only the matching rule removed");
    assert.deepStrictEqual(rec.saves, [true], "persisted with a force-save");
    // wsm-e2e-pinned-33c.4: the watch_rules_updated broadcast is PRUNED (no client consumes it) —
    // the force-save above is the durable effect this suite now pins.
    const frame = rec.broadcasts.find((b) => b.type === "watch_rules_updated");
    assert.ok(!frame, "watch_rules_updated broadcast is PRUNED");

    const { res, sent } = makeFakeRes();
    resultToHttp(result, res);
    assert.strictEqual(sent.status, 200);
  });

  it("unknown id -> ok narration -> 200 (inline 404 -> 200 delta); no mutation, no broadcast, no save", async () => {
    const { ctx, rec, watchRules } = makeCtx({ watchRules: [sampleWatchRule("keep_1")] });
    const result = await runAction(REGISTRY, "remove_watch_rule", { id: "ghost" }, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.deepStrictEqual(watchRules.map((r) => r.id), ["keep_1"], "no rule removed for an unknown id");
    assert.strictEqual(rec.saves.length, 0, "no persist when nothing changed");
    assert.strictEqual(rec.broadcasts.length, 0, "no repaint when nothing changed");
    const { res, sent } = makeFakeRes();
    resultToHttp(result, res);
    assert.strictEqual(sent.status, 200, "404 collapses to a 200 ok-narration (client ignores the body)");
  });
});

// ── delete_orchestrator_plan — splice by :plan_id + save + plans_updated; unknown id -> 200 ok ───────
describe("c55 delete_orchestrator_plan", () => {
  it("removes the matching plan from the board (splice + persist), repaints via plans_updated; ok -> 200", async () => {
    const { ctx, rec, plans } = makeCtx({ plans: [samplePlan("keep_a", "A"), samplePlan("drop_b", "B")] });
    const result = await runAction(REGISTRY, "delete_orchestrator_plan", { plan_id: "drop_b" }, ctx);
    assert.strictEqual(result.kind, "ok");

    assert.deepStrictEqual(plans.map((p) => p.id), ["keep_a"], "only the matching plan removed from the board");
    assert.deepStrictEqual(rec.saves, [true], "persisted with a force-save");
    const frame = rec.broadcasts.find((b) => b.type === "plans_updated");
    assert.ok(frame, "must broadcast plans_updated so the board repaints");
    assert.deepStrictEqual(frame!.plans, plans, "broadcast carries the post-deletion plan list");

    const { res, sent } = makeFakeRes();
    resultToHttp(result, res);
    assert.strictEqual(sent.status, 200);
  });

  it("unknown plan id -> ok narration -> 200 (inline 404 -> 200 delta); no mutation, no broadcast, no save", async () => {
    const { ctx, rec, plans } = makeCtx({ plans: [samplePlan("keep_a", "A")] });
    const result = await runAction(REGISTRY, "delete_orchestrator_plan", { plan_id: "ghost" }, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.deepStrictEqual(plans.map((p) => p.id), ["keep_a"], "no plan removed for an unknown id");
    assert.strictEqual(rec.saves.length, 0, "no persist when nothing changed");
    assert.strictEqual(rec.broadcasts.length, 0, "no repaint when nothing changed");
    const { res, sent } = makeFakeRes();
    resultToHttp(result, res);
    assert.strictEqual(sent.status, 200);
  });
});
