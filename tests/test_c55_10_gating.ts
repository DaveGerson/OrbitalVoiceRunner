// c55.10 — gate-tightening contract suite for the 4 cutover ALWAYS_ALLOWED rest-write defs.
//
// Four defs flip from ALWAYS_ALLOWED → a GATED matrix row (all default Ask) per the P2 taxonomy:
//   send_keys                 POST   /api/terminals/:pane_id/input  (NEW cap, twin of write_to_pane)
//   add_watch_rule            POST   /api/watch-rules               (EXISTING reserved row, un-reserved)
//   remove_watch_rule         DELETE /api/watch-rules/:id           (NEW cap, mirror of add_watch_rule)
//   delete_orchestrator_plan  DELETE /api/plans/:plan_id            (NEW cap, destructive)
//
// DOCTRINE (def-level deterministic, mirrors test_c55_14_lifecycle.ts): call runAction with a fake ctx
// whose gateOrDefer disposition is configurable, assert the ActionResult kind/output + that the side
// effect ran (Auto) / did NOT run (Ask/Off), then assert applyResultToHttp maps the kind to {status,body}.
// No server boot, no PTY. We additionally PIN, against the real matrix sources (DEFAULT_CAPABILITY_GATES
// + the spotlight set), that the EFFECTIVE off-context default for these 4 caps is "Ask" — i.e. the
// DEFAULT REST result is the 202-deferred path, not 200. This catches a future spotlight-eligibility
// or default-gate regression that would silently re-open the channel.
//
// Runner: npx tsx --test --test-force-exit tests/test_c55_10_gating.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";

import { REGISTRY } from "../src/actions/registry";
import { runAction } from "../src/actions/gemini";
import { applyResultToHttp, type RestResponse } from "../src/actions/rest";
import { INTENTIONAL_ASYMMETRY } from "../src/actions/coverage";
import type { ActionContext, ActionDef, GateDisposition } from "../src/actions/types";
import { DEFAULT_CAPABILITY_GATES } from "../src/types";
import { resolveCapabilityGateWithContext, SPOTLIGHT_CAPABILITIES } from "../src/pendingApprovals";

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

interface FakeTerm { writes: string[]; writeInput: (s: string) => void; }
function makeFakeTerm(): FakeTerm {
  const t: FakeTerm = { writes: [], writeInput: (s: string) => { t.writes.push(s); } };
  return t;
}

interface CtxOpts {
  terminals?: Record<string, FakeTerm>;
  watchRules?: Array<{ id: string }>;
  plans?: Array<{ id: string }>;
  gateDisposition?: GateDisposition;
}

interface Recorded {
  gateCalls: Array<{ capability: string; paneId: string | null; summary: string; params?: Record<string, unknown> }>;
  ledgerUpdates: number;
  saves: boolean[];
  broadcasts: Array<{ type: string }>;
}

function makeCtx(opts: CtxOpts = {}): { ctx: ActionContext; rec: Recorded; manager: any } {
  const rec: Recorded = { gateCalls: [], ledgerUpdates: 0, saves: [], broadcasts: [] };
  const terminals = opts.terminals ?? {};
  const watchRules = opts.watchRules ?? [];
  const plans = opts.plans ?? [];
  const manager: any = {
    terminals,
    settings: { advanced: {} },
    ledger: {
      watchRules,
      plans,
      save: (immediate?: boolean): void => { rec.saves.push(!!immediate); },
    },
  };
  const ctx = {
    manager,
    session: null,
    redact: (s: string) => s,
    broadcast: (msg: { type: string }) => { rec.broadcasts.push(msg); },
    broadcastLedgerUpdate: () => { rec.ledgerUpdates++; },
    broadcastTerminalsUpdated: () => {},
    // Mirrors the REAL gateOrDefer: it STAGES `run` only on the deferred (Ask) path; on the "run" (Auto)
    // path it returns {disposition:"run"} WITHOUT invoking run — the CALLER runs the effect. The handler
    // therefore must call the effect itself on Auto (the c55.14 / respawn_pane contract).
    gateOrDefer: (capability: string, paneId: string | null, summary: string, run: () => string, params?: Record<string, unknown>): GateDisposition => {
      rec.gateCalls.push({ capability, paneId, summary, params });
      const d = opts.gateDisposition ?? { disposition: "run" as const };
      void run; // not invoked on the "run" path (handler runs the effect)
      return d;
    },
  } as unknown as ActionContext;
  return { ctx, rec, manager };
}

// send_keys' Auto path runs the REAL addCommand -> saveHistory, which writes .janus_history.json to
// process.cwd(). Isolate the cwd so those writes never collide with the repo's file (otherwise a stale
// entry leaks into tests/test_read_gating.ts, which reads the same file). Mirrors the Batch C helper.
async function withTempCwd<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c55-10-hist-"));
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(prev);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// (a) SHAPE — all four defs present, rest-only, now GATED on the expected NEW/EXISTING capability row.
// ─────────────────────────────────────────────────────────────────────────────
describe("c55.10 — shape (the 4 cutover defs are now gated, rest-only)", () => {
  const cases: Array<{ name: string; capability: string; method: string; path: string }> = [
    { name: "send_keys", capability: "send_keys", method: "post", path: "/api/terminals/:pane_id/input" },
    { name: "add_watch_rule", capability: "add_watch_rule", method: "post", path: "/api/watch-rules" },
    { name: "remove_watch_rule", capability: "remove_watch_rule", method: "delete", path: "/api/watch-rules/:id" },
    { name: "delete_orchestrator_plan", capability: "delete_orchestrator_plan", method: "delete", path: "/api/plans/:plan_id" },
  ];
  for (const { name, capability, method, path } of cases) {
    it(`${name} rides cap=${capability}, ${method.toUpperCase()} ${path}, rest-only + allow-listed`, () => {
      const def = findDef(name);
      assert.strictEqual(def.capability, capability, `${name} capability`);
      assert.deepStrictEqual([...def.surfaces].sort(), ["rest"], `${name} surfaces must be exactly {rest} (no voice exposure)`);
      assert.strictEqual(def.readOnly, false, `${name} readOnly:false`);
      assert.ok(def.rest, `${name} must declare a rest binding`);
      assert.strictEqual(def.rest!.method, method, `${name} rest method`);
      assert.strictEqual(def.rest!.path, path, `${name} rest path`);
      // surfaces unchanged → INTENTIONAL_ASYMMETRY stays rest-only (the asymmetry guard cannot move).
      assert.deepStrictEqual(INTENTIONAL_ASYMMETRY[name], new Set(["rest"]), `${name} must be allow-listed rest-only`);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) EFFECTIVE DEFAULT — the 4 caps are Ask off-context AND NOT spotlight-eligible, so the DEFAULT
//     (off-context, no per-pane override) effective gate is Ask → the default REST result is 202-deferred,
//     never 200. Pins a future spotlight-eligibility / default-gate regression.
// ─────────────────────────────────────────────────────────────────────────────
describe("c55.10 — effective off-context default is Ask (deferred path), not Auto", () => {
  const caps = ["send_keys", "add_watch_rule", "remove_watch_rule", "delete_orchestrator_plan"] as const;
  for (const cap of caps) {
    it(`${cap}: DEFAULT_CAPABILITY_GATES is Ask`, () => {
      assert.strictEqual(DEFAULT_CAPABILITY_GATES[cap], "Ask", `${cap} global default must be Ask`);
    });
    it(`${cap}: NOT spotlight-eligible (focus can never loosen it to Auto)`, () => {
      assert.ok(!SPOTLIGHT_CAPABILITIES.has(cap), `${cap} must NOT be spotlight-eligible`);
    });
    it(`${cap}: resolves to Ask even on the ACTIVE pane (no override) → deferred default`, () => {
      const resolved = resolveCapabilityGateWithContext(undefined, DEFAULT_CAPABILITY_GATES[cap], cap, true);
      assert.strictEqual(resolved, "Ask", `${cap} stays Ask on the active pane — the default REST result is 202, not 200`);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) GATING — status-via-kinds for EACH gated def: forbidden→403, deferred→202, run→200 (+ side effects).
//     The Auto (run) arm MUST exercise the real effect (gateOrDefer does NOT invoke run); Ask/Off must NOT.
// ─────────────────────────────────────────────────────────────────────────────

describe("c55.10 — send_keys gating (status-via-kinds)", () => {
  function seed(term: FakeTerm): CtxOpts { return { terminals: { p1: term } }; }

  it("Off -> blocked -> 403 {error}; NO write to the PTY", async () => {
    await withTempCwd(async () => {
      const term = makeFakeTerm();
      const { ctx, rec } = makeCtx({ ...seed(term), gateDisposition: { disposition: "forbidden" } });
      const result = await runAction(REGISTRY, "send_keys", { pane_id: "p1", command: "rm -rf /" }, ctx);
      assert.strictEqual(result.kind, "blocked");
      assert.strictEqual(rec.gateCalls[0].capability, "send_keys", "gated via the send_keys capability");
      assert.strictEqual(rec.gateCalls[0].paneId, "p1", "gate keyed on the pane id");
      assert.strictEqual(rec.gateCalls[0].params?.origin, "rest", "params carry origin:rest");
      assert.deepStrictEqual(term.writes, [], "forbidden send does NOT write to the PTY");
      const { res, sent } = makeFakeRes();
      applyResultToHttp(findDef("send_keys"), result, {}, res);
      assert.strictEqual(sent.status, 403);
      assert.ok((sent.json as { error: string }).error);
    });
  });

  it("Ask -> pending (messageId+summary) -> 202; effect deferred (no PTY write yet)", async () => {
    await withTempCwd(async () => {
      const term = makeFakeTerm();
      const { ctx, rec } = makeCtx({ ...seed(term), gateDisposition: { disposition: "deferred", actionId: "act_sk", summary: "Send keystrokes to pane p1" } });
      const result = await runAction(REGISTRY, "send_keys", { pane_id: "p1", command: "ls" }, ctx);
      assert.strictEqual(result.kind, "pending");
      assert.deepStrictEqual(term.writes, [], "deferred send does NOT write to the PTY yet");
      assert.strictEqual(rec.ledgerUpdates, 0, "no broadcast for a deferred send");
      const { res, sent } = makeFakeRes();
      applyResultToHttp(findDef("send_keys"), result, {}, res);
      assert.strictEqual(sent.status, 202);
      assert.deepStrictEqual(sent.json, { status: "pending_approval", messageId: "act_sk" });
    });
  });

  it("Auto -> ok -> 200; writes to the PTY + broadcastLedgerUpdate", async () => {
    await withTempCwd(async () => {
      const term = makeFakeTerm();
      const { ctx, rec } = makeCtx(seed(term));
      const result = await runAction(REGISTRY, "send_keys", { pane_id: "p1", command: "echo hi" }, ctx);
      assert.strictEqual(result.kind, "ok");
      assert.deepStrictEqual(term.writes, ["echo hi"], "Auto send writes the command to the live PTY");
      assert.strictEqual(rec.ledgerUpdates, 1, "broadcastLedgerUpdate fired");
      const { res, sent } = makeFakeRes();
      applyResultToHttp(findDef("send_keys"), result, {}, res);
      assert.strictEqual(sent.status, 200);
    });
  });

  it("unknown pane -> ok narration -> 200; gate NOT consulted (resolve before gate)", async () => {
    await withTempCwd(async () => {
      const { ctx, rec } = makeCtx({ terminals: {} });
      const result = await runAction(REGISTRY, "send_keys", { pane_id: "ghost", command: "ls" }, ctx);
      assert.strictEqual(result.kind, "ok");
      assert.strictEqual(rec.gateCalls.length, 0, "a write to a non-existent pane is never staged/forbidden");
      const { res, sent } = makeFakeRes();
      applyResultToHttp(findDef("send_keys"), result, {}, res);
      assert.strictEqual(sent.status, 200);
    });
  });
});

describe("c55.10 — add_watch_rule gating (status-via-kinds)", () => {
  const body = { triggerTerminalId: "trig", triggerTransition: "idle" as const, actionTerminalId: "act", actionCommand: "npm test" };

  it("Off -> blocked -> 403; NO rule pushed", async () => {
    const { ctx, rec, manager } = makeCtx({ watchRules: [], gateDisposition: { disposition: "forbidden" } });
    const result = await runAction(REGISTRY, "add_watch_rule", body, ctx);
    assert.strictEqual(result.kind, "blocked");
    assert.strictEqual(rec.gateCalls[0].capability, "add_watch_rule", "gated via the add_watch_rule capability");
    assert.strictEqual(rec.gateCalls[0].paneId, "trig", "gate keyed on the trigger terminal id");
    assert.strictEqual(rec.gateCalls[0].params?.origin, "rest", "params carry origin:rest");
    assert.strictEqual(manager.ledger.watchRules.length, 0, "forbidden add pushes no rule");
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("add_watch_rule"), result, {}, res);
    assert.strictEqual(sent.status, 403);
  });

  it("Ask -> pending -> 202; effect deferred (no rule pushed, no save)", async () => {
    const { ctx, manager } = makeCtx({ watchRules: [], gateDisposition: { disposition: "deferred", actionId: "act_aw", summary: "Add watch rule on pane trig" } });
    const result = await runAction(REGISTRY, "add_watch_rule", body, ctx);
    assert.strictEqual(result.kind, "pending");
    assert.strictEqual(manager.ledger.watchRules.length, 0, "deferred add does NOT push the rule yet");
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("add_watch_rule"), result, {}, res);
    assert.strictEqual(sent.status, 202);
    assert.deepStrictEqual(sent.json, { status: "pending_approval", messageId: "act_aw" });
  });

  it("Auto -> ok -> 200; rule pushed + save(true) + watch_rules_updated", async () => {
    const { ctx, rec, manager } = makeCtx({ watchRules: [] });
    const result = await runAction(REGISTRY, "add_watch_rule", body, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(manager.ledger.watchRules.length, 1, "Auto add pushes the rule");
    assert.strictEqual(manager.ledger.watchRules[0].triggerTerminalId, "trig");
    assert.deepStrictEqual(rec.saves, [true], "ledger.save(true)");
    assert.ok(rec.broadcasts.some((b) => b.type === "watch_rules_updated"), "watch_rules_updated broadcast");
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("add_watch_rule"), result, {}, res);
    assert.strictEqual(sent.status, 200);
  });
});

describe("c55.10 — remove_watch_rule gating (status-via-kinds)", () => {
  function seed(): CtxOpts { return { watchRules: [{ id: "rule_x" }, { id: "rule_y" }] }; }

  it("Off -> blocked -> 403; rule NOT removed", async () => {
    const { ctx, rec, manager } = makeCtx({ ...seed(), gateDisposition: { disposition: "forbidden" } });
    const result = await runAction(REGISTRY, "remove_watch_rule", { id: "rule_x" }, ctx);
    assert.strictEqual(result.kind, "blocked");
    assert.strictEqual(rec.gateCalls[0].capability, "remove_watch_rule", "gated via the remove_watch_rule capability");
    assert.strictEqual(rec.gateCalls[0].paneId, null, "remove_watch_rule gate is global (paneId null)");
    assert.strictEqual(rec.gateCalls[0].params?.origin, "rest", "params carry origin:rest");
    assert.strictEqual(manager.ledger.watchRules.length, 2, "forbidden remove leaves both rules");
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("remove_watch_rule"), result, {}, res);
    assert.strictEqual(sent.status, 403);
  });

  it("Ask -> pending -> 202; effect deferred (rule still present)", async () => {
    const { ctx, manager } = makeCtx({ ...seed(), gateDisposition: { disposition: "deferred", actionId: "act_rw", summary: "Remove watch rule rule_x" } });
    const result = await runAction(REGISTRY, "remove_watch_rule", { id: "rule_x" }, ctx);
    assert.strictEqual(result.kind, "pending");
    assert.strictEqual(manager.ledger.watchRules.length, 2, "deferred remove does NOT splice yet");
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("remove_watch_rule"), result, {}, res);
    assert.strictEqual(sent.status, 202);
    assert.deepStrictEqual(sent.json, { status: "pending_approval", messageId: "act_rw" });
  });

  it("Auto -> ok -> 200; rule spliced + save(true) + watch_rules_updated", async () => {
    const { ctx, rec, manager } = makeCtx(seed());
    const result = await runAction(REGISTRY, "remove_watch_rule", { id: "rule_x" }, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.deepStrictEqual(manager.ledger.watchRules.map((r: { id: string }) => r.id), ["rule_y"], "rule_x spliced");
    assert.deepStrictEqual(rec.saves, [true], "ledger.save(true)");
    assert.ok(rec.broadcasts.some((b) => b.type === "watch_rules_updated"), "watch_rules_updated broadcast");
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("remove_watch_rule"), result, {}, res);
    assert.strictEqual(sent.status, 200);
  });

  it("unknown id -> ok narration -> 200; gate NOT consulted (resolve before gate)", async () => {
    const { ctx, rec, manager } = makeCtx(seed());
    const result = await runAction(REGISTRY, "remove_watch_rule", { id: "ghost" }, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(rec.gateCalls.length, 0, "a no-op remove is never staged/forbidden");
    assert.strictEqual(manager.ledger.watchRules.length, 2, "no mutation");
    assert.deepStrictEqual(rec.saves, [], "no save for a no-op");
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("remove_watch_rule"), result, {}, res);
    assert.strictEqual(sent.status, 200);
  });
});

describe("c55.10 — delete_orchestrator_plan gating (status-via-kinds)", () => {
  function seed(): CtxOpts { return { plans: [{ id: "plan_a" }, { id: "plan_b" }] }; }

  it("Off -> blocked -> 403; plan NOT deleted", async () => {
    const { ctx, rec, manager } = makeCtx({ ...seed(), gateDisposition: { disposition: "forbidden" } });
    const result = await runAction(REGISTRY, "delete_orchestrator_plan", { plan_id: "plan_a" }, ctx);
    assert.strictEqual(result.kind, "blocked");
    assert.strictEqual(rec.gateCalls[0].capability, "delete_orchestrator_plan", "gated via the delete_orchestrator_plan capability");
    assert.strictEqual(rec.gateCalls[0].paneId, null, "delete_orchestrator_plan gate is global (paneId null)");
    assert.strictEqual(rec.gateCalls[0].params?.origin, "rest", "params carry origin:rest");
    assert.strictEqual(manager.ledger.plans.length, 2, "forbidden delete leaves both plans");
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("delete_orchestrator_plan"), result, {}, res);
    assert.strictEqual(sent.status, 403);
  });

  it("Ask -> pending -> 202; effect deferred (plan still present)", async () => {
    const { ctx, manager } = makeCtx({ ...seed(), gateDisposition: { disposition: "deferred", actionId: "act_dp", summary: "Delete plan plan_a" } });
    const result = await runAction(REGISTRY, "delete_orchestrator_plan", { plan_id: "plan_a" }, ctx);
    assert.strictEqual(result.kind, "pending");
    assert.strictEqual(manager.ledger.plans.length, 2, "deferred delete does NOT splice yet");
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("delete_orchestrator_plan"), result, {}, res);
    assert.strictEqual(sent.status, 202);
    assert.deepStrictEqual(sent.json, { status: "pending_approval", messageId: "act_dp" });
  });

  it("Auto -> ok -> 200; plan spliced + save(true) + plans_updated", async () => {
    const { ctx, rec, manager } = makeCtx(seed());
    const result = await runAction(REGISTRY, "delete_orchestrator_plan", { plan_id: "plan_a" }, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.deepStrictEqual(manager.ledger.plans.map((p: { id: string }) => p.id), ["plan_b"], "plan_a spliced");
    assert.deepStrictEqual(rec.saves, [true], "ledger.save(true)");
    assert.ok(rec.broadcasts.some((b) => b.type === "plans_updated"), "plans_updated broadcast");
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("delete_orchestrator_plan"), result, {}, res);
    assert.strictEqual(sent.status, 200);
  });

  it("unknown id -> ok narration -> 200; gate NOT consulted (resolve before gate)", async () => {
    const { ctx, rec, manager } = makeCtx(seed());
    const result = await runAction(REGISTRY, "delete_orchestrator_plan", { plan_id: "ghost" }, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(rec.gateCalls.length, 0, "a no-op delete is never staged/forbidden");
    assert.strictEqual(manager.ledger.plans.length, 2, "no mutation");
    assert.deepStrictEqual(rec.saves, [], "no save for a no-op");
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("delete_orchestrator_plan"), result, {}, res);
    assert.strictEqual(sent.status, 200);
  });
});
