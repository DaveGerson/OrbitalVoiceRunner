import { test, expect, gotoMockedApp } from "./fixtures";

/**
 * A-UI (wsm-e2e-pinned-5h0): the Terminal View header's "leave this pane" controls must carry
 * VISIBLE TEXT LABELS, not bare icons. The reported bug was the operator overlooking the unlabeled
 * Exit/Grid icons and concluding the just-shipped exit/archive feature was "missing". This pins that
 * Grid + Exit render labeled, and that Back-to-Grid actually leaves the pane (returns to Dashboard).
 */
test.describe("terminal-view header affordances (A-UI)", () => {
  test("Grid + Exit are labeled, and Back-to-Grid leaves the pane", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoMockedApp(page); // boots into Terminal View (mock_pane_1 live)

    const grid = page.getByTitle("Back to grid (leave this pane running)");
    const exit = page.getByTitle(/Exit pane .* recoverable/);
    await expect(grid).toContainText("Grid");
    await expect(exit).toContainText("Exit");

    // Back-to-Grid returns to the Dashboard — the terminal pane is no longer mounted.
    await grid.click();
    await expect(page.getByTestId("terminal-pane")).toBeHidden();
  });
});
