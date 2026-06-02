import { test, expect, gotoMockedApp, injectWipDraft } from "./fixtures";

/**
 * U3 (bead wsm-e2e-pinned-dlj): the desktop Sync Spec tab gets a cyan animate-pulse
 * draft-pending badge gated on `promptBuffer.trim().length > 0 || wipDrafts.length > 0`.
 * Without it, an operator on the Orchestrate/Alerts tab cannot tell a command is being
 * drafted one tab over. The composer's `→ {activePaneName}` target chip is pinned with a
 * testid so the "which pane does this draft target" half stays asserted.
 */
test.describe("sync-spec draft badge (U3)", () => {
  test("badge is absent on a clean load and appears when promptBuffer fills", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoMockedApp(page);

    // Clean harness load: no draft text, no wipDrafts -> badge MUST be absent.
    await expect(page.getByTestId("sync-spec-draft-badge")).toHaveCount(0);

    // Fill the composer draft via the real input path.
    await page.getByTestId("composer-edit-toggle").click();
    await page.getByTestId("composer-input").fill("ship the badge");

    // Badge now present and visible.
    await expect(page.getByTestId("sync-spec-draft-badge")).toBeVisible();
  });

  test("whitespace-only draft does NOT trigger the badge (.trim() gate)", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoMockedApp(page);

    await page.getByTestId("composer-edit-toggle").click();
    const input = page.getByTestId("composer-input");

    // Spaces only -> the .trim() gate keeps the badge hidden.
    await input.fill("   ");
    await expect(page.getByTestId("sync-spec-draft-badge")).toHaveCount(0);

    // Real text -> badge appears.
    await input.fill("real draft");
    await expect(page.getByTestId("sync-spec-draft-badge")).toBeVisible();
  });

  test("a WIP draft for a non-active pane lights the badge with an empty composer", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoMockedApp(page);

    // Empty composer, no badge.
    await expect(page.getByTestId("sync-spec-draft-badge")).toHaveCount(0);

    // Stage a draft for a DIFFERENT pane -> the wipDrafts OR-clause fires independently.
    await injectWipDraft(page, "mock_pane_2", "queued elsewhere");
    await expect(page.getByTestId("sync-spec-draft-badge")).toBeVisible();
  });

  test("clearing the draft removes the badge", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoMockedApp(page);

    await page.getByTestId("composer-edit-toggle").click();
    await page.getByTestId("composer-input").fill("draft to clear");
    await expect(page.getByTestId("sync-spec-draft-badge")).toBeVisible();

    // The composer Clear button (sibling of composer-send in the action toolbar) calls
    // handlePromptBufferChange(""). Scope to that toolbar so we don't hit the transcript-history Clear.
    const composerToolbar = page.getByTestId("composer-send").locator("xpath=ancestor::div[1]");
    await composerToolbar.getByRole("button", { name: "Clear", exact: true }).click();
    await expect(page.getByTestId("sync-spec-draft-badge")).toHaveCount(0);
  });

  test("composer target-pane chip reflects the active pane", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoMockedApp(page);

    // Under ?mock=1 the ledger is empty, so activePaneName falls back to the active pane id.
    await expect(page.getByTestId("composer-target-pane")).toContainText("mock_pane_1");
  });
});
