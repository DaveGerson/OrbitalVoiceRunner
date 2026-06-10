import { expect, test } from "@playwright/test";

/**
 * 4U.4 — the LIVE lane (test honesty). Runs ONLY under the "live" Playwright project
 * (`npm run test:e2e:live` → PW_LIVE=1 → playwright.config.ts boots the REAL `tsx server.ts`
 * on a fresh temp JANUS_DB; no GEMINI key needed — the lane tests REST + the observe WS,
 * never a voice session). NO ?mock=1: every flow below crosses the real wire — pane creation
 * through the capability gate (create_pane defaults to Ask → 202 → confirm at the pass), the
 * stop-all freeze trio, and clear-exited — the exact paths the mock harness short-circuits.
 *
 * ONE serial spec by design: each step builds on the server state the previous one made.
 */
test.describe.configure({ mode: "serial" });

test("boot → real board → new pane via the UI → stop-all freeze/release → clear-exited", async ({ page }) => {
  // ── 1) boot: the kitchen renders REAL (non-mock) against the live server ──
  await page.goto("/");
  await expect(page.getByTestId("tab-line")).toBeVisible();
  // the ?mock=1 harness never armed: no e2e-ready marker, no seeded mock panes
  expect(await page.locator("html[data-e2e-ready='1']").count()).toBe(0);
  await expect(page.locator('[data-testid="station-card"]')).toHaveCount(0);
  // the observe /live?observe=1 socket actually attached (auth cookie auto-seeded by the server)
  await expect(page.getByTestId("kitchen-status")).toContainText("Kitchen open", { timeout: 30_000 });

  // ── 2) open a project (the fresh temp DB boots an empty kitchen) ──
  await page.getByText("New project").click();
  await expect(page.getByTestId("orbital-modal")).toBeVisible();
  await page.getByTestId("newproject-name").fill("Live Smoke");
  await page.getByPlaceholder("~/code/notifications").fill("."); // a real cwd for the PTY spawn
  await page.getByText("Open it up").click();
  const projRow = page.locator('[data-testid^="project-row-"]:not([data-testid="project-row-all"])');
  await expect(projRow).toHaveCount(1, { timeout: 15_000 }); // POST /api/projects landed; ledger refetched
  await projRow.click();

  // ── 3) fire a pane via the UI (Pass ticket → "Fire a pane" → New Pane modal) ──
  await page.getByTestId("pass-jot-input").fill("live smoke ticket");
  await page.getByTestId("pass-jot-add").click();
  await expect(page.getByTestId("pass-ticket")).toHaveCount(1);
  await page.getByTestId("pass-ticket-fire").click();
  await expect(page.getByTestId("orbital-modal")).toBeVisible();
  await page.getByTestId("newpane-name").fill("smoke pane");
  await page.getByText("Custom", { exact: true }).click(); // Custom preset → bash (exists everywhere)
  await page.getByText("let 'em cook").click(); // pane-level Full Auto, so the Order Pad send runs
  await page.getByText("Fire it up").click();

  // POST /api/terminals runs through the REAL capability gate. Default settings gate create_pane
  // on Ask → the server defers (202) and pushes action_pending → the confirm dialog at the pass.
  // (Kept tolerant of an Auto resolution: then the card just appears.)
  const actionDialog = page.getByTestId("action-dialog");
  const stationCard = page.locator('[data-testid="station-card"]');
  await expect(actionDialog.or(stationCard.first())).toBeVisible({ timeout: 30_000 });
  if (await actionDialog.isVisible()) {
    await expect(actionDialog).toContainText("create_pane");
    await page.getByTestId("action-confirm").click(); // POST /api/actions/:id/confirm
  }
  // the REAL PTY spawned and the pane landed on the Line (terminals_updated → board repaint)
  await expect(stationCard).toHaveCount(1, { timeout: 60_000 });
  await expect(stationCard.first()).toContainText("smoke-pane");

  // ── 4) stop-all: freeze engages server-side, survives a reload, releases ──
  await page.getByTestId("all-hands").click(); // POST /api/stop-all + the panic overlay
  await expect(page.getByTestId("emergency-stop")).toBeVisible();
  // reload: the freeze is SERVER state (GET /api/stop-all/status) — the banner must come back
  await page.reload();
  await expect(page.getByTestId("frozen-banner")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("frozen-banner").click();
  await expect(page.getByTestId("emergency-stop")).toBeVisible();
  await page.getByText("Release the brake").click(); // POST /api/stop-all/release
  await expect(page.getByTestId("frozen-banner")).toHaveCount(0);
  await expect(page.getByTestId("emergency-stop")).toHaveCount(0);
  // and the release stuck server-side too
  await page.reload();
  await expect(page.getByTestId("kitchen-status")).toContainText("Kitchen open", { timeout: 30_000 });
  await expect(page.getByTestId("frozen-banner")).toHaveCount(0);

  // ── 5) clear-exited: walk the pane to Exited for real, then clear the line ──
  await page.locator('[data-testid="station-card"]').first().click();
  await expect(page.getByTestId("burner")).toBeVisible();
  // the Order Pad send is operator-direct (the operator IS the approval): bash gets `exit`
  await page.getByTestId("burner-draft").fill("exit");
  await page.waitForTimeout(500); // let the draft_edit frame persist server-side before send
  await page.getByText("Send to the line").click(); // POST /api/panes/:proj/:pane/draft/send
  await page.getByTestId("burner-close").click();
  // the real PTY died → pane_status pushes Exited onto the board
  await expect(page.locator('[data-testid="station-card"][data-status="Exited"]')).toHaveCount(1, { timeout: 90_000 });
  await expect(page.getByTestId("clear-exited")).toBeVisible();
  await page.getByTestId("clear-exited").click(); // POST /api/terminals/clear-exited
  await expect(page.locator('[data-testid="station-card"]')).toHaveCount(0, { timeout: 30_000 });
});
