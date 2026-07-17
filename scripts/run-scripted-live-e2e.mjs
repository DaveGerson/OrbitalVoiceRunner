// Scripted-live e2e runner (BEAD wsm-e2e-pinned-s1ap, mirrors scripts/run-live-e2e.mjs). Sets
// PW_SCRIPTED=1 portably (npm scripts can't set an env var cross-platform — POSIX `PW_SCRIPTED=1 …`
// breaks under cmd.exe on Windows) and flips playwright.config.ts into the "scripted" project: the
// REAL `tsx server.ts` webServer on its OWN fresh temp JANUS_DB + its OWN port, booted with
// JANUS_MOCK_LIVE=1 so the in-process scripted Gemini Live connector + loopback-only control channel
// are active (src/voice/scriptedLiveConnector.ts). No ?mock=1, no real Gemini key, no microphone.
// Extra CLI args pass through (e.g. --headed, -g).
//
// Runs via the SAME shared self-cleaning lane wrapper the live lane uses
// (scripts/e2eLaneRunner.mjs): Playwright's own globalTimeout bounds the run, a defense-in-depth
// watchdog force-kills the child TREE if that fails (Windows `taskkill /T`), and the scripted lane's
// port (3118, or PW_SCRIPTED_PORT) is ALWAYS probed for a leak afterward — pass, fail, or timeout.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { runLane } from "./e2eLaneRunner.mjs";
import { SCRIPTED_GLOBAL_TIMEOUT_MS, WATCHDOG_BUFFER_MS, SCRIPTED_PORT } from "./e2eBudgets.mjs";

async function main() {
  const exit = await runLane({
    label: "scripted",
    playwrightArgs: ["--project=scripted", ...process.argv.slice(2)],
    env: { PW_SCRIPTED: "1" },
    watchdogMs: SCRIPTED_GLOBAL_TIMEOUT_MS + WATCHDOG_BUFFER_MS,
    cleanupPorts: [Number(process.env.PW_SCRIPTED_PORT || SCRIPTED_PORT)],
  });
  process.exit(exit);
}

// Run main() only when invoked directly, not when imported by the test.
const invokedDirectly =
  process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
