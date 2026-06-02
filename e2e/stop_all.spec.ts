import { test, expect, gotoMockedApp, setFrozenMock } from "./fixtures";

/**
 * bead 8sq (spec §2.C / §8): the global two-stage emergency STOP-ALL.
 *   - Stage 1: the top-bar "Stop everything" trigger → FROZEN banner (driven here via setFrozenMock,
 *     which mirrors the server's `frozen` WS event the real client consumes).
 *   - Stage 2: the FROZEN banner's HOLD-TO-FIRE kill button (irreversible).
 *   - Release: clears the freeze.
 * Plain language throughout (no raw identifiers).
 */

test.describe("two-stage STOP-ALL", () => {
  test("the top-bar trigger is visible when not frozen", async ({ page }) => {
    await gotoMockedApp(page);
    const trigger = page.getByTestId("stop-all-trigger");
    await expect(trigger).toBeVisible();
    await expect(trigger).toContainText(/stop everything/i);
    // No banner yet.
    await expect(page.getByTestId("frozen-banner")).toHaveCount(0);
  });

  test("Stage 1 freeze shows the FROZEN banner with the running-pane count and a Release", async ({ page }) => {
    await gotoMockedApp(page);
    // Trigger Stage 1 (the real click hits the server; under mock we drive the same banner state the
    // `frozen` WS event would, since the harness is client-only).
    await page.getByTestId("stop-all-trigger").click();
    await setFrozenMock(page, true, ["pane-a", "pane-b"]);

    const banner = page.getByTestId("frozen-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/frozen/i);
    await expect(banner).toContainText(/2 panes/i);
    await expect(page.getByTestId("stop-all-release")).toBeVisible();
    // The Stage-1 trigger is gone (replaced by the banner).
    await expect(page.getByTestId("stop-all-trigger")).toHaveCount(0);
  });

  test("Stage 2 kill button is hold-to-fire (a quick click does NOT fire)", async ({ page }) => {
    await gotoMockedApp(page);
    await setFrozenMock(page, true, ["pane-a"]);

    const kill = page.getByTestId("stop-all-kill");
    await expect(kill).toBeVisible();
    await expect(kill).toContainText(/hold to kill/i);

    // A brief mousedown+up (no full ~1s hold) must NOT complete the kill: the banner stays.
    await kill.dispatchEvent("mousedown");
    await page.waitForTimeout(150);
    await kill.dispatchEvent("mouseup");
    await page.waitForTimeout(100);
    await expect(page.getByTestId("frozen-banner")).toBeVisible(); // still frozen, not killed
  });

  test("Release clears the freeze and restores the top-bar trigger", async ({ page }) => {
    await gotoMockedApp(page);
    await setFrozenMock(page, true, ["pane-a"]);
    await expect(page.getByTestId("frozen-banner")).toBeVisible();

    // Release (under mock, the click + the frozen=false state the server would broadcast).
    await page.getByTestId("stop-all-release").click();
    await setFrozenMock(page, false, []);

    await expect(page.getByTestId("frozen-banner")).toHaveCount(0);
    await expect(page.getByTestId("stop-all-trigger")).toBeVisible();
  });

  test("with no running panes, the banner shows no kill button (nothing to kill)", async ({ page }) => {
    await gotoMockedApp(page);
    await setFrozenMock(page, true, []);
    const banner = page.getByTestId("frozen-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/no panes are still running/i);
    await expect(page.getByTestId("stop-all-kill")).toHaveCount(0);
    await expect(page.getByTestId("stop-all-release")).toBeVisible();
  });
});
