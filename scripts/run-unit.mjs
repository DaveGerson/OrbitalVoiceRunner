// scripts/run-unit.mjs — per-test flake-intersection wrapper around the unit gate (BEAD 0gt, part 2).
//
// WHY THIS EXISTS: on Windows, @homebridge/node-pty-prebuilt-multiarch's
// conpty_console_list_agent.ts intermittently throws "AttachConsole failed" and kills the unit
// PROCESS with exit 1 AFTER tests have run (a PTY-lifecycle teardown race inside the prebuilt
// native package). Separately, under CPU/IO load a *single* test can flake (transient
// starvation/timeout) on one run and pass on the next. Both false-red the gate.
//
// THE OLD MITIGATION (single retry on the AGGREGATE exit code) was too coarse: if leg1 flaked
// test A and leg2 flaked a DIFFERENT test B — each transient, neither reproducing — the build
// still went red because BOTH legs exited non-zero. That is a false failure: no single test
// failed deterministically.
//
// THIS MITIGATION (per-test intersection):
//   1. Run the suite (leg1). Exit 0 => pass immediately (no leg2).
//   2. leg1 non-zero => run the suite again (leg2).
//   3. leg2 exit 0 => pass.
//   4. BOTH non-zero => intersect the two REAL failing-test-name sets:
//        - intersection EMPTY  => every failure was non-reproducing (flake) => PASS, logging each
//          discounted test ("<name> failed attempt N but passed attempt M — discounted as flake").
//        - intersection NON-EMPTY => those test(s) failed BOTH legs deterministically => RED,
//          exit non-zero listing exactly those tests. A genuine assertion failure is deterministic
//          and reproduces on retry, so it lands here and is NEVER masked.
//   SAFETY: if a non-zero leg yields NO parseable failing test names (a crash/teardown with no
//   test-level failure — TAP missing or empty), we CANNOT compute an honest intersection, so we
//   fall back to conservative RED. We never go green on an intersection we could not actually
//   compute.
//
// HOW WE GET MACHINE-PARSEABLE FAILURES FROM THE REAL RUNNER (the crux — and the trap that killed
// the first attempt): node:test via `tsx --test` emits the SPEC reporter on stdout (lines like
// "✖ <name>", a "failing tests:" block, and "ℹ fail N") — it does NOT emit TAP "not ok" lines on
// stdout. The first attempt parsed stdout for /^not ok/ => matched nothing on real failures =>
// the de-flake never fired. The fix, VERIFIED empirically against this exact toolchain
// (tsx 4.21 + node:test, Windows): node:test supports DUAL reporters with independent
// destinations. We keep the spec reporter on stdout for humans AND add a SECOND tap reporter whose
// destination is a temp FILE. tsx forwards both `--test-reporter`/`--test-reporter-destination`
// pairs and actually writes the TAP file. We then parse the file's "not ok <n> - <name>" lines.
// Real assertion failures appear as "not ok N - <test name>" (clean name); a process-level crash
// appears as "not ok N - <file path>" with code ERR_TEST_FAILURE — either way it is a parseable
// name, and an identical crash reproducing in both legs correctly reds (same as the old behavior).
//
// CONSTRAINT: Node built-ins only (mirrors check-deps.mjs) so it runs even if deps are odd.
// CLI:  node scripts/run-unit.mjs            -> dual-reporter run of tests/*.ts, intersect-on-retry
//       node scripts/run-unit.mjs <args...>  -> pass-through extra args to the runner

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEARDOWN_SIGNATURE = "AttachConsole failed";
const RUNNER = "tsx";
const BASE_ARGS = ["--test", "--test-force-exit"];
const DEFAULT_GLOB = "tests/*.ts";

/**
 * Pure: extract the set of failing test names from a node:test TAP-reporter file.
 * Matches `not ok <n> - <name>` (TAP13). Returns a Set of names (trimmed). For a genuine
 * assertion failure the name is the test name; for a process-level crash node:test synthesizes
 * a file-level `not ok` whose name is the file path — both are returned, both are parseable.
 */
export function parseTapFailures(tapText) {
  const failures = new Set();
  if (!tapText) return failures;
  for (const line of tapText.split(/\r?\n/)) {
    const m = /^not ok \d+ - (.+?)\s*(?:#.*)?$/.exec(line);
    if (m) failures.add(m[1].trim());
  }
  return failures;
}

/**
 * Pure: given the two legs' results, decide the gate outcome.
 *
 * A leg is `{ status: number|null, failures: Set<string>, parseable: boolean }` where
 * `parseable` is true iff a non-zero leg produced at least one parseable failing name (so we
 * could honestly compute an intersection). `status === 0` legs need no failures.
 *
 * Returns `{ exit: number, reason: string, discounted: string[], intersection: string[] }`.
 *   - exit 0 => pass; non-zero => red.
 *   - discounted => names that failed one leg but not the other (logged as flakes).
 *   - intersection => names that failed BOTH legs (the deterministic failures that red the build).
 */
export function decideOutcome(leg1, leg2) {
  if (leg1.status === 0) {
    return { exit: 0, reason: "leg1-clean", discounted: [], intersection: [] };
  }
  if (leg2.status === 0) {
    // Everything leg1 reported was non-reproducing.
    return {
      exit: 0,
      reason: "leg2-clean",
      discounted: [...leg1.failures].sort(),
      intersection: [],
    };
  }
  // Both legs non-zero. We MUST be able to name the failures in BOTH legs to honestly intersect;
  // an unparseable non-zero leg (crash/teardown with no test-level failure) → conservative RED.
  if (!leg1.parseable || !leg2.parseable) {
    return {
      exit: 1,
      reason: "unparseable-leg",
      discounted: [],
      intersection: [],
    };
  }
  const intersection = [...leg1.failures].filter((n) => leg2.failures.has(n)).sort();
  if (intersection.length === 0) {
    // Union of the two disjoint failing sets were all non-reproducing → flakes.
    const discounted = [...new Set([...leg1.failures, ...leg2.failures])].sort();
    return { exit: 0, reason: "disjoint-flakes", discounted, intersection: [] };
  }
  return { exit: 1, reason: "reproduced", discounted: [], intersection };
}

/**
 * Run the unit suite once with dual reporters: spec → stdout (live, human-readable) and tap →
 * `tapFile` (machine-parseable). Streams stdout/stderr live; captures stderr for the teardown
 * fingerprint. Returns `{ status, failures, parseable, sawTeardownCrash }`.
 */
function runLeg(extraArgs, tapFile) {
  // Fresh TAP file per leg so a stale file can never leak failures between legs.
  try { fs.rmSync(tapFile, { force: true }); } catch { /* ignore */ }

  const args = [
    ...BASE_ARGS,
    "--test-reporter", "spec",
    "--test-reporter-destination", "stdout",
    "--test-reporter", "tap",
    "--test-reporter-destination", tapFile,
    ...(extraArgs.length > 0 ? extraArgs : [DEFAULT_GLOB]),
  ];

  // stdout inherited so the spec reporter streams live; stderr piped so we can both echo it AND
  // fingerprint the ConPTY teardown crash. shell:true so the tests/*.ts glob expands on Windows.
  const res = spawnSync(RUNNER, args, {
    stdio: ["inherit", "inherit", "pipe"],
    shell: true,
    encoding: "utf8",
  });
  if (res.stderr) process.stderr.write(res.stderr);

  let tapText = "";
  try { tapText = fs.readFileSync(tapFile, "utf8"); } catch { /* file may be absent on a hard crash */ }
  const failures = parseTapFailures(tapText);

  return {
    status: res.status,
    failures,
    // A non-zero leg is "parseable" iff we actually extracted >=1 failing name; a clean leg is
    // trivially parseable (no failures to compute).
    parseable: res.status === 0 || failures.size > 0,
    sawTeardownCrash: (res.stderr ?? "").includes(TEARDOWN_SIGNATURE),
  };
}

function logRetryBanner(leg1) {
  const crashNote = leg1.sawTeardownCrash
    ? ` with the known ConPTY teardown crash ("${TEARDOWN_SIGNATURE}").`
    : ``;
  const failing = leg1.failures.size > 0 ? [...leg1.failures].join(", ") : "(none parseable)";
  console.warn(
    `\n[run-unit] attempt 1 exited ${leg1.status}${crashNote}` +
      ` Failing tests: ${failing}.` +
      ` Running attempt 2 to distinguish reproducible failures from flakes.`,
  );
}

function logDiscountedFlakes(outcome, leg1) {
  for (const name of outcome.discounted) {
    // Which attempt did this name fail? It is, by construction, in the symmetric difference.
    const [failed, passed] = leg1.failures.has(name) ? [1, 2] : [2, 1];
    console.warn(`[run-unit] ${name} failed attempt ${failed} but passed attempt ${passed} — discounted as flake.`);
  }
  if (outcome.reason === "leg2-clean") {
    console.warn("[run-unit] attempt 2 was fully clean — attempt 1's failures did not reproduce; treating as flakes.");
  }
  console.warn("[run-unit] no test failed BOTH attempts — passing (every failure was non-reproducing).");
}

/** Emit the appropriate human log for a decided outcome and return the process exit code. */
function reportOutcome(outcome, leg1, leg2) {
  if (outcome.exit === 0) {
    logDiscountedFlakes(outcome, leg1);
    return 0;
  }
  if (outcome.reason === "unparseable-leg") {
    const sawCrash = leg1.sawTeardownCrash || leg2.sawTeardownCrash;
    console.error(
      `[run-unit] both attempts exited non-zero but at least one produced NO parseable test-level failure ` +
        `(crash/teardown). Cannot compute an honest per-test intersection — failing conservatively (RED) ` +
        `rather than masking a possible real failure.` +
        (sawCrash ? ` (Saw "${TEARDOWN_SIGNATURE}".)` : ``),
    );
    return leg2.status ?? leg1.status ?? 1;
  }
  console.error(
    `[run-unit] the following test(s) failed BOTH attempts (deterministic — a REAL failure, not a flake): ` +
      outcome.intersection.join(", "),
  );
  return leg2.status ?? 1;
}

function main() {
  const extra = process.argv.slice(2);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-run-unit-"));
  try {
    const leg1 = runLeg(extra, path.join(tmpDir, "leg1.tap"));
    if (leg1.status === 0) process.exit(0);

    logRetryBanner(leg1);
    const leg2 = runLeg(extra, path.join(tmpDir, "leg2.tap"));
    process.exit(reportOutcome(decideOutcome(leg1, leg2), leg1, leg2));
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

// Run main() only when invoked directly, not when imported by the test.
const invokedDirectly =
  process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
