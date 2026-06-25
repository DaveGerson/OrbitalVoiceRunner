/**
 * sidebar_pixel_parity.spec.ts — bespoke PIXEL-PARITY gate for the chunk-4 WorkspaceSidebar
 * extraction (bead wsm-e2e-pinned chunk-4). The sidebar carries NO data-testid anchors and its
 * framer-motion AnimatePresence pane rows (key={pane.pane_id}, initial={false}) are the top
 * regression risk of the whole dbt4 decomposition, so the 178-case DOM lane is a thin net here.
 * This spec snapshots the settled sidebar <nav> so a same-machine before/after run proves the
 * extraction caused zero visual drift (className/layout/GateChip/active-row rendering).
 *
 * HOW IT IS USED (same-machine before/after, NOT a committed cross-platform golden):
 *   1. On pre-extraction code: `PIXEL_PARITY=1 npx playwright test sidebar_pixel_parity` writes baselines.
 *   2. After the extraction: re-run — Playwright COMPARES; 0 diff == parity.
 * Baselines are gitignored (.gitignore: e2e/*-snapshots/) — win32-specific local proof, not a CI
 * golden (Linux font rendering would false-fail). Opt-in: SKIPS unless PIXEL_PARITY=1 (and win32),
 * so the shared e2e lane / CI never tries to compare against a win32 baseline.
 *
 * NOTE: a static snapshot captures the SETTLED frame; it guards layout/className drift. The
 * AnimatePresence key reconciliation correctness is additionally guarded by the adversarial
 * byte-fidelity review (key={pane.pane_id} + initial={false} preserved verbatim).
 */
import { test, expect, gotoMockedApp, switchActivePane, MOCK_TERMINAL_ID } from "./fixtures";

test.skip(process.env.PIXEL_PARITY !== "1" || process.platform !== "win32", "sidebar pixel parity is an opt-in Windows-local refactor tool (set PIXEL_PARITY=1)");

const SHOT = { animations: "disabled" as const, caret: "hide" as const };

test.describe("workspace sidebar pixel parity", () => {
  test("default cockpit sidebar renders identically (project list + pane rows + GateChip)", async ({ page }) => {
    await gotoMockedApp(page);
    // The lone <nav> is the WorkspaceSidebar (desktop lg:flex at the 1280px default viewport).
    await expect(page.locator("nav").first()).toHaveScreenshot("sidebar-default.png", SHOT);
  });

  test("sidebar with an active pane renders identically (active-row actions/notes, AnimatePresence)", async ({ page }) => {
    await gotoMockedApp(page);
    await switchActivePane(page, MOCK_TERMINAL_ID);
    await expect(page.locator("nav").first()).toHaveScreenshot("sidebar-active-pane.png", SHOT);
  });
});
