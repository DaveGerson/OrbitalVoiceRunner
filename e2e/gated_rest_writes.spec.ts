import { test, expect, gotoMockedApp } from "./fixtures";

/**
 * i0r (c55.10): the rest-only writes send_keys / add_watch_rule / remove_watch_rule /
 * delete_orchestrator_plan are now default-Ask, so OFF-CONTEXT their REST write returns
 * HTTP 202 {status:"pending_approval", messageId} (deferred), NOT 200. The operator-UI
 * handlers must surface that deferred state — play the "queued" earcon + raise the amber
 * ⏳ raw-key-notification toast — and must NOT play a false success / clear the input.
 *
 * The ?mock=1 harness has NO backend and NO WS, so:
 *  - the outgoing gated write is intercepted with page.route and fulfilled as 202;
 *  - we assert the LOCAL deferred toast (testid raw-key-notification) and that the input
 *    is left intact (no false-success clear). The action_pending -> confirm-dialog path is
 *    WS-driven and is covered separately by e2e/action.spec.ts (injectPendingAction).
 *
 * DEFAULT_MOCK_GATES already pins add_watch_rule / send_keys = "Ask" (src/e2e/harness.ts),
 * so no gate setup is needed — the 202 is supplied by the route fulfillment.
 */

const DEFER_BODY = '{"status":"pending_approval","messageId":"act_test"}';

// Open the desktop "Orchestrate" helper tab where the broadcaster + watch-rule creator live.
async function openOrchestrateTab(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Orchestrate" }).click();
}

test.describe("gated rest-only writes surface the 202 deferred state (i0r)", () => {
  test("add_watch_rule 202: amber deferred toast + the command input is NOT cleared", async ({ page }) => {
    await gotoMockedApp(page);

    // Fulfill the gated create as a 202 defer. (No GET route needed: fetchWatchRules is a no-op in
    // mock mode, so the false-success symptom we assert against is the input clear, not a list diff.)
    await page.route(/\/api\/watch-rules$/, (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status: 202, contentType: "application/json", body: DEFER_BODY })
        : route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
    );

    await openOrchestrateTab(page);

    // Fill the "Register Watch-Trigger Guardian" form so the create button enables.
    const selects = page.locator("text=Register Watch-Trigger Guardian").locator("xpath=ancestor::div[1]").locator("select");
    await selects.nth(0).selectOption("mock_pane_1"); // Trigger Node
    await selects.nth(2).selectOption("mock_pane_2"); // Execute Node (index 1 is the transition select)
    const cmdInput = page.getByPlaceholder("e.g. npm run build");
    await cmdInput.fill("npm run build");

    const createReq = page.waitForRequest(
      (req) => /\/api\/watch-rules$/.test(req.url()) && req.method() === "POST",
      { timeout: 10_000 },
    );
    await page.getByRole("button", { name: "+ Register Watch Rule" }).click();
    await createReq;

    // The deferred surface appears (REUSED raw-key-notification toast)…
    const toast = page.getByTestId("raw-key-notification");
    await expect(toast).toBeVisible();
    await expect(toast).toContainText("Deferred");
    await expect(toast).toContainText("Awaiting Confirm");

    // …and there is NO false success: the command input was NOT cleared (clear runs only on a real 200).
    await expect(cmdInput).toHaveValue("npm run build");
  });

  test("send_keys broadcast 202: amber deferred toast + the broadcast command is NOT cleared", async ({ page }) => {
    await gotoMockedApp(page);

    // Every selected pane's keystroke POST defers (202). The old code counted 202 as a 2xx "sent" and
    // cleared the input — the regression this asserts against.
    await page.route(/\/api\/terminals\/.+\/input$/, (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status: 202, contentType: "application/json", body: DEFER_BODY })
        : route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
    );

    await openOrchestrateTab(page);

    // Select one broadcast target (mock seeds mock_pane_1 / mock_pane_2) and type a payload.
    await page.getByRole("button", { name: "MOCK_PANE_1" }).click();
    const bcastInput = page.getByPlaceholder("Type command (e.g. npm run test)...");
    await bcastInput.fill("npm run test");

    const inputReq = page.waitForRequest(
      (req) => /\/api\/terminals\/.+\/input$/.test(req.url()) && req.method() === "POST",
      { timeout: 10_000 },
    );
    await page.getByRole("button", { name: /Execute Broadcast to Selected/ }).click();
    await inputReq;

    // Deferred toast appears…
    const toast = page.getByTestId("raw-key-notification");
    await expect(toast).toBeVisible();
    await expect(toast).toContainText("Deferred");
    await expect(toast).toContainText("Awaiting Confirm");

    // …and because EVERY target deferred (nothing sent), the input is left intact for retry/confirm.
    await expect(bcastInput).toHaveValue("npm run test");
  });
});
