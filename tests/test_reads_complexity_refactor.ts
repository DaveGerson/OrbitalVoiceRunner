// tests/test_reads_complexity_refactor.ts — CHARACTERIZATION tests for the cyclomatic-complexity
// burndown refactor of src/actions/defs/reads.ts. These pin the CURRENT observable outputs of the
// two over-limit handlers so the behaviour-preserving refactor (extracting the shared bridge-first /
// file-fallback history loader) changes NO gate decision, slice/redaction shape, or output.
//
//   - getPaneCommandHistory.handler (CC13): Off-veto (read_pane), bridge-first load + maxCmds slice,
//     file fallback, and the CONCISE per-entry mapping (finalResponse || redact(strip(output).slice
//     (-300).trim()) || "No output captured.").
//   - getTerminalHistory.handler    (CC11): the SAME bridge-first / file-fallback load + slice, but
//     the RAW (verbatim, unmapped) entry array.
//
// Written GREEN against the UNREFACTORED code FIRST (D-6), then kept green. Uses a registered fake
// HistoryBridge to avoid the filesystem (the bridge-first production path). PURE otherwise.
//
// Runner: npx tsx --test --test-force-exit tests/test_reads_complexity_refactor.ts

import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { getPaneCommandHistory, getTerminalHistory } from "../src/actions/defs/reads";
import type { ActionContext, ActionResult } from "../src/actions/types";
import { registerHistoryBridge, type HistoryBridgeEntry } from "../src/historyBridge";

afterEach(() => registerHistoryBridge(null));

interface CtxOpts {
  gate?: string;
  frozen?: boolean;
  maxCmds?: number;
  redact?: (s: string) => string;
}

function makeCtx(opts: CtxOpts = {}): ActionContext {
  return {
    manager: {
      settings: { advanced: { historyMaxCommands: opts.maxCmds } },
    } as unknown as ActionContext["manager"],
    effectiveCapabilityGateFor: () => (opts.gate ?? "Auto") as never,
    isFrozen: () => opts.frozen ?? false,
    redact: opts.redact ?? ((s) => s),
  } as unknown as ActionContext;
}

function fakeBridge(byPane: Record<string, HistoryBridgeEntry[]>) {
  registerHistoryBridge({
    loadHistory: (id: string) => byPane[id] ?? [],
    addCommand: () => {},
    clearHistory: () => {},
  });
}

async function run(
  def: { handler: (a: never, c: ActionContext) => Promise<ActionResult> | ActionResult },
  args: unknown,
  ctx: ActionContext,
): Promise<ActionResult> {
  return await def.handler(args as never, ctx);
}

// ═════════════════════════════════════════════════════════════════════════════
// get_pane_command_history (CC13)
// ═════════════════════════════════════════════════════════════════════════════
describe("reads refactor — getPaneCommandHistory.handler", () => {
  it("read_pane Off (not frozen) -> forbidden string", async () => {
    const ctx = makeCtx({ gate: "Off", frozen: false });
    const r = await run(getPaneCommandHistory, { pane_id: "p1" }, ctx);
    assert.deepStrictEqual(r, { kind: "ok", output: "Error: the 'read_pane' capability is gated Off; reading pane content is forbidden by policy." });
  });

  it("read_pane Off but FROZEN -> reads stay available (no forbidden)", async () => {
    fakeBridge({ p1: [{ command: "ls", timestamp: "t", output: "out", finalResponse: "ok" }] });
    const ctx = makeCtx({ gate: "Off", frozen: true });
    const r = await run(getPaneCommandHistory, { pane_id: "p1" }, ctx) as { kind: "ok"; output: any };
    assert.strictEqual(r.kind, "ok");
    assert.ok(Array.isArray(r.output));
    assert.strictEqual(r.output[0].finalResponse, "ok");
  });

  it("bridge entries -> concise mapping uses finalResponse when present", async () => {
    fakeBridge({ p1: [{ command: "build", timestamp: "ts1", output: "raw output", finalResponse: "built" }] });
    const ctx = makeCtx({});
    const r = await run(getPaneCommandHistory, { pane_id: "p1" }, ctx) as { kind: "ok"; output: any };
    assert.deepStrictEqual(r.output, [{ command: "build", timestamp: "ts1", finalResponse: "built" }]);
  });

  it("no finalResponse -> raw output stripped/sliced/trimmed/redacted fallback", async () => {
    fakeBridge({ p1: [{ command: "echo", timestamp: "ts2", output: "  hello world  " }] });
    const ctx = makeCtx({});
    const r = await run(getPaneCommandHistory, { pane_id: "p1" }, ctx) as { kind: "ok"; output: any };
    assert.strictEqual(r.output[0].finalResponse, "hello world");
  });

  it("no finalResponse + empty output -> 'No output captured.'", async () => {
    fakeBridge({ p1: [{ command: "noop", timestamp: "ts3", output: "   " }] });
    const ctx = makeCtx({});
    const r = await run(getPaneCommandHistory, { pane_id: "p1" }, ctx) as { kind: "ok"; output: any };
    assert.strictEqual(r.output[0].finalResponse, "No output captured.");
  });

  it("maxCmds slice (default 50) -> only last N entries", async () => {
    const entries: HistoryBridgeEntry[] = Array.from({ length: 5 }, (_, i) => ({ command: `c${i}`, timestamp: "t", output: "", finalResponse: `r${i}` }));
    fakeBridge({ p1: entries });
    const ctx = makeCtx({ maxCmds: 2 });
    const r = await run(getPaneCommandHistory, { pane_id: "p1" }, ctx) as { kind: "ok"; output: any };
    assert.deepStrictEqual(r.output.map((e: any) => e.command), ["c3", "c4"]);
  });

  it("unknown pane via bridge -> empty array (no error)", async () => {
    fakeBridge({});
    const ctx = makeCtx({});
    const r = await run(getPaneCommandHistory, { pane_id: "ghost" }, ctx) as { kind: "ok"; output: any };
    assert.deepStrictEqual(r.output, []);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// get_terminal_history (CC11) — RAW array
// ═════════════════════════════════════════════════════════════════════════════
describe("reads refactor — getTerminalHistory.handler", () => {
  it("bridge entries -> RAW verbatim array (no concise mapping)", async () => {
    const entries: HistoryBridgeEntry[] = [{ command: "x", timestamp: "t", output: "RAW OUTPUT", finalResponse: "fr" }];
    fakeBridge({ p1: entries });
    const ctx = makeCtx({});
    const r = await run(getTerminalHistory, { pane_id: "p1" }, ctx) as { kind: "ok"; output: any };
    assert.deepStrictEqual(r.output, [{ command: "x", timestamp: "t", output: "RAW OUTPUT", finalResponse: "fr" }]);
  });

  it("maxCmds slice applies to the raw array", async () => {
    const entries: HistoryBridgeEntry[] = Array.from({ length: 4 }, (_, i) => ({ command: `c${i}`, timestamp: "t", output: "o" }));
    fakeBridge({ p1: entries });
    const ctx = makeCtx({ maxCmds: 1 });
    const r = await run(getTerminalHistory, { pane_id: "p1" }, ctx) as { kind: "ok"; output: any };
    assert.deepStrictEqual(r.output.map((e: any) => e.command), ["c3"]);
  });

  it("unknown pane -> empty array", async () => {
    fakeBridge({});
    const ctx = makeCtx({});
    const r = await run(getTerminalHistory, { pane_id: "ghost" }, ctx) as { kind: "ok"; output: any };
    assert.deepStrictEqual(r.output, []);
  });
});
