// tests/helpers/settingsPath.ts — bead eoef: pin JANUS_SETTINGS_PATH into a fresh tmpdir for the
// whole test process.
//
// WHY: OrchestratorManager.resolveSettingsPath falls back to a cwd-relative ".janus_settings.json"
// when JANUS_SETTINGS_PATH is unset — so any server-booting test file that constructs a manager
// (directly or via startServer) without pinning first writes .janus_settings.json into the repo
// root during a battery run. The run-unit cleanliness gate (bead 1p84) fails the battery on that
// leak. Call this ONCE at module top of any such test file, BEFORE any test registers:
//
//   import { pinSettingsPathToTmpdir } from "./helpers/settingsPath";
//   pinSettingsPathToTmpdir();
//
// Node's test runner executes each test FILE in its own child process, so a module-level pin
// cannot bleed into other files, and no restore is needed (the process exits). Files that need a
// per-case settings path (e.g. tests/test_boot_recovery_summary.ts) keep their own before/after
// management — a later explicit assignment simply overrides this baseline pin.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Point JANUS_SETTINGS_PATH at a fresh tmpdir file; returns that path. Cleans up on process exit
 *  (best-effort — a leftover tmpdir holds one small gitignored json, never a repo-root artifact). */
export function pinSettingsPathToTmpdir(prefix = "janus-test-settings-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const settingsPath = join(dir, ".janus_settings.json");
  process.env.JANUS_SETTINGS_PATH = settingsPath;
  process.on("exit", () => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });
  return settingsPath;
}
