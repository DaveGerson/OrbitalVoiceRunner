import { test, expect, gotoMockedApp, injectMalformedPosture } from "./fixtures";

/**
 * bead ahz (n2r crash-safety regression, spec docs/process/session-fixes/n2r-plan.md §2–3):
 *
 * The gate chip + matrix render directly off SERVER-PROVIDED posture / effective_gates. A single
 * malformed frame — a posture word outside the closed OPEN|GUARDED|LOCKED union — used to index an
 * undefined POSTURE_STYLE record and THROW during render, unwinding to the one global ErrorBoundary
 * and WHITE-SCREENING the entire cockpit.
 *
 * The n2r normalizers (src/gateSurface.ts) + the GateChip-local error boundary fixed that. This spec
 * is the end-to-end regression guard: a malformed posture must DEGRADE the chip (normalize → the safe
 * GUARDED default + a calm `gate-chip-degraded` tell in the popover), NOT crash the app. We drive the
 * bad payload through the harness's injectMalformedPosture hook, which feeds a value the closed union
 * forbids (the only way to reproduce a contract-violating server frame in the client-only harness).
 */
test.describe("gate chip — crash-safety on a malformed posture", () => {
  test("a malformed posture degrades the chip (GUARDED safe default), it does NOT white-screen", async ({ page }) => {
    await gotoMockedApp(page);
    // Sanity: the app rendered its real cockpit before we corrupt the posture.
    await expect(page.getByTestId("terminal-pane")).toBeVisible();

    await injectMalformedPosture(page, "TOTALLY_BROKEN");

    // The app is STILL alive — the terminal pane is mounted, not a dead ErrorBoundary fault page.
    await expect(page.getByTestId("terminal-pane")).toBeVisible();

    // The chip itself still renders (truthy posture keeps it mounted), normalized to the safe GUARDED
    // default rather than the malformed word.
    const chip = page.getByTestId("gate-chip").first();
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute("data-posture", "GUARDED");
    await expect(chip.getByTestId("gate-chip-trigger")).toContainText("GUARDED");
  });

  test("the popover surfaces the calm gate-chip-degraded tell for a malformed posture", async ({ page }) => {
    await gotoMockedApp(page);
    await injectMalformedPosture(page, "??!");

    // dispatchEvent('click') fires React's onClick directly (the same deterministic open the rest of
    // the gate-chip suite uses — at the mock viewport the cramped header can otherwise clip a real
    // pointer click). The header chip is the active-pane chip carrying the malformed posture.
    await page.getByTestId("gate-chip-header").getByTestId("gate-chip-trigger").dispatchEvent("click");

    const popover = page.getByTestId("gate-chip-popover");
    await expect(popover).toBeVisible();

    const degraded = popover.getByTestId("gate-chip-degraded");
    await expect(degraded).toBeVisible();
    await expect(degraded).toContainText("Posture unavailable");
  });

  test("a WELL-FORMED posture shows NO degraded tell (the guard is specific, not blanket)", async ({ page }) => {
    await gotoMockedApp(page);
    // Default seeded posture is the valid GUARDED — open the popover and prove the tell is absent.
    await page.getByTestId("gate-chip-header").getByTestId("gate-chip-trigger").dispatchEvent("click");
    await expect(page.getByTestId("gate-chip-popover")).toBeVisible();
    await expect(page.getByTestId("gate-chip-degraded")).toHaveCount(0);
  });
});
