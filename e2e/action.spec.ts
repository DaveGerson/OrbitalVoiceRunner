import { test, expect, gotoMockedApp, injectPendingAction } from "./fixtures";

/**
 * Confirm dialog for a gated NON-PTY deferred action (capability gate Ask tier — G1).
 * The action's side effect is held server-side (PendingActionStore) and runs only on confirm.
 */
test.describe("action confirm dialog", () => {
  test("appears for an injected pending action and shows capability + summary", async ({ page }) => {
    await gotoMockedApp(page);
    await injectPendingAction(page, "create_pane", "Create pane build-1 (claude) in proj_x");

    const dialog = page.getByTestId("action-dialog");
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId("action-capability")).toContainText("create_pane");
    await expect(page.getByTestId("action-summary")).toContainText("Create pane build-1");
  });

  test("Confirm dismisses the dialog", async ({ page }) => {
    await gotoMockedApp(page);
    await injectPendingAction(page, "set_global_permissions", "Set global permissions to Full Auto");

    await expect(page.getByTestId("action-dialog")).toBeVisible();
    await page.getByTestId("action-confirm").click();
    await expect(page.getByTestId("action-dialog")).toHaveCount(0);
  });

  test("Cancel dismisses the dialog", async ({ page }) => {
    await gotoMockedApp(page);
    await injectPendingAction(page, "set_pane_permissions", "Set pane p1 permissions to Read-Only");

    await expect(page.getByTestId("action-dialog")).toBeVisible();
    await page.getByTestId("action-cancel").click();
    await expect(page.getByTestId("action-dialog")).toHaveCount(0);
  });
});
