import { expect, test, type Page } from "@playwright/test";

// Wave P9 — the "feels good" polish (audit-driven). These pin the connective-tissue + feedback that
// make the kitchen feel alive rather than merely look right: acks narrate into the Kitchen Radio,
// HiTL resolves are never silent, the call sheet is live + clickable, a ticket becomes a pane, the
// "needs you" jump surfaces, and running cards show a live burner-peek.

async function gotoKitchen(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?ui=kitchen&mock=1");
  await page.waitForSelector("html[data-e2e-ready='1']");
}
async function injectPendingApproval(page: Page, cmd: string, terminalId = "mock_pane_1") {
  await page.evaluate(([c, id]) => (window as unknown as { __ORBITAL_E2E__?: { injectPendingApproval: (c: string, id?: string) => void } }).__ORBITAL_E2E__?.injectPendingApproval(c, id), [cmd, terminalId] as const);
}

test.describe("Orbital Kitchen — feels-good polish", () => {
  test("every ack narrates into the Kitchen Radio (the source of truth)", async ({ page }) => {
    await page.route(/\/api\/projects\/.+\/notes$/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: '{"output":"ok"}' }));
    await gotoKitchen(page);
    await page.getByTestId("pass-jot-input").fill("prep the sauce");
    await page.getByTestId("pass-jot-add").click();
    // visible toast AND a durable Chef de Cuisine line in the radio transcript
    await expect(page.getByTestId("toast")).toContainText("Jotted it down");
    await expect(page.getByTestId("radio-transcript")).toContainText("Jotted it down");
  });

  test("approving a gated command is never silent — 'Order up!'", async ({ page }) => {
    await gotoKitchen(page);
    await injectPendingApproval(page, "npm run migrate");
    await expect(page.getByTestId("approval-dialog")).toBeVisible();
    await page.getByTestId("approval-approve").click();
    await expect(page.getByTestId("toast")).toContainText("Order up");
    await expect(page.getByTestId("radio-transcript")).toContainText("Order up");
  });

  test("the call sheet is live and clickable — voice parity", async ({ page }) => {
    await gotoKitchen(page);
    await page.getByRole("button", { name: "🎙 calls" }).click();
    // a dynamic call built from the live board (mock pane "React Frontend")
    await expect(page.getByTestId("radio-calls")).toContainText("open react frontend");
    await page.getByTestId("radio-call").first().click();
    await expect(page.getByTestId("toast")).toContainText("heard, Chef");
  });

  test("a ticket becomes live work — Fire a pane", async ({ page }) => {
    await page.route(/\/api\/projects\/.+\/notes$/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: '{"output":"ok"}' }));
    await gotoKitchen(page);
    await page.getByTestId("pass-jot-input").fill("rework the retry queue");
    await page.getByTestId("pass-jot-add").click();
    await page.getByTestId("pass-ticket-fire").first().click();
    await expect(page.getByTestId("orbital-modal")).toBeVisible(); // NewPaneModal, scoped to the ticket's kitchen
  });

  test("a Needs-Input pane raises the glance-able 'Needs you' pill", async ({ page }) => {
    await gotoKitchen(page);
    await injectPendingApproval(page, "rm -rf dist");
    await expect(page.getByTestId("needs-you")).toBeVisible();
    await expect(page.getByTestId("needs-you")).toContainText("Needs you");
  });

  test("running cards show a live burner-peek", async ({ page }) => {
    await gotoKitchen(page);
    // the seeded mock panes are Running, so their card shows the colored output peek
    await expect(page.getByTestId("station-peek").first()).toBeVisible();
    await expect(page.getByTestId("station-peek").first()).toContainText("MOCKTERM_READY");
  });
});
