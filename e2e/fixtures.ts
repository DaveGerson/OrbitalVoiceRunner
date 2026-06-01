import { test as base, expect, type Page } from "@playwright/test";

/**
 * Shared e2e fixtures. `gotoMockedApp` loads the app in the deterministic ?mock=1
 * harness and waits for it to signal readiness. The inject* helpers drive the app
 * through window.__ORBITAL_E2E__ (wired to the real client handlers in App.tsx),
 * so specs exercise the actual render paths with mocked inputs.
 */

declare global {
  interface Window {
    __ORBITAL_E2E__?: {
      injectStdoutChunk: (terminalId: string, chunk: string) => void;
      injectTranscript: (sender: "User" | "Janus", text: string) => void;
      injectPendingApproval: (cmd: string, terminalId?: string) => void;
    };
  }
}

export const MOCK_TERMINAL_ID = "mock_pane_1";

export async function gotoMockedApp(page: Page): Promise<void> {
  await page.goto("/?mock=1");
  // The harness sets this attribute once mock data is seeded and hooks installed.
  await page.waitForSelector("html[data-e2e-ready='1']", { timeout: 15_000 });
  await expect(page.getByTestId("terminal-pane")).toBeVisible();
}

export async function injectStdoutChunk(page: Page, terminalId: string, chunk: string): Promise<void> {
  await page.evaluate(
    ([id, c]) => window.__ORBITAL_E2E__?.injectStdoutChunk(id, c),
    [terminalId, chunk] as const,
  );
}

export async function injectTranscript(page: Page, sender: "User" | "Janus", text: string): Promise<void> {
  await page.evaluate(
    ([s, t]) => window.__ORBITAL_E2E__?.injectTranscript(s as "User" | "Janus", t),
    [sender, text] as const,
  );
}

export async function injectPendingApproval(page: Page, cmd: string, terminalId = MOCK_TERMINAL_ID): Promise<void> {
  await page.evaluate(
    ([c, id]) => window.__ORBITAL_E2E__?.injectPendingApproval(c, id),
    [cmd, terminalId] as const,
  );
}

export const test = base;
export { expect };
