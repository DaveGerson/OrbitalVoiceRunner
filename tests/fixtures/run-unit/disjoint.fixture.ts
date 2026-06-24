// Fixture for tests/test_run_unit.ts — simulates a LOAD-STARVATION flake that fails a DIFFERENT
// test on each of the two sequential legs (so neither failure reproduces; the intersection is
// empty and the wrapper must PASS, discounting both as flakes).
//
// Determinism without timing: we read+increment a sentinel counter file whose path is supplied via
// $RUN_UNIT_FIXTURE_SENTINEL. The two sequential legs the wrapper runs observe run #1 then run #2:
//   - run #1 (odd)  -> fail "disjoint_alpha", pass "disjoint_beta"
//   - run #2 (even) -> pass "disjoint_alpha", fail "disjoint_beta"
// => leg1 failing set {disjoint_alpha} ∩ leg2 failing set {disjoint_beta} = ∅ -> discounted flakes.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

const sentinel = process.env.RUN_UNIT_FIXTURE_SENTINEL;
if (!sentinel) throw new Error("disjoint.fixture requires RUN_UNIT_FIXTURE_SENTINEL");

// Increment the persisted run counter. The two legs are sequential, so they read 1 then 2.
let prior = 0;
try { prior = parseInt(fs.readFileSync(sentinel, "utf8").trim(), 10) || 0; } catch { prior = 0; }
const runNumber = prior + 1;
fs.writeFileSync(sentinel, String(runNumber));
const oddRun = runNumber % 2 === 1;

test("disjoint_alpha", () => {
  assert.ok(!oddRun, `disjoint_alpha flaked on run ${runNumber}`);
});
test("disjoint_beta", () => {
  assert.ok(oddRun, `disjoint_beta flaked on run ${runNumber}`);
});
