import { test, expect, gotoMockedApp } from "./fixtures";

/**
 * NOTE: this targets feat/terminal-fidelity's "Shared Prompt Buffer" composer.
 * The prompt-composer-refactor branch replaces it with the per-pane WIP-draft
 * Workbench composer — when these branches coalesce, retarget this spec at that
 * composer (the harness, fixtures, and other specs carry over unchanged).
 */
test.describe("composer", () => {
  test("operator can type a prompt into the composer and it persists", async ({ page }) => {
    // Wide viewport so the right-hand helper panel (which hosts the composer) shows.
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoMockedApp(page);

    // The buffer defaults to Preview; switch to Edit to reveal the textarea.
    await page.getByTestId("composer-edit-toggle").click();

    const input = page.getByTestId("composer-input");
    await expect(input).toBeVisible();
    await input.fill("- [ ] ship the terminal e2e suite");
    await expect(input).toHaveValue("- [ ] ship the terminal e2e suite");
  });

  test("Send (Sync Note) is available once a pane is active", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoMockedApp(page);
    // The mock harness seeds + activates a pane, so the per-pane Sync action shows.
    await expect(page.getByTestId("composer-send")).toBeVisible();
  });
});
