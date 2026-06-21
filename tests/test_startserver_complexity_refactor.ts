// tests/test_startserver_complexity_refactor.ts — CHARACTERIZATION test for the cyclomatic-
// complexity burndown refactor of server.ts's `startServer` (the server bootstrap, CC 29 -> <=10).
//
// The refactor was PURE code-motion: groups of route/middleware registrations and a handful of
// boot-time derivations were extracted into named helpers called from startServer in the EXACT
// same order. Most of those helpers (registerAuthMiddleware / registerRawInputRoute /
// registerDraftAndSettingsRoutes / mountFrontend / startRetentionSweepTimer / listenServer /
// createMemorySubsystem) bind a live Express app, a real PTY manager, or an http listener, so they
// are integration-level — their true gate is the e2e-live lane (NOT run here). They are pinned only
// by `tsc --noEmit` + the isolated eslint (startServer <= 10) + verbatim extraction review.
//
// This file pins the ONE pure, deterministic helper that was extracted: clampMemorySynthTimeoutMs.
// It is the boot-time clamp of the persisted memory-synth deadline (a 0/negative/NaN/non-number
// value would fire synthesizeAsync's race timer immediately, since `??` does not catch 0), so the
// clamp floors it to the 150ms default. These pins lock the exact branch lattice of the inline
// ternary the helper replaced.
//
// Importing ../server has module-level side effects (store + manager construction). Per the
// established sibling pattern (tests/test_raw_input_endpoint.ts) we set JANUS_NO_AUTOSTART=1 BEFORE
// the dynamic import so the bundle does not auto-bind a listener at import time.
//
// Runner: npx tsx --test --test-force-exit tests/test_startserver_complexity_refactor.ts

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

let clampMemorySynthTimeoutMs: (raw: unknown) => number;

before(async () => {
  process.env.JANUS_NO_AUTOSTART = "1";
  const mod = await import("../server");
  clampMemorySynthTimeoutMs = mod.clampMemorySynthTimeoutMs;
});

describe("clampMemorySynthTimeoutMs (startServer memory-deadline clamp)", () => {
  it("passes through a finite positive number unchanged", () => {
    assert.equal(clampMemorySynthTimeoutMs(500), 500);
    assert.equal(clampMemorySynthTimeoutMs(1), 1);
    assert.equal(clampMemorySynthTimeoutMs(150), 150);
    assert.equal(clampMemorySynthTimeoutMs(2_000_000), 2_000_000);
  });

  it("floors 0 to the 150ms default (the bug the clamp exists to prevent)", () => {
    // ?? does NOT catch 0, so a persisted 0 would fire the race timer immediately -> permanent
    // fallback. The clamp must convert it to 150.
    assert.equal(clampMemorySynthTimeoutMs(0), 150);
  });

  it("floors a negative number to 150", () => {
    assert.equal(clampMemorySynthTimeoutMs(-1), 150);
    assert.equal(clampMemorySynthTimeoutMs(-9999), 150);
  });

  it("floors NaN / Infinity / -Infinity to 150 (non-finite)", () => {
    assert.equal(clampMemorySynthTimeoutMs(NaN), 150);
    assert.equal(clampMemorySynthTimeoutMs(Infinity), 150);
    assert.equal(clampMemorySynthTimeoutMs(-Infinity), 150);
  });

  it("floors a non-number (undefined/null/string) to 150", () => {
    assert.equal(clampMemorySynthTimeoutMs(undefined), 150);
    assert.equal(clampMemorySynthTimeoutMs(null), 150);
    assert.equal(clampMemorySynthTimeoutMs("300"), 150);
    assert.equal(clampMemorySynthTimeoutMs({}), 150);
  });
});
