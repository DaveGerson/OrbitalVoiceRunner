// tests/test_arbiter_telemetry.ts — v02l watch tooling RED: the arbiter telemetry check script.
// The +14d watch bead reviews (1) the jump_over counter — post-arbiter it should be STRUCTURALLY
// ZERO; any row is a bypass/classifier bug — and (2) the arbiter_drain size/mode/headline-cls
// distributions, via the REAL JanusStore readers (getJumpOvers/getArbiterDrains, schema v14).
// The script exports its core as a pure function over a store handle (the CLI shell just wires
// the production DB path), so this test drives it with a real in-memory store through the real
// record/read API — no fixtures, no SQL duplication.
// Runner: npx tsx --test --test-force-exit tests/test_arbiter_telemetry.ts
import { test } from "node:test";
import assert from "node:assert";
import { JanusStore } from "../src/store/sqliteStore";
import { buildArbiterTelemetryReport } from "../scripts/arbiter-telemetry";

const T0 = 1_700_000_000_000;

test("the report reflects real rows: 1 jump-over (flagged as a bug) + 2 drains with distributions", () => {
  const store = new JanusStore(":memory:");
  store.init();
  try {
    store.recordJumpOver({ ts: T0, sessionId: "s1", producer: "completion", cls: 3, detail: "landed mid-utterance" });
    store.recordArbiterDrain({ ts: T0 + 1_000, sessionId: "s1", mode: "forced-turn", headlineCls: 0, drainSize: 3, tailCount: 2, delivered: true });
    store.recordArbiterDrain({ ts: T0 + 2_000, sessionId: "s1", mode: "next-turn", headlineCls: 3, drainSize: 1, tailCount: 0, delivered: true });

    const out = buildArbiterTelemetryReport(store, { sinceTs: 0 });

    // jump_over: the counter, the bug flag, and EVERY row (ts/producer/cls/detail).
    assert.ok(out.includes("jump_over total: 1"), `jump-over count missing:\n${out}`);
    assert.match(out, /bypass\/classifier bug/i, "a non-zero counter must be called out as a bug");
    assert.ok(out.includes("producer=completion"), "each row prints its producer");
    assert.ok(out.includes("cls=3"), "each row prints its cls");
    assert.ok(out.includes("landed mid-utterance"), "each row prints its detail");

    // arbiter_drain: count + size distribution (min/p50/p90/max + count-by-size), mode + cls dists.
    assert.ok(out.includes("drains total: 2"), `drain count missing:\n${out}`);
    assert.ok(out.includes("min=1"), "size min");
    assert.ok(out.includes("p50=1"), "size p50 (nearest-rank over [1,3])");
    assert.ok(out.includes("p90=3"), "size p90 (nearest-rank over [1,3])");
    assert.ok(out.includes("max=3"), "size max");
    assert.ok(out.includes("size 1 x1") && out.includes("size 3 x1"), "count by drainSize");
    assert.ok(out.includes("forced-turn x1") && out.includes("next-turn x1"), "mode distribution");
    assert.ok(out.includes("cls 0 x1") && out.includes("cls 3 x1"), "headlineCls distribution");
  } finally {
    store.close();
  }
});

test("structurally-zero steady state: no rows -> the report says so without flagging a bug", () => {
  const store = new JanusStore(":memory:");
  store.init();
  try {
    const out = buildArbiterTelemetryReport(store, { sinceTs: 0 });
    assert.ok(out.includes("jump_over total: 0"), "zero jump-overs is the expected verdict");
    assert.match(out, /expected/i, "the zero case reads as the healthy expectation");
    assert.ok(!/bypass\/classifier bug/i.test(out.split("arbiter_drain")[0]) || out.includes("jump_over total: 0"),
      "no false bug alarm on the healthy path");
    assert.ok(out.includes("drains total: 0"), "an empty drain window reports 0, not a crash");
  } finally {
    store.close();
  }
});
