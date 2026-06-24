// tests/test_run_unit.ts — validates the per-test flake-intersection in scripts/run-unit.mjs.
//
// This test exists because the FIRST de-flake attempt (PR #89, rejected) was inert: it parsed
// stdout for TAP "not ok" lines that `tsx --test`'s spec reporter NEVER emits, so the intersection
// never fired, and its own unit tests fed HAND-WRITTEN TAP the runner doesn't produce (false
// confidence). Every assertion here exercises the REAL runner output:
//   1. parseTapFailures is validated against a REAL TAP file produced by spawning `tsx --test` with
//      the wrapper's actual dual-reporter flags against a known-failing fixture.
//   2. The wrapper's intersection is validated by spawning the REAL `node scripts/run-unit.mjs`
//      child against fixtures: clean => exit 0; disjoint flakes => exit 0 (discounted); a failure
//      that reproduces in BOTH legs => non-zero (never masked).
//   3. decideOutcome is unit-tested as a pure decision table.
//
// Fixtures live under tests/fixtures/run-unit/ so they are OUTSIDE the default tests/*.ts glob and
// never run in the normal suite — they are invoked explicitly here.
//
// Runner: npx tsx --test --test-force-exit tests/test_run_unit.ts

import { test } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseTapFailures, decideOutcome } from "../scripts/run-unit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const FIXTURE_DIR = path.join(HERE, "fixtures", "run-unit");
const RUN_UNIT = path.join(REPO_ROOT, "scripts", "run-unit.mjs");

const fixture = (name: string) => path.join(FIXTURE_DIR, name);

function tmpFile(suffix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-run-unit-test-"));
  return path.join(dir, suffix);
}

// This test runs UNDER node:test, which sets NODE_TEST_CONTEXT. If a child `tsx --test` inherits
// it, node:test detects "recursive run()" and SKIPS the files (exit 0, no tests). Stripping it
// gives the child a clean, independent test run — exactly how the wrapper behaves in real `npm test`
// usage (which is NOT nested inside another node:test process).
function cleanTestEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

// ---------------------------------------------------------------------------------------------
// 1. PARSER vs. REAL RUNNER OUTPUT — the assertion the first attempt lacked.
// ---------------------------------------------------------------------------------------------

test("parseTapFailures extracts the failing test name from REAL `tsx --test` TAP output", () => {
  // Spawn the actual runner with the SAME dual-reporter flags the wrapper uses, writing a real TAP
  // file. We do NOT hand-write TAP — this is the genuine reporter output.
  const tapPath = tmpFile("real.tap");
  const res = spawnSync(
    "tsx",
    [
      "--test",
      "--test-reporter", "spec",
      "--test-reporter-destination", "stdout",
      "--test-reporter", "tap",
      "--test-reporter-destination", tapPath,
      fixture("parser-target.fixture.ts"),
    ],
    { shell: true, encoding: "utf8", env: cleanTestEnv() },
  );

  // The fixture has one failing test, so the leg must exit non-zero and write a TAP file.
  assert.notEqual(res.status, 0, "fixture with a failing test must exit non-zero");
  const tapText = fs.readFileSync(tapPath, "utf8");

  // PROOF the parser handles REAL output: the genuine TAP must contain a "not ok ... - <name>" line.
  assert.match(tapText, /not ok \d+ - parser_target_fails/, "real TAP must contain the failing test's not-ok line");

  const failures = parseTapFailures(tapText);
  assert.ok(failures.has("parser_target_fails"), "parser must extract the real failing test name");
  assert.ok(!failures.has("parser_target_passes"), "parser must NOT include passing tests");
  assert.equal(failures.size, 1, "exactly the one failing test should be parsed");
});

test("parseTapFailures returns an empty set for empty / missing TAP", () => {
  assert.equal(parseTapFailures("").size, 0);
  assert.equal(parseTapFailures(undefined as unknown as string).size, 0);
  assert.equal(parseTapFailures("TAP version 13\nok 1 - all good\n1..1\n").size, 0);
});

// ---------------------------------------------------------------------------------------------
// 2. END-TO-END WRAPPER via REAL child runs of scripts/run-unit.mjs.
// ---------------------------------------------------------------------------------------------

function runWrapper(globPath: string, extraEnv: Record<string, string> = {}) {
  return spawnSync("node", [RUN_UNIT, globPath], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: cleanTestEnv(extraEnv),
  });
}

test("wrapper: a clean suite exits 0 (leg1 short-circuits, no leg2)", () => {
  const res = runWrapper(fixture("clean.fixture.ts"));
  assert.equal(res.status, 0, `clean suite must pass.\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
});

test("wrapper: disjoint per-leg failures are discounted as flakes => exit 0", () => {
  // The fixture fails a DIFFERENT test on each sequential leg (run #1 fails alpha, run #2 fails
  // beta) via a sentinel counter — so leg1 ∩ leg2 = ∅ and the wrapper must pass while logging both
  // discounts. This deterministically reproduces the load-starvation flake the de-flake targets.
  const sentinel = tmpFile("sentinel.count");
  const res = runWrapper(fixture("disjoint.fixture.ts"), { RUN_UNIT_FIXTURE_SENTINEL: sentinel });
  assert.equal(
    res.status,
    0,
    `disjoint flakes must be discounted to exit 0.\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
  );
  const log = `${res.stdout}\n${res.stderr}`;
  // Each disjoint failure must be explicitly logged as a discounted flake.
  assert.match(log, /disjoint_alpha failed attempt 1 but passed attempt 2 — discounted as flake/);
  assert.match(log, /disjoint_beta failed attempt 2 but passed attempt 1 — discounted as flake/);
  // Sentinel must show exactly two legs ran (proves leg2 actually executed, not short-circuited).
  assert.equal(fs.readFileSync(sentinel, "utf8").trim(), "2", "both legs must have run");
});

test("wrapper: a failure that reproduces in BOTH legs is NEVER masked => non-zero", () => {
  const res = runWrapper(fixture("reproduces.fixture.ts"));
  assert.notEqual(res.status, 0, "a deterministic failure must red the build");
  const log = `${res.stdout}\n${res.stderr}`;
  assert.match(log, /failed BOTH attempts/, "must report the reproduced failure");
  assert.match(log, /reproduces_fail_always/, "must name the test that failed both legs");
});

// ---------------------------------------------------------------------------------------------
// 3. decideOutcome — pure decision table.
// ---------------------------------------------------------------------------------------------

const leg = (status: number | null, names: string[], parseable?: boolean) => ({
  status,
  failures: new Set(names),
  parseable: parseable ?? (status === 0 || names.length > 0),
});

test("decideOutcome: leg1 clean => pass, no leg2 considered", () => {
  const o = decideOutcome(leg(0, []), leg(1, ["x"]));
  assert.equal(o.exit, 0);
  assert.equal(o.reason, "leg1-clean");
});

test("decideOutcome: leg1 fails, leg2 clean => pass, leg1 failures discounted", () => {
  const o = decideOutcome(leg(1, ["a", "b"]), leg(0, []));
  assert.equal(o.exit, 0);
  assert.equal(o.reason, "leg2-clean");
  assert.deepEqual(o.discounted, ["a", "b"]);
});

test("decideOutcome: both fail on DISJOINT tests => pass, union discounted", () => {
  const o = decideOutcome(leg(1, ["a"]), leg(1, ["b"]));
  assert.equal(o.exit, 0);
  assert.equal(o.reason, "disjoint-flakes");
  assert.deepEqual(o.discounted, ["a", "b"]);
  assert.deepEqual(o.intersection, []);
});

test("decideOutcome: both fail on the SAME test => RED, intersection named", () => {
  const o = decideOutcome(leg(1, ["a", "shared"]), leg(1, ["shared", "c"]));
  assert.equal(o.exit, 1);
  assert.equal(o.reason, "reproduced");
  assert.deepEqual(o.intersection, ["shared"]);
});

test("decideOutcome: both fail but one leg is UNPARSEABLE (crash, no test names) => conservative RED", () => {
  // A non-zero leg with no parseable failures (e.g. ConPTY teardown) cannot be intersected honestly.
  const o = decideOutcome(leg(1, ["a"]), { status: 1, failures: new Set<string>(), parseable: false });
  assert.equal(o.exit, 1);
  assert.equal(o.reason, "unparseable-leg");
});
