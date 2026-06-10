import { expect, test, type Page } from "@playwright/test";

/**
 * LIVE lane — core operator journeys the mock harness short-circuits (companion to
 * live_kitchen.spec.ts; same lane, same style, same honesty rules). Runs ONLY under the
 * "live" Playwright project (`npm run test:e2e:live` → real `tsx server.ts`, fresh temp
 * JANUS_DB, real PTYs, real observe-WS). NO ?mock=1 anywhere.
 *
 * Journeys covered here:
 *   1. Draft durability — the Order Pad draft persists SERVER-side (draft_edit over the
 *      observe WS → ledger.setDraft), survives a full page reload, and Send actually
 *      reaches the live bash PTY (the echoed marker comes back through the stdout stream).
 *   2. Pane lifecycle — real command → `exit` → Exited card → "86 this station" → the
 *      Pantry freezer (GET /api/archive) → Restore (POST /api/archive/:id/restore).
 *
 * The lane shares ONE live server with the other live_*.spec.ts files (single worker,
 * filename order), so every selector is scoped to THIS file's unique project/pane names and
 * the file cleans its own panes off the board (live_kitchen boots asserting an empty Line).
 */
test.describe.configure({ mode: "serial" });

const RUN = Math.random().toString(36).slice(2, 7);
const PROJECT_NAME = `Journeys ${RUN}`;
const PANE_NAME = "journey pane"; // createPane slugs this → pane id "journey-pane-xxxx"
const PANE_ID_PREFIX = "journey-pane-";
const MARKER = `LIVE_JOURNEY_${RUN}`;

// Serial state carried between the tests in this file (same worker process).
let projectId = "";
let paneId = "";

async function boot(page: Page) {
  // Reduced motion, like live_kitchen: the kitchen's signature animations never settle and
  // would spin Playwright's stability checks forever.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByTestId("tab-line")).toBeVisible();
  // Wait for the observe socket — the Order Pad persists drafts over it (draft_edit frames).
  await expect(page.getByTestId("kitchen-status")).toContainText("Kitchen open", { timeout: 30_000 });
}

function paneCard(page: Page) {
  return page.locator(`[data-testid="station-card"][data-pane-id^="${PANE_ID_PREFIX}"]`);
}

async function openBurner(page: Page) {
  await paneCard(page).first().click();
  await expect(page.getByTestId("burner")).toBeVisible();
}

// Type into the Order Pad and send it to the real PTY. The 600ms pause lets the draft_edit
// frame persist server-side before send (live_kitchen's tolerance pattern).
async function sendDraft(page: Page, text: string) {
  await page.getByTestId("burner-draft").fill(text);
  await page.waitForTimeout(600);
  await page.getByText("Send to the line").click();
}

test("draft durability: the Order Pad draft survives a reload (server truth) and Send reaches the PTY", async ({ page }) => {
  await boot(page);

  // ── a project + a real bash pane of our own ──
  await page.getByText("New project").click();
  const modal = page.getByTestId("orbital-modal");
  await expect(modal).toBeVisible();
  await page.getByTestId("newproject-name").fill(PROJECT_NAME);
  await page.getByPlaceholder("~/code/notifications").fill("."); // a real cwd for the PTY spawn
  await modal.getByText("Open it up").click();
  const projRow = page.locator('[data-testid^="project-row-"]', { hasText: PROJECT_NAME });
  await expect(projRow).toBeVisible({ timeout: 15_000 });
  projectId = (await projRow.getAttribute("data-testid"))!.replace("project-row-", "");
  await projRow.click(); // selects the project (board scope + Pass jot target)

  await page.getByTestId("pass-jot-input").fill(`journeys ticket ${RUN}`);
  await page.getByTestId("pass-jot-add").click();
  const ticket = page.locator('[data-testid="pass-ticket"]', { hasText: `journeys ticket ${RUN}` });
  await expect(ticket).toHaveCount(1);
  await ticket.getByTestId("pass-ticket-fire").click();
  await expect(modal).toBeVisible();
  await page.getByTestId("newpane-name").fill(PANE_NAME);
  await modal.getByText("Custom", { exact: true }).click(); // Custom preset → bash (exists everywhere)
  await modal.getByText("let 'em cook").click(); // pane-level Full Auto
  await modal.getByText("Fire it up").click();

  // create_pane defaults to Ask → the server defers (202) and pushes action_pending. Kept
  // tolerant of an Auto resolution (then the card just appears), like live_kitchen.
  const actionDialog = page.getByTestId("action-dialog");
  await expect(actionDialog.or(paneCard(page).first())).toBeVisible({ timeout: 30_000 });
  if (await actionDialog.isVisible()) {
    await expect(actionDialog).toContainText("create_pane");
    await page.getByTestId("action-confirm").click();
  }
  await expect(paneCard(page)).toHaveCount(1, { timeout: 60_000 });
  paneId = (await paneCard(page).first().getAttribute("data-pane-id"))!;

  // ── the draft: type it, reload the whole page, it's still there (server-persisted) ──
  await openBurner(page);
  await page.getByTestId("burner-draft").fill(`echo ${MARKER}`);
  await page.waitForTimeout(600); // let the draft_edit frame land server-side
  await page.reload();
  await expect(page.getByTestId("kitchen-status")).toContainText("Kitchen open", { timeout: 30_000 });
  await openBurner(page);
  // The Order Pad refetches GET /api/panes/:proj/:pane/draft on open — server truth, not
  // client memory (the reload wiped all client state).
  await expect(page.getByTestId("burner-draft")).toHaveValue(`echo ${MARKER}`, { timeout: 15_000 });

  // ── send it: the marker must come back through the real PTY's stdout stream ──
  await page.getByText("Send to the line").click();
  await expect(page.getByTestId("burner-terminal")).toContainText(MARKER, { timeout: 30_000 });
  // …and a successful send clears the pad (server clears the draft + pushes draft_updated).
  await expect(page.getByTestId("burner-draft")).toHaveValue("", { timeout: 15_000 });
  await page.getByTestId("burner-close").click();
});

test("pane lifecycle: exit → Exited card → 86 to the freezer → restore (ledger truth)", async ({ page }) => {
  expect(paneId, "the draft test must have created the pane").toBeTruthy();
  await boot(page);

  // ── walk the pane to Exited for real (the operator-direct Order Pad send) ──
  await openBurner(page);
  await sendDraft(page, "exit");
  await page.getByTestId("burner-close").click();
  await expect(
    page.locator(`[data-testid="station-card"][data-pane-id="${paneId}"][data-status="Exited"]`),
  ).toHaveCount(1, { timeout: 90_000 });

  // ── "86 this station": an Exited pane skips the confirm tap → straight to the freezer ──
  await openBurner(page);
  await page.getByTestId("burner-86").click();
  await expect(page.getByTestId("toast")).toContainText("86'd", { timeout: 15_000 });
  // The pane left the Line (stopAndArchivePane archived its ledger row) and the burner
  // self-closed (its station disappeared from the board).
  await expect(paneCard(page)).toHaveCount(0, { timeout: 30_000 });

  // ── the Pantry freezer shows it (GET /api/archive), and Restore brings the record back ──
  await page.getByTestId("tab-pantry").click();
  await expect(page.getByTestId("pantry")).toBeVisible();
  await page.getByTestId(`pantry-project-${projectId}`).click();
  const frozenRow = page.locator(`[data-testid="freezer-pane"][data-pane-id="${paneId}"]`);
  await expect(frozenRow).toBeVisible({ timeout: 15_000 });
  await frozenRow.getByTestId("freezer-restore").click();
  await expect(page.getByTestId("toast")).toContainText("back on the line", { timeout: 15_000 });
  await expect(frozenRow).toHaveCount(0, { timeout: 15_000 });

  // SERVER truth: the restore landed in the ledger — the pane row is back under our project.
  const ledger = await (await page.request.get("/api/ledger")).json();
  expect(ledger?.[projectId]?.panes?.[paneId]).toBeTruthy();

  // SERVER-SIDE GAP this lane surfaced (reported, not papered over): restore_archived_pane
  // only reinstates the LEDGER row (ledger.restoreArchivedPane — no PTY respawn), and the
  // board derives stations from GET /api/terminals, which lists only live manager.terminals
  // (registry.ts list_panes, c55 Batch F). So a restored pane is INVISIBLE everywhere in the
  // kitchen UI — no card on the Line, not in the Pantry's pane list — until something
  // respawns it. The freezer row disappearing + the toast are the only operator feedback.
  const terminals = await (await page.request.get("/api/terminals")).json();
  expect(Array.isArray(terminals)).toBe(true);
  expect((terminals as { id: string }[]).some((t) => t.id === paneId)).toBe(false);
  await expect(paneCard(page)).toHaveCount(0); // honest: restore does NOT put a card back
});
