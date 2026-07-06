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
let resolveCortexPrimaryFlagFromEnv: (raw: string | undefined) => boolean;

before(async () => {
  process.env.JANUS_NO_AUTOSTART = "1";
  const mod = await import("../server");
  clampMemorySynthTimeoutMs = mod.clampMemorySynthTimeoutMs;
  resolveCortexPrimaryFlagFromEnv = mod.resolveCortexPrimaryFlagFromEnv;
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

// Wave 4 (896, 2026-07-02) revert-fix (fixer review, 2026-07-03): spec D5 says the flip's default
// becomes PRIMARY (unset or "1") once the battery is green under that mode; `JANUS_CORTEX_PRIMARY=0`
// is the escape hatch (the JANUS_LEDGER_BACKEND=legacy analog). A prior integration pass shipped the
// OPPOSITE default (OFF-unless-explicitly-"1") because flipping regressed fixtures that boot with no
// warm daemon — those fixtures are now pinned to explicit `setCortexPrimary(false)` instead (see
// tests/test_context_smoke_journeys.ts, tests/test_context_injection_telemetry.ts,
// tests/test_cortex_cutover_journeys.ts), unblocking this default flip. These pins lock the exact
// env-string lattice the boot-time flip parses.
describe("resolveCortexPrimaryFlagFromEnv (the CORTEX FLIP's default-resolution, D5)", () => {
  it("unset or empty -> primary (the new default)", () => {
    assert.equal(resolveCortexPrimaryFlagFromEnv(undefined), true);
    assert.equal(resolveCortexPrimaryFlagFromEnv(""), true);
    assert.equal(resolveCortexPrimaryFlagFromEnv("   "), true);
  });

  it('"1"/"true"/"on"/"yes" (any case) -> primary', () => {
    for (const v of ["1", "true", "TRUE", "on", "On", "yes", "YES"]) {
      assert.equal(resolveCortexPrimaryFlagFromEnv(v), true, `expected primary for ${v}`);
    }
  });

  it('"0"/"false"/"off"/"no" (any case) -> the floor-only escape hatch', () => {
    for (const v of ["0", "false", "FALSE", "off", "Off", "no", "NO"]) {
      assert.equal(resolveCortexPrimaryFlagFromEnv(v), false, `expected floor-only for ${v}`);
    }
  });

  it("an unrecognized non-empty value fails toward primary, not silently toward the floor", () => {
    // Only the recognized off-tokens opt out; anything else (including typos/garbage) keeps the
    // D5 default rather than silently downgrading to the floor on a config typo.
    assert.equal(resolveCortexPrimaryFlagFromEnv("banana"), true);
  });
});
