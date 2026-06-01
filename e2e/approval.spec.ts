import { test, expect, gotoMockedApp, injectPendingApproval } from "./fixtures";

test.describe("approval dialog", () => {
  test("appears for an injected pending command and shows the command", async ({ page }) => {
    await gotoMockedApp(page);
    await injectPendingApproval(page, "rm -rf build");

    const dialog = page.getByTestId("approval-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("rm -rf build");
  });

  test("Confirm & Fire dismisses the dialog", async ({ page }) => {
    await gotoMockedApp(page);
    await injectPendingApproval(page, "npm run deploy");

    await expect(page.getByTestId("approval-dialog")).toBeVisible();
    await page.getByTestId("approval-approve").click();
    await expect(page.getByTestId("approval-dialog")).toHaveCount(0);
  });

  test("Reject dismisses the dialog", async ({ page }) => {
    await gotoMockedApp(page);
    await injectPendingApproval(page, "drop table users");

    await expect(page.getByTestId("approval-dialog")).toBeVisible();
    await page.getByTestId("approval-reject").click();
    await expect(page.getByTestId("approval-dialog")).toHaveCount(0);
  });
});
