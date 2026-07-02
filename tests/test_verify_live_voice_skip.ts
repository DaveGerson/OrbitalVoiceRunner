/**
 * tests/test_verify_live_voice_skip.ts — bead wsm-e2e-pinned-vpy1
 *
 * The only sub-behavior of scripts/verify-live-voice.ts that's meaningfully unit-testable
 * without a real, paid GEMINI_API_KEY + network egress: its env-gate. When GEMINI_API_KEY is
 * unset/empty, the script MUST print a clear SKIP line and exit 0 (never fail CI for lacking
 * live credentials). The real Gemini Live round-trip logic is validated manually — see
 * docs/runbooks/live-voice-verify.md.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, "..", "scripts", "verify-live-voice.ts");

function runWithout(key: string | undefined): { status: number | null; stdout: string; stderr: string } {
  const env = { ...process.env };
  delete env.GEMINI_API_KEY;
  if (key !== undefined) env.GEMINI_API_KEY = key;
  const res = spawnSync(process.execPath, ["--import", "tsx", SCRIPT], {
    cwd: path.join(here, ".."),
    env,
    encoding: "utf8",
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

test("verify-live-voice: exits 0 with a clear SKIP message when GEMINI_API_KEY is unset", () => {
  const { status, stdout } = runWithout(undefined);
  assert.equal(status, 0, `expected exit 0, got ${status}; stdout=${stdout}`);
  assert.match(stdout, /SKIP/);
  assert.match(stdout, /GEMINI_API_KEY/);
});

test("verify-live-voice: exits 0 with a clear SKIP message when GEMINI_API_KEY is empty string", () => {
  const { status, stdout } = runWithout("");
  assert.equal(status, 0, `expected exit 0, got ${status}; stdout=${stdout}`);
  assert.match(stdout, /SKIP/);
});
