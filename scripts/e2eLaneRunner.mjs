// scripts/e2eLaneRunner.mjs — shared, self-cleaning Playwright lane wrapper (BEAD wsm-e2e-pinned-rwnq).
//
// WHY THIS EXISTS: both E2E lanes used to run Playwright with NO run-wide cap and (for the live
// lane) via a blocking `spawnSync`, so the ONLY thing that ever stopped a stuck run was the
// orchestrator's external wall-clock SIGKILL. That kill fires from OUTSIDE the process tree, so
// Playwright's own webServer teardown never runs and the `vite --port 5173` / `tsx server.ts` child
// is orphaned (the leaked 5173/3117 listeners the bead reports).
//
// THE FIX (shared by both lanes):
//   1. Playwright's `globalTimeout` (set in playwright.config.ts from scripts/e2eBudgets.mjs) makes
//      Playwright stop ITSELF first — well under the outer wall — running its normal teardown.
//   2. This wrapper uses ASYNC `spawn` (not spawnSync) so its event loop stays live and can react
//      to signals + a defense-in-depth WATCHDOG timer.
//   3. On watchdog fire OR SIGINT/SIGTERM, it kills the WHOLE child tree — via `taskkill /T /F` on
//      Windows (the `/T` tree semantics the bead calls out) or a process-group SIGTERM on POSIX
//      (catchable, so a trapping child gets its graceful shutdown; the lane still exits non-zero
//      either way) — so no orphan survives even if Playwright's own teardown is bypassed.
//   4. A `finally` ALWAYS runs the post-run port-leak check (scripts/checkE2ePortsFree.mjs) — pass,
//      fail, or timeout — so a leak is self-reported instead of found by manual spelunking.
//
// CONSTRAINT: Node built-ins only (mirrors run-unit.mjs / check-deps.mjs).

import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT_CHECK_SCRIPT = path.join(HERE, "checkE2ePortsFree.mjs");
// Playwright's CLI entry, spawned via process.execPath (no npx, no shell): with shell:true on
// Windows, Node CONCATENATES argv for cmd.exe instead of quoting it, so a spaced passthrough like
// `-g "pane restart"` re-splits into `-g pane` + stray `restart` and silently mis-filters tests.
const PLAYWRIGHT_CLI = createRequire(import.meta.url).resolve("@playwright/test/cli");

/**
 * Pure: how to kill a child's WHOLE process tree on the given platform.
 *   - win32 => `{ cmd: 'taskkill', args: ['/pid', <pid>, '/T', '/F'] }` (kills the tree; `node
 *     (playwright cli) → workers → webServer` all die). `/T` = tree, `/F` = force.
 *   - POSIX (linux/darwin/…) => `null`, meaning: the caller should use `process.kill(-pid, signal)`
 *     against the child's process GROUP (the child is spawned `detached` so it leads its own group).
 * Returning data (not spawning) keeps this unit-testable without ever launching a real process.
 */
export function buildKillTreeCommand(pid, platform = process.platform) {
  if (platform === "win32") {
    return { cmd: "taskkill", args: ["/pid", String(pid), "/T", "/F"] };
  }
  return null;
}

/**
 * Pure: map a child process exit (`code`, `signal`) to a wrapper exit code. A signal-kill reports
 * `code === null` — we must surface that as a NON-ZERO exit so CI never reads a killed run as green.
 */
export function resolveExitCode(code, signal) {
  if (typeof code === "number") return code;
  if (signal) return 1; // killed by signal (watchdog / external) — never a false green
  return 1;
}

/** Kill the child's whole tree, platform-appropriately. Best-effort; never throws. */
function killTree(child, platform = process.platform) {
  if (!child || child.pid == null || child.killed) return;
  const plan = buildKillTreeCommand(child.pid, platform);
  try {
    if (plan) {
      spawnSync(plan.cmd, plan.args, { stdio: "ignore" });
    } else {
      // POSIX: signal the whole process group (negative pid). Child was spawned detached.
      try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
    }
  } catch {
    /* best-effort teardown */
  }
}

/**
 * Run a Playwright lane as a self-cleaning child process.
 *
 * @param {object} opts
 * @param {string}   opts.label        - short lane label for diagnostics (e.g. "live", "mock").
 * @param {string[]} opts.playwrightArgs - args after `playwright test` (e.g. ["--project=live"]).
 * @param {object}   [opts.env]        - extra env merged over process.env.
 * @param {number}   opts.watchdogMs   - hard wrapper watchdog (defense-in-depth; > globalTimeout).
 * @param {number[]} opts.cleanupPorts - ports to assert FREE after the run (best-effort).
 * @returns {Promise<number>} the resolved process exit code.
 */
export function runLane({ label, playwrightArgs, env = {}, watchdogMs, cleanupPorts }) {
  return new Promise((resolve) => {
    const onWin = process.platform === "win32";
    const child = spawn(process.execPath, [PLAYWRIGHT_CLI, "test", ...playwrightArgs], {
      stdio: "inherit",
      env: { ...process.env, ...env },
      // POSIX: detached so the child leads its own process group and killTree can signal the
      // whole group with a negative pid. (No shell on either platform — see PLAYWRIGHT_CLI.)
      detached: !onWin,
    });

    let settled = false;
    let watchdogHit = false;

    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      // ALWAYS run the post-run port-leak check — pass, fail, or timeout (the bead's guarantee).
      runPortCleanupCheck(cleanupPorts);
      let exit = resolveExitCode(code, signal);
      if (watchdogHit) {
        console.error(`[e2e:${label}] wrapper watchdog fired after ${watchdogMs}ms — killed the child tree and failing (exit ${exit || 1}).`);
        exit = exit || 1;
      }
      resolve(exit);
    };

    const watchdog = setTimeout(() => {
      watchdogHit = true;
      console.error(`[e2e:${label}] watchdog: run exceeded ${watchdogMs}ms; Playwright's own globalTimeout did not stop it — force-killing the process tree.`);
      killTree(child);
    }, watchdogMs);
    // Do not let the watchdog itself keep the event loop alive past a clean exit.
    if (typeof watchdog.unref === "function") watchdog.unref();

    const onSignal = () => {
      console.error(`[e2e:${label}] received termination signal — killing the child tree before exit.`);
      killTree(child);
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    child.on("error", (err) => {
      console.error(`[e2e:${label}] failed to spawn playwright:`, err?.message ?? err);
      finish(1, null);
    });
    child.on("exit", (code, signal) => finish(code, signal));
  });
}

/** Best-effort post-run port check; errors swallowed so cleanup never masks the real result. */
function runPortCleanupCheck(cleanupPorts) {
  if (!cleanupPorts || cleanupPorts.length === 0) return;
  try {
    spawnSync("node", [PORT_CHECK_SCRIPT, ...cleanupPorts.map(String)], { stdio: "inherit" });
  } catch {
    /* diagnostic only — never fail the lane on the checker itself */
  }
}
