// tests/test_settings_path_anchor.ts
//
// BEAD kqy (P1) — settingsFilePath cwd-relative hazard.
//
// loadSettings()/saveSettings() read/write .janus_settings.json RELATIVE to
// process.cwd(). If the server is launched from a different cwd than the repo
// root, it silently reads a DIFFERENT (or missing) settings file -> no Gemini
// key -> voice dead. CONFIRMED in practice 2026-06-04.
//
// FIX: honor an env override JANUS_SETTINGS_PATH (a stable, portable anchor that
// works under both tsx-dev and the bundled dist/server.cjs, where __dirname
// differs). When set, the resolved path must be ABSOLUTE and INDEPENDENT of
// process.cwd(). When UNSET, stay backward-compatible: a server started from the
// repo root must still find the existing cwd-relative .janus_settings.json.
//
// SECRET INVARIANT: never assert on / log the Gemini key here — only the PATH.
//
// Runner: npx tsx --test --test-force-exit tests/test_settings_path_anchor.ts
import { test } from "node:test";
import assert from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { OrchestratorManager } from "../src/terminal";

test("JANUS_SETTINGS_PATH override: resolved settings path is ABSOLUTE and independent of process.cwd()", () => {
  const anchorDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-anchor-"));
  const anchorFile = path.join(anchorDir, ".janus_settings.json");
  // A DIFFERENT cwd from the anchor — this is the exact hazard: launched-from cwd
  // diverges from where settings actually live.
  const cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-cwd-"));
  const prevCwd = process.cwd();
  const prevEnv = process.env.JANUS_SETTINGS_PATH;
  process.env.JANUS_SETTINGS_PATH = anchorFile;
  process.chdir(cwdDir);
  try {
    const m = new OrchestratorManager();
    const resolved = m.getSettingsFilePath();
    // ABSOLUTE — never a bare cwd-relative ".janus_settings.json".
    assert.ok(path.isAbsolute(resolved), `resolved settings path must be absolute, got: ${resolved}`);
    // INDEPENDENT of cwd — it must point at the ANCHOR, not the launch cwd.
    assert.strictEqual(resolved, anchorFile, "resolved path must honor JANUS_SETTINGS_PATH (the stable anchor)");
    assert.notStrictEqual(
      resolved,
      path.join(cwdDir, ".janus_settings.json"),
      "resolved path must NOT track the launch cwd when the env override is set",
    );
    // And the file actually lands at the anchor, not in cwd.
    assert.ok(fs.existsSync(anchorFile), "settings file is written to the anchor path");
    assert.ok(!fs.existsSync(path.join(cwdDir, ".janus_settings.json")), "no settings file leaks into the launch cwd");
  } finally {
    process.chdir(prevCwd);
    if (prevEnv === undefined) delete process.env.JANUS_SETTINGS_PATH;
    else process.env.JANUS_SETTINGS_PATH = prevEnv;
    fs.rmSync(anchorDir, { recursive: true, force: true });
    fs.rmSync(cwdDir, { recursive: true, force: true });
  }
});

test("backward-compat: with JANUS_SETTINGS_PATH UNSET, settings still land at the cwd-relative .janus_settings.json", () => {
  const cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-bc-"));
  const prevCwd = process.cwd();
  const prevEnv = process.env.JANUS_SETTINGS_PATH;
  delete process.env.JANUS_SETTINGS_PATH;
  process.chdir(cwdDir);
  try {
    const m = new OrchestratorManager();
    const resolved = m.getSettingsFilePath();
    // The existing on-disk contract: a server from the repo root finds/writes the
    // cwd-relative file (this is what the secrets-at-rest suite relies on).
    assert.strictEqual(
      path.resolve(resolved),
      path.join(cwdDir, ".janus_settings.json"),
      "unset override must keep the cwd-relative .janus_settings.json (back-compat)",
    );
    assert.ok(fs.existsSync(path.join(cwdDir, ".janus_settings.json")), "settings file written at cwd as before");
  } finally {
    process.chdir(prevCwd);
    if (prevEnv === undefined) delete process.env.JANUS_SETTINGS_PATH;
    else process.env.JANUS_SETTINGS_PATH = prevEnv;
    fs.rmSync(cwdDir, { recursive: true, force: true });
  }
});
