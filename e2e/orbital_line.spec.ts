import { expect, test, type Page } from "@playwright/test";

// Wave P2 — The Line: the board renders live STATIONS merged from the mock
// harness's seeded terminals + ledger (mock_pane_1 "React Frontend",
// mock_pane_2 "Python Backend" in workspace "Mock Project").

async function gotoKitchen(page: Page) {
  await page.goto("/?ui=kitchen&mock=1");
  await page.waitForSelector("html[data-e2e-ready='1']");
}

test.describe("Orbital Kitchen — The Line", () => {
  test("renders the seeded panes as live station cards", async ({ page }) => {
    await gotoKitchen(page);
    const cards = page.getByTestId("station-card");
    await expect(cards).toHaveCount(2);
    await expect(page.getByRole("heading", { name: "React Frontend" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Python Backend" })).toBeVisible();
    // both seeded panes are Running → the kitchen-open chip counts 2
    await expect(page.getByTestId("kitchen-status")).toContainText("2 on the burner");
    // every card carries the literal pane status word
    await expect(page.getByTestId("status-badge").first()).toHaveAttribute("data-status", "Running");
  });

  test("the project sidebar reflects live counts and filters the board", async ({ page }) => {
    await gotoKitchen(page);
    const row = page.getByTestId("project-row-mock_project");
    await expect(row).toContainText("Mock Project");
    await expect(row).toContainText("2 panes");
    await row.click();
    // filtered to the one project — still both panes (they belong to it)
    await expect(page.getByTestId("station-card")).toHaveCount(2);
  });

  test("clicking a station moves the active highlight (sets active pane)", async ({ page }) => {
    await gotoKitchen(page);
    // mock_pane_1 is the default active pane (harness seeds it)
    await expect(page.locator('[data-pane-id="mock_pane_1"]')).toContainText("active");
    await expect(page.locator('[data-pane-id="mock_pane_2"]')).not.toContainText("active");
    await page.locator('[data-pane-id="mock_pane_2"]').click();
    await expect(page.locator('[data-pane-id="mock_pane_2"]')).toContainText("active");
    await expect(page.locator('[data-pane-id="mock_pane_1"]')).not.toContainText("active");
  });

  test("rail layout groups stations by status", async ({ page }) => {
    await gotoKitchen(page);
    await page.getByTestId("tweaks-toggle").click();
    await page.getByRole("button", { name: "rail", exact: true }).click();
    await expect(page.getByText("On the burner", { exact: true })).toBeVisible();
    await expect(page.getByText("Off the line", { exact: true })).toBeVisible();
    // both Running panes land under the burner column
    await expect(page.getByTestId("station-card")).toHaveCount(2);
  });
});
