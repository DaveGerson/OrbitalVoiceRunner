import { expect, test, type Page } from "@playwright/test";
import { armE2EWire } from "./fixtures";

// bead 8fz.2 — the Kitchen Radio status chip now reads deriveConversationalState(...) directly
// (10-kind ladder) instead of the retired getChipLabel/getChipBg boolean plumbing, and carries
// role="status" aria-live="polite" so a screen reader hears turn-state transitions too (today
// aria-live was only wired to the toast). This pins: the aria-live wiring itself, the off-air
// steady state, and the transition to a live-state label once the radio is tuned in.

async function gotoKitchen(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await armE2EWire(page); // 3C.3b: mock-mode wires only fire on a Playwright-armed page
  await page.goto("/?ui=kitchen&mock=1");
  await page.waitForSelector("html[data-e2e-ready='1']");
}

test.describe("Orbital Kitchen — Kitchen Radio conversational chip (bead 8fz.2)", () => {
  test("the chip carries role=status aria-live=polite and reads OFF AIR when not live", async ({ page }) => {
    await gotoKitchen(page);
    const radio = page.getByTestId("kitchen-radio");
    const chip = radio.locator('[role="status"][aria-live="polite"]');
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("OFF AIR");
  });

  test("after mock go-live the chip's aria-live status reads a live-state label", async ({ page }) => {
    await gotoKitchen(page);
    const radio = page.getByTestId("kitchen-radio");
    const chip = radio.locator('[role="status"][aria-live="polite"]');
    await page.getByTestId("radio-golive").click();
    // Mock mode skips the real socket but transitions the UI to a live state (mic toggle appears).
    await expect(page.getByTestId("radio-mute")).toBeVisible();
    await expect(chip).toContainText("LIVE");
    await expect(chip).not.toContainText("OFF AIR");
  });
});
