import { expect, test, type Page } from "@playwright/test";
import { armE2EWire, injectApprovalPendingFrame, injectApprovalResolvedFrame, switchActivePane, MOCK_TERMINAL_ID, MOCK_TERMINAL_ID_2 } from "./fixtures";

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

// bead 8xn — FOCUS-ROUTED approval delivery. A held approval lands on EXACTLY ONE surface, chosen by
// focus: the operator's ACTIVE station (+ a visible tab) pops the blocking ApprovalDialog modal; any
// OTHER station routes the held approval into the attention inbox keyed by messageId (a real
// Approve/Deny via e7h's id-gate, NOT a fake one). On return to that station the inbox row promotes
// one-directionally to the modal, and a held-approval badge keeps a silently-blocked pane visible.
//
// CRITICAL: these drive `approval_pending` through injectApprovalPendingFrame (→ injectWsFrame →
// handleObserveFrame → the isApprovalHere router), NOT injectPendingApproval — the latter seeds
// pendingCommands directly and would bypass the routing under test. mock_pane_1 is the default active
// station; mock_pane_2 is seeded as a background station.
test.describe("Orbital Kitchen — focus-routed approvals (bead 8xn)", () => {
  test("an approval for the ACTIVE station pops the modal (not the inbox)", async ({ page }) => {
    await gotoKitchen(page);
    await injectApprovalPendingFrame(page, "rm -rf build", MOCK_TERMINAL_ID, "msg_active_1");
    await expect(page.getByTestId("approval-dialog")).toBeVisible();
    await expect(page.getByTestId("approval-dialog")).toContainText("rm -rf build");
    // It must NOT also seed an inbox row — exactly one surface.
    await expect(page.getByTestId("attn-row")).toHaveCount(0);
  });

  test("an approval for a BACKGROUND station routes to the inbox with a working Approve (no modal)", async ({ page }) => {
    await gotoKitchen(page);
    await injectApprovalPendingFrame(page, "npm run deploy", MOCK_TERMINAL_ID_2, "msg_bg_1");
    // No modal — the operator isn't at that station.
    await expect(page.getByTestId("approval-dialog")).toHaveCount(0);
    // A held-approval badge surfaces the silently-blocked pane.
    await expect(page.getByTestId("pass-approval-badge")).toHaveAttribute("data-approval-count", "1");
    // The inbox row is a REAL Approve/Deny (id-gated), and resolving in-inbox clears it without a modal.
    await page.getByTestId("pass-tab-attention").click();
    const row = page.getByTestId("attn-row");
    await expect(row).toHaveAttribute("data-attn-act", "approve");
    await page.getByTestId("attn-approve").click();
    await expect(page.getByTestId("toast")).toContainText("Order up"); // the SAME resolver voice/modal use
    await expect(page.getByTestId("attn-row")).toHaveCount(0);
    await expect(page.getByTestId("approval-dialog")).toHaveCount(0); // never popped a modal
  });

  test("navigating TO the background station promotes its inbox approval to the modal", async ({ page }) => {
    await gotoKitchen(page);
    await injectApprovalPendingFrame(page, "drop table users", MOCK_TERMINAL_ID_2, "msg_promote_1");
    await expect(page.getByTestId("approval-dialog")).toHaveCount(0); // inbox, not modal
    await page.getByTestId("pass-tab-attention").click();
    await expect(page.getByTestId("attn-row")).toHaveCount(1);
    // Walk to that station → the held approval promotes one-directionally to the blocking modal.
    await switchActivePane(page, MOCK_TERMINAL_ID_2);
    await expect(page.getByTestId("approval-dialog")).toBeVisible();
    await expect(page.getByTestId("approval-dialog")).toContainText("drop table users");
    // and it has LEFT the inbox (no double-surfacing).
    await expect(page.getByTestId("attn-row")).toHaveCount(0);
  });

  test("the held-approval badge reflects the count and updates on resolve", async ({ page }) => {
    await gotoKitchen(page);
    await injectApprovalPendingFrame(page, "deploy one", MOCK_TERMINAL_ID_2, "msg_badge_1");
    await injectApprovalPendingFrame(page, "deploy two", MOCK_TERMINAL_ID_2, "msg_badge_2");
    await expect(page.getByTestId("pass-approval-badge")).toHaveAttribute("data-approval-count", "2");
    // Resolve one in the inbox → the badge drops to 1.
    await page.getByTestId("pass-tab-attention").click();
    await page.getByTestId("attn-approve").first().click();
    await expect(page.getByTestId("pass-approval-badge")).toHaveAttribute("data-approval-count", "1");
  });

  // bead 8xn (round-1 review): "resolve anywhere clears EVERYWHERE." The four tests above only ever
  // clear the inbox via the inbox Approve button (the one path that works through the optimistic
  // filter). These two pin the EXACT round-1 failure mode: a held approval routed to the inbox,
  // resolved on a NON-inbox surface (voice / cross-client REST / modal / TTL sweep — all of which
  // arrive as the server's `approval_resolved` broadcast), must drop the inbox row AND the badge —
  // and once cleared, walking to that station must NOT resurrect a zombie modal.
  test("resolving a routed approval via a NON-inbox path (approval_resolved) clears the inbox row + badge", async ({ page }) => {
    await gotoKitchen(page);
    await injectApprovalPendingFrame(page, "npm run deploy", MOCK_TERMINAL_ID_2, "msg_xsurf_1");
    await expect(page.getByTestId("pass-approval-badge")).toHaveAttribute("data-approval-count", "1");
    await page.getByTestId("pass-tab-attention").click();
    await expect(page.getByTestId("attn-row")).toHaveCount(1);
    // The server resolves it elsewhere (voice/REST/modal/TTL) → only an approval_resolved frame lands.
    await injectApprovalResolvedFrame(page, "msg_xsurf_1", "approved");
    await expect(page.getByTestId("attn-row")).toHaveCount(0);              // inbox row cleared
    await expect(page.getByTestId("pass-approval-badge")).toHaveCount(0);   // badge gone (renders only when count > 0)
  });

  test("a routed approval resolved out-of-band does NOT resurrect a zombie modal on return to its station", async ({ page }) => {
    await gotoKitchen(page);
    await injectApprovalPendingFrame(page, "drop table users", MOCK_TERMINAL_ID_2, "msg_zombie_1");
    await expect(page.getByTestId("approval-dialog")).toHaveCount(0); // inbox, not modal
    await page.getByTestId("pass-tab-attention").click();
    await expect(page.getByTestId("attn-row")).toHaveCount(1);        // the routed row is present
    // Resolve it out-of-band (voice/REST/modal/TTL) BEFORE the operator returns to the station.
    await injectApprovalResolvedFrame(page, "msg_zombie_1", "approved");
    await expect(page.getByTestId("attn-row")).toHaveCount(0);        // no stale inbox row to promote
    // Walk to that station — the promotion effect must find nothing to resurrect.
    await switchActivePane(page, MOCK_TERMINAL_ID_2);
    await expect(page.getByTestId("approval-dialog")).toHaveCount(0); // NO phantom gate
  });
});
