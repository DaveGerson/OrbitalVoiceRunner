import { test, expect, gotoMockedApp, setPostureMock } from "./fixtures";

/**
 * bead 8sq (spec §2.A / §8): the per-pane EFFECTIVE-posture chip. Renders ONE calm posture word +
 * colored dot + a focus ★ when the spotlight loosened a write here; click opens a popover listing all
 * capabilities in PLAIN language. The chip renders from SERVER truth (the posture/effective_gates the
 * harness seeds), never client policy re-derivation.
 *
 * PHASE 2 (veto-toggle honesty): the popover now renders the HONEST status per enforcement class —
 * deferrable caps show their raw Auto/Ask/Off word; veto caps show only Allowed/Blocked (a veto "Ask"
 * is collapsed to "Allowed" — never shown as "Ask"); informational caps show an "Always on" badge.
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

  test("popover lists all capabilities in plain language (no raw identifiers)", async ({ page }) => {
    await gotoMockedApp(page);
    // dispatchEvent('click') fires React's onClick directly, bypassing pointer hit-testing. In the
    // mock viewport the cramped center-header can let the right-hand control group overlap/clip the
    // chip (it lives inside an overflow-hidden min-w-0 group), which made a real .click() flake. These
    // tests only assert the popover CONTENTS, so a synthetic click is the deterministic way to open it.
    await page.getByTestId("gate-chip-trigger").first().dispatchEvent("click");
    const popover = page.getByTestId("gate-chip-popover");
    await expect(popover).toBeVisible();

    // A few plain labels are present; NO raw snake_case identifier leaks.
    await expect(popover).toContainText("Type a command into a pane");
    await expect(popover).toContainText("Close a pane");
    await expect(popover).toContainText("Change these safety gates");
    await expect(popover).not.toContainText("write_to_pane");
    await expect(popover).not.toContainText("compose_draft");
    await expect(popover).not.toContainText("set_voice_mute");

    // Every seeded capability row renders.
    const caps = Object.keys(ALL_AUTO);
    for (const cap of caps) {
      await expect(popover.getByTestId(`gate-row-${cap}`)).toBeVisible();
    }
    // And the PHASE 2 promoted veto/informational rows render too (27-cap matrix).
    await expect(popover.getByTestId("gate-row-compose_draft")).toBeVisible();
    await expect(popover.getByTestId("gate-row-read_pane")).toBeVisible();
    await expect(popover.getByTestId("gate-row-set_voice_mute")).toBeVisible();
  });

  test("popover renders the HONEST control per enforcement class (Phase 2)", async ({ page }) => {
    await gotoMockedApp(page);
    // dispatchEvent('click') fires React's onClick directly, bypassing pointer hit-testing. In the
    // mock viewport the cramped center-header can let the right-hand control group overlap/clip the
    // chip (it lives inside an overflow-hidden min-w-0 group), which made a real .click() flake. These
    // tests only assert the popover CONTENTS, so a synthetic click is the deterministic way to open it.
    await page.getByTestId("gate-chip-trigger").first().dispatchEvent("click");
    const popover = page.getByTestId("gate-chip-popover");
    await expect(popover).toBeVisible();

    // informational (set_voice_mute) → read-only "Always on" badge, never a gate word.
    const muteRow = popover.getByTestId("gate-row-set_voice_mute");
    await expect(muteRow).toHaveAttribute("data-control", "badge");
    await expect(muteRow).toContainText("Always on");

    // veto (compose_draft) defaults Auto → shows "Allowed", and is tagged as a two-way control.
    const draftRow = popover.getByTestId("gate-row-compose_draft");
    await expect(draftRow).toHaveAttribute("data-control", "two-way");
    await expect(draftRow).toContainText("Allowed");

    // deferrable (write_to_pane) stays a three-way control.
    const writeRow = popover.getByTestId("gate-row-write_to_pane");
    await expect(writeRow).toHaveAttribute("data-control", "three-way");
  });

  test("a veto cap NEVER displays 'Ask' — a seeded Ask collapses to Allowed", async ({ page }) => {
    await gotoMockedApp(page);
    // Seed compose_draft = Ask (a legacy/incoherent value for a veto cap). The popover must show it as
    // Allowed, proving the switch never lies about a veto cap supporting "Ask".
    await setPostureMock(page, "GUARDED", { ...ALL_AUTO, compose_draft: "Ask" });
    // dispatchEvent('click') fires React's onClick directly, bypassing pointer hit-testing. In the
    // mock viewport the cramped center-header can let the right-hand control group overlap/clip the
    // chip (it lives inside an overflow-hidden min-w-0 group), which made a real .click() flake. These
    // tests only assert the popover CONTENTS, so a synthetic click is the deterministic way to open it.
    await page.getByTestId("gate-chip-trigger").first().dispatchEvent("click");
    const draftRow = page.getByTestId("gate-chip-popover").getByTestId("gate-row-compose_draft");
    await expect(draftRow).toContainText("Allowed");
    await expect(draftRow).not.toContainText("Ask");
  });

  test("the center-header chip is genuinely clickable by a real pointer at the default viewport", async ({ page }) => {
    // Regression guard at the DEFAULT 1280px mock viewport (sidebar + open transcript panel = the
    // cramped case). With the header layout fix (the chip is a shrink-0 sibling before the truncating
    // command, no longer inside an overflow-hidden group the right controls can cover), a REAL click
    // (full Playwright actionability + hit-test — it throws if the trigger is occluded) must land on the
    // header chip and open the popover. Targets the header chip explicitly (gate-chip-header):
    // `gate-chip-trigger.first()` resolves to a sidebar chip, which was never the occluded one. If the
    // layout ever regresses to occluding the chip at 1280, this throws — the truth the content tests'
    // dispatchEvent opens can't catch.
    await gotoMockedApp(page);
    await page.getByTestId("gate-chip-header").getByTestId("gate-chip-trigger").click();
    await expect(page.getByTestId("gate-chip-popover")).toBeVisible();
  });
});
