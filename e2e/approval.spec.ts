import { test, expect, gotoMockedApp, injectPendingApproval, MOCK_TERMINAL_ID } from "./fixtures";

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

  // ── bead 2j3: posture-rider cases ──────────────────────────────────────────────
  // The injection hook now takes an OPTIONAL posture. When supplied, the dialog renders its
  // "Approving into: <POSTURE>" effective rider (server truth, same palette as the chip) so the
  // operator sees the posture they are approving a write into. When omitted, the bare dialog stays.
  test("with a posture rider, the effective block renders the posture word", async ({ page }) => {
    await gotoMockedApp(page);
    await injectPendingApproval(page, "rm -rf build", MOCK_TERMINAL_ID, "GUARDED");

    const dialog = page.getByTestId("approval-dialog");
    await expect(dialog).toBeVisible();
    const rider = page.getByTestId("approval-effective");
    await expect(rider).toBeVisible();
    await expect(rider).toContainText("Approving into:");
    await expect(rider).toContainText("GUARDED");
  });

  test("a LOCKED posture rider surfaces the LOCKED word in the effective block", async ({ page }) => {
    await gotoMockedApp(page);
    await injectPendingApproval(page, "npm run deploy", MOCK_TERMINAL_ID, "LOCKED");

    const rider = page.getByTestId("approval-effective");
    await expect(rider).toBeVisible();
    await expect(rider).toContainText("LOCKED");
  });

  test("WITHOUT a posture rider, the effective block is absent (degrade-safe, unchanged)", async ({ page }) => {
    await gotoMockedApp(page);
    await injectPendingApproval(page, "ls -la");

    await expect(page.getByTestId("approval-dialog")).toBeVisible();
    await expect(page.getByTestId("approval-effective")).toHaveCount(0);
  });
});
