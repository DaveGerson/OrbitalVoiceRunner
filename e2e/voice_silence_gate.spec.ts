import { test, expect, gotoMockedApp } from "./fixtures";

/**
 * bead tkd (UI toggle): the should-I-speak (silence) gate is flippable from Settings → Voice Session.
 * EXPERIMENTAL, OFF by default. The gate logic itself is unit-pinned (tests/test_speak_gate.ts); this
 * spec covers the pure-JSX Settings toggle leg: it renders, defaults unchecked, and round-trips on click.
 */

async function openVoiceSession(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: /config/i }).click();
  await page.getByRole("button", { name: "Voice Session", exact: true }).click();
  await expect(page.getByTestId("settings-voice-silence-gate")).toBeVisible();
}

test.describe("voice silence-gate toggle (tkd)", () => {
  test("renders in Voice Session, defaults OFF, marked experimental, and toggles", async ({ page }) => {
    await gotoMockedApp(page);
    await openVoiceSession(page);

    await expect(page.getByText("Stay silent while I think")).toBeVisible();
    await expect(page.getByText("EXPERIMENTAL", { exact: true })).toBeVisible();

    const toggle = page.getByTestId("settings-voice-silence-gate");
    await expect(toggle).not.toBeChecked();

    await toggle.check();
    await expect(toggle).toBeChecked();
    await page.screenshot({ path: "test-results/tkd-silence-gate-toggle.png", fullPage: false });

    await toggle.uncheck();
    await expect(toggle).not.toBeChecked();
  });
});
