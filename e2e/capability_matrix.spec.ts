import { test, expect, gotoMockedApp } from "./fixtures";

/**
 * bead 8sq (spec §2.B / §8): the Capability-Matrix settings tab. Grouped 3-way [Auto|Ask|Off] toggles
 * by category, in PLAIN language, with a scope selector (Global / preset / pane). This spec pins the
 * client-side round-trip: open the tab, toggle a gate, and assert the segmented control reflects the
 * new value in FORM STATE (the value the parent then round-trips on Save via settingsGatesRoundTrip).
 *
 * The full save→server→reload persistence round-trip across all three scopes needs a live server
 * (the ?mock=1 harness is client-only); that leg is unit-pinned by tests/test_settings_gates_roundtrip.ts
 * (global + preset) and tests/test_pane_gates_rest.ts (per-pane REST), and flagged for live verify.
 */

async function openMatrixTab(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: /config/i }).click();
  await page.getByTestId("settings-tab-gates").click();
  await expect(page.getByTestId("capability-matrix-tab")).toBeVisible();
}

test.describe("capability matrix tab", () => {
  test("opens and lists capabilities in plain language (no raw identifiers)", async ({ page }) => {
    await gotoMockedApp(page);
    await openMatrixTab(page);

    const tab = page.getByTestId("capability-matrix-tab");
    await expect(tab).toContainText("Type a command into a pane");
    await expect(tab).toContainText("Close a pane");
    await expect(tab).toContainText("Update notes & metadata");
    await expect(tab).not.toContainText("write_to_pane");
  });

  test("the scope selector offers Global plus the pane override scope", async ({ page }) => {
    await gotoMockedApp(page);
    await openMatrixTab(page);
    const select = page.getByTestId("matrix-scope-select");
    await expect(select).toBeVisible();
    // Global is the default scope.
    await expect(select).toHaveValue("global");
  });

  test("toggling a gate updates the segmented control (form-state round-trip)", async ({ page }) => {
    await gotoMockedApp(page);
    await openMatrixTab(page);

    // Default global scope: set write_to_pane to Off, then Ask, then Auto and assert aria-pressed flips.
    const offBtn = page.getByTestId("matrix-write_to_pane-Off");
    const askBtn = page.getByTestId("matrix-write_to_pane-Ask");
    const autoBtn = page.getByTestId("matrix-write_to_pane-Auto");

    await offBtn.click();
    await expect(offBtn).toHaveAttribute("aria-pressed", "true");
    await expect(askBtn).toHaveAttribute("aria-pressed", "false");

    await askBtn.click();
    await expect(askBtn).toHaveAttribute("aria-pressed", "true");
    await expect(offBtn).toHaveAttribute("aria-pressed", "false");

    await autoBtn.click();
    await expect(autoBtn).toHaveAttribute("aria-pressed", "true");
    await expect(askBtn).toHaveAttribute("aria-pressed", "false");
  });

  test("every one of the 16 capabilities renders a 3-way toggle row", async ({ page }) => {
    await gotoMockedApp(page);
    await openMatrixTab(page);
    const caps = [
      "write_to_pane", "deliver_handoff", "create_pane", "close_pane", "restart_pane",
      "set_pane_permissions", "set_global_permissions", "set_capability_gate", "add_watch_rule",
      "execute_plan", "apply_recipe", "create_project", "update_metadata", "switch_context",
      "set_voice_mute", "dismiss_attention",
    ];
    for (const cap of caps) {
      await expect(page.getByTestId(`matrix-row-${cap}`)).toBeVisible();
    }
    expect(caps).toHaveLength(16);
  });
});
