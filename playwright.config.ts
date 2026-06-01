import { defineConfig, devices } from "@playwright/test";

/**
 * E2E config. The React app is served standalone by Vite and driven entirely
 * client-side via the ?mock=1 harness (see src/App.tsx) — no backend, no auth,
 * fully deterministic. Specs inject mocked text/terminal inputs through
 * window.__ORBITAL_E2E__ and (for resize) intercept the outgoing POST.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "npx vite --port 5173 --strictPort",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
