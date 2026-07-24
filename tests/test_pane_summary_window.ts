// tests/test_pane_summary_window.ts — BUG-030(a): get_pane_summary windowing (limit + offset).
//
// REQUIRED post-fix behavior this suite pins:
//   1. UniversalTerminal.getRecentOutput(linesCount, offset) honors an `offset` (lines back from
//      the tail): offset>0 returns an OLDER window of `linesCount` lines, not the same tail.
//   2. OrchestratorManager.getPaneSummary(paneId, limit, offset) threads the offset through to
//      getRecentOutput; output stays ANSI-stripped + secret-redacted + fenced.
//   3. The get_pane_summary ActionDef's zod schema accepts optional `limit` (int 1..500) and
//      `offset` (int >=0), retains them on parse, and REJECTS out-of-range values.
//   4. The get_pane_summary handler threads args.limit / args.offset into manager.getPaneSummary.
//
// RED today (all BEHAVIORAL — no missing imports; the file compiles + repo tsc stays green):
//   - getRecentOutput ignores its 2nd arg (`slice(-linesCount)`), so an offset window == the tail.
//   - getPaneSummary ignores a 3rd arg, so a windowed summary == the last-20 tail.
//   - The schema is PaneIdParams (z.object({pane_id})): it STRIPS limit/offset and validates neither.
//   - The handler calls manager.getPaneSummary(args.pane_id) with no count/offset.
//
// Runner: npx tsx --test --test-force-exit tests/test_pane_summary_window.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import { UniversalTerminal, OrchestratorManager } from "../src/terminal";
import { JanusStore } from "../src/store/sqliteStore";
import { getPaneSummary as getPaneSummaryDef } from "../src/actions/defs/reads";

// Push clean lines straight into the model-lane buffer the way onData does (no real PTY).
function feed(term: any, lines: string[]) {
  term.outputBuffer.push(...lines);
  if (term.outputBuffer.length > term.maxBufferLines) {
    term.outputBuffer.splice(0, term.outputBuffer.length - term.maxBufferLines);
  }
  term.totalLines += lines.length;
}

// 60 uniquely-numbered, zero-padded lines: "line-001".."line-060". Padding keeps "line-021"
// from being a substring of any other line (so includes()/indexOf assertions are exact).
function sixtyLines(): string[] {
  return Array.from({ length: 60 }, (_, i) => `line-${String(i + 1).padStart(3, "0")}`);
}

describe("BUG-030(a): UniversalTerminal.getRecentOutput honors offset (older window)", () => {
  it("offset=0 returns the tail (backward-compatible with the current slice(-limit))", () => {
    const t: any = new UniversalTerminal("sumwin-t0", ".", "shell");
    feed(t, sixtyLines());
    const tail = t.getRecentOutput(20, 0).split("\n");
    assert.strictEqual(tail.length, 20, "limit=20 returns 20 lines");
    assert.strictEqual(tail[0], "line-041");
    assert.strictEqual(tail[19], "line-060");
  });

  it("offset=20 returns the 20-line window JUST BEFORE the tail (older output)", () => {
    const t: any = new UniversalTerminal("sumwin-t1", ".", "shell");
    feed(t, sixtyLines());
    const older = t.getRecentOutput(20, 20).split("\n");
    assert.strictEqual(older.length, 20, "still a 20-line window, one page back");
    assert.strictEqual(older[0], "line-021", "window starts 40 lines back from the tail");
    assert.strictEqual(older[19], "line-040", "window ends 20 lines back from the tail");
    assert.ok(!older.includes("line-060"), "the older window must NOT contain the newest line");
  });
});

describe("BUG-030(a): OrchestratorManager.getPaneSummary threads offset", () => {
  function setup() {
    const store = new JanusStore(":memory:");
    store.init();
    const m: any = new OrchestratorManager({ ledger: store });
    const t: any = new UniversalTerminal("sumwin-m", ".", "shell");
    m.terminals["sumwin-m"] = t;
    feed(t, sixtyLines());
    return m;
  }

  it("limit=20 offset=0 fences the newest 20 lines", () => {
    const s = setup().getPaneSummary("sumwin-m", 20, 0);
    assert.match(s, /line-060/, "tail window includes the newest line");
    assert.match(s, /line-041/);
    assert.match(s, /```/, "fenced block preserved");
  });

  it("limit=20 offset=20 fences the OLDER 20-line window (not the tail)", () => {
    const s = setup().getPaneSummary("sumwin-m", 20, 20);
    assert.match(s, /line-021/, "older window includes line-021");
    assert.match(s, /line-040/, "older window includes line-040");
    assert.ok(!/line-060/.test(s), "older window must NOT re-show the newest line");
  });
});

describe("BUG-030(a): get_pane_summary ActionDef schema accepts + validates limit/offset", () => {
  it("retains limit and offset on parse", () => {
    const parsed: any = getPaneSummaryDef.params.parse({ pane_id: "p1", limit: 50, offset: 20 });
    assert.strictEqual(parsed.pane_id, "p1");
    assert.strictEqual(parsed.limit, 50, "limit must be retained, not stripped");
    assert.strictEqual(parsed.offset, 20, "offset must be retained, not stripped");
  });

  it("leaves limit/offset optional (bare pane_id still parses)", () => {
    const parsed: any = getPaneSummaryDef.params.parse({ pane_id: "p1" });
    assert.strictEqual(parsed.pane_id, "p1");
  });

  it("rejects limit outside 1..500 and non-integers", () => {
    assert.throws(() => getPaneSummaryDef.params.parse({ pane_id: "p1", limit: 501 }), "limit>500 rejected");
    assert.throws(() => getPaneSummaryDef.params.parse({ pane_id: "p1", limit: 0 }), "limit<1 rejected");
    assert.throws(() => getPaneSummaryDef.params.parse({ pane_id: "p1", limit: 1.5 }), "non-int limit rejected");
  });

  it("rejects a negative offset", () => {
    assert.throws(() => getPaneSummaryDef.params.parse({ pane_id: "p1", offset: -1 }), "offset<0 rejected");
  });
});

describe("BUG-030(a): get_pane_summary handler threads limit/offset to the manager", () => {
  function setup() {
    const store = new JanusStore(":memory:");
    store.init();
    const m: any = new OrchestratorManager({ ledger: store });
    const t: any = new UniversalTerminal("sumwin-h", ".", "shell");
    m.terminals["sumwin-h"] = t;
    feed(t, sixtyLines());
    const ctx: any = { manager: m, isFrozen: () => false, effectiveCapabilityGateFor: () => "Auto" };
    return ctx;
  }

  it("offset=0 -> newest window; offset=20 -> older window", () => {
    const ctx = setup();
    const r0: any = getPaneSummaryDef.handler({ pane_id: "sumwin-h", limit: 20, offset: 0 } as any, ctx);
    const r20: any = getPaneSummaryDef.handler({ pane_id: "sumwin-h", limit: 20, offset: 20 } as any, ctx);
    assert.match(String(r0.output), /line-060/, "offset=0 shows the newest line");
    assert.match(String(r20.output), /line-021/, "offset=20 shows the older window");
    assert.ok(!/line-060/.test(String(r20.output)), "offset=20 must NOT re-show the newest line");
  });
});
