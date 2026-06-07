import { expect, test, type Page } from "@playwright/test";

// Wave P5a — HiTL gating in the kitchen. The reused ApprovalDialog (staged PTY write) and
// ActionConfirmDialog (gated non-PTY action) render from the live pendingCommands/pendingActions,
// driven through the SAME ?mock=1 harness hooks the classic app uses (injectPendingApproval /
// injectPendingAction). Approve/reject + confirm/cancel route through the real REST choke-points
// (optimistic dismiss in mock; the wire itself is pinned by the server suite).

async function gotoKitchen(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?ui=kitchen&mock=1");
  await page.waitForSelector("html[data-e2e-ready='1']");
}

async function injectPendingApproval(page: Page, cmd: string) {
  await page.evaluate(
    (c) => (window as unknown as { __ORBITAL_E2E__?: { injectPendingApproval: (c: string) => void } }).__ORBITAL_E2E__?.injectPendingApproval(c),
    cmd,
  );
}
async function injectPendingAction(page: Page, capability: string, summary: string) {
  await page.evaluate(
    ([cap, sum]) => (window as unknown as { __ORBITAL_E2E__?: { injectPendingAction: (c: string, s: string) => void } }).__ORBITAL_E2E__?.injectPendingAction(cap, sum),
    [capability, summary] as const,
  );
}

test.describe("Orbital Kitchen — approvals (HiTL)", () => {
  test("a staged PTY write raises the approval dialog with the command", async ({ page }) => {
    await gotoKitchen(page);
    await injectPendingApproval(page, "rm -rf build");
    const dialog = page.getByTestId("approval-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("rm -rf build");
  });

  test("Confirm & Fire dismisses the approval", async ({ page }) => {
    await gotoKitchen(page);
    await injectPendingApproval(page, "npm run deploy");
    await expect(page.getByTestId("approval-dialog")).toBeVisible();
    await page.getByTestId("approval-approve").click();
    await expect(page.getByTestId("approval-dialog")).toHaveCount(0);
  });

  test("Reject dismisses the approval", async ({ page }) => {
    await gotoKitchen(page);
    await injectPendingApproval(page, "drop table users");
    await expect(page.getByTestId("approval-dialog")).toBeVisible();
    await page.getByTestId("approval-reject").click();
    await expect(page.getByTestId("approval-dialog")).toHaveCount(0);
  });

  test("a gated action raises the confirm dialog with capability + summary", async ({ page }) => {
    await gotoKitchen(page);
    await injectPendingAction(page, "create_pane", "Open a new pane in Notifications");
    const dialog = page.getByTestId("action-dialog");
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId("action-summary")).toContainText("Open a new pane in Notifications");
    await expect(page.getByTestId("action-capability")).toContainText("create_pane");
  });

  test("Confirm runs the action and dismisses", async ({ page }) => {
    await gotoKitchen(page);
    await injectPendingAction(page, "set_global_permissions", "Set the line to Full Auto");
    await expect(page.getByTestId("action-dialog")).toBeVisible();
    await page.getByTestId("action-confirm").click();
    await expect(page.getByTestId("action-dialog")).toHaveCount(0);
  });

  test("Cancel dismisses the action without running it", async ({ page }) => {
    await gotoKitchen(page);
    await injectPendingAction(page, "delete_pane", "Close pane #3");
    await expect(page.getByTestId("action-dialog")).toBeVisible();
    await page.getByTestId("action-cancel").click();
    await expect(page.getByTestId("action-dialog")).toHaveCount(0);
  });
});
