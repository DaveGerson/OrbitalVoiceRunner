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

// BEAD ox1q: node-pty's conpty_console_list_agent races the synchronous pty kill on Windows and
// intermittently logs "AttachConsole failed" to stderr during test teardown — benign, endemic
// harness noise (NOT a test failure) that showed up ~42x in a fully green battery and obscured
// root-causing real stderr in bxpk. This regex is intentionally NARROW (the literal phrase only)
// so it can never mask a real error line that merely mentions consoles/attaching in passing.
const BENIGN_TEARDOWN_RE = /AttachConsole failed/;

/**
 * Pure: filter the known-benign ConPTY teardown noise out of a leg's raw stderr, WITHOUT hiding
 * any other line. Returns `{ cleaned, sawTeardownCrash, droppedCount }`:
 *   - `cleaned` — stderr with every line matching BENIGN_TEARDOWN_RE removed, lines rejoined with
 *     "\n". Real errors (anything not matching the narrow pattern) pass through verbatim.
 *   - `droppedCount` — how many lines were dropped (surfaced in a breadcrumb so nothing is
 *     silently hidden).
 *   - `sawTeardownCrash` — true iff at least one line was dropped; this is the SAME fingerprint
 *     the retry banner and the conservative-RED unparseable-leg path depend on, now derived from
 *     the filter itself rather than a raw `.includes()` on the unfiltered blob.
 */
export function filterBenignTeardownNoise(stderr) {
  const text = stderr ?? "";
  if (!text) return { cleaned: "", sawTeardownCrash: false, droppedCount: 0 };
  const lines = text.split(/\r?\n/);
  const kept = [];
  let droppedCount = 0;
  for (const line of lines) {
    if (BENIGN_TEARDOWN_RE.test(line)) {
      droppedCount += 1;
      continue;
    }
    kept.push(line);
  }
  return { cleaned: kept.join("\n"), sawTeardownCrash: droppedCount > 0, droppedCount };
}

// bead 1p84: repo-root sentinel files a well-behaved battery must never create at process.cwd()
// (an operator's own dev-time .janus.db/.janus_settings.json are pre-existing and must NOT be
// flagged — only a NEWLY created one, during THIS run, is a leak).
const REPO_ROOT_SENTINELS = [".janus.db", ".janus.db-wal", ".janus.db-shm", ".janus_settings.json"];

/**
 * Pure: given a before/after snapshot of `{ [sentinelName]: boolean }` (existence at
 * process.cwd()), return the sentinel names that are ABSENT before and PRESENT after — i.e.
 * genuinely created DURING the run. A sentinel present before the run (an operator's own DB)
 * is never flagged, even if it's still present after.
 */
export function detectRepoRootLeak(before, after) {
  const leaked = [];
  for (const name of REPO_ROOT_SENTINELS) {
    if (!before[name] && after[name]) leaked.push(name);
  }
  return leaked;
}

/** Snapshot `REPO_ROOT_SENTINELS` existence at `cwd` (defaults to process.cwd()). */
function snapshotRepoRootSentinels(cwd = process.cwd()) {
  const snap = {};
  for (const name of REPO_ROOT_SENTINELS) snap[name] = fs.existsSync(path.join(cwd, name));
  return snap;
}

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

  // BEAD ox1q: filter the known-benign ConPTY "AttachConsole failed" teardown noise before
  // echoing stderr — real errors pass through untouched; the dropped count is surfaced in a
  // single breadcrumb rather than silently swallowed.
  const noise = filterBenignTeardownNoise(res.stderr ?? "");
  if (noise.cleaned) process.stderr.write(noise.cleaned.endsWith("\n") ? noise.cleaned : `${noise.cleaned}\n`);
  if (noise.droppedCount > 0) {
    console.warn(
      `[run-unit] filtered ${noise.droppedCount} benign ConPTY teardown line(s) ("${TEARDOWN_SIGNATURE}") — ` +
        `known node-pty console-list-agent noise, not a real error.`,
    );
  }

  let tapText = "";
  try { tapText = fs.readFileSync(tapFile, "utf8"); } catch { /* file may be absent on a hard crash */ }
  const failures = parseTapFailures(tapText);

  return {
    status: res.status,
    failures,
    // A non-zero leg is "parseable" iff we actually extracted >=1 failing name; a clean leg is
    // trivially parseable (no failures to compute).
    parseable: res.status === 0 || failures.size > 0,
    sawTeardownCrash: noise.sawTeardownCrash,
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

/**
 * bead 1p84: assert the battery leaves NO repo-root .janus.db / .janus_settings.json artifact.
 * Snapshot before/after the WHOLE run (both legs, if a retry happened) so a leak from either leg
 * is caught. A non-empty leak list is loud and forces a non-zero exit even if the tests
 * themselves were green — cleanliness is part of the gate, not an afterthought.
 */
function assertRepoRootCleanliness(before) {
  const after = snapshotRepoRootSentinels();
  const leaked = detectRepoRootLeak(before, after);
  if (leaked.length > 0) {
    console.error(
      `\n[run-unit] REPO-ROOT LEAK: the unit battery created ${leaked.join(", ")} at ` +
        `${process.cwd()} during this run. A test imported server.ts (or otherwise constructed ` +
        `a JanusStore/OrchestratorManager) without rooting it in a tmpdir/scratch dir — fix the ` +
        `offending test (see tests/helpers/mockLive.ts's loadMockLive() for the pattern) rather ` +
        `than deleting the file and moving on.`,
    );
  }
  return leaked;
}

function main() {
  const extra = process.argv.slice(2);
  const beforeSentinels = snapshotRepoRootSentinels();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-run-unit-"));
  try {
    const leg1 = runLeg(extra, path.join(tmpDir, "leg1.tap"));
    if (leg1.status === 0) {
      const leaked = assertRepoRootCleanliness(beforeSentinels);
      process.exit(leaked.length > 0 ? 1 : 0);
    }

    logRetryBanner(leg1);
    const leg2 = runLeg(extra, path.join(tmpDir, "leg2.tap"));
    const outcomeExit = reportOutcome(decideOutcome(leg1, leg2), leg1, leg2);
    const leaked = assertRepoRootCleanliness(beforeSentinels);
    process.exit(outcomeExit !== 0 ? outcomeExit : leaked.length > 0 ? 1 : 0);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

// Run main() only when invoked directly, not when imported by the test.
const invokedDirectly =
  process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
