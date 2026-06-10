import { defineConfig, devices } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * E2E config — TWO lanes:
 *
 * • MOCK (default, `npm run test:e2e`): the React app is served standalone by Vite and driven
 *   entirely client-side via the ?mock=1 harness (see src/e2e/harness.ts) — no backend, no auth,
 *   fully deterministic. Specs inject mocked inputs through window.__ORBITAL_E2E__ and intercept
 *   outgoing wires (the Playwright-armed 3C.3b marker).
 *
 * • LIVE (`npm run test:e2e:live`, which sets PW_LIVE=1 via scripts/run-live-e2e.mjs): the REAL
 *   dev server (`tsx server.ts` — Express + WS + Vite middleware) on a FRESH temp state set
 *   (JANUS_DB / settings / legacy-ledger path all pointed at a per-run temp dir, so the repo's
 *   own .janus* state is never touched and the boot-time JSON→SQLite migration finds nothing to
 *   import). No ?mock=1: pane creation, the capability gate, stop-all and clear-exited run
 *   end-to-end against the real REST + observe-WS surface. Boots WITHOUT a GEMINI key (the
 *   GoogleGenAI client only warns; the live lane never opens a voice session). One serial spec,
 *   generous timeouts (real PTY spawns).
 */
const LIVE = process.env.PW_LIVE === "1";
const LIVE_PORT = Number(process.env.PW_LIVE_PORT || 3117);
// Per-run temp state for the live server. Keyed by pid so a worker re-evaluating this config
// computes the same path as the runner process that started the webServer's parent.
const LIVE_STATE_DIR = path.join(os.tmpdir(), `orbital-live-e2e-${process.pid}`);
if (LIVE) fs.mkdirSync(LIVE_STATE_DIR, { recursive: true });

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: LIVE ? `http://127.0.0.1:${LIVE_PORT}` : "http://localhost:5173",
    trace: "on-first-retry",
  },
  projects: LIVE
    ? [
        {
          name: "live",
          testMatch: /live_kitchen\.spec\.ts/,
          timeout: 180_000, // real server, real PTYs — generous by design
          use: { ...devices["Desktop Chrome"] },
        },
      ]
    : [
        // The default lane stays mock-only: the live spec is excluded here so `npm run test:e2e`
        // never needs (or touches) a real server.
        { name: "chromium", testIgnore: /live_kitchen\.spec\.ts/, use: { ...devices["Desktop Chrome"] } },
      ],
  webServer: LIVE
    ? {
        command: "npx tsx server.ts",
        url: `http://127.0.0.1:${LIVE_PORT}/`,
        reuseExistingServer: false, // the live lane owns a FRESH server + state, always
        timeout: 120_000,
        env: {
          PORT: String(LIVE_PORT),
          // Fresh, isolated state: a temp SQLite DB; settings + legacy-ledger paths pointed into
          // the temp dir so defaults apply deterministically (global mode Inherit, gates default)
          // and the repo root's real .janus* files are neither read nor renamed by the migration.
          JANUS_DB: path.join(LIVE_STATE_DIR, "janus-live.db"),
          JANUS_SETTINGS_PATH: path.join(LIVE_STATE_DIR, "janus-settings.json"),
          JANUS_LEDGER_PATH: path.join(LIVE_STATE_DIR, "janus-ledger.json"),
          // Pinned token (the browser is keyed automatically via the auto-seeded auth cookie).
          API_AUTH_TOKEN: "orbital-live-e2e",
        },
      }
    : {
        command: "npx vite --port 5173 --strictPort",
        url: "http://localhost:5173",
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
      },
});
