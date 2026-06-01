import { test, expect, gotoMockedApp } from "./fixtures";

/**
 * Targets the Workbench composer (prompt-composer-refactor): a per-pane draft
 * edited via composer-input and dispatched with the primary Send (composer-send),
 * which is disabled until a pane is active AND the draft is non-empty.
 */
test.describe("composer", () => {
  test("operator can type a draft into the composer and it persists", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoMockedApp(page);

    // The buffer defaults to Preview; switch to Edit to reveal the textarea.
    await page.getByTestId("composer-edit-toggle").click();

    const input = page.getByTestId("composer-input");
    await expect(input).toBeVisible();
    await input.fill("- [ ] ship the terminal e2e suite");
    await expect(input).toHaveValue("- [ ] ship the terminal e2e suite");
  });

  test("Send is gated until a pane is active and the draft is non-empty", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoMockedApp(page);

    const send = page.getByTestId("composer-send");
    // A pane is seeded active by the harness, but the draft starts empty -> disabled.
    await expect(send).toBeDisabled();

    await page.getByTestId("composer-edit-toggle").click();
    await page.getByTestId("composer-input").fill("deploy the service");
    await expect(send).toBeEnabled();
  });
});
