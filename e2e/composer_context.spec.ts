import { test, expect, gotoMockedApp, switchActivePane, MOCK_TERMINAL_ID_2 } from "./fixtures";

/**
 * f06 (bead wsm-e2e-pinned-f06): the Workbench context body must track the active pane in the SAME
 * frame the cyan highlight moves — no server round-trip. The felt bug was "highlight snaps to the new
 * pane instantly, but name + model/human context still show the PREVIOUS pane until set_active_pane
 * round-trips and the server broadcasts terminals_updated/ledger_updated back."
 *
 * The harness seeds a 2-pane ledger (mock_pane_1 = "React Frontend"/A-*, mock_pane_2 = "Python
 * Backend"/B-*) and `switchActivePane` drives the REAL setActiveTerminalId path WITHOUT any broadcast.
 * To make the no-round-trip assertion airtight, we also abort any /api/ledger refetch so a refresh
 * cannot "rescue" the body. If the body still flips, it derives purely from the local ledger in-frame.
 */
test.describe("composer context body tracks the active pane (f06)", () => {
  test("A→B context flips with NO broadcast and NO ledger refetch", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });

    // Belt-and-suspenders: forbid any ledger refetch from rescuing the body. The switch path emits
    // no broadcast anyway, but aborting /api/ledger proves the flip is purely the local derivation.
    await page.route(/\/api\/ledger/, (route) => route.abort());

    await gotoMockedApp(page);

    // Guard: this assertion only means something on THIS build (the testid is new on this branch).
    const body = page.getByTestId("pane-context-body");
    await expect(body).toBeVisible();

    // Pane A (mock_pane_1) active on load → body shows A's name + A's model/human context.
    await expect(page.getByTestId("composer-target-pane")).toContainText("React Frontend");
    await expect(body).toContainText("A-model-context");
    await expect(body).toContainText("A-human-context");
    // ...and NOT B's context yet.
    await expect(body).not.toContainText("B-model-context");

    // Switch to B (mock_pane_2) via the real setActiveTerminalId path — NO broadcast delivered.
    await switchActivePane(page, MOCK_TERMINAL_ID_2);

    // The body must flip in-frame: name + model/human context all become B's.
    await expect(page.getByTestId("composer-target-pane")).toContainText("Python Backend");
    await expect(body).toContainText("B-model-context");
    await expect(body).toContainText("B-human-context");
    // ...and A's context is gone (no stale lag).
    await expect(body).not.toContainText("A-model-context");
  });

  test("rapid double-switch A→B→A: the body reflects the LAST switch (pure derivation can't lag)", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.route(/\/api\/ledger/, (route) => route.abort());
    await gotoMockedApp(page);

    const body = page.getByTestId("pane-context-body");
    // Two switches back-to-back; last write (back to A) must win.
    await switchActivePane(page, MOCK_TERMINAL_ID_2);
    await switchActivePane(page, "mock_pane_1");

    await expect(page.getByTestId("composer-target-pane")).toContainText("React Frontend");
    await expect(body).toContainText("A-model-context");
    await expect(body).not.toContainText("B-model-context");
  });
});
