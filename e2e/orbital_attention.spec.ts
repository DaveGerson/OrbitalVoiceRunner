import { expect, test, type Page } from "@playwright/test";
import { armE2EWire, injectAttention } from "./fixtures";

// bead e7h — the Attention inbox actually approves/denies. A queue row that carries a held-request
// messageId is genuinely ACTIONABLE: it shows real Approve/Deny that route through the SAME resolver
// (approveCommand/rejectCommand → POST /api/commands/approve) voice uses, and clears optimistically.
// A row with NO messageId is honestly triage-only: it shows "Open" (go to the station), never a fake
// approve. The attention queue is seeded through a REAL `attention_updated` frame (injectAttention →
// injectWsFrame → the observe-lane switch), so the row renders through the production handler path.
//
// Under ?mock=1 the resolver short-circuits to its toast (the wire is pinned by the server suite), so
// the e2e asserts (a) the id-gated button set, and (b) that an in-inbox approve invokes the resolver
// (its "Order up! 🍽" toast) and clears the row — proving the inbox is wired to the gate, not local.

async function gotoKitchen(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await armE2EWire(page);
  await page.goto("/?ui=kitchen&mock=1");
  await page.waitForSelector("html[data-e2e-ready='1']");
  await expect(page.getByTestId("the-pass")).toBeVisible();
}

async function openAttentionTab(page: Page) {
  // The tab toggle appears once anything is in the inbox (attnCount > 0).
  await expect(page.getByTestId("pass-tab-attention")).toBeVisible();
  await page.getByTestId("pass-tab-attention").click();
  await expect(page.getByTestId("attn-list")).toBeVisible();
}

test.describe("Orbital Kitchen — attention inbox approve/deny (bead e7h)", () => {
  test("a row WITH a messageId is actionable: real Approve/Deny buttons", async ({ page }) => {
    await gotoKitchen(page);
    await injectAttention(page, [
      { id: "att_held", type: "approval", terminalId: "mock_pane_1", message: "pane #1 needs your ok: rm -rf build", messageId: "msg_held_1" },
    ]);
    await openAttentionTab(page);
    const row = page.getByTestId("attn-row");
    await expect(row).toHaveAttribute("data-attn-act", "approve");
    await expect(page.getByTestId("attn-approve")).toBeVisible();
    await expect(page.getByTestId("attn-approve")).toContainText("Approve");
    await expect(page.getByTestId("attn-deny")).toBeVisible();
    await expect(page.getByTestId("attn-deny")).toContainText("Deny");
  });

  test("a row WITHOUT a messageId is triage-only: Open, never a fake approve", async ({ page }) => {
    await gotoKitchen(page);
    await injectAttention(page, [
      { id: "att_suggest", type: "confirmation", terminalId: "mock_pane_1", message: "Suggestion: run 'npm test' on mock_pane_1" },
    ]);
    await openAttentionTab(page);
    const row = page.getByTestId("attn-row");
    await expect(row).toHaveAttribute("data-attn-act", "open");
    await expect(page.getByTestId("attn-open")).toBeVisible();
    await expect(page.getByTestId("attn-open")).toContainText("Open");
    // It must NOT offer a (fake) Approve/Deny — there is no held request to resolve.
    await expect(page.getByTestId("attn-approve")).toHaveCount(0);
    await expect(page.getByTestId("attn-deny")).toHaveCount(0);
  });

  test("Approve on a held row resolves it (resolver toast) and clears the row", async ({ page }) => {
    await gotoKitchen(page);
    await injectAttention(page, [
      { id: "att_held", type: "approval", terminalId: "mock_pane_1", message: "pane #1 needs your ok: deploy", messageId: "msg_held_2" },
    ]);
    await openAttentionTab(page);
    await expect(page.getByTestId("attn-row")).toHaveCount(1);
    await page.getByTestId("attn-approve").click();
    // approveCommand's signature (the SAME resolver voice uses) — its mock branch fires this toast.
    await expect(page.getByTestId("toast")).toContainText("Order up");
    // The row is optimistically cleared from the inbox.
    await expect(page.getByTestId("attn-row")).toHaveCount(0);
  });

  test("Deny on a held row rejects it (resolver toast) and clears the row", async ({ page }) => {
    await gotoKitchen(page);
    await injectAttention(page, [
      { id: "att_held", type: "confirmation", terminalId: "mock_pane_1", message: "pane #1 needs your ok: migrate", messageId: "msg_held_3" },
    ]);
    await openAttentionTab(page);
    await expect(page.getByTestId("attn-row")).toHaveCount(1);
    await page.getByTestId("attn-deny").click();
    // rejectCommand's mock-branch signature.
    await expect(page.getByTestId("toast")).toContainText("86'd it");
    await expect(page.getByTestId("attn-row")).toHaveCount(0);
  });
});
