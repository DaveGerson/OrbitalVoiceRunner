// tests/test_run_unit_cleanliness.ts — bead 1p84: unit-tests the pure repo-root-leak detector
// extracted into scripts/run-unit.mjs. Mirrors the existing exported-pure-core tests
// (parseTapFailures/decideOutcome, same file) for the same reason: a Node-builtins-only script
// with pure logic exported for direct unit coverage, no process spawning needed here.
//
// FAILS before the fix: detectRepoRootLeak is not exported from scripts/run-unit.mjs.
//
// Runner: npx tsx --test --test-force-exit tests/test_run_unit_cleanliness.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { detectRepoRootLeak } from "../scripts/run-unit.mjs";

test("detectRepoRootLeak: a sentinel absent before and present after is a leak", () => {
  const leaked = detectRepoRootLeak({ ".janus.db": false }, { ".janus.db": true });
  assert.deepEqual(leaked, [".janus.db"]);
});

test("detectRepoRootLeak: a pre-existing operator DB is NOT flagged (no false-red)", () => {
  const leaked = detectRepoRootLeak({ ".janus.db": true }, { ".janus.db": true });
  assert.deepEqual(leaked, []);
});

test("detectRepoRootLeak: absent both before and after is not a leak", () => {
  const leaked = detectRepoRootLeak({ ".janus.db": false }, { ".janus.db": false });
  assert.deepEqual(leaked, []);
});

test("detectRepoRootLeak: present before but absent after is not flagged as a NEW leak", () => {
  // (a suite legitimately cleaning up a pre-existing file is not what this detector polices)
  const leaked = detectRepoRootLeak({ ".janus.db": true }, { ".janus.db": false });
  assert.deepEqual(leaked, []);
});

test("detectRepoRootLeak covers .janus.db, -wal, -shm, and .janus_settings.json", () => {
  const before = {
    ".janus.db": false,
    ".janus.db-wal": false,
    ".janus.db-shm": false,
    ".janus_settings.json": false,
  };
  const after = {
    ".janus.db": true,
    ".janus.db-wal": true,
    ".janus.db-shm": true,
    ".janus_settings.json": true,
  };
  const leaked = detectRepoRootLeak(before, after);
  assert.deepEqual(
    [...leaked].sort(),
    [".janus.db", ".janus.db-shm", ".janus.db-wal", ".janus_settings.json"].sort(),
  );
});

test("detectRepoRootLeak: mixed sentinels only flags the genuinely-new ones", () => {
  const before = { ".janus.db": true, ".janus_settings.json": false };
  const after = { ".janus.db": true, ".janus_settings.json": true };
  const leaked = detectRepoRootLeak(before, after);
  assert.deepEqual(leaked, [".janus_settings.json"]);
});
