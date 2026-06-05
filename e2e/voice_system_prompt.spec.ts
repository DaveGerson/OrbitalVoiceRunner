import { test, expect, gotoMockedApp } from "./fixtures";

/**
 * bead sa4: the Janus voice system prompt is operator-editable from Settings → Voice Session.
 * This spec pins the UI affordance RENDERS and round-trips in form state (the leg unit tests can't
 * cover — pure JSX): the multiline textarea + "Reset to default" button appear in the Voice Session
 * sub-tab, the reset button is disabled while blank and enabled once a custom prompt is typed, and
 * clicking it clears the field back to blank (which the parent persists as undefined => the builder
 * falls back to DEFAULT_SYSTEM_PROMPT — guarded by content invariants in tests/test_system_prompt.ts).
 *
 * The save→server→reconnect leg needs a live server (the ?mock=1 harness is client-only); that is
 * unit-pinned by tests/test_secrets_at_rest.ts (persist, not blanked) + tests/test_system_prompt.ts.
 */

async function openVoiceSession(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: /config/i }).click();
  // The "Setup Panels" (form) tab is default; make the Voice Session sub-tab active explicitly.
  // Exact match: "Voice Session" the sub-tab, not the "(start a voice session first)" hint button.
  await page.getByRole("button", { name: "Voice Session", exact: true }).click();
  await expect(page.getByTestId("settings-voice-system-prompt")).toBeVisible();
}

test.describe("voice system prompt settings (sa4)", () => {
  test("renders the editable textarea + Reset-to-default in Voice Session", async ({ page }) => {
    await gotoMockedApp(page);
    await openVoiceSession(page);

    await expect(page.getByText("Voice System Prompt")).toBeVisible();
    const textarea = page.getByTestId("settings-voice-system-prompt");
    await expect(textarea).toBeVisible();
    // Default state is blank — the built-in default shows as the placeholder hint, not the value.
    await expect(textarea).toHaveValue("");
    await expect(textarea).toHaveAttribute("placeholder", /Project Janus/);

    await page.screenshot({ path: "test-results/sa4-voice-system-prompt.png", fullPage: false });
  });

  test("Reset-to-default is disabled while blank, enables on input, and clears on click", async ({ page }) => {
    await gotoMockedApp(page);
    await openVoiceSession(page);

    const textarea = page.getByTestId("settings-voice-system-prompt");
    const reset = page.getByTestId("settings-voice-system-prompt-reset");

    // Nothing to reset when blank.
    await expect(reset).toBeDisabled();

    await textarea.fill("custom prompt for {{activeProjectId}}");
    await expect(textarea).toHaveValue("custom prompt for {{activeProjectId}}");
    await expect(reset).toBeEnabled();

    await reset.click();
    await expect(textarea).toHaveValue("");
    await expect(reset).toBeDisabled();
  });
});
