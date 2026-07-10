import { expect, test, type Page } from "@playwright/test";
import { armE2EWire } from "./fixtures";

// Phase 3, Step 3.3 — the Instruction Workbench (exchange draft state + controls) surfacing in the
// Kitchen burner's Order Pad. Follows the exact mock (?mock=1) harness idiom orbital_burner.spec.ts
// already uses: armE2EWire() pre-arms the wire so mock-mode mutations fire real REST calls we can
// intercept + assert, and `injectWsFrame` (window.__ORBITAL_E2E__) seeds the additive `exchange`
// field on a draft_updated frame — the SAME frame shape server.ts's broadcastDraft now emits.

async function gotoKitchen(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await armE2EWire(page);
  await page.goto("/?ui=kitchen&mock=1");
  await page.waitForSelector("html[data-e2e-ready='1']");
}

async function openBurner(page: Page) {
  await gotoKitchen(page);
  await page.locator('[data-testid="station-card"][data-pane-id="mock_pane_1"]').first().click();
  await expect(page.getByTestId("burner")).toBeVisible();
}

interface MockExchange {
  exchangeId: string;
  target: { projectId: string; paneId: string } | null;
  objective: string;
  relevantContext: string[];
  constraints: string[];
  requestedOutput: string | null;
  completionSignal: string | null;
  draftVersion: number;
  sentVersions: number[];
  readiness: { ready: true } | { ready: false; missing: "target" | "objective"; clarification: string };
}

const DRAFT_EXCHANGE: MockExchange = {
  exchangeId: "exch_e2e_1",
  target: { projectId: "mock_project", paneId: "mock_pane_1" },
  objective: "fix the retry bug in the webhook handler",
  relevantContext: ["the last deploy regressed this"],
  constraints: ["keep the public API unchanged"],
  requestedOutput: null,
  completionSignal: null,
  draftVersion: 1,
  sentVersions: [],
  readiness: { ready: true },
};

async function injectDraftUpdated(page: Page, text: string, exchange: MockExchange | null) {
  await page.evaluate(
    ([t, e]) =>
      (window as unknown as { __ORBITAL_E2E__?: { injectWsFrame: (f: unknown) => void } }).__ORBITAL_E2E__?.injectWsFrame({
        type: "draft_updated",
        projectId: "mock_project",
        paneId: "mock_pane_1",
        draft: { text: t, updatedAt: new Date().toISOString() },
        exchange: e,
      }),
    [text, exchange] as const,
  );
}

test.describe("Orbital Kitchen — the Instruction Workbench", () => {
  test("no open exchange draft: the panel renders nothing (zero visual delta)", async ({ page }) => {
    await openBurner(page);
    await expect(page.getByTestId("instruction-workbench")).toHaveCount(0);
    // The plain Order Pad still works exactly as before this step.
    await expect(page.getByTestId("burner-draft")).toBeVisible();
  });

  test("a seeded exchange draft appears with target, objective, readiness, and version", async ({ page }) => {
    await openBurner(page);
    await injectDraftUpdated(page, DRAFT_EXCHANGE.objective, DRAFT_EXCHANGE);

    const panel = page.getByTestId("instruction-workbench");
    await expect(panel).toBeVisible();
    await expect(page.getByTestId("exchange-target")).toContainText("mock_pane_1");
    await expect(page.getByTestId("exchange-objective")).toContainText("fix the retry bug");
    await expect(page.getByTestId("exchange-version")).toContainText("v1");
    await expect(page.getByTestId("exchange-approval-chip")).toContainText("not sent");
    await expect(page.getByTestId("exchange-readiness")).toContainText("Ready to send");

    // The compact card chip on the station-card mirrors the same state.
    await expect(page.locator('[data-testid="station-card"][data-pane-id="mock_pane_1"]').getByTestId("exchange-card-chip")).toContainText("not sent");
  });

  test("Revise focuses the existing composer editing the same durable draft", async ({ page }) => {
    await openBurner(page);
    await injectDraftUpdated(page, DRAFT_EXCHANGE.objective, DRAFT_EXCHANGE);
    await expect(page.getByTestId("instruction-workbench")).toBeVisible();

    await page.getByTestId("exchange-revise").click();
    await expect(page.getByTestId("burner-draft")).toBeFocused();
  });

  test("operator revises (typed) and sends — sees the delivered state", async ({ page }) => {
    await page.route(/\/api\/panes\/.+\/draft$/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"success":true,"draft":{"text":""}}' }));
    await page.route(/\/api\/panes\/.+\/draft\/send$/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"success":true}' }));
    await openBurner(page);
    await injectDraftUpdated(page, DRAFT_EXCHANGE.objective, DRAFT_EXCHANGE);
    await expect(page.getByTestId("instruction-workbench")).toBeVisible();

    // Revise: a typed edit on the SAME durable draft — the existing draft PUT/WS path, untouched.
    await page.getByTestId("burner-draft").fill("fix the retry bug in the webhook handler, and add a test");

    // Send: the Workbench's own Send control fires the SAME POST …/draft/send the Order Pad's
    // "Send to the line" button already uses — no parallel effect path.
    const sendReq = page.waitForRequest(
      (r) => /\/api\/panes\/.+\/draft\/send$/.test(r.url()) && r.method() === "POST",
      { timeout: 10_000 },
    );
    await page.getByTestId("exchange-send").click();
    await sendReq;
    await expect(page.getByTestId("toast")).toContainText("Sent to the line");

    // The delivered state is now visible on the panel (the client-local send acknowledgment — see
    // src/orbital/TerminalWindow.tsx's ackSend / InstructionWorkbench.tsx's header comment on the
    // REST Workbench lane not yet stamping sentVersions server-side).
    await expect(page.getByTestId("exchange-approval-chip")).toContainText("delivered");
  });

  test("a stale draft (revised after delivery) shows the stale-approval indicator", async ({ page }) => {
    await openBurner(page);
    await injectDraftUpdated(page, DRAFT_EXCHANGE.objective, { ...DRAFT_EXCHANGE, draftVersion: 2, sentVersions: [1] });
    await expect(page.getByTestId("exchange-approval-chip")).toContainText("revised since delivery");
  });

  test("Cancel clears the rendered draft via the existing clear route", async ({ page }) => {
    await page.route(/\/api\/panes\/.+\/draft$/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"success":true,"draft":{"text":""}}' }));
    await openBurner(page);
    await injectDraftUpdated(page, DRAFT_EXCHANGE.objective, DRAFT_EXCHANGE);
    await expect(page.getByTestId("instruction-workbench")).toBeVisible();

    const putReq = page.waitForRequest((r) => /\/api\/panes\/.+\/draft$/.test(r.url()) && r.method() === "PUT", { timeout: 10_000 });
    await page.getByTestId("exchange-cancel").click();
    const body = (await putReq).postDataJSON();
    expect(body?.text).toBe("");
    await expect(page.getByTestId("instruction-workbench")).toHaveCount(0);
    await expect(page.getByTestId("burner-draft")).toHaveValue("");
  });

  test("Retarget is an honest voice-only affordance, not a fake control", async ({ page }) => {
    await openBurner(page);
    await injectDraftUpdated(page, DRAFT_EXCHANGE.objective, DRAFT_EXCHANGE);
    const retarget = page.getByTestId("exchange-retarget");
    await expect(retarget).toBeVisible();
    await expect(retarget).toHaveAttribute("aria-disabled", "true");
  });
});
