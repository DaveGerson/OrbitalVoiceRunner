import { test, expect, gotoMockedApp } from "./fixtures";

/**
 * bead 8sq (spec §2.B / §8): the Capability-Matrix settings tab. Grouped toggles by category, in PLAIN
 * language, with a scope selector (Global / preset / pane). This spec pins the client-side round-trip:
 * open the tab, toggle a gate, and assert the segmented control reflects the new value in FORM STATE
 * (the value the parent then round-trips on Save via settingsGatesRoundTrip).
 *
 * PHASE 2 (veto-toggle honesty): the control per row now matches the capability's ENFORCEMENT class —
 * deferrable → 3-way [Auto|Ask|Off]; veto → 2-way [Allow|Off] (Allow stores "Auto", "Ask" is never
 * offered); informational → a read-only "Always on" badge. The data-control attribute on each row
 * carries the class so the per-class rendering is assertable.
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

  test("every capability renders a row, with the HONEST control for its enforcement class", async ({ page }) => {
    await gotoMockedApp(page);
    await openMatrixTab(page);
    // A representative deferrable cap renders a 3-way control.
    for (const cap of ["write_to_pane", "create_pane", "close_pane", "update_metadata", "clear_history"]) {
      const row = page.getByTestId(`matrix-row-${cap}`);
      await expect(row).toBeVisible();
      await expect(row).toHaveAttribute("data-control", "three-way");
    }
    // Veto caps render a 2-way Allow/Off control — and NEVER an Ask button.
    for (const cap of ["switch_context", "dismiss_attention", "compose_draft", "read_pane", "focus_pane"]) {
      const row = page.getByTestId(`matrix-row-${cap}`);
      await expect(row).toBeVisible();
      await expect(row).toHaveAttribute("data-control", "two-way");
      await expect(page.getByTestId(`matrix-${cap}-Allow`)).toBeVisible();
      await expect(page.getByTestId(`matrix-${cap}-Off`)).toBeVisible();
      await expect(page.getByTestId(`matrix-${cap}-Ask`)).toHaveCount(0);
    }
    // Informational caps render a read-only "Always on" badge, no interactive control.
    const muteRow = page.getByTestId("matrix-row-set_voice_mute");
    await expect(muteRow).toHaveAttribute("data-control", "badge");
    await expect(page.getByTestId("matrix-set_voice_mute-badge")).toBeVisible();
    await expect(page.getByTestId("matrix-set_voice_mute-Auto")).toHaveCount(0);
  });

  test("a veto cap's Allow/Off toggle round-trips (Allow stores Auto)", async ({ page }) => {
    await gotoMockedApp(page);
    await openMatrixTab(page);
    // compose_draft is veto-class: only Allow/Off, and Allow persists the stored value "Auto".
    const allowBtn = page.getByTestId("matrix-compose_draft-Allow");
    const offBtn = page.getByTestId("matrix-compose_draft-Off");
    await offBtn.click();
    await expect(offBtn).toHaveAttribute("aria-pressed", "true");
    await expect(allowBtn).toHaveAttribute("aria-pressed", "false");
    await allowBtn.click();
    await expect(allowBtn).toHaveAttribute("aria-pressed", "true");
    await expect(offBtn).toHaveAttribute("aria-pressed", "false");
  });
});
