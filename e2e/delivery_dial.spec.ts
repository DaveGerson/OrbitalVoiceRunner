import { test, expect, gotoMockedApp } from "./fixtures";

/**
 * fikj.12: the D4 delivery-dial rows — the pure-JSX leg (same split as e2e/voice_silence_gate.spec.ts:
 * boundary + arbiter behavior are unit-pinned in tests/test_delivery_dial*.ts; this proves the rows
 * render with the STRUCTURAL floor and the locked defaults).
 */
test.describe("delivery-mode dial rows (fikj.12)", () => {
  test("per-class selects render with the never-silent floor and locked defaults", async ({ page }) => {
    await gotoMockedApp(page);
    await page.getByRole("button", { name: /config/i }).click();
    await page.getByRole("button", { name: "Voice Session", exact: true }).click();

    const class0 = page.getByTestId("settings-dial-class-0");
    await expect(class0).toBeVisible();
    await expect(class0.locator("option")).toHaveCount(2); // floor: passive-context not even offered
    await expect(class0).toHaveValue("forced-turn");

    const class3 = page.getByTestId("settings-dial-class-3");
    await expect(class3.locator("option")).toHaveCount(3);
    await expect(class3).toHaveValue("steered-digest");
    await class3.selectOption("forced-turn");
    await expect(class3).toHaveValue("forced-turn");

    await expect(page.getByTestId("settings-completion-announce")).toHaveValue("dispatched");
  });
});
