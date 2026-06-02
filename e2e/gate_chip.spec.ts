import { test, expect, gotoMockedApp, setPostureMock } from "./fixtures";

/**
 * bead 8sq (spec §2.A / §8): the per-pane EFFECTIVE-posture chip. Renders ONE calm posture word +
 * colored dot + a focus ★ when the spotlight loosened a write here; click opens a popover listing all
 * 16 capabilities in PLAIN language. The chip renders from SERVER truth (the posture/effective_gates
 * the harness seeds), never client policy re-derivation.
 */

const ALL_AUTO: Record<string, "Auto" | "Ask" | "Off"> = {
  write_to_pane: "Auto", deliver_handoff: "Auto", create_pane: "Auto", close_pane: "Auto",
  restart_pane: "Auto", set_pane_permissions: "Auto", set_global_permissions: "Auto",
  set_capability_gate: "Auto", add_watch_rule: "Auto", execute_plan: "Auto", apply_recipe: "Auto",
  create_project: "Auto", update_metadata: "Auto", switch_context: "Auto", set_voice_mute: "Auto",
  dismiss_attention: "Auto",
};

const WRITE_OFF: Record<string, "Auto" | "Ask" | "Off"> = { ...ALL_AUTO, write_to_pane: "Off" };

test.describe("gate chip — effective posture", () => {
  test("renders the seeded posture word (GUARDED by default) on the active pane", async ({ page }) => {
    await gotoMockedApp(page);
    const chip = page.getByTestId("gate-chip").first();
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute("data-posture", "GUARDED");
    await expect(chip.getByTestId("gate-chip-trigger")).toContainText("GUARDED");
  });

  test("shows the focus ★ when the spotlight loosened a write on the active pane", async ({ page }) => {
    await gotoMockedApp(page);
    // The default mock gates resolve write_to_pane=Auto on this (active) pane → spotlight tell.
    await expect(page.getByTestId("gate-chip-focus-star").first()).toBeVisible();
  });

  test("OPEN posture when every capability resolves Auto", async ({ page }) => {
    await gotoMockedApp(page);
    await setPostureMock(page, "OPEN", ALL_AUTO);
    const chip = page.getByTestId("gate-chip").first();
    await expect(chip).toHaveAttribute("data-posture", "OPEN");
    await expect(chip.getByTestId("gate-chip-trigger")).toContainText("OPEN");
  });

  test("LOCKED posture when write_to_pane is Off", async ({ page }) => {
    await gotoMockedApp(page);
    await setPostureMock(page, "LOCKED", WRITE_OFF);
    const chip = page.getByTestId("gate-chip").first();
    await expect(chip).toHaveAttribute("data-posture", "LOCKED");
    await expect(chip.getByTestId("gate-chip-trigger")).toContainText("LOCKED");
  });

  test("popover lists all 16 capabilities in plain language (no raw identifiers)", async ({ page }) => {
    await gotoMockedApp(page);
    await page.getByTestId("gate-chip-trigger").first().click();
    const popover = page.getByTestId("gate-chip-popover");
    await expect(popover).toBeVisible();

    // A few plain labels are present; the raw identifier is NOT.
    await expect(popover).toContainText("Type a command into a pane");
    await expect(popover).toContainText("Close a pane");
    await expect(popover).toContainText("Change these safety gates");
    await expect(popover).not.toContainText("write_to_pane");

    // All 16 capability rows render.
    const caps = Object.keys(ALL_AUTO);
    for (const cap of caps) {
      await expect(popover.getByTestId(`gate-row-${cap}`)).toBeVisible();
    }
    expect(caps).toHaveLength(16);
  });
});
