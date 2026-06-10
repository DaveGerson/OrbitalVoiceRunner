// c55 Batch C — rest-only pane/UI ActionDefs contract suite (wsm-e2e-pinned-c55.3).
//
// Five NEW rest-only defs that converge inline pane/UI routes with NO voice twin today:
//   respawn_pane   POST /api/terminals/:pane_id/restart   (GATED via restart_pane capability — behaviorDelta)
//   send_keys      POST /api/terminals/:pane_id/input      (GATED via send_keys capability — c55.10; was ungated)
//   resize_pane    POST /api/terminals/:pane_id/resize      (ALWAYS_ALLOWED; zod rejects bad cols/rows)
//   clear_history  POST /api/terminals/:pane_id/history/clear (ALWAYS_ALLOWED)
//   clear_exited   POST /api/terminals/clear-exited          (ALWAYS_ALLOWED)
//
// DOCTRINE (def-level deterministic): call runAction with a fake ctx + fake manager, assert the
// ActionResult kind/output, then assert resultToHttp maps it to {status,body}. No server boot, no PTY.
// Also pins: each def is rest-only (surfaces === {'rest'}), has its rest binding, respawn_pane routes
// THROUGH ctx.gateOrDefer (gate consulted), resize zod REJECTS non-positive cols/rows, send_keys writes
// input + records command history, clear_history zeroes a pane's history, clear_exited archives.

import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";

import { REGISTRY } from "../src/actions/registry";
import { runAction } from "../src/actions/gemini";
import { resultToHttp, type RestResponse } from "../src/actions/rest";
import type { ActionContext, ActionDef, ActionResult } from "../src/actions/types";
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

interface FakeTerm {
  stopped: number;
  started: number;
  resizedTo: Array<[number, number]>;
  inputs: string[];
  stop: () => Promise<void>;
  start: () => void;
  resize: (c: number, r: number) => void;
  writeInput: (s: string) => void;
}

function makeFakeTerm(): FakeTerm {
  const t: FakeTerm = {
    stopped: 0, started: 0, resizedTo: [], inputs: [],
    stop: async () => { t.stopped++; },
    start: () => { t.started++; },
    resize: (c: number, r: number) => { t.resizedTo.push([c, r]); },
    writeInput: (s: string) => { t.inputs.push(s); },
  };
  return t;
}

interface CtxOpts {
  terminals?: Record<string, FakeTerm>;
  activeProject?: { directory?: string; panes: Record<string, { tool_preset?: string; permissions_mode?: string; session_id?: string; alive?: boolean }> } | null;
  activeProjectId?: string | null;
  gateDisposition?: GateDisposition;
  addTerminal?: (...a: unknown[]) => string;
  archiveExitedPanes?: (id?: string) => number;
}

interface Recorded {
  gateCalls: Array<{ capability: string; paneId: string | null; summary: string; params?: Record<string, unknown> }>;
  ledgerUpdates: number;
  terminalsUpdated: number;
  addTerminalCalls: unknown[][];
  archiveCalls: Array<string | undefined>;
}

function makeCtx(opts: CtxOpts = {}): { ctx: ActionContext; rec: Recorded; manager: any } {
  const rec: Recorded = { gateCalls: [], ledgerUpdates: 0, terminalsUpdated: 0, addTerminalCalls: [], archiveCalls: [] };
  const terminals = opts.terminals ?? {};
  const activeProject = opts.activeProject === undefined ? null : opts.activeProject;
  const manager: any = {
    terminals,
    settings: { presets: undefined, advanced: { defaultShellCommand: "" } },
    // Phase 4: clear_exited now forces a live PTY->ledger sync before reading alive flags
    // (ActionContext manager contract — same fixture completion pattern as isFrozen).
    refreshLedger: () => {},
    addTerminal: (...a: unknown[]): string => {
      rec.addTerminalCalls.push(a);
      return (opts.addTerminal ? opts.addTerminal(...a) : "created");
    },
    resize: (id: string, c: number, r: number) => { terminals[id]?.resize(c, r); },
    ledger: {
      activeProjectId: opts.activeProjectId ?? null,
      getActiveProject: () => activeProject,
      getProject: (id: string) => (id === opts.activeProjectId ? activeProject : null),
      archiveExitedPanes: (id?: string): number => {
        rec.archiveCalls.push(id);
        return opts.archiveExitedPanes ? opts.archiveExitedPanes(id) : 0;
      },
    },
  };
  const ctx = {
    manager,
    session: null,
    redact: (s: string) => s,
    isFrozen: () => false, // 2S.4: ActionContext requires it; clear_history/clear_exited now check the brake.
    broadcast: () => {},
    broadcastLedgerUpdate: () => { rec.ledgerUpdates++; },
    broadcastTerminalsUpdated: () => { rec.terminalsUpdated++; },
    // Mirrors the REAL gateOrDefer (src/gating/index.ts): it STAGES the run closure only on the Ask
    // (deferred) path; on the Auto ("run") path it returns {disposition:"run"} WITHOUT invoking run —
    // the CALLER runs the effect. So the fake must NOT call run() for "run" (the handler does).
    gateOrDefer: (capability: string, paneId: string | null, summary: string, run: () => string, params?: Record<string, unknown>): GateDisposition => {
      rec.gateCalls.push({ capability, paneId, summary, params });
      const d = opts.gateDisposition ?? { disposition: "run" as const };
      void run; // referenced for parity with the real signature; not invoked on the "run" path
      return d;
    },
  } as unknown as ActionContext;
  return { ctx, rec, manager };
}

// Use an isolated cwd so the .janus_history.json file writes don't collide with the repo's. AWAITS the
// fn (the assertions read the file AFTER the awaited runAction completes) before restoring cwd.
async function withTempCwd<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c55-hist-"));
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(prev);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

function readHistoryFile(): Record<string, unknown[]> {
  const fp = path.join(process.cwd(), ".janus_history.json");
  if (!fs.existsSync(fp)) return {};
  return JSON.parse(fs.readFileSync(fp, "utf-8"));
}

// ── registry shape: all five defs present, rest-only, with a rest binding ─────────────────────────
describe("c55 Batch C — registry shape", () => {
  const names = ["respawn_pane", "send_keys", "resize_pane", "clear_history", "clear_exited"];
  for (const name of names) {
    it(`${name} is a rest-only def with a rest binding`, () => {
      const def = findDef(name);
      assert.deepStrictEqual([...def.surfaces].sort(), ["rest"], `${name} surfaces must be exactly {rest}`);
      assert.ok(def.rest, `${name} must declare a rest binding`);
      assert.strictEqual(def.rest!.method, name === "clear_exited" || name === "respawn_pane" || name === "send_keys" || name === "resize_pane" || name === "clear_history" ? "post" : "post");
    });
  }

  it("rest paths match the inline routes they replace", () => {
    assert.strictEqual(findDef("respawn_pane").rest!.path, "/api/terminals/:pane_id/restart");
    assert.strictEqual(findDef("send_keys").rest!.path, "/api/terminals/:pane_id/input");
    assert.strictEqual(findDef("resize_pane").rest!.path, "/api/terminals/:pane_id/resize");
    assert.strictEqual(findDef("clear_history").rest!.path, "/api/terminals/:pane_id/history/clear");
    assert.strictEqual(findDef("clear_exited").rest!.path, "/api/terminals/clear-exited");
  });

  it("gates (c55.10): send_keys is GATED (send_keys); resize_pane/clear_history/clear_exited stay ALWAYS_ALLOWED; respawn_pane enforces", () => {
    // c55.10 tightened send_keys (term.writeInput to the live PTY — a consequential CLI keystroke act)
    // from ALWAYS_ALLOWED to its OWN matrix row `send_keys` (default Ask). resize/clear_history/clear_exited
    // stay ungated per the P2 taxonomy (viewport plumbing / display-buffer clear / reversible archive).
    assert.strictEqual(findDef("send_keys").capability, "send_keys");
    assert.strictEqual(findDef("resize_pane").capability, "ALWAYS_ALLOWED");
    assert.strictEqual(findDef("clear_history").capability, "ALWAYS_ALLOWED");
    assert.strictEqual(findDef("clear_exited").capability, "ALWAYS_ALLOWED");
    // The action is respawn_pane; the CAPABILITY it rides is still named restart_pane (matrix row).
    assert.strictEqual(findDef("respawn_pane").capability, "restart_pane");
  });
});

// ── respawn_pane ─────────────────────────────────────────────────────────────────────────────────
describe("c55 respawn_pane", () => {
  it("live terminal -> gate consulted -> stop()+start(); ok -> 200 {output}", async () => {
    const term = makeFakeTerm();
    const { ctx, rec } = makeCtx({ terminals: { p1: term } });
    const result = await runAction(REGISTRY, "respawn_pane", { pane_id: "p1" }, ctx);
    assert.strictEqual(result.kind, "ok");
    // The gate was consulted with the restart_pane CAPABILITY (the deliberate safety improvement).
    assert.strictEqual(rec.gateCalls.length, 1, "respawn_pane MUST route through ctx.gateOrDefer");
    assert.strictEqual(rec.gateCalls[0].capability, "restart_pane");
    assert.strictEqual(rec.gateCalls[0].paneId, "p1");
    assert.strictEqual(term.stopped, 1, "live pane stopped");
    assert.strictEqual(term.started, 1, "live pane restarted");
    const { res, sent } = makeFakeRes();
    resultToHttp(result, res);
    assert.strictEqual(sent.status, 200);
    assert.ok((sent.json as { output: string }).output);
  });

  it("ledger-only pane (no live term) -> rebuild via addTerminal with presetCommand", async () => {
    const { ctx, rec } = makeCtx({
      activeProjectId: "proj",
      activeProject: { directory: "/tmp/proj", panes: { p2: { tool_preset: "Custom", permissions_mode: "Human-in-the-Loop", session_id: "s2" } } },
    });
    const result = await runAction(REGISTRY, "respawn_pane", { pane_id: "p2" }, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(rec.gateCalls.length, 1, "gate consulted for the ledger-only rebuild too");
    assert.strictEqual(rec.addTerminalCalls.length, 1, "ledger-only pane rebuilt via addTerminal");
    assert.strictEqual(rec.addTerminalCalls[0][0], "p2", "rebuilt the right pane id");
  });

  it("Off gate -> blocked -> 403 {error}; no restart side effect", async () => {
    const term = makeFakeTerm();
    const { ctx } = makeCtx({ terminals: { p1: term }, gateDisposition: { disposition: "forbidden" } });
    const result = await runAction(REGISTRY, "respawn_pane", { pane_id: "p1" }, ctx);
    assert.strictEqual(result.kind, "blocked");
    assert.strictEqual(term.stopped, 0, "forbidden restart performs NO stop");
    assert.strictEqual(term.started, 0, "forbidden restart performs NO start");
    const { res, sent } = makeFakeRes();
    resultToHttp(result, res);
    assert.strictEqual(sent.status, 403);
    assert.ok((sent.json as { error: string }).error);
  });

  it("Ask gate -> pending -> 202 {status:'pending_approval'}; effect deferred (not run)", async () => {
    const term = makeFakeTerm();
    const { ctx } = makeCtx({
      terminals: { p1: term },
      gateDisposition: { disposition: "deferred", actionId: "act_1", summary: "Restart pane p1" },
    });
    const result = await runAction(REGISTRY, "respawn_pane", { pane_id: "p1" }, ctx);
    assert.strictEqual(result.kind, "pending");
    assert.strictEqual(term.stopped, 0, "deferred restart does NOT run the stop yet");
    const { res, sent } = makeFakeRes();
    resultToHttp(result, res);
    assert.strictEqual(sent.status, 202);
    assert.deepStrictEqual(sent.json, { status: "pending_approval", messageId: "act_1" });
  });

  it("unknown pane (no live term, not in active project) -> ok narration -> 200 (404->200 delta)", async () => {
    const { ctx, rec } = makeCtx({ activeProjectId: "proj", activeProject: { panes: {} } });
    const result = await runAction(REGISTRY, "respawn_pane", { pane_id: "ghost" }, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(rec.addTerminalCalls.length, 0, "no rebuild for an unknown pane");
    const { res, sent } = makeFakeRes();
    resultToHttp(result, res);
    assert.strictEqual(sent.status, 200);
  });
});

// ── send_keys ─────────────────────────────────────────────────────────────────────────────────────
describe("c55 send_keys", () => {
  it("writes input + records command history; ok -> 200 {output}", async () => {
    await withTempCwd(async () => {
      const term = makeFakeTerm();
      const { ctx } = makeCtx({ terminals: { p1: term } });
      const result = await runAction(REGISTRY, "send_keys", { pane_id: "p1", command: "git status" }, ctx);
      assert.strictEqual(result.kind, "ok");
      assert.deepStrictEqual(term.inputs, ["git status"], "command written to the pane PTY");
      const hist = readHistoryFile();
      assert.ok(Array.isArray(hist["p1"]) && hist["p1"].length === 1, "command recorded in pane history");
      assert.strictEqual((hist["p1"][0] as { command: string }).command, "git status");
      const { res, sent } = makeFakeRes();
      resultToHttp(result, res);
      assert.strictEqual(sent.status, 200);
    });
  });

  it("unknown pane -> ok narration -> 200 (404->200 delta); no history written", async () => {
    await withTempCwd(async () => {
      const { ctx } = makeCtx({ terminals: {} });
      const result = await runAction(REGISTRY, "send_keys", { pane_id: "ghost", command: "ls" }, ctx);
      assert.strictEqual(result.kind, "ok");
      const hist = readHistoryFile();
      assert.ok(!hist["ghost"], "no history written for an unknown pane");
    });
  });

  it("missing command -> zod rejects -> 500/error (replaces inline 400)", async () => {
    const term = makeFakeTerm();
    const { ctx } = makeCtx({ terminals: { p1: term } });
    const result = await runAction(REGISTRY, "send_keys", { pane_id: "p1" }, ctx);
    assert.strictEqual(result.kind, "error", "missing required command is a zod rejection");
    assert.strictEqual(term.inputs.length, 0, "nothing written on a rejected request");
  });
});

// ── resize_pane ────────────────────────────────────────────────────────────────────────────────────
describe("c55 resize_pane", () => {
  it("valid cols/rows -> manager.resize; ok -> 200 {output}", async () => {
    const term = makeFakeTerm();
    const { ctx } = makeCtx({ terminals: { p1: term } });
    const result = await runAction(REGISTRY, "resize_pane", { pane_id: "p1", cols: 120, rows: 40 }, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.deepStrictEqual(term.resizedTo, [[120, 40]], "pane resized to the requested grid");
    const { res, sent } = makeFakeRes();
    resultToHttp(result, res);
    assert.strictEqual(sent.status, 200);
  });

  for (const bad of [
    { cols: 0, rows: 40 },
    { cols: 120, rows: 0 },
    { cols: -1, rows: 40 },
    { cols: 120, rows: -5 },
    { cols: 1.5, rows: 40 },
  ]) {
    it(`rejects non-positive-int cols/rows ${JSON.stringify(bad)} -> error (no resize)`, async () => {
      const term = makeFakeTerm();
      const { ctx } = makeCtx({ terminals: { p1: term } });
      const result = await runAction(REGISTRY, "resize_pane", { pane_id: "p1", ...bad }, ctx);
      assert.strictEqual(result.kind, "error", "bad cols/rows must be a zod rejection");
      assert.strictEqual(term.resizedTo.length, 0, "no resize on a rejected request");
    });
  }
});

// ── clear_history ──────────────────────────────────────────────────────────────────────────────────
describe("c55 clear_history", () => {
  it("zeroes a pane's history; ok -> 200 {output}", async () => {
    await withTempCwd(async () => {
      // Seed a history file with two entries for p1.
      const fp = path.join(process.cwd(), ".janus_history.json");
      fs.writeFileSync(fp, JSON.stringify({ p1: [{ command: "a", timestamp: "t", output: "" }, { command: "b", timestamp: "t", output: "" }], p2: [{ command: "x", timestamp: "t", output: "" }] }), "utf-8");
      const { ctx } = makeCtx({ terminals: {} });
      const result = await runAction(REGISTRY, "clear_history", { pane_id: "p1" }, ctx);
      assert.strictEqual(result.kind, "ok");
      const hist = readHistoryFile();
      assert.deepStrictEqual(hist["p1"], [], "p1 history cleared");
      assert.ok(Array.isArray(hist["p2"]) && hist["p2"].length === 1, "sibling pane history untouched");
      const { res, sent } = makeFakeRes();
      resultToHttp(result, res);
      assert.strictEqual(sent.status, 200);
    });
  });
});

// ── clear_exited ───────────────────────────────────────────────────────────────────────────────────
describe("c55 clear_exited", () => {
  it("archives exited panes on the active project; ok -> 200 {output}", async () => {
    const exitedTerm = makeFakeTerm();
    const { ctx, rec } = makeCtx({
      activeProjectId: "proj",
      activeProject: { panes: { dead: { alive: false } }, directory: "/tmp" } as any,
      terminals: { dead: exitedTerm },
      archiveExitedPanes: () => 1,
    });
    const result = await runAction(REGISTRY, "clear_exited", {}, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(rec.archiveCalls.length, 1, "archiveExitedPanes called on the active project");
    assert.strictEqual(rec.terminalsUpdated, 1, "broadcasts terminals_updated");
    assert.strictEqual(rec.ledgerUpdates, 1, "broadcasts ledger update");
    const { res, sent } = makeFakeRes();
    resultToHttp(result, res);
    assert.strictEqual(sent.status, 200);
  });
});
