/**
 * grid_pixel_parity.spec.ts — bespoke PIXEL-PARITY gate for the chunk-7 PaneGridSection extraction
 * (bead wsm-e2e-pinned-zi2). The pane grid is the highest-capture, highest-risk extraction of the
 * dbt4 decomposition: the whole filteredPanes.map with four mode-card renderers sharing ~11
 * per-iteration locals, framer-motion <AnimatePresence mode="popLayout"> over <motion.div layout
 * key={pane.pane_id}>, and the compact card's ControlKeyBar (raw-key-bar-grid + writeControlKeyFromGrid).
 * The grid container is a dynamic-className motion.div with no testid, so this snapshots <main> in the
 * dashboard grid view; everything else in <main> (sidebar, dashboard chrome) is already-merged and
 * 0-diff, so a same-machine before/after diff isolates the grid extraction.
 *
 * HOW IT IS USED (same-machine before/after, NOT a committed cross-platform golden):
 *   1. On pre-extraction code: `PIXEL_PARITY=1 npx playwright test grid_pixel_parity` writes baselines.
 *   2. After the extraction: re-run — Playwright COMPARES; 0 diff == parity.
 * Baselines are gitignored (.gitignore: e2e/*-snapshots/) — win32-specific local proof, not a CI golden.
 * Opt-in: SKIPS unless PIXEL_PARITY=1 (and win32).
 *
 * NOTE: the default mock view is an active pane (terminal-pane); we drop back to the grid via the
 * Back-to-grid affordance. Compact is the default gridDisplayMode and carries the riskiest card
 * (raw-key-bar-grid). The other three card modes are guarded by the mock-e2e DOM lane + the
 * adversarial byte-fidelity review (all four renderers move atomically by the same mechanism).
 */
import { test, expect, gotoMockedApp } from "./fixtures";

test.skip(process.env.PIXEL_PARITY !== "1" || process.platform !== "win32", "grid pixel parity is an opt-in Windows-local refactor tool (set PIXEL_PARITY=1)");

const SHOT = { animations: "disabled" as const, caret: "hide" as const };

test.describe("pane grid pixel parity", () => {
  test("the dashboard pane grid renders identically (compact cards + AnimatePresence popLayout)", async ({ page }) => {
    await gotoMockedApp(page);
    // Default mock view is an active pane; drop back to the dashboard grid view.
    await expect(page.getByTestId("terminal-pane")).toBeVisible();
    await page.getByTitle(/^Back to grid/).click();
    await expect(page.getByTitle(/^Exit pane/)).toBeHidden();
    await expect(page.locator("main")).toHaveScreenshot("dashboard-grid-compact.png", SHOT);
  });
});
