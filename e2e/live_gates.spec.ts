import { expect, test, type Page } from "@playwright/test";

/**
 * LIVE lane — per-pane autonomy from the UI (companion to live_kitchen.spec.ts; same lane,
 * same style, same honesty rules). Runs ONLY under the "live" Playwright project
 * (`npm run test:e2e:live` → real `tsx server.ts`, fresh temp JANUS_DB, real PTYs). NO ?mock=1.
 *
 * Journey: the operator tunes ONE station's rules in Back of House → Rulebook (pane scope),
 * the override persists across a full reload (ledger truth via PUT
 * /api/projects/:p/panes/:id/capability-gates), and it actually GOVERNS the gate engine —
 * WITHOUT the server's active project ever pointing at the pane's project (the engine resolves
 * the pane's OWNING project, findPaneOwningProject in src/gating/index.ts; the server context is
 * deliberately parked on a decoy project for the whole lane to pin that decoupling):
 *   - restart_pane override = Auto  → the burner's "Re-fire" runs immediately (200, no dialog)
 *   - restart_pane override = Ask   → the same click DEFERS (202 → action_pending → the
 *     action-dialog at the pass), and confirming it fires the real restart.
 * restart_pane is the right probe: it defaults to Ask globally, is never spotlight-loosened
 * (SPOTLIGHT_CAPABILITIES = productive writes only), and the REST route enforces it (c55 Batch C).
 *
 * The lane shares ONE live server with the other live_*.spec.ts files (single worker, filename
 * order) — selectors are scoped to THIS file's unique names and the pane is 86'd at the end
 * (live_kitchen boots asserting an empty Line).
 */
test.describe.configure({ mode: "serial" });

const RUN = Math.random().toString(36).slice(2, 7);
const PROJECT_NAME = `Gates ${RUN}`;
const PANE_NAME = "gates pane"; // createPane slugs this → pane id "gates-pane-xxxx"
const PANE_ID_PREFIX = "gates-pane-";

let projectId = "";
let paneId = "";

async function boot(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByTestId("tab-line")).toBeVisible();
  await expect(page.getByTestId("kitchen-status")).toContainText("Kitchen open", { timeout: 30_000 });
}

function paneCard(page: Page) {
  return page.locator(`[data-testid="station-card"][data-pane-id^="${PANE_ID_PREFIX}"]`);
}

// Back of House → Rulebook → scope to OUR pane, returning the restart_pane rule row.
async function openPaneRulebook(page: Page) {
  await page.getByTestId("tab-boh").click();
  await expect(page.getByTestId("boh-body")).toBeVisible();
  const scopeBtn = page.getByTestId(`rulebook-scope-${paneId}`);
  await expect(scopeBtn).toBeVisible({ timeout: 15_000 });
  await scopeBtn.click();
  await expect(page.getByTestId("rulebook-scope-note")).toContainText("overrides win");
  return page.getByTestId("rule-restart_pane");
}

test("a per-pane gate override set in the Rulebook persists across reload (server truth)", async ({ page }) => {
  await boot(page);

  // ── a project + a real bash pane (guarded — the modal's HiTL default — so nothing here
  //    depends on pane-level Full Auto loosening anything) ──
  await page.getByText("New project").click();
  const modal = page.getByTestId("orbital-modal");
  await expect(modal).toBeVisible();
  await page.getByTestId("newproject-name").fill(PROJECT_NAME);
  await page.getByPlaceholder("~/code/notifications").fill(".");
  await modal.getByText("Open it up").click();
  const projRow = page.locator('[data-testid^="project-row-"]', { hasText: PROJECT_NAME });
  await expect(projRow).toBeVisible({ timeout: 15_000 });
  projectId = (await projRow.getAttribute("data-testid"))!.replace("project-row-", "");
  await projRow.click();

  await page.getByTestId("pass-jot-input").fill(`gates ticket ${RUN}`);
  await page.getByTestId("pass-jot-add").click();
  await page.locator('[data-testid="pass-ticket"]', { hasText: `gates ticket ${RUN}` })
    .getByTestId("pass-ticket-fire").click();
  await expect(modal).toBeVisible();
  await page.getByTestId("newpane-name").fill(PANE_NAME);
  await modal.getByText("Custom", { exact: true }).click(); // Custom preset → bash
  await modal.getByText("Fire it up").click(); // keep "taste every plate" (HiTL default)

  const actionDialog = page.getByTestId("action-dialog");
  await expect(actionDialog.or(paneCard(page).first())).toBeVisible({ timeout: 30_000 });
  if (await actionDialog.isVisible()) {
    await expect(actionDialog).toContainText("create_pane");
    await page.getByTestId("action-confirm").click();
  }
  await expect(paneCard(page)).toHaveCount(1, { timeout: 60_000 });
  paneId = (await paneCard(page).first().getAttribute("data-pane-id"))!;

  // SERVER-SIDE COUPLING this lane surfaced — NOW FIXED: the gate engine used to resolve
  // per-pane overrides from the ACTIVE project only (effectiveCapabilityGateFor →
  // ledger.getActiveProject()), so an override on a pane in a non-active project was written
  // fine but never consulted until something switched server context. The resolver now finds
  // the pane's OWNING project (findPaneOwningProject, src/gating/index.ts). To prove the
  // DECOUPLING live — not just that the happy path works — we deliberately park the server's
  // active context on a DECOY project (same REST routes a real operator action rides,
  // live_kitchen's precedent) and NEVER switch back: every gate edit and gated click below
  // must govern our pane while its project is NOT the active one.
  const decoyId = `gates-decoy-${RUN}`;
  expect(decoyId, "the decoy must be a DIFFERENT project, or this lane proves nothing").not.toBe(projectId);
  const decoy = await page.request.post(`/api/projects`, { data: { id: decoyId, directory: "." } });
  expect(decoy.ok()).toBeTruthy();
  const switched = await page.request.post(`/api/projects/${decoyId}/switch`);
  expect(switched.ok()).toBeTruthy();

  // ── Rulebook, pane scope: loosen restart_pane to Auto for THIS station only ──
  const rule = await openPaneRulebook(page);
  await rule.getByTestId("gate-Auto").click();
  await expect(page.getByTestId("toast")).toContainText("Rulebook updated for that station");

  // ── reload: the override must come back from the LEDGER, not client memory ──
  await page.reload();
  await expect(page.getByTestId("kitchen-status")).toContainText("Kitchen open", { timeout: 30_000 });
  const ruleAfter = await openPaneRulebook(page);
  await expect(ruleAfter.getByTestId("gate-Auto")).toHaveAttribute("aria-pressed", "true");
  // …and the kitchen-wide default is untouched (restart_pane stays Ask globally).
  await page.getByTestId("rulebook-scope-kitchen").click();
  await expect(page.getByTestId("rule-restart_pane").getByTestId("gate-Ask")).toHaveAttribute("aria-pressed", "true");
});

test("the override governs the live gate: Auto re-fires immediately, Ask defers to the action dialog", async ({ page }) => {
  expect(paneId, "the persistence test must have created the pane").toBeTruthy();
  await boot(page);
  // NOTE: the server's active project is STILL the decoy from the first test (server state
  // persists across this serial file) — every gated click below resolves our pane's override
  // from its OWNING, non-active project. That is the decoupled behavior under test.
  const actionDialog = page.getByTestId("action-dialog");

  // ── Auto: the burner's Re-fire runs straight through (200) — no dialog, success ack ──
  await paneCard(page).first().click();
  await expect(page.getByTestId("burner")).toBeVisible();
  await page.getByTestId("burner-restart").click();
  await expect(page.getByTestId("toast")).toContainText("Re-firing the station", { timeout: 15_000 });
  await expect(actionDialog).toHaveCount(0);
  await page.getByTestId("burner-close").click();

  // ── tighten the SAME capability back to Ask for this pane ──
  const rule = await openPaneRulebook(page);
  await rule.getByTestId("gate-Ask").click();
  await expect(page.getByTestId("toast")).toContainText("Rulebook updated for that station");

  // ── Ask: the same click now DEFERS — 202 + action_pending → the confirm dialog ──
  await page.getByTestId("tab-line").click();
  await paneCard(page).first().click();
  await expect(page.getByTestId("burner")).toBeVisible();
  await page.getByTestId("burner-restart").click();
  await expect(page.getByTestId("toast")).toContainText("Re-fire queued", { timeout: 15_000 });
  await expect(actionDialog).toBeVisible({ timeout: 15_000 });
  await expect(actionDialog).toContainText("restart_pane");

  // …and confirming at the pass actually runs the deferred restart (the staged closure fires).
  await page.getByTestId("action-confirm").click();
  await expect(page.getByTestId("toast")).toContainText("Fired it", { timeout: 15_000 });
  await expect(actionDialog).toHaveCount(0, { timeout: 15_000 });
  await expect(paneCard(page)).toHaveCount(1); // the station survived its gated re-fire

  // ── cleanup: 86 the pane so the shared board is left clean. A still-running pane arms the
  //    two-tap confirm; a pane that has already exited takes the one-tap freezer path. ──
  await expect(page.getByTestId("burner")).toBeVisible();
  const btn86 = page.getByTestId("burner-86");
  await btn86.click();
  if ((await btn86.count()) > 0 && (await btn86.getAttribute("data-confirming")) !== null) {
    await btn86.click();
  }
  await expect(paneCard(page)).toHaveCount(0, { timeout: 30_000 });
});
