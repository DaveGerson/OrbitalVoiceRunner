// tests/test_idle_diff.ts — CHARACTERIZATION tests for the pure prev-vs-current terminals idle diff
// extracted out of src/App.tsx (bead dbt4 — App.tsx decomposition). The 6s flag-clear timers in
// useRecentlyIdled (src/classic/hooks/useRecentlyIdled.ts) are hook-coupled and exercised by the
// classic UI; this pins the ONE pure decision the hook delegates to — computeIdleDiff, the exact
// Running→Idle / stale-flag-clear loop the former effect ran inline.
//
// Runner: npx tsx --test --test-force-exit tests/test_idle_diff.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import { computeIdleDiff } from "../src/classic/helpers/idleDiff";
import type { Terminal } from "../src/types";

// Minimal Terminal factory — only id + status matter to the diff.
function term(id: string, status: Terminal["status"]): Terminal {
  return { id, cwd: "", command: "", output: "", status };
}

describe("idleDiff — computeIdleDiff", () => {
  it("flags a pane that went Running→Idle and records it as newly idled", () => {
    const prev = [term("a", "Running")];
    const next = [term("a", "Idle")];
    const r = computeIdleDiff(prev, next, {});
    assert.deepStrictEqual(r.nextRecentlyIdled, { a: true });
    assert.strictEqual(r.hasChanges, true);
    assert.deepStrictEqual(r.newlyIdledIds, ["a"]);
  });

  it("no change when a pane stays Running (and had no flag)", () => {
    const prev = [term("a", "Running")];
    const next = [term("a", "Running")];
    const r = computeIdleDiff(prev, next, {});
    assert.deepStrictEqual(r.nextRecentlyIdled, {});
    assert.strictEqual(r.hasChanges, false);
    assert.deepStrictEqual(r.newlyIdledIds, []);
  });

  it("clears a stale flag when a flagged pane is Running again", () => {
    const prev = [term("a", "Idle")];
    const next = [term("a", "Running")];
    const r = computeIdleDiff(prev, next, { a: true });
    assert.deepStrictEqual(r.nextRecentlyIdled, {});
    assert.strictEqual(r.hasChanges, true);
    assert.deepStrictEqual(r.newlyIdledIds, []);
  });

  it("does NOT flag an Idle pane that was not Running last tick (no prevTerm Running)", () => {
    const prev = [term("a", "Idle")];
    const next = [term("a", "Idle")];
    const r = computeIdleDiff(prev, next, {});
    assert.deepStrictEqual(r.nextRecentlyIdled, {});
    assert.strictEqual(r.hasChanges, false);
    assert.deepStrictEqual(r.newlyIdledIds, []);
  });

  it("does NOT flag a brand-new Idle pane absent from prev", () => {
    const prev: Terminal[] = [];
    const next = [term("a", "Idle")];
    const r = computeIdleDiff(prev, next, {});
    assert.deepStrictEqual(r.nextRecentlyIdled, {});
    assert.strictEqual(r.hasChanges, false);
    assert.deepStrictEqual(r.newlyIdledIds, []);
  });

  it("the Running→Idle branch wins when a pane both newly idles (the else never fires for it)", () => {
    // A pane carrying a flag that goes Running→Idle: only the first branch applies; the flag is
    // (re)set true, NOT dropped. Verifies the if/else ordering is preserved.
    const prev = [term("a", "Running")];
    const next = [term("a", "Idle")];
    const r = computeIdleDiff(prev, next, { a: true });
    assert.deepStrictEqual(r.nextRecentlyIdled, { a: true });
    assert.deepStrictEqual(r.newlyIdledIds, ["a"]);
  });

  it("handles a mixed batch: one newly idled, one cleared, one untouched", () => {
    const prev = [term("a", "Running"), term("b", "Idle"), term("c", "Running")];
    const next = [term("a", "Idle"), term("b", "Running"), term("c", "Running")];
    const r = computeIdleDiff(prev, next, { b: true });
    assert.deepStrictEqual(r.nextRecentlyIdled, { a: true });
    assert.strictEqual(r.hasChanges, true);
    assert.deepStrictEqual(r.newlyIdledIds, ["a"]);
  });

  it("never mutates the input recentlyIdled map", () => {
    const input = { a: true };
    const prev = [term("a", "Idle")];
    const next = [term("a", "Running")];
    computeIdleDiff(prev, next, input);
    assert.deepStrictEqual(input, { a: true });
  });
});
