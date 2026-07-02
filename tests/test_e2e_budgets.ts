// tests/test_e2e_budgets.ts — regression guard for the E2E lane time budgets (BEAD wsm-e2e-pinned-rwnq).
//
// The bead requires each full E2E lane to have a bounded runtime that sits COMFORTABLY under its
// external wall-clock kill (10 min mock, 15 min live) so Playwright stops itself first and runs its
// own teardown, instead of being SIGKILLed from outside and orphaning the webServer child. This
// test encodes that "comfortably under" invariant as data so a future timeout bump that erases the
// margin fails loudly here rather than silently re-introducing the orphan/masking bug.
//
// Runner: npx tsx --test --test-force-exit tests/test_e2e_budgets.ts

import { test } from "node:test";
import assert from "node:assert";

import {
  MOCK_GLOBAL_TIMEOUT_MS,
  LIVE_GLOBAL_TIMEOUT_MS,
  OUTER_MOCK_WALL_MS,
  OUTER_LIVE_WALL_MS,
  WATCHDOG_BUFFER_MS,
} from "../scripts/e2eBudgets.mjs";

// A real safety margin, not merely "less than". If someone bumps a global timeout to within a
// minute of the wall, that is effectively unbounded again from the orchestrator's perspective.
const MARGIN_MS = 60_000;

test("mock lane global timeout sits comfortably under the outer mock wall", () => {
  assert.ok(
    MOCK_GLOBAL_TIMEOUT_MS + MARGIN_MS <= OUTER_MOCK_WALL_MS,
    `mock global timeout (${MOCK_GLOBAL_TIMEOUT_MS}) + margin must be <= outer wall (${OUTER_MOCK_WALL_MS})`,
  );
});

test("live lane global timeout sits comfortably under the outer live wall", () => {
  assert.ok(
    LIVE_GLOBAL_TIMEOUT_MS + MARGIN_MS <= OUTER_LIVE_WALL_MS,
    `live global timeout (${LIVE_GLOBAL_TIMEOUT_MS}) + margin must be <= outer wall (${OUTER_LIVE_WALL_MS})`,
  );
});

test("wrapper watchdog (globalTimeout + buffer) still fires before the outer wall", () => {
  // The defense-in-depth watchdog fires LATER than Playwright's globalTimeout but must still beat
  // the external wall, otherwise the orphan path the bead reports can recur.
  assert.ok(
    MOCK_GLOBAL_TIMEOUT_MS + WATCHDOG_BUFFER_MS < OUTER_MOCK_WALL_MS,
    "mock watchdog must fire before the outer mock wall",
  );
  assert.ok(
    LIVE_GLOBAL_TIMEOUT_MS + WATCHDOG_BUFFER_MS < OUTER_LIVE_WALL_MS,
    "live watchdog must fire before the outer live wall",
  );
});

test("budgets are positive, ordered numbers", () => {
  for (const v of [MOCK_GLOBAL_TIMEOUT_MS, LIVE_GLOBAL_TIMEOUT_MS, OUTER_MOCK_WALL_MS, OUTER_LIVE_WALL_MS, WATCHDOG_BUFFER_MS]) {
    assert.equal(typeof v, "number");
    assert.ok(v > 0, "every budget must be a positive number of ms");
  }
  // Live gets a longer leash than mock (real PTY spawns), and each wall exceeds its own cap.
  assert.ok(LIVE_GLOBAL_TIMEOUT_MS > MOCK_GLOBAL_TIMEOUT_MS);
  assert.ok(OUTER_LIVE_WALL_MS > OUTER_MOCK_WALL_MS);
});
