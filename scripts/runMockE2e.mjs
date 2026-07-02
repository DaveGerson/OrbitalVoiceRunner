// Mock-lane e2e runner (BEAD wsm-e2e-pinned-rwnq). The mock lane used to be invoked directly as
// `"test:e2e": "playwright test"` — no wrapper, so there was nowhere to bound runtime or clean up,
// and an external SIGKILL of a stuck run orphaned the `vite --port 5173` webServer.
//
// This wraps the FULL mock suite (no coverage dropped — CI still runs every spec) via the shared
// self-cleaning lane wrapper (scripts/e2eLaneRunner.mjs): Playwright's own globalTimeout bounds the
// run, a defense-in-depth watchdog force-kills the child TREE if that fails (Windows `taskkill /T`),
// and port 5173 is ALWAYS probed for a leak afterward — pass, fail, or timeout. Extra CLI args pass
// through (e.g. -g, --headed, --shard=1/2).
//
// NOTE ON COVERAGE / SHARDING: this runs the complete suite (all specs, one Playwright invocation).
// If a measured full run approaches MOCK_GLOBAL_TIMEOUT_MS, split it EXPLICITLY into sequential
// `--shard=1/2` + `--shard=2/2` invocations here and document it — the bead forbids SILENT
// de-scoping, so any coverage split must be visible in this file and reported, never implicit.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { runLane } from "./e2eLaneRunner.mjs";
import { MOCK_GLOBAL_TIMEOUT_MS, WATCHDOG_BUFFER_MS, MOCK_PORT } from "./e2eBudgets.mjs";

async function main() {
  const exit = await runLane({
    label: "mock",
    playwrightArgs: [...process.argv.slice(2)],
    watchdogMs: MOCK_GLOBAL_TIMEOUT_MS + WATCHDOG_BUFFER_MS,
    cleanupPorts: [MOCK_PORT],
  });
  process.exit(exit);
}

// Run main() only when invoked directly, not when imported by a test.
const invokedDirectly =
  process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
