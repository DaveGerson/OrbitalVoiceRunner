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
      injectPendingAction: (capability: string, summary: string) => void;
      injectWipDraft: (paneId: string, text: string) => void;
      simulateDisconnect: () => void;
      simulateReconnect: () => string | null;
      setPostureMock: (posture: "OPEN" | "GUARDED" | "LOCKED", effectiveGates: Record<string, "Auto" | "Ask" | "Off">) => void;
      setFrozenMock: (frozen: boolean, running: string[]) => void;
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

export async function injectPendingAction(page: Page, capability: string, summary: string): Promise<void> {
  await page.evaluate(
    ([c, s]) => window.__ORBITAL_E2E__?.injectPendingAction(c, s),
    [capability, summary] as const,
  );
}

/** U3: stage a WIP draft for `paneId` so the Sync Spec tab's draft-pending badge can be exercised. */
export async function injectWipDraft(page: Page, paneId: string, text: string): Promise<void> {
  await page.evaluate(
    ([p, t]) => window.__ORBITAL_E2E__?.injectWipDraft(p, t),
    [paneId, text] as const,
  );
}

/** WS-F (spec §6.1): model a WS drop. The harness KEEPS staged survivors (detach, not purge). */
export async function simulateDisconnect(page: Page): Promise<void> {
  await page.evaluate(() => window.__ORBITAL_E2E__?.simulateDisconnect());
}

/**
 * WS-F (spec §6.2/§7): model a reconnect. The harness pushes ONE batched resumption digest across the
 * surviving staged items and returns it (or `null` when there were none → silent). Chips repopulate.
 */
export async function simulateReconnect(page: Page): Promise<string | null> {
  return page.evaluate(() => window.__ORBITAL_E2E__?.simulateReconnect() ?? null);
}

/** bead 8sq: set the mock pane's server-resolved posture so the GateChip renders deterministically. */
export async function setPostureMock(
  page: Page,
  posture: "OPEN" | "GUARDED" | "LOCKED",
  effectiveGates: Record<string, "Auto" | "Ask" | "Off">,
): Promise<void> {
  await page.evaluate(
    ([p, g]) => window.__ORBITAL_E2E__?.setPostureMock(p as "OPEN" | "GUARDED" | "LOCKED", g as Record<string, "Auto" | "Ask" | "Off">),
    [posture, effectiveGates] as const,
  );
}

/** bead 8sq: drive the two-stage STOP-ALL FROZEN banner (frozen flag + still-running pane count). */
export async function setFrozenMock(page: Page, frozen: boolean, running: string[] = []): Promise<void> {
  await page.evaluate(
    ([f, r]) => window.__ORBITAL_E2E__?.setFrozenMock(f as boolean, r as string[]),
    [frozen, running] as const,
  );
}

export const test = base;
export { expect };
