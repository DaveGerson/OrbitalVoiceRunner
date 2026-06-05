/**
 * tests/test_c55_batch_f.ts — c55 Batch F (wsm-e2e-pinned-c55.6): hard structured page-load reads.
 *
 * Batch F converges the three structured page-load READS whose bodies the flat `{output:string}`
 * cannot carry. Each rides the Batch-E `rest.toHttp` primitive so the def emits its bespoke
 * structured body TOP-LEVEL (not wrapped in `{output}`). The HIGHEST blast radius is list_panes: the
 * UI's setTerminals() needs the FLAT per-pane array, byte-identical-or-intended-superset of the
 * legacy inline GET /api/terminals body, field by field.
 *
 *   list_panes            GET /api/terminals               — flat rich per-pane array (toHttp top-level).
 *                         The VOICE surface still narrates the project/pane TREE (surface-aware handler);
 *                         only the REST surface builds the flat array.
 *   get_stop_all_status   GET /api/stop-all/status         — NEW readOnly ALWAYS_ALLOWED rest-only def.
 *                         Boot-restore snapshot {frozen, running}; running = runningPaneIds() iff frozen.
 *   get_terminal_history  GET /api/terminals/:pane_id/history — NEW rest-only def; RAW HistoryManager
 *                         array (NOT the concise/redacted get_pane_command_history prose).
 *
 * DOCTRINE (def-level deterministic): call runAction with a fake ctx, assert the ActionResult kind +
 * output, then assert applyResultToHttp (the seam mountRestRoutes routes through, which honours
 * def.rest.toHttp) maps it to the expected {status, body}. The list_panes assertion captures the
 * legacy inline GET /api/terminals body builder (reproduced here from server.ts:558-582) and asserts
 * the new REST body is field-for-field identical.
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { REGISTRY } from "../src/actions/registry";
import { runAction, resultToToolResponse } from "../src/actions/gemini";
import {
  applyResultToHttp,
  mountRestRoutes,
  type RestApp,
  type RestHandler,
  type RestRequest,
  type RestResponse,
} from "../src/actions/rest";
import { INTENTIONAL_ASYMMETRY } from "../src/actions/coverage";
import type { ActionContext, ActionDef, ActionResult } from "../src/actions/types";

// ── fakes ─────────────────────────────────────────────────────────────────────────────────────────
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

/** Run an action through the real choke-point, then map to HTTP exactly as the REST seam does (via
 *  applyResultToHttp, which honours def.rest.toHttp — NOT the bare resultToHttp default map). */
async function runToHttp(
  name: string,
  rawArgs: Record<string, unknown>,
  ctx: ActionContext,
): Promise<{ result: ActionResult; status?: number; json?: unknown }> {
  const def = findDef(name);
  const result = await runAction(REGISTRY, name, rawArgs, ctx);
  const { res, sent } = makeFakeRes();
  applyResultToHttp(def, result, rawArgs, res);
  return { result, status: sent.status, json: sent.json };
}

// A fake UniversalTerminal that mirrors the fields the legacy inline builder reads.
function makeTerm(id: string, over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    cwd: `/work/${id}`,
    shellCmd: `cmd-${id}`,
    status: "Running",
    permissionsMode: "Human-in-the-Loop",
    toolPreset: "Claude Code",
    sessionId: `sess-${id}`,
    contextSize: 1234,
    getRawBackfill: () => `RAW-BACKFILL-${id}[0m`,
    getRecentOutput: (n: number) => `stripped-output-${id}-last${n}`,
    ...over,
  };
}

interface CtxOpts {
  terminals?: Record<string, Record<string, unknown>>;
  surface?: "voice" | "rest";
  frozen?: boolean;
  running?: string[];
  // posture per pane: { effective_gates, posture }.
  posture?: (id: string) => { effective_gates: Record<string, string>; posture: string };
  treeSentinel?: unknown;
  historyMaxCommands?: number;
}

function makeCtx(opts: CtxOpts = {}): ActionContext {
  const terminals = opts.terminals ?? {};
  const posture = opts.posture ?? ((id: string) => ({
    effective_gates: { read_pane: "Auto", write_to_pane: "Ask" },
    posture: `posture-${id}`,
  }));
  const manager: any = {
    terminals,
    settings: { advanced: { historyMaxCommands: opts.historyMaxCommands ?? 50 } },
    // The voice TREE narration source — a sentinel so we can assert the REST surface does NOT use it.
    listPanes: () => opts.treeSentinel ?? { tree: true, projects: Object.keys(terminals) },
  };
  const ctx = {
    manager,
    session: null,
    surface: opts.surface ?? "rest",
    callId: "call-f",
    redact: (s: string) => s,
    broadcast: () => {},
    broadcastLedgerUpdate: () => {},
    isFrozen: () => opts.frozen ?? false,
    runningPaneIds: () => opts.running ?? Object.keys(terminals),
    posturePayloadForPane: (id: string) => ({ id, ...posture(id) }),
    // unused by Batch-F reads but referenced by runAction redaction etc.
    effectiveCapabilityGateFor: () => "Auto",
  } as unknown as ActionContext;
  return ctx;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// list_panes — flat REST array (toHttp top-level) vs legacy inline GET /api/terminals body
// ════════════════════════════════════════════════════════════════════════════════════════════════

// FIDELITY REFERENCE: the legacy inline builder (server.ts GET /api/terminals, captured pre-cutover).
// Reproduced here so the test fails loudly if the converged body diverges field-for-field.
function legacyTerminalsBody(
  terminals: Record<string, Record<string, unknown>>,
  posture: (id: string) => { effective_gates: Record<string, string>; posture: string },
): unknown[] {
  return Object.keys(terminals).map((id) => {
    const term = terminals[id];
    const p = posture(id);
    return {
      id,
      cwd: term.cwd,
      command: term.shellCmd,
      backfill: (term.getRawBackfill as () => string)(),
      output: (term.getRecentOutput as (n: number) => string)(20),
      status: term.status,
      // Concurrent multi-cli merge added the "cooking…" overlay flag (term.quiescing || undefined) to the
      // inline GET /api/terminals body; the converged list_panes builder carries it field-identically.
      quiescing: term.quiescing || undefined,
      permissions_mode: term.permissionsMode,
      tool_preset: term.toolPreset,
      session_id: term.sessionId,
      context_size: term.contextSize,
      effective_gates: p.effective_gates,
      posture: p.posture,
    };
  });
}

describe("c55 Batch F — list_panes flat REST array", () => {
  it("stays voice+rest (NOT rest-only — voice narrates the tree) and binds GET /api/terminals", () => {
    const def = findDef("list_panes");
    assert.ok(def.surfaces.has("voice"), "list_panes must keep the voice surface (tree narration)");
    assert.ok(def.surfaces.has("rest"), "list_panes must keep the rest surface (GET /api/terminals)");
    assert.deepStrictEqual(def.rest?.method, "get");
    assert.deepStrictEqual(def.rest?.path, "/api/terminals");
    assert.ok(typeof def.rest?.toHttp === "function", "list_panes must declare a rest.toHttp translator");
  });

  it("REST surface: toHttp emits the FLAT per-pane array TOP-LEVEL (not wrapped in {output})", async () => {
    const postureFn = (id: string) => ({
      effective_gates: { read_pane: "Auto", write_to_pane: "Off", create_pane: "Ask" },
      posture: `P-${id}`,
    });
    const terminals = { p1: makeTerm("p1"), p2: makeTerm("p2", { status: "Exited", contextSize: 0 }) };
    const ctx = makeCtx({ terminals, surface: "rest", posture: postureFn });

    const { result, status, json } = await runToHttp("list_panes", {}, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(status, 200, "page-load read is HTTP 200");

    // The body is the bare array (top-level), NOT { output: [...] }.
    assert.ok(Array.isArray(json), "REST body must be the flat array TOP-LEVEL, not wrapped in {output}");

    // FIELD-FOR-FIELD parity with the captured legacy inline body.
    const legacy = legacyTerminalsBody(terminals, postureFn);
    assert.deepStrictEqual(json, legacy, "converged GET /api/terminals body must be byte-identical to the legacy inline body");
  });

  it("REST flat array carries every UI-load field (backfill, output, effective_gates, posture, context_size)", async () => {
    const terminals = { only: makeTerm("only") };
    const ctx = makeCtx({ terminals, surface: "rest" });
    const { json } = await runToHttp("list_panes", {}, ctx);
    const row = (json as Array<Record<string, unknown>>)[0];
    for (const key of [
      "id", "cwd", "command", "backfill", "output", "status",
      "permissions_mode", "tool_preset", "session_id", "context_size",
      "effective_gates", "posture",
    ]) {
      assert.ok(key in row, `flat pane row must carry '${key}' for setTerminals()`);
    }
    assert.strictEqual(row.backfill, "RAW-BACKFILL-only[0m", "backfill is RAW ANSI (xterm renders it)");
    assert.strictEqual(row.output, "stripped-output-only-last20", "output is the ANSI-stripped tail (getRecentOutput(20))");
  });

  it("VOICE surface narrates the project/pane TREE (NOT the flat array) — surface-aware handler", async () => {
    const treeSentinel = { tree: "VOICE-TREE", projects: ["a"] };
    const ctx = makeCtx({ terminals: { p1: makeTerm("p1") }, surface: "voice", treeSentinel });
    const result = await runAction(REGISTRY, "list_panes", {}, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.deepStrictEqual((result as { output: unknown }).output, treeSentinel,
      "voice list_panes must return the manager.listPanes() tree, untouched");
  });

  it("voice projection narrates the tree output (resultToToolResponse reads result.output, never toHttp)", async () => {
    const treeSentinel = { tree: "VOICE-TREE-2" };
    const ctx = makeCtx({ terminals: { p1: makeTerm("p1") }, surface: "voice", treeSentinel });
    const result = await runAction(REGISTRY, "list_panes", {}, ctx);
    let spoken: any;
    const session = { sendToolResponse: (p: any) => { spoken = p.functionResponses[0].response; } };
    resultToToolResponse(result, session as any, "list_panes", "cid-tree");
    assert.deepStrictEqual(spoken.output, treeSentinel, "voice speaks the tree (result.output), bypassing toHttp");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// get_stop_all_status — NEW readOnly ALWAYS_ALLOWED rest-only boot-restore snapshot
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("c55 Batch F — get_stop_all_status (boot-restore snapshot)", () => {
  it("is a NEW ALWAYS_ALLOWED rest-only def binding GET /api/stop-all/status", () => {
    const def = findDef("get_stop_all_status");
    assert.strictEqual(def.capability, "ALWAYS_ALLOWED", "the brake-status read is never gated (readable even while frozen)");
    // readOnly:false — the §8.1 invariant binds readOnly only to read_pane/read_notes; the {frozen,
    // running} body carries pane ids only (no secrets), so no egress redaction is lost.
    assert.strictEqual(def.readOnly, false);
    assert.deepStrictEqual([...def.surfaces], ["rest"], "rest-only (pure-UI boot snapshot, no voice tool)");
    assert.deepStrictEqual(def.rest?.method, "get");
    assert.deepStrictEqual(def.rest?.path, "/api/stop-all/status");
    assert.ok(typeof def.rest?.toHttp === "function", "must declare a rest.toHttp translator emitting {frozen,running}");
    assert.deepStrictEqual(INTENTIONAL_ASYMMETRY["get_stop_all_status"], new Set(["rest"]),
      "rest-only def must be allow-listed in INTENTIONAL_ASYMMETRY");
  });

  it("NOT frozen -> { frozen:false, running:[] } at HTTP 200", async () => {
    const ctx = makeCtx({ frozen: false, running: ["p1", "p2"] });
    const { result, status, json } = await runToHttp("get_stop_all_status", {}, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(json, { frozen: false, running: [] }, "running is EMPTY unless frozen (mirrors the inline guard)");
  });

  it("frozen -> { frozen:true, running:[...] } from runningPaneIds() at HTTP 200", async () => {
    const ctx = makeCtx({ frozen: true, running: ["alpha", "beta"] });
    const { status, json } = await runToHttp("get_stop_all_status", {}, ctx);
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(json, { frozen: true, running: ["alpha", "beta"] }, "frozen lists the still-running panes");
  });

  it("toHttp emits {frozen,running} TOP-LEVEL, not wrapped in {output}", async () => {
    const ctx = makeCtx({ frozen: true, running: ["x"] });
    const { json } = await runToHttp("get_stop_all_status", {}, ctx);
    assert.ok(json && typeof json === "object" && !Array.isArray(json));
    assert.deepStrictEqual(Object.keys(json as object).sort(), ["frozen", "running"]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// get_terminal_history — NEW rest-only def; RAW HistoryManager array
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("c55 Batch F — get_terminal_history (raw history array)", () => {
  it("is a NEW rest-only def binding GET /api/terminals/:pane_id/history", () => {
    const def = findDef("get_terminal_history");
    assert.deepStrictEqual([...def.surfaces], ["rest"], "rest-only (the voice get_pane_command_history emits PROSE)");
    assert.strictEqual(def.readOnly, true);
    assert.deepStrictEqual(def.rest?.method, "get");
    assert.deepStrictEqual(def.rest?.path, "/api/terminals/:pane_id/history");
    assert.ok(typeof def.rest?.toHttp === "function", "must declare a rest.toHttp translator emitting the raw array");
    assert.deepStrictEqual(INTENTIONAL_ASYMMETRY["get_terminal_history"], new Set(["rest"]),
      "rest-only def must be allow-listed in INTENTIONAL_ASYMMETRY");
  });

  it("returns the RAW history array (full output, no concise/redacted mapping) TOP-LEVEL at 200", async () => {
    // Seed the SAME .janus_history.json the inline route's HistoryManager.loadHistory(id) reads.
    const filePath = path.join(process.cwd(), ".janus_history.json");
    const existed = existsSync(filePath);
    const backup = existed ? readFileSync(filePath, "utf-8") : null;
    const rawEntries = [
      { command: "npm test", timestamp: "2026-06-05T00:00:00Z", output: "RAW [31moutput[0m with ansi", finalResponse: "all green" },
      { command: "git status", timestamp: "2026-06-05T00:01:00Z", output: "clean" },
    ];
    try {
      writeFileSync(filePath, JSON.stringify({ "pane-h": rawEntries, "other": [{ command: "x", timestamp: "t", output: "y" }] }), "utf-8");
      const ctx = makeCtx({ terminals: { "pane-h": makeTerm("pane-h") } });
      const { result, status, json } = await runToHttp("get_terminal_history", { pane_id: "pane-h" }, ctx);
      assert.strictEqual(result.kind, "ok");
      assert.strictEqual(status, 200);
      assert.ok(Array.isArray(json), "history body is the raw array TOP-LEVEL");
      assert.deepStrictEqual(json, rawEntries, "RAW entries (full ANSI output preserved, NOT stripped/redacted/concise)");
    } finally {
      if (backup !== null) writeFileSync(filePath, backup, "utf-8");
      else if (existsSync(filePath)) rmSync(filePath);
    }
  });

  it("unknown pane -> empty array (loadHistory returns [] for a missing key)", async () => {
    const filePath = path.join(process.cwd(), ".janus_history.json");
    const existed = existsSync(filePath);
    const backup = existed ? readFileSync(filePath, "utf-8") : null;
    try {
      writeFileSync(filePath, JSON.stringify({ known: [{ command: "a", timestamp: "t", output: "o" }] }), "utf-8");
      const ctx = makeCtx();
      const { status, json } = await runToHttp("get_terminal_history", { pane_id: "nope" }, ctx);
      assert.strictEqual(status, 200);
      assert.deepStrictEqual(json, [], "missing key -> []");
    } finally {
      if (backup !== null) writeFileSync(filePath, backup, "utf-8");
      else if (existsSync(filePath)) rmSync(filePath);
    }
  });

  it("the :pane_id route segment reaches the handler through mountRestRoutes", async () => {
    let captured: { path: string; handler: RestHandler } | undefined;
    const fakeApp = {
      get: (p: string, h: RestHandler) => { captured = { path: p, handler: h }; },
      post: () => {}, put: () => {}, delete: () => {},
    } as unknown as RestApp;
    const filePath = path.join(process.cwd(), ".janus_history.json");
    const existed = existsSync(filePath);
    const backup = existed ? readFileSync(filePath, "utf-8") : null;
    try {
      writeFileSync(filePath, JSON.stringify({ "seg-pane": [{ command: "c", timestamp: "t", output: "o" }] }), "utf-8");
      const ctx = makeCtx();
      mountRestRoutes(fakeApp, REGISTRY, () => ctx, { only: new Set(["get_terminal_history"]) });
      assert.ok(captured, "mountRestRoutes must register get_terminal_history");
      assert.strictEqual(captured!.path, "/api/terminals/:pane_id/history");
      const { res, sent } = makeFakeRes();
      await captured!.handler({ params: { pane_id: "seg-pane" } }, res);
      assert.strictEqual(sent.status, 200);
      assert.deepStrictEqual(sent.json, [{ command: "c", timestamp: "t", output: "o" }], "the :pane_id segment reached loadHistory");
    } finally {
      if (backup !== null) writeFileSync(filePath, backup, "utf-8");
      else if (existsSync(filePath)) rmSync(filePath);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// cutover guard — server.ts inline GET routes deleted + names added to the only-set
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("c55 Batch F — server.ts cutover guard (no double-registration)", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const serverSrc = readFileSync(path.join(here, "..", "server.ts"), "utf8");

  const mountIdx = serverSrc.indexOf("mountRestRoutes(");
  const onlyOpenIdx = mountIdx >= 0 ? serverSrc.indexOf("only: new Set([", mountIdx) : -1;
  const onlyCloseIdx = onlyOpenIdx >= 0 ? serverSrc.indexOf("])", onlyOpenIdx) : -1;
  const mountBlock = onlyOpenIdx >= 0 && onlyCloseIdx >= 0 ? serverSrc.slice(onlyOpenIdx, onlyCloseIdx + 2) : "";

  for (const name of ["list_panes", "get_stop_all_status", "get_terminal_history"]) {
    it(`mountRestRoutes only-set includes "${name}"`, () => {
      assert.ok(mountIdx >= 0, "server.ts must call mountRestRoutes");
      assert.ok(new RegExp(`["']${name}["']`).test(mountBlock), `only-set must include "${name}" after the Batch-F cutover`);
    });
  }

  // The CONVERGED inline GET route literals must be GONE (double-registration silently masks the cutover).
  const goneLiterals: Array<{ label: string; needle: RegExp }> = [
    { label: "GET /api/terminals", needle: /app\.get\(\s*["']\/api\/terminals["']/ },
    { label: "GET /api/stop-all/status", needle: /app\.get\(\s*["']\/api\/stop-all\/status["']/ },
    { label: "GET /api/terminals/:id/history", needle: /app\.get\(\s*["']\/api\/terminals\/:id\/history["']/ },
  ];
  for (const { label, needle } of goneLiterals) {
    it(`inline route is deleted: ${label}`, () => {
      assert.ok(!needle.test(serverSrc), `inline ${label} must be deleted (converged to the registry)`);
    });
  }
});
