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
 *      Pantry freezer (GET /api/archive) → Restore (POST /api/archive/:id/restore), which
 *      reinstates the ledger row AND respawns the pane's terminal (gated like Re-fire:
 *      restart_pane, default Ask → confirm at the pass), so the station card REAPPEARS.
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
  // The toast is a SINGLE displaceable slot: on a fast runner the "86'd" flash loses it to the
  // trailing async exit announcements ("Pane ... exited." / "Command outcome summary unavailable"
  // — deterministic CI-only failure 2026-07-06, ubuntu live lane, both retries). Every toast also
  // appends a durable line to the radio transcript (useOrbitalData's showToast), so assert the
  // record, not the flash.
  await expect(page.getByTestId("radio-transcript")).toContainText("86'd", { timeout: 15_000 });
  // The pane left the Line (stopAndArchivePane archived its ledger row) and the burner
  // self-closed (its station disappeared from the board).
  await expect(paneCard(page)).toHaveCount(0, { timeout: 30_000 });

  // ── the Pantry freezer shows it (GET /api/archive), and Restore brings the PANE back ──
  await page.getByTestId("tab-pantry").click();
  await expect(page.getByTestId("pantry")).toBeVisible();
  await page.getByTestId(`pantry-project-${projectId}`).click();
  const frozenRow = page.locator(`[data-testid="freezer-pane"][data-pane-id="${paneId}"]`);
  await expect(frozenRow).toBeVisible({ timeout: 15_000 });
  await frozenRow.getByTestId("freezer-restore").click();
  // Toast (not transcript) on purpose: the Pantry tab doesn't render the radio transcript, and
  // unlike the 86 step there is no trailing async announcement to displace this slot.
  await expect(page.getByTestId("toast")).toContainText("back on the line", { timeout: 15_000 });
  await expect(frozenRow).toHaveCount(0, { timeout: 15_000 });

  // SERVER truth: the restore landed in the ledger — the pane row is back under our project.
  const ledger = await (await page.request.get("/api/ledger")).json();
  expect(ledger?.[projectId]?.panes?.[paneId]).toBeTruthy();

  // FIXED (this WAS the gap this lane surfaced): restore now ALSO respawns the pane's terminal
  // from its persisted identity (project cwd + preset-derived launch command — never the old
  // last_command), gated exactly like the burner's Re-fire (restart_pane, default Ask). Under
  // Ask the ledger row lands immediately and the SPAWN defers to the action dialog — which is a
  // GLOBAL fixed overlay that intercepts pointer events, so it must be handled BEFORE any tab
  // navigation (clicking tab-line under it times out; an unconfirmed pending action then
  // cascades its overlay into every later spec on this shared server). Tolerant of an Auto
  // resolution (no dialog — the card just appears after the tab switch below).
  const actionDialog = page.getByTestId("action-dialog");
  const dialogAppeared = await actionDialog
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (dialogAppeared) {
    await expect(actionDialog).toContainText("restart_pane");
    await page.getByTestId("action-confirm").click();
    await expect(actionDialog).toHaveCount(0, { timeout: 15_000 });
  }

  // SERVER truth first (no UI dependency): the respawned pane joins live manager.terminals.
  await expect
    .poll(
      async () => {
        const t = await (await page.request.get("/api/terminals")).json();
        return Array.isArray(t) && (t as { id: string }[]).some((x) => x.id === paneId);
      },
      { timeout: 60_000 },
    )
    .toBe(true);

  // The respawn ACTIVATES the pane (the create-activates effect), and the kitchen auto-opens the
  // active pane's burner window — a fixed modal that intercepts tab clicks. Close it if it landed
  // before navigating (it may arrive a beat after the spawn broadcast — give it a settle).
  await page.waitForTimeout(750);
  const burner = page.getByTestId("burner");
  if (await burner.isVisible().catch(() => false)) {
    await page.getByTestId("burner-close").click();
    await expect(burner).toHaveCount(0, { timeout: 15_000 });
  }

  // The station card REAPPEARS on the Line — the board derives stations from GET /api/terminals
  // (live manager.terminals), so the respawned pane is visible everywhere again.
  await page.getByTestId("tab-line").click();
  await expect(
    page.locator(`[data-testid="station-card"][data-pane-id="${paneId}"]`),
  ).toHaveCount(1, { timeout: 60_000 });

  // ── clean our pane off the board again (live_kitchen boots asserting an EMPTY Line): 86 the
  // now-RUNNING station — a running pane takes the two-tap "Sure, Chef?" confirm. ──
  await openBurner(page);
  const btn86 = page.getByTestId("burner-86");
  await btn86.click();
  if ((await btn86.count()) > 0 && (await btn86.getAttribute("data-confirming")) !== null) {
    await btn86.click(); // second tap confirms the 86 on a running pane
  }
  await expect(paneCard(page)).toHaveCount(0, { timeout: 30_000 });
});
