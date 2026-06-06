// c55.16 — set_pane_gates: the BULK per-pane gate-map writer convergence contract suite.
//
// Converges the inline PUT /api/projects/:projectId/panes/:paneId/capability-gates (server.ts:868) —
// the operator matrix-editor's BULK whole-map per-pane override writer — onto a NEW rest-only ActionDef
// `set_pane_gates`. It is the deliberate UI sibling of the voice `set_capability_gate` tool: where voice
// is single-entry + tighten-only, this UI route writes the operator-chosen map VERBATIM (loosening
// allowed). It reuses the EXISTING `set_capability_gate` capability row (zero matrix-file edits) and
// rides the rest.toHttp primitive to reproduce the inline route's exact 200/404 contract.
//
// DOCTRINE (def-level deterministic, mirrors test_c55_14_lifecycle.ts): call runAction with a fake ctx +
// fake manager, assert the ActionResult kind/output + the side effects (updatePane, broadcasts,
// recordActivity), then assert applyResultToHttp maps it to {status,body}. No server boot, no PTY.
//
// Pins the inline (A)-(H): (A) notFound sentinel BEFORE any mutation/broadcast; (B) Auto|Ask|Off filter
// (silent-drop, NOT zod-500); (C) pane.capabilityGates = any?clean:undefined (empty/all-invalid CLEARS);
// (D) updatePane(projectId,pane,true) on BOTH set+clear (NOT save() — SQLite no-op); (E) recordActivity
// permission_changed under if(ctx.store)+try/catch; (F)+(G) both broadcasts on BOTH set+clear; (H)
// ungated/verbatim/immediate (no gateOrDefer, no isLoosening refusal).
//
// Runner: npx tsx --test --test-force-exit tests/test_c55_16_set_pane_gates.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { REGISTRY } from "../src/actions/registry";
import { runAction } from "../src/actions/gemini";
import { applyResultToHttp, type RestResponse } from "../src/actions/rest";
import { INTENTIONAL_ASYMMETRY } from "../src/actions/coverage";
import type { ActionContext, ActionDef } from "../src/actions/types";

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

// A minimal pane stand-in carrying only the field the def touches.
interface FakePane { pane_id: string; capabilityGates?: Record<string, string> }
interface FakeWs { panes: Record<string, FakePane> }

interface CtxOpts {
  workspaces?: Record<string, FakeWs>;
  withStore?: boolean; // when false, ctx.store is null (legacy backend / store-init failure)
}

interface RecordedActivity { type: string; project_id: string; pane_id: string | null; summary: string; payload: Record<string, unknown> }
interface Recorded {
  updatePaneCalls: Array<{ projectId: string; pane: FakePane; immediate: boolean }>;
  saves: boolean[];               // any bare ledger.save() — should NEVER fire (regression bar R5)
  ledgerUpdates: number;
  terminalsUpdated: number;
  activities: RecordedActivity[];
}

function makeCtx(opts: CtxOpts = {}): { ctx: ActionContext; rec: Recorded; manager: any } {
  const rec: Recorded = {
    updatePaneCalls: [], saves: [], ledgerUpdates: 0, terminalsUpdated: 0, activities: [],
  };
  const workspaces = opts.workspaces ?? {};
  const manager: any = {
    ledger: {
      workspaces,
      getProject: (id: string): FakeWs | null => workspaces[id] ?? null,
      updatePane: (projectId: string, pane: FakePane, immediate?: boolean): void => {
        rec.updatePaneCalls.push({ projectId, pane, immediate: !!immediate });
      },
      save: (immediate?: boolean): void => { rec.saves.push(!!immediate); },
    },
  };
  const store = opts.withStore === false ? null : {
    recordActivity: (event: RecordedActivity): void => { rec.activities.push(event); },
  };
  const ctx = {
    manager,
    session: null,
    redact: (s: string) => s,
    broadcast: () => {},
    broadcastLedgerUpdate: () => { rec.ledgerUpdates++; },
    broadcastTerminalsUpdated: () => { rec.terminalsUpdated++; },
    store,
  } as unknown as ActionContext;
  return { ctx, rec, manager };
}

function seedPane(): { workspaces: Record<string, FakeWs>; pane: FakePane } {
  const pane: FakePane = { pane_id: "pg-1" };
  return { workspaces: { proj: { panes: { "pg-1": pane } } }, pane };
}

// ─────────────────────────────────────────────────────────────────────────────
// (1) SHAPE — set_pane_gates is rest-only, reuses the set_capability_gate cap, put + toHttp, snake path.
//     Also pins the set_capability_gate surface flip + BOTH INTENTIONAL_ASYMMETRY rows.
// ─────────────────────────────────────────────────────────────────────────────
describe("c55.16 — shape", () => {
  it("set_pane_gates is a rest-only def: cap=set_capability_gate, PUT snake-path, toHttp present", () => {
    const def = findDef("set_pane_gates");
    assert.deepStrictEqual([...def.surfaces].sort(), ["rest"], "surfaces must be exactly {rest}");
    assert.strictEqual(def.capability, "set_capability_gate", "reuses the existing set_capability_gate cap row");
    assert.strictEqual(def.readOnly, false, "readOnly:false");
    assert.ok(def.rest, "must declare a rest binding");
    assert.strictEqual(def.rest!.method, "put", "rest method is put");
    assert.strictEqual(def.rest!.path, "/api/projects/:project_id/panes/:pane_id/capability-gates", "snake-case rest.path");
    assert.strictEqual(typeof def.rest!.toHttp, "function", "carries a rest.toHttp hook");
  });

  it("set_capability_gate is now VOICE-ONLY (dormant rest binding removed)", () => {
    const def = findDef("set_capability_gate");
    assert.deepStrictEqual([...def.surfaces].sort(), ["voice"], "set_capability_gate surfaces must be exactly {voice}");
    assert.strictEqual(def.rest, undefined, "set_capability_gate must no longer carry a rest binding (path re-homed to set_pane_gates)");
  });

  it("BOTH INTENTIONAL_ASYMMETRY rows are present (set_capability_gate:{voice}, set_pane_gates:{rest})", () => {
    assert.deepStrictEqual(INTENTIONAL_ASYMMETRY["set_capability_gate"], new Set(["voice"]), "set_capability_gate allow-listed voice-only");
    assert.deepStrictEqual(INTENTIONAL_ASYMMETRY["set_pane_gates"], new Set(["rest"]), "set_pane_gates allow-listed rest-only");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (2) SUCCESS FIDELITY — a map write round-trips into pane.capabilityGates verbatim, updatePane(.,.,true),
//     both broadcasts, recordActivity; applyResultToHttp -> 200 {success:true, capabilityGates:<map>}.
// ─────────────────────────────────────────────────────────────────────────────
describe("c55.16 — set_pane_gates success fidelity", () => {
  it("writes the whole map verbatim + updatePane(projectId,pane,true) + both broadcasts + audit; 200", async () => {
    const { workspaces, pane } = seedPane();
    const { ctx, rec } = makeCtx({ workspaces });
    const gates = { write_to_pane: "Off", close_pane: "Ask" };
    const result = await runAction(REGISTRY, "set_pane_gates", {
      project_id: "proj", pane_id: "pg-1", capability_gates: gates,
    }, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.deepStrictEqual(pane.capabilityGates, gates, "pane carries the override verbatim (no loss)");
    assert.deepStrictEqual(rec.saves, [], "NEVER a bare ledger.save() (SQLite no-op — R5)");
    assert.strictEqual(rec.updatePaneCalls.length, 1, "updatePane called once");
    assert.strictEqual(rec.updatePaneCalls[0].projectId, "proj", "updatePane keyed on project_id");
    assert.strictEqual(rec.updatePaneCalls[0].pane, pane, "updatePane handed the live pane object");
    assert.strictEqual(rec.updatePaneCalls[0].immediate, true, "updatePane(projectId,pane,TRUE) — durable BOTH backends");
    assert.strictEqual(rec.ledgerUpdates, 1, "broadcastLedgerUpdate fired");
    assert.strictEqual(rec.terminalsUpdated, 1, "broadcastTerminalsUpdated fired");
    assert.strictEqual(rec.activities.length, 1, "recordActivity fired once");
    assert.strictEqual(rec.activities[0].type, "permission_changed", "audit type permission_changed");
    assert.strictEqual(rec.activities[0].pane_id, "pg-1", "audit keyed on the pane id");
    assert.deepStrictEqual(rec.activities[0].payload, { action: "set_pane_gates", capabilityGates: gates }, "audit payload carries the clean map");

    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("set_pane_gates"), result, {}, res);
    assert.strictEqual(sent.status, 200);
    assert.deepStrictEqual(sent.json, { success: true, capabilityGates: gates }, "200 body byte-for-byte");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (3) NORMALIZE + CLEAR — invalid values silently dropped; empty {} / all-invalid CLEARS to undefined,
//     body reports null, updatePane still called (durable clear), both broadcasts STILL fire (R7).
// ─────────────────────────────────────────────────────────────────────────────
describe("c55.16 — normalize + clear", () => {
  it("an invalid gate value is SILENTLY DROPPED (Auto|Ask|Off filter, not a zod-500)", async () => {
    const { workspaces, pane } = seedPane();
    const { ctx } = makeCtx({ workspaces });
    const result = await runAction(REGISTRY, "set_pane_gates", {
      project_id: "proj", pane_id: "pg-1", capability_gates: { write_to_pane: "Off", bogus: "NOPE" },
    }, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.deepStrictEqual(pane.capabilityGates, { write_to_pane: "Off" }, "bogus dropped, valid kept");
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("set_pane_gates"), result, {}, res);
    assert.deepStrictEqual(sent.json, { success: true, capabilityGates: { write_to_pane: "Off" } });
  });

  it("an empty {} CLEARS the override (pane.capabilityGates===undefined), body null, updatePane + broadcasts still fire", async () => {
    const { workspaces, pane } = seedPane();
    pane.capabilityGates = { close_pane: "Off" }; // pre-existing override to clear
    const { ctx, rec } = makeCtx({ workspaces });
    const result = await runAction(REGISTRY, "set_pane_gates", {
      project_id: "proj", pane_id: "pg-1", capability_gates: {},
    }, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(pane.capabilityGates, undefined, "cleared to undefined (no masking {})");
    assert.strictEqual(rec.updatePaneCalls.length, 1, "updatePane STILL called on the clear path (durable)");
    assert.strictEqual(rec.updatePaneCalls[0].immediate, true, "clear is also updatePane(.,.,true)");
    assert.deepStrictEqual(rec.saves, [], "still never a bare save() on the clear path");
    assert.strictEqual(rec.ledgerUpdates, 1, "broadcastLedgerUpdate fired on clear (R7 — chips repaint to default)");
    assert.strictEqual(rec.terminalsUpdated, 1, "broadcastTerminalsUpdated fired on clear (R7)");
    assert.strictEqual(rec.activities[0].payload.capabilityGates, null, "audit payload capabilityGates:null on clear");
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("set_pane_gates"), result, {}, res);
    assert.strictEqual(sent.status, 200);
    assert.deepStrictEqual(sent.json, { success: true, capabilityGates: null }, "cleared body reports null (not {})");
  });

  it("an all-invalid map behaves like empty (clears)", async () => {
    const { workspaces, pane } = seedPane();
    pane.capabilityGates = { write_to_pane: "Off" };
    const { ctx } = makeCtx({ workspaces });
    const result = await runAction(REGISTRY, "set_pane_gates", {
      project_id: "proj", pane_id: "pg-1", capability_gates: { foo: "BAD", bar: "ALSO_BAD" },
    }, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(pane.capabilityGates, undefined, "all-invalid clears like empty");
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("set_pane_gates"), result, {}, res);
    assert.deepStrictEqual(sent.json, { success: true, capabilityGates: null });
  });

  it("an ABSENT map clears (no capability_gates key at all)", async () => {
    const { workspaces, pane } = seedPane();
    pane.capabilityGates = { write_to_pane: "Off" };
    const { ctx, rec } = makeCtx({ workspaces });
    const result = await runAction(REGISTRY, "set_pane_gates", { project_id: "proj", pane_id: "pg-1" }, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(pane.capabilityGates, undefined, "absent map clears");
    assert.strictEqual(rec.updatePaneCalls.length, 1, "absent-map clear is still durable");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (4) 404 SENTINEL — missing pane -> {notFound:true} ok-sentinel BEFORE any mutation: NO updatePane,
//     NO broadcasts, NO audit; applyResultToHttp -> 404 {error:"Pane not found"}.
// ─────────────────────────────────────────────────────────────────────────────
describe("c55.16 — 404 sentinel (pane not found)", () => {
  it("unknown pane in a known project -> ok-sentinel; NO mutation/broadcast/audit; 404 {error}", async () => {
    const { workspaces } = seedPane();
    const { ctx, rec } = makeCtx({ workspaces });
    const result = await runAction(REGISTRY, "set_pane_gates", {
      project_id: "proj", pane_id: "does-not-exist", capability_gates: { write_to_pane: "Off" },
    }, ctx);
    assert.strictEqual(result.kind, "ok", "modeled as an ok-shaped sentinel (so toHttp can pick the 404 status)");
    assert.deepStrictEqual(rec.updatePaneCalls, [], "NO updatePane on the 404 path (pre-check before mutation)");
    assert.deepStrictEqual(rec.saves, [], "NO save on the 404 path");
    assert.strictEqual(rec.ledgerUpdates, 0, "NO broadcastLedgerUpdate on the 404 path");
    assert.strictEqual(rec.terminalsUpdated, 0, "NO broadcastTerminalsUpdated on the 404 path");
    assert.strictEqual(rec.activities.length, 0, "NO recordActivity on the 404 path");
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("set_pane_gates"), result, {}, res);
    assert.strictEqual(sent.status, 404);
    assert.deepStrictEqual(sent.json, { error: "Pane not found" }, "404 body byte-for-byte");
  });

  it("missing PROJECT (null ws) is also a 404", async () => {
    const { ctx, rec } = makeCtx({ workspaces: {} });
    const result = await runAction(REGISTRY, "set_pane_gates", {
      project_id: "ghost", pane_id: "pg-1", capability_gates: { write_to_pane: "Off" },
    }, ctx);
    assert.deepStrictEqual(rec.updatePaneCalls, [], "no mutation when the project is missing");
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("set_pane_gates"), result, {}, res);
    assert.strictEqual(sent.status, 404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (5) coerceArgs alias — body camelCase `capabilityGates` aliases to snake `capability_gates` ONLY when
//     the snake key is absent (mirror set_pane_permissions); snake key untouched when present.
// ─────────────────────────────────────────────────────────────────────────────
describe("c55.16 — coerceArgs camelCase body alias", () => {
  it("the matrix-editor body {capabilityGates} lands on the snake zod key", async () => {
    const { workspaces, pane } = seedPane();
    const { ctx } = makeCtx({ workspaces });
    const result = await runAction(REGISTRY, "set_pane_gates", {
      project_id: "proj", pane_id: "pg-1", capabilityGates: { write_to_pane: "Off" },
    } as Record<string, unknown>, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.deepStrictEqual(pane.capabilityGates, { write_to_pane: "Off" }, "camelCase body aliased to capability_gates");
  });

  it("when BOTH present, the snake key wins (alias only fills when snake is absent)", () => {
    const def = findDef("set_pane_gates");
    assert.ok(def.coerceArgs, "set_pane_gates must declare coerceArgs");
    const out = def.coerceArgs!({ capability_gates: { a: "Off" }, capabilityGates: { b: "Auto" } });
    assert.deepStrictEqual(out.capability_gates, { a: "Off" }, "snake key untouched when present");
    assert.strictEqual((out as Record<string, unknown>).capabilityGates, undefined, "camelCase key consumed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (6) store:null path — recordActivity guarded by if(ctx.store); the mutation/broadcasts still happen.
// ─────────────────────────────────────────────────────────────────────────────
describe("c55.16 — store:null (legacy backend) is guarded", () => {
  it("writes the override + broadcasts even when ctx.store is null (no audit, no throw)", async () => {
    const { workspaces, pane } = seedPane();
    const { ctx, rec } = makeCtx({ workspaces, withStore: false });
    const result = await runAction(REGISTRY, "set_pane_gates", {
      project_id: "proj", pane_id: "pg-1", capability_gates: { write_to_pane: "Off" },
    }, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.deepStrictEqual(pane.capabilityGates, { write_to_pane: "Off" }, "override still written with store:null");
    assert.strictEqual(rec.updatePaneCalls.length, 1, "updatePane still fired");
    assert.strictEqual(rec.ledgerUpdates, 1, "broadcast still fired with store:null");
    assert.strictEqual(rec.activities.length, 0, "no audit recorded when store is null");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// (7) cutover guard — only-set INCLUDES set_pane_gates AND the inline app.put literal is GONE.
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("c55.16 — server.ts cutover guard (no double-registration)", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const serverSrc = readFileSync(path.join(here, "..", "server.ts"), "utf8");
  const mountIdx = serverSrc.indexOf("mountRestRoutes(");
  const onlyOpenIdx = mountIdx >= 0 ? serverSrc.indexOf("only: new Set([", mountIdx) : -1;
  const onlyCloseIdx = onlyOpenIdx >= 0 ? serverSrc.indexOf("])", onlyOpenIdx) : -1;
  const mountBlock = onlyOpenIdx >= 0 && onlyCloseIdx >= 0 ? serverSrc.slice(onlyOpenIdx, onlyCloseIdx + 2) : "";

  it('mountRestRoutes only-set includes "set_pane_gates"', () => {
    assert.ok(mountIdx >= 0, "server.ts must call mountRestRoutes");
    assert.ok(/["']set_pane_gates["']/.test(mountBlock), "only-set must include set_pane_gates after the cutover");
  });

  it("inline PUT /api/projects/:projectId/panes/:paneId/capability-gates is deleted (incl. commented form)", () => {
    const needle = /app\.put\(\s*["']\/api\/projects\/:projectId\/panes\/:paneId\/capability-gates["']/;
    assert.ok(!needle.test(serverSrc), "the inline capability-gates app.put literal must be GONE (prose-only breadcrumb)");
  });
});
