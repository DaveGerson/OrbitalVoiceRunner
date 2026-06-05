import { test, expect, gotoMockedApp, injectTranscript, injectGrounding } from "./fixtures";

/**
 * bead aqx (build-out): grounded web search (Google).
 *  (1) the Settings toggle renders in Voice Session, defaults OFF, and toggles.
 *  (2) when a grounded turn arrives, the Janus transcript shows a "grounded via <source>" chip
 *      with a clickable link to the source URI.
 *
 * The off-by-default config builder is unit-pinned (tests/test_live_config.ts + test_voice_tools.ts);
 * the grounding-metadata extraction is unit-pinned (tests/test_grounding.ts). This spec covers the two
 * pure-JSX render legs unit tests can't: the Settings toggle and the transcript source chip.
 */

async function openVoiceSession(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: /config/i }).click();
  // "Setup Panels" (form) tab is default; activate the Voice Session sub-tab (exact, not the hint button).
  await page.getByRole("button", { name: "Voice Session", exact: true }).click();
  await expect(page.getByTestId("settings-voice-grounding")).toBeVisible();
}

test.describe("voice grounded web search (aqx)", () => {
  test("Settings toggle renders in Voice Session, defaults OFF, and toggles", async ({ page }) => {
    await gotoMockedApp(page);
    await openVoiceSession(page);

    await expect(page.getByText("Grounded web search (Google)")).toBeVisible();
    const toggle = page.getByTestId("settings-voice-grounding");
    await expect(toggle).not.toBeChecked();

    await toggle.check();
    await expect(toggle).toBeChecked();
    await page.screenshot({ path: "test-results/aqx-grounding-toggle.png", fullPage: false });

    await toggle.uncheck();
    await expect(toggle).not.toBeChecked();
  });

  test("a grounded Janus turn shows a 'grounded via' source chip with a link", async ({ page }) => {
    await gotoMockedApp(page);

    await injectTranscript(page, "Janus", "The latest Node.js LTS is 24.x.");
    await injectGrounding(page, ["current node lts version"], [
      { uri: "https://nodejs.org/en/about/releases", title: "Node.js Releases" },
    ]);

    const chip = page.getByTestId("transcript-grounding");
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("grounded via");
    const link = chip.getByRole("link", { name: "Node.js Releases" });
    await expect(link).toHaveAttribute("href", "https://nodejs.org/en/about/releases");
    await page.screenshot({ path: "test-results/aqx-grounding-chip.png", fullPage: false });
  });

  test("a User turn never gets a grounding chip (sources attach to Janus only)", async ({ page }) => {
    await gotoMockedApp(page);
    await injectTranscript(page, "User", "what is the latest node version");
    // No Janus turn yet => injectGrounding is a no-op (nothing to attach to).
    await injectGrounding(page, ["node version"], [{ uri: "https://nodejs.org", title: "Node" }]);
    await expect(page.getByTestId("transcript-grounding")).toHaveCount(0);
  });
});
