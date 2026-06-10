import { expect, test, type Page } from "@playwright/test";
import { armE2EWire } from "./fixtures";

// Wave P3 — operating the line: ServiceMode (globalPermissionsMode), All Hands
// (stop-all 2-stage), New Pane / New Project modals. Driven via the ?mock=1
// harness (createPane/createProject short-circuit to a toast in mock mode).

async function gotoKitchen(page: Page) {
  // The emergency-stop modal shakes/sirens (orb-shake/orb-siren); reduced-motion
  // (which the kitchen honors) stills it so clicks register deterministically.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await armE2EWire(page); // 3C.3b: mock-mode wires only fire on a Playwright-armed page
  await page.goto("/?ui=kitchen&mock=1");
  await page.waitForSelector("html[data-e2e-ready='1']");
}

test.describe("Orbital Kitchen — controls", () => {
  test("ServiceMode switches the autonomy posture (Full Auto takes one confirm tap)", async ({ page }) => {
    await gotoKitchen(page);
    // default posture = Human-in-the-Loop
    await expect(page.getByTestId("service-hitl")).toHaveAttribute("aria-pressed", "true");
    // 2K.4: escalating to Full Auto is the riskiest click — the FIRST tap arms an inline confirm
    // on the control itself (no mode change yet); the SECOND tap fires it.
    await page.getByTestId("service-auto").click();
    await expect(page.getByTestId("service-auto")).toHaveAttribute("data-confirming", "true");
    await expect(page.getByTestId("service-auto")).toHaveAttribute("aria-pressed", "false"); // not flipped yet
    await page.getByTestId("service-auto").click();
    await expect(page.getByTestId("service-auto")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("service-hitl")).toHaveAttribute("aria-pressed", "false");
    // de-escalation stays one-tap
    await page.getByTestId("service-read").click();
    await expect(page.getByTestId("service-read")).toHaveAttribute("aria-pressed", "true");
  });

  test("All Hands opens the two-stage emergency stop", async ({ page }) => {
    await gotoKitchen(page);
    await page.getByTestId("all-hands").click();
    await expect(page.getByTestId("emergency-stop")).toBeVisible();
    await expect(page.getByText("ALL HANDS!")).toBeVisible();
    // hold-to-fire crosses into stage 2 (gas off)
    const kill = page.getByTestId("hold-to-kill");
    await kill.hover();
    await page.mouse.down();
    await page.waitForTimeout(900);
    await page.mouse.up();
    await expect(page.getByText("Gas is off.")).toBeVisible();
    await page.getByRole("button", { name: "Re-open the kitchen" }).click();
    await expect(page.getByTestId("emergency-stop")).toHaveCount(0);
  });

  test("All Hands → release dismisses without killing", async ({ page }) => {
    await gotoKitchen(page);
    await page.getByTestId("all-hands").click();
    await page.getByRole("button", { name: "Release the brake — back to service" }).click();
    await expect(page.getByTestId("emergency-stop")).toHaveCount(0);
  });

  test("New Pane modal opens, takes a name, and confirms", async ({ page }) => {
    await gotoKitchen(page);
    await page.getByTitle("Open a new pane in this project").first().click();
    await expect(page.getByTestId("orbital-modal")).toBeVisible();
    await page.getByTestId("newpane-name").fill("Webhook retries");
    await page.getByRole("button", { name: "Fire it up" }).click();
    await expect(page.getByTestId("orbital-modal")).toHaveCount(0);
    await expect(page.getByTestId("toast")).toContainText("Fired up");
  });

  test("New Project modal opens and confirms", async ({ page }) => {
    await gotoKitchen(page);
    await page.getByRole("button", { name: "New project" }).click();
    await expect(page.getByTestId("orbital-modal")).toBeVisible();
    await page.getByTestId("newproject-name").fill("Notifications");
    await page.getByRole("button", { name: "Open it up" }).click();
    await expect(page.getByTestId("orbital-modal")).toHaveCount(0);
    await expect(page.getByTestId("toast")).toContainText("New kitchen");
  });
});
