import { test, expect, gotoMockedApp, MOCK_TERMINAL_ID } from "./fixtures";

// Runtime verification of the new per-pane header controls (B3 Exit, B4 back-to-grid).
// The ?mock=1 harness has NO backend, so the outgoing requests are intercepted with
// page.route — this exercises the real render + click handlers in App.tsx (the client
// half of the path); the server half (stopAndArchivePane) is covered by the unit suite.
// "Left the active-pane view" is asserted via the Exit button disappearing, since that
// header only mounts while a pane is active (robust vs. grid tiles reusing test ids).

test.describe("per-pane exit controls (active-pane header)", () => {
  test("the Exit and back-to-grid buttons render in the header", async ({ page }) => {
    await gotoMockedApp(page);
    await expect(page.getByTitle(/^Exit pane/)).toBeVisible();
    await expect(page.getByTitle(/^Back to grid/)).toBeVisible();
    await page.screenshot({ path: "e2e-artifacts/pane-exit-buttons.png" });
  });

  test("clicking Exit POSTs the non-destructive stop endpoint and drops back to the grid", async ({ page }) => {
    await gotoMockedApp(page);

    // Fulfill the stop POST and the follow-up GETs so the handler completes cleanly.
    await page.route(/\/api\/projects\/.+\/panes\/.+\/stop$/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"success":true,"archived":true}' }));
    await page.route(/\/api\/(ledger|terminals|archive)\b.*/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));

    const stopReq = page.waitForRequest(
      (req) => /\/api\/projects\/.+\/panes\/.+\/stop$/.test(req.url()) && req.method() === "POST",
      { timeout: 10_000 },
    );

    await expect(page.getByTestId("terminal-pane")).toBeVisible();
    await page.getByTitle(/^Exit pane/).click();

    const req = await stopReq;
    expect(req.method()).toBe("POST");
    expect(req.url()).toContain(`/panes/${MOCK_TERMINAL_ID}/stop`);

    // The active-pane header unmounts → we are back on the grid.
    await expect(page.getByTitle(/^Exit pane/)).toBeHidden({ timeout: 10_000 });
    await page.screenshot({ path: "e2e-artifacts/pane-exit-after.png" });
  });

  test("clicking back-to-grid dismisses the view WITHOUT a stop request (pane keeps running)", async ({ page }) => {
    await gotoMockedApp(page);

    let stopFired = false;
    await page.route(/\/api\/projects\/.+\/panes\/.+\/stop$/, (route) => {
      stopFired = true;
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    await expect(page.getByTestId("terminal-pane")).toBeVisible();
    await page.getByTitle(/^Back to grid/).click();

    // Left the active-pane view…
    await expect(page.getByTitle(/^Exit pane/)).toBeHidden({ timeout: 10_000 });
    // …but the pane was NOT terminated — no stop request was issued.
    expect(stopFired).toBe(false);
  });
});
