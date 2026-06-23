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

  // ── bead 2j3: posture-rider cases ──────────────────────────────────────────────
  // The injection hook now takes an OPTIONAL posture. When supplied, the dialog renders its
  // "Effective …: <POSTURE>" effective rider (server truth, same gateSurface palette as the chip).
  // When omitted, today's bare dialog (no rider) is preserved.
  test("with a posture rider, the effective block renders the posture word", async ({ page }) => {
    await gotoMockedApp(page);
    await injectPendingAction(page, "create_pane", "Create pane build-1 (claude) in proj_x", "GUARDED");

    await expect(page.getByTestId("action-dialog")).toBeVisible();
    const rider = page.getByTestId("action-effective");
    await expect(rider).toBeVisible();
    await expect(page.getByTestId("action-scope")).toBeVisible();
    await expect(rider).toContainText("GUARDED");
  });

  test("an OPEN posture rider surfaces the OPEN word in the effective block", async ({ page }) => {
    await gotoMockedApp(page);
    await injectPendingAction(page, "create_project", "Create project proj_y", "OPEN");

    const rider = page.getByTestId("action-effective");
    await expect(rider).toBeVisible();
    await expect(rider).toContainText("OPEN");
  });

  test("WITHOUT a posture rider, the effective block is absent (degrade-safe, unchanged)", async ({ page }) => {
    await gotoMockedApp(page);
    await injectPendingAction(page, "create_pane", "Create pane build-2");

    await expect(page.getByTestId("action-dialog")).toBeVisible();
    await expect(page.getByTestId("action-effective")).toHaveCount(0);
  });
});
