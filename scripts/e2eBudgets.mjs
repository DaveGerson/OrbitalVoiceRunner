// scripts/e2eBudgets.mjs — single source of truth for the E2E lane time budgets (BEAD wsm-e2e-pinned-rwnq).
//
// WHY THIS EXISTS: both lanes used to have NO run-wide cap, so the only thing that ever stopped a
// stuck/slow run was the orchestrator's external wall-clock SIGKILL — which fires from OUTSIDE
// Playwright, skipping Playwright's own webServer teardown and orphaning the `vite --port 5173` /
// `tsx server.ts` child (the leaked 5173/3117 listeners the bead reports). Bounding each lane with
// a Playwright `globalTimeout` that sits COMFORTABLY under its outer wall lets Playwright stop
// itself first, print a clear timeout summary, and run its normal teardown.
//
// These are exported as DATA (not inlined in playwright.config.ts) so the safety margin between the
// in-runner cap and the external wall is independently unit-testable (tests/test_e2e_budgets.ts) —
// a regression guard that fails loudly if someone bumps one number without re-checking the other.
//
// CONSTRAINT: Node built-ins only, no imports — consumed by both an ESM Playwright config and a
// node:test file.

const MINUTE_MS = 60_000;

// The external wall-clock kills the orchestrator applies to each lane (the hard SIGKILL that
// orphans children). Our in-runner caps MUST stay comfortably below these.
export const OUTER_MOCK_WALL_MS = 10 * MINUTE_MS; // `npm run test:e2e`
export const OUTER_LIVE_WALL_MS = 15 * MINUTE_MS; // `npm run test:e2e:live`
// BEAD wsm-e2e-pinned-s1ap: the scripted lane boots the same real `tsx server.ts` + vite middleware
// as the live lane (JANUS_MOCK_LIVE=1 instead of a real Gemini key) — same cost profile, same wall.
export const OUTER_SCRIPTED_WALL_MS = 15 * MINUTE_MS; // `npm run test:e2e:scripted`

// Playwright `globalTimeout` per lane: Playwright itself aborts the run here — well before the
// outer wall — so it emits its own summary and runs its normal webServer teardown.
export const MOCK_GLOBAL_TIMEOUT_MS = 7 * MINUTE_MS; // 3 min headroom under the 10 min mock wall
export const LIVE_GLOBAL_TIMEOUT_MS = 9 * MINUTE_MS; // 6 min headroom under the 15 min live wall
export const SCRIPTED_GLOBAL_TIMEOUT_MS = 9 * MINUTE_MS; // mirrors LIVE_GLOBAL_TIMEOUT_MS — same wall

// Defense-in-depth watchdog buffer added on top of a lane's globalTimeout inside the wrapper
// scripts: if Playwright's own globalTimeout somehow fails to fire (or teardown hangs), the
// wrapper's watchdog tree-kills the child this many ms LATER — still comfortably under the wall.
export const WATCHDOG_BUFFER_MS = 60_000;

// Ports the lanes bind (Vite mock server / live tsx server / scripted tsx server). Post-run cleanup
// checks these. SCRIPTED gets its OWN port (not LIVE_PORT) so a stray leaked live-lane server can
// never collide with a scripted-lane run (or vice versa) even if both leaked from a prior run.
export const MOCK_PORT = 5173;
export const LIVE_PORT = 3117;
export const SCRIPTED_PORT = 3118;
