// tests/test_mocklive_loader.ts — bead c1ky (insight b) + 1p84: acceptance for `loadMockLive()`,
// an exported async loader in tests/helpers/mockLive.ts that OWNS the env guard
// (JANUS_NO_AUTOSTART=1) and a STABLE scratch root for JANUS_DB — a mkdtemp'd directory OUTSIDE
// the repo checkout AND outside any per-suite tmpdir, so the process-wide JanusStore singleton
// (opened once, at the FIRST post-chdir dynamic import of server.ts) never roots at a per-suite
// tmpdir a later afterEach rmSync's out from under the still-open sqlite handle (the 1p84 leak).
//
// FAILS before the fix: loadMockLive is not exported from tests/helpers/mockLive.ts.
//
// Runner: npx tsx --test --test-force-exit tests/test_mocklive_loader.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const mockLiveUrl = pathToFileURL(path.join(__dirname, "helpers", "mockLive.ts")).href;

test("loadMockLive() exists and returns the mockLive surface", async () => {
  const mod = await import("./helpers/mockLive");
  assert.equal(typeof (mod as any).loadMockLive, "function", "loadMockLive must be exported");
  const m = await (mod as any).loadMockLive();
  assert.equal(typeof m.installMockLive, "function");
  assert.equal(typeof m.setLiveConnector, "function");
});

test("loadMockLive() sets JANUS_NO_AUTOSTART=1", async () => {
  const { loadMockLive } = await import("./helpers/mockLive");
  await (loadMockLive as any)();
  assert.equal(process.env.JANUS_NO_AUTOSTART, "1");
});

test("loadMockLive() roots JANUS_DB at an absolute path under the OS tmpdir, never the repo", async () => {
  const { loadMockLive } = await import("./helpers/mockLive");
  await (loadMockLive as any)();
  const janusDb = process.env.JANUS_DB;
  assert.ok(janusDb, "JANUS_DB must be set");
  assert.ok(path.isAbsolute(janusDb!), `JANUS_DB must be absolute, got: ${janusDb}`);
  assert.ok(
    janusDb!.startsWith(os.tmpdir()),
    `JANUS_DB must live under the OS tmpdir, got: ${janusDb}`,
  );
  assert.ok(
    !janusDb!.startsWith(repoRoot),
    `JANUS_DB must NOT live under the repo checkout, got: ${janusDb}`,
  );
});

test("loadMockLive() is idempotent: a second call leaves JANUS_DB unchanged (single memoized scratch root)", async () => {
  const { loadMockLive } = await import("./helpers/mockLive");
  await (loadMockLive as any)();
  const first = process.env.JANUS_DB;
  await (loadMockLive as any)();
  const second = process.env.JANUS_DB;
  assert.equal(second, first, "loadMockLive must not mint a new scratch root on repeat calls");
});

// Respect-explicit: a caller that pre-sets JANUS_DB before the FIRST loadMockLive() call owns
// that choice — the loader must not clobber it. This mutates process env in a way that could
// pollute other tests in this same file/process, so it runs in an isolated child process.
test("loadMockLive() respects an explicitly pre-set JANUS_DB (subprocess)", () => {
  const script = `
    process.env.JANUS_DB = "explicit-marker.db";
    const { loadMockLive } = await import(${JSON.stringify(mockLiveUrl)});
    await loadMockLive();
    if (process.env.JANUS_DB !== "explicit-marker.db") {
      console.error("MISMATCH:" + process.env.JANUS_DB);
      process.exit(1);
    }
    process.exit(0);
  `;
  const res = spawnSync("npx", ["tsx", "-e", script], {
    cwd: repoRoot,
    encoding: "utf8",
    shell: true,
  });
  assert.equal(
    res.status,
    0,
    `child exited ${res.status}; stdout=${res.stdout}\nstderr=${res.stderr}`,
  );
});
