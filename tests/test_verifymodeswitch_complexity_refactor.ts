// tests/test_verifymodeswitch_complexity_refactor.ts — CHARACTERIZATION tests for the
// cyclomatic-complexity burndown refactor of scripts/verify-live-modeswitch-agy.ts.
//
// Pins the pure `computeVerdictInfo` function extracted from `main` (CC 18 → ≤10).
// This function is the only extractable piece that is (a) pure / side-effect-free and
// (b) not gated behind a live ConPTY process, so it is the right scope for unit testing.
//
// What we can characterize:
//   • computeVerdictInfo — all branch combinations of floorMarker / axisDown / axisTab,
//     the distinct / downDistinct / tabDistinct sets, downMoved / tabMoved booleans, and
//     the inconclusive flag.  All 9 boolean sub-expressions are covered.
//
// What we cannot characterize without a live agy process:
//   • spawnAndAwaitTUI, clearSetupPrompts, probePermissionsPicker — they depend on a real
//     ConPTY/node-pty terminal and real process.exit side effects, and the hard timeout
//     callback in main. These are exercised end-to-end only when a real agy binary is
//     present; the isolated lint + tsc exit-0 checks are the gate for those paths.
//
// Runner: npx tsx --test --test-force-exit tests/test_verifymodeswitch_complexity_refactor.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeVerdictInfo } from "../scripts/verify-live-modeswitch-agy";

// ---------------------------------------------------------------------------
// 1. inconclusive = true: no non-null markers at all
// ---------------------------------------------------------------------------
describe("computeVerdictInfo — inconclusive: all null markers", () => {
  it("all (null) markers → distinct empty, inconclusive=true, neither axis moved", () => {
    const v = computeVerdictInfo(null, ["(null)", "(null)"], ["(null)", "(null)"]);
    assert.equal(v.distinct.size, 0, "distinct should be empty when every marker is (null)");
    assert.equal(v.inconclusive, true);
    assert.equal(v.downMoved, false);
    assert.equal(v.tabMoved, false);
  });

  it("floor is non-null but all probe markers are (null) → distinct=1 (floor), inconclusive=true", () => {
    const v = computeVerdictInfo("request-review", ["(null)"], ["(null)"]);
    assert.equal(v.distinct.size, 1);
    assert.ok(v.distinct.has("request-review"));
    assert.equal(v.inconclusive, true, "size=1 means inconclusive");
    assert.equal(v.downMoved, false, "no non-null downDistinct → not moved");
    assert.equal(v.tabMoved, false);
  });
});

// ---------------------------------------------------------------------------
// 2. inconclusive = false: ≥2 distinct non-null markers
// ---------------------------------------------------------------------------
describe("computeVerdictInfo — conclusive: ≥2 distinct markers", () => {
  it("shift+down cycles between two values (no floor) → distinct=2, downMoved=true (size>1)", () => {
    const v = computeVerdictInfo(null, ["always-proceed", "strict"], []);
    assert.equal(v.distinct.size, 2);
    assert.equal(v.inconclusive, false);
    assert.equal(v.downMoved, true, "downDistinct.size > 1 → downMoved");
    assert.equal(v.tabMoved, false);
  });

  it("shift+tab cycles between two values (no floor) → tabMoved=true (size>1)", () => {
    const v = computeVerdictInfo(null, [], ["always-proceed", "strict"]);
    assert.equal(v.inconclusive, false);
    assert.equal(v.downMoved, false);
    assert.equal(v.tabMoved, true);
  });
});

// ---------------------------------------------------------------------------
// 3. downMoved via the floor-comparison branch: size=1 but differs from floor
// ---------------------------------------------------------------------------
describe("computeVerdictInfo — downMoved via floor-comparison branch", () => {
  it("downDistinct.size=1 AND differs from floorMarker → downMoved=true", () => {
    // Branch: floorMarker truthy && downDistinct.size >= 1 && !downDistinct.has(floorMarker)
    const v = computeVerdictInfo("request-review", ["always-proceed"], []);
    assert.equal(v.downDistinct.size, 1);
    assert.ok(!v.downDistinct.has("request-review"), "sanity: floor not in downDistinct");
    assert.equal(v.downMoved, true);
  });

  it("downDistinct.size=1 BUT equals floorMarker → downMoved=false (no net change)", () => {
    // Branch: floorMarker truthy && downDistinct.size >= 1 && downDistinct.has(floorMarker) → false
    const v = computeVerdictInfo("request-review", ["request-review"], []);
    assert.equal(v.downMoved, false, "same value as floor → nothing moved");
  });

  it("downDistinct.size=1 differs from floor AND floor is null → downMoved=false (!!floorMarker gate)", () => {
    // Branch: floorMarker is null → !!floorMarker = false → second disjunct short-circuits
    const v = computeVerdictInfo(null, ["always-proceed"], []);
    assert.equal(v.downDistinct.size, 1);
    assert.equal(v.downMoved, false, "null floor → floor-comparison branch is unreachable");
  });
});

// ---------------------------------------------------------------------------
// 4. tabMoved via the same floor-comparison branch (mirror of §3)
// ---------------------------------------------------------------------------
describe("computeVerdictInfo — tabMoved via floor-comparison branch", () => {
  it("tabDistinct.size=1 AND differs from floorMarker → tabMoved=true", () => {
    const v = computeVerdictInfo("strict", [], ["proceed-in-sandbox"]);
    assert.equal(v.tabMoved, true);
  });

  it("tabDistinct.size=1 equals floorMarker → tabMoved=false", () => {
    const v = computeVerdictInfo("strict", [], ["strict"]);
    assert.equal(v.tabMoved, false);
  });

  it("tabDistinct.size=1, floor null → tabMoved=false", () => {
    const v = computeVerdictInfo(null, [], ["proceed-in-sandbox"]);
    assert.equal(v.tabMoved, false);
  });
});

// ---------------------------------------------------------------------------
// 5. distinct set composition — floor + down + tab merged correctly
// ---------------------------------------------------------------------------
describe("computeVerdictInfo — distinct set composition", () => {
  it("floor + overlapping down/tab markers deduplicate correctly", () => {
    const v = computeVerdictInfo("strict", ["strict", "always-proceed"], ["strict"]);
    // all non-(null): strict (floor), strict (down×2 deduped), always-proceed, strict (tab)
    // distinct = { strict, always-proceed }
    assert.equal(v.distinct.size, 2);
    assert.ok(v.distinct.has("strict"));
    assert.ok(v.distinct.has("always-proceed"));
  });

  it("(null) strings are filtered out of distinct even when mixed with real markers", () => {
    const v = computeVerdictInfo("request-review", ["(null)", "always-proceed"], ["(null)"]);
    assert.equal(v.distinct.size, 2, "only request-review and always-proceed survive");
    assert.ok(!v.distinct.has("(null)"), "(null) must not appear in distinct");
  });

  it("empty axisDown and empty axisTab with non-null floor → distinct=1, inconclusive=true", () => {
    const v = computeVerdictInfo("request-review", [], []);
    assert.equal(v.distinct.size, 1);
    assert.equal(v.inconclusive, true);
  });

  it("all empty arrays and null floor → distinct=0, inconclusive=true", () => {
    const v = computeVerdictInfo(null, [], []);
    assert.equal(v.distinct.size, 0);
    assert.equal(v.inconclusive, true);
  });
});

// ---------------------------------------------------------------------------
// 6. downMoved = true via size > 1 even when floor is null
// ---------------------------------------------------------------------------
describe("computeVerdictInfo — downMoved size>1 path with null floor", () => {
  it("three distinct down values with null floor → downMoved=true via size>1", () => {
    const v = computeVerdictInfo(null, ["a", "b", "c"], []);
    assert.equal(v.downDistinct.size, 3);
    assert.equal(v.downMoved, true);
  });
});
