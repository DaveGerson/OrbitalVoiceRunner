import { expect, test, type Page } from "@playwright/test";
import { armE2EWire } from "./fixtures";

// Wave P5a — HiTL gating in the kitchen. The reused ApprovalDialog (staged PTY write) and
// ActionConfirmDialog (gated non-PTY action) render from the live pendingCommands/pendingActions,
// driven through the SAME ?mock=1 harness hooks the classic app uses (injectPendingApproval /
// injectPendingAction). Approve/reject + confirm/cancel route through the real REST choke-points
// (optimistic dismiss in mock; the wire itself is pinned by the server suite).

async function gotoKitchen(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await armE2EWire(page); // 3C.3b: mock-mode wires only fire on a Playwright-armed page
  await page.goto("/?ui=kitchen&mock=1");
  await page.waitForSelector("html[data-e2e-ready='1']");
}

async function injectPendingApproval(page: Page, cmd: string, expectedCount?: number) {
  // When expectedCount is omitted, infer it as (current count + 1) to serialize sequential calls
  // even when React batches state updates under parallel-suite load (de-flake: 20n).
  const before = expectedCount !== undefined
    ? expectedCount - 1
    : await page.locator('[data-testid="approval-dialog"]').count();
  await page.evaluate(
    (c) => (window as unknown as { __ORBITAL_E2E__?: { injectPendingApproval: (c: string) => void } }).__ORBITAL_E2E__?.injectPendingApproval(c),
    cmd,
  );
  await page.waitForFunction(
    (n) => document.querySelectorAll('[data-testid="approval-dialog"]').length >= n,
    before + 1,
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

  // 1B.2: with several overlays stacked, ONE Escape used to bulk-reject everything (every dialog
  // registered its own window-level handler). Now only the TOPMOST dialog owns Escape.
  test("Escape dismisses only the topmost dialog, one at a time", async ({ page }) => {
    await gotoKitchen(page);
    await injectPendingAction(page, "create_pane", "Open a new pane in Notifications");
    await injectPendingApproval(page, "npm run deploy");
    await expect(page.getByTestId("action-dialog")).toHaveCount(1);
    await expect(page.getByTestId("approval-dialog")).toHaveCount(1);
    // approvals render after actions → the approval is DOM-topmost and owns the first Escape
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("approval-dialog")).toHaveCount(0);
    await expect(page.getByTestId("action-dialog")).toHaveCount(1); // survived the first Escape
    // the action is now topmost → the second Escape cancels it
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("action-dialog")).toHaveCount(0);
  });

  test("Escape pops stacked approvals one at a time, newest first", async ({ page }) => {
    await gotoKitchen(page);
    await injectPendingApproval(page, "first staged write");
    await injectPendingApproval(page, "second staged write");
    await expect(page.getByTestId("approval-dialog")).toHaveCount(2);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("approval-dialog")).toHaveCount(1);
    // the survivor is the FIRST injected one (the topmost/newest was rejected)
    await expect(page.getByTestId("approval-dialog")).toContainText("first staged write");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("approval-dialog")).toHaveCount(0);
  });
});
