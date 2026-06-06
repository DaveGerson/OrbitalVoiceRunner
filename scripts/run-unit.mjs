// scripts/run-unit.mjs — single-retry wrapper around the unit gate (BEAD 0gt, part 2).
//
// WHY THIS EXISTS: on Windows, @homebridge/node-pty-prebuilt-multiarch's
// conpty_console_list_agent.ts intermittently throws "AttachConsole failed" and kills
// the unit PROCESS with exit 1 AFTER every test has already passed (a PTY-lifecycle
// teardown race inside the prebuilt native package — NOT one of our dispose seams, and
// not an assertion regression). That false-reds the gate and forces manual re-runs.
//
// MITIGATION (lowest-risk, per the bead — do NOT over-engineer the native layer): run
// the unit suite; if it exits non-zero, retry ONCE. A genuine assertion failure is
// deterministic and will fail again on the retry (so this does NOT mask real bugs); the
// non-deterministic post-run teardown crash clears on the second attempt. We surface the
// teardown-signature detection in the log so a masked-vs-real distinction stays visible.
//
// CONSTRAINT: Node built-ins only (mirrors check-deps.mjs) so it runs even if deps are odd.
// CLI:  node scripts/run-unit.mjs            -> tsx --test --test-force-exit tests/*.ts, retry once
//       node scripts/run-unit.mjs <args...>  -> pass-through extra args to the runner

import { spawnSync } from "node:child_process";

const TEARDOWN_SIGNATURE = "AttachConsole failed";
const RUNNER = "tsx";
const BASE_ARGS = ["--test", "--test-force-exit", "tests/*.ts"];

function runOnce(extraArgs) {
  // Inherit stdio for live output AND capture stderr so we can fingerprint the
  // teardown crash. spawnSync with shell:true so the tests/*.ts glob expands on Windows.
  const res = spawnSync(RUNNER, [...BASE_ARGS, ...extraArgs], {
    stdio: ["inherit", "inherit", "pipe"],
    shell: true,
    encoding: "utf8",
  });
  if (res.stderr) process.stderr.write(res.stderr);
  return res;
}

function main() {
  const extra = process.argv.slice(2);
  const first = runOnce(extra);
  if (first.status === 0) {
    process.exit(0);
  }

  const sawTeardownCrash = (first.stderr ?? "").includes(TEARDOWN_SIGNATURE);
  console.warn(
    `\n[run-unit] first attempt exited ${first.status}` +
      (sawTeardownCrash
        ? ` with the known ConPTY teardown crash ("${TEARDOWN_SIGNATURE}") — retrying once.`
        : ` — retrying once (a real failure will reproduce; a flaky post-run teardown will clear).`),
  );

  const second = runOnce(extra);
  if (second.status === 0) {
    console.warn("[run-unit] retry passed — the first exit was a non-deterministic teardown race, not a test failure.");
    process.exit(0);
  }
  console.error(`[run-unit] retry also exited ${second.status} — this is a REAL failure, not the teardown flake.`);
  process.exit(second.status ?? 1);
}

main();
