/**
 * ledger_data_pixel_parity.spec.ts — PIXEL-PARITY gate (bead wsm-e2e-pinned-4ib).
 *
 * Operator acceptance gate #2: "ensure pixel parity for every interaction type." The useLedgerData
 * extraction moves STATE + FETCHERS only — it touches zero JSX/CSS — so the rendered cockpit must be
 * pixel-identical before and after. This spec drives each ledger-data-fed interaction state through
 * the deterministic ?mock=1 harness and snapshots the stable component, so a same-machine before/after
 * run proves zero visual drift.
 *
 * HOW IT IS USED (same-machine before/after, not a committed cross-platform golden):
 *   1. On pre-extraction code: `npx playwright test ledger_data_pixel_parity` writes the baselines.
 *   2. After the extraction: re-run — Playwright COMPARES against those baselines; 0 diff == parity.
 * Baselines are gitignored (.gitignore: *-snapshots/) — they are Windows-specific and a local proof
 * artifact, NOT a CI golden (Linux font rendering would false-fail). The spec SKIPS under CI / non-win32
 * so the Linux e2e lane never tries to compare against a win32 baseline.
 *
 * Each snapshot's intent is catalogued in docs/superpowers/specs/2026-06-24-ledger-data-parity-catalogue.md.
 */
import { test, expect, gotoMockedApp, setFrozenMock, injectPendingApproval, injectPendingAction, MOCK_TERMINAL_ID } from "./fixtures";

// OPT-IN refactor verification tool, not a standing gate. Run deliberately with PIXEL_PARITY=1 (and on
// Windows — win32 baselines can't match a Linux render). Skipped by default so it never trips the
// shared e2e lane / CI on a worktree without locally-written baselines (which are gitignored).
//   PIXEL_PARITY=1 npx playwright test ledger_data_pixel_parity.spec.ts
test.skip(process.env.PIXEL_PARITY !== "1" || process.platform !== "win32", "pixel parity is an opt-in Windows-local refactor tool (set PIXEL_PARITY=1)");

const SHOT = { animations: "disabled" as const, caret: "hide" as const };

test.describe("ledger-data pixel parity", () => {
  test("boot cockpit renders identically (terminals/ledger/settings/plans/archive state)", async ({ page }) => {
    await gotoMockedApp(page);
    // The main pane area is driven entirely by ledger-data state (the seeded mock pane + ledger).
    await expect(page.getByTestId("terminal-pane")).toHaveScreenshot("boot-terminal-pane.png", SHOT);
  });

  test("FROZEN emergency-stop banner renders identically (frozen/frozenRunning state)", async ({ page }) => {
    await gotoMockedApp(page);
    // The safety-critical kill-switch surface — the highest-value parity check on this keystone.
    await setFrozenMock(page, true, [MOCK_TERMINAL_ID]);
    await expect(page.getByTestId("frozen-banner")).toHaveScreenshot("frozen-banner.png", SHOT);
  });

  test("approval modal renders identically (pendingCommands path)", async ({ page }) => {
    await gotoMockedApp(page);
    await injectPendingApproval(page, "rm -rf ./build", MOCK_TERMINAL_ID);
    await expect(page.getByTestId("approval-dialog").first()).toHaveScreenshot("approval-dialog.png", SHOT);
  });

  test("pending-action dialog renders identically (pendingActions path)", async ({ page }) => {
    await gotoMockedApp(page);
    await injectPendingAction(page, "shell.write", "Append a line to notes.md");
    await expect(page.getByTestId("action-dialog").first()).toHaveScreenshot("action-dialog.png", SHOT);
  });
});
