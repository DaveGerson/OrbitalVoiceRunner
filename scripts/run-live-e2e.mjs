// Live-lane e2e runner (4U.4 + BEAD wsm-e2e-pinned-rwnq). Sets PW_LIVE=1 portably (npm scripts
// can't set an env var cross-platform — POSIX `PW_LIVE=1 …` breaks under cmd.exe on Windows) and
// flips playwright.config.ts into the "live" project: the REAL `tsx server.ts` webServer on a fresh
// temp JANUS_DB, no ?mock=1. Extra CLI args pass through (e.g. --headed, -g).
//
// HARDENED for the bead: runs via the shared self-cleaning lane wrapper (scripts/e2eLaneRunner.mjs)
// so the run is bounded by a defense-in-depth watchdog (on top of Playwright's own globalTimeout),
// the whole child TREE is force-killed on watchdog/signal (Windows `taskkill /T`), and the live
// port (3117) is ALWAYS probed for a leak afterward — pass, fail, or timeout.
//
// `buildKillTreeCommand` is re-exported so tests can import the pure kill-tree decision from here.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { runLane, buildKillTreeCommand } from "./e2eLaneRunner.mjs";
import { LIVE_GLOBAL_TIMEOUT_MS, WATCHDOG_BUFFER_MS, LIVE_PORT } from "./e2eBudgets.mjs";

export { buildKillTreeCommand };

async function main() {
  const exit = await runLane({
    label: "live",
    playwrightArgs: ["--project=live", ...process.argv.slice(2)],
    env: { PW_LIVE: "1" },
    watchdogMs: LIVE_GLOBAL_TIMEOUT_MS + WATCHDOG_BUFFER_MS,
    cleanupPorts: [LIVE_PORT],
  });
  process.exit(exit);
}

// Run main() only when invoked directly, not when imported by the test.
const invokedDirectly =
  process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
