import { expect, test } from "@playwright/test";

// Wave P0 — the Orbital Kitchen shell: chrome, view routing, tweaks.
// The reskin lives behind ?ui=kitchen until the migration completes.

test.describe("Orbital Kitchen — shell", () => {
  test("renders the kitchen chrome with three tabs", async ({ page }) => {
    await page.goto("/?ui=kitchen");
    await expect(page.getByText("ORBITAL", { exact: true })).toBeVisible();
    await expect(page.getByText("the kitchen pass")).toBeVisible();
    await expect(page.getByTestId("tab-line")).toBeVisible();
    await expect(page.getByTestId("tab-pantry")).toBeVisible();
    await expect(page.getByTestId("tab-boh")).toBeVisible();
  });

  test("routes between the three views", async ({ page }) => {
    await page.goto("/?ui=kitchen");
    // default = The Line → the projects sidebar is its stable marker
    await expect(page.getByText("Projects", { exact: true })).toBeVisible();
    await page.getByTestId("tab-pantry").click();
    await expect(page.getByTestId("pantry")).toBeVisible();
    await page.getByTestId("tab-boh").click();
    await expect(page.getByTestId("boh-room-rulebook")).toBeVisible(); // Back of House room nav
    await page.getByTestId("tab-line").click();
    await expect(page.getByText("Projects", { exact: true })).toBeVisible();
  });

  test("deep-links a view via ?view=", async ({ page }) => {
    await page.goto("/?ui=kitchen&view=boh");
    await expect(page.getByTestId("boh-room-rulebook")).toBeVisible();
  });

  test("tweaks panel opens and toggles persist to localStorage", async ({ page }) => {
    await page.goto("/?ui=kitchen");
    await page.getByTestId("tweaks-toggle").click();
    await expect(page.getByTestId("tweaks-panel")).toBeVisible();
    // flip dark mode → it should write the tweaks blob
    await page.getByRole("switch", { name: "Dinner-service (dark)" }).click();
    const stored = await page.evaluate(() => localStorage.getItem("orbital-tweaks"));
    expect(stored).toContain("\"dark\":true");
  });

  test("the kitchen is the default app", async ({ page }) => {
    await page.goto("/");
    // kitchen chrome is present without any flag (the cutover default)
    await expect(page.getByTestId("tab-line")).toBeVisible();
  });

  test("the classic app is still reachable via ?ui=classic", async ({ page }) => {
    await page.goto("/?ui=classic");
    // kitchen-only chrome must be ABSENT on the classic fallback
    await expect(page.getByTestId("tab-line")).toHaveCount(0);
  });
});
