import { expect, test, type Page } from "@playwright/test";

/**
 * LIVE lane — operator direct-typing into a focused xterm pane (companion to
 * live_journeys.spec.ts; same lane, same style, same honesty rules). Runs ONLY under the
 * "live" Playwright project (`npm run test:e2e:live` → real `tsx server.ts`, fresh temp
 * JANUS_DB, real PTYs, real observe-WS). NO ?mock=1.
 *
 * Why live-only: the feature is a keystroke → PTY round-trip. It has NO REST fallback and (by
 * design) does not echo locally — the proof is the real shell echoing the typed bytes back
 * through stdout. The mock lane has no backend and no open observe socket, so the `pane_input`
 * frame would never depart (the onInput guard requires an OPEN ws); there is nothing to assert
 * there. The server-side helper (applyPaneInputFrame) is unit-pinned in tests/test_pane_input.ts;
 * this spec covers the full wire end-to-end.
 *
 * Journey covered:
 *   Open a pane's burner, click the xterm [data-testid="burner-terminal"] to focus it, use
 *   page.keyboard to send "echo hi" + Enter, and assert the echoed text appears in the terminal.
 *   This proves the whole path fires: keyboard → TerminalView onData/onInput → WS frame
 *   { type:"pane_input", paneId, data } → server applyPaneInputFrame → term.writeRaw → real PTY
 *   → stdout echo → xterm display.
 *
 * The lane shares ONE live server with the other live_*.spec.ts files (single worker, filename
 * order), so every name is unique to this file and the pane is 86'd at the end.
 */
test.describe.configure({ mode: "serial" });

const RUN = Math.random().toString(36).slice(2, 7);
const PROJECT_NAME = `Typing ${RUN}`;
const PANE_NAME = "typing pane"; // createPane slugs this → pane id "typing-pane-xxxx"
const PANE_ID_PREFIX = "typing-pane-";
const MARKER = `PANEIN_${RUN}`; // unique per run → the round-trip assertion can't pass on stale scrollback

async function boot(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByTestId("tab-line")).toBeVisible();
  // Wait for the observe socket — the pane_input frame rides the same socket.
  await expect(page.getByTestId("kitchen-status")).toContainText("Kitchen open", { timeout: 30_000 });
}

function paneCard(page: Page) {
  return page.locator(`[data-testid="station-card"][data-pane-id^="${PANE_ID_PREFIX}"]`);
}

async function openBurner(page: Page) {
  await paneCard(page).first().click();
  await expect(page.getByTestId("burner")).toBeVisible();
}

test("pane_input path: keyboard → TerminalView → WS frame → PTY → echo visible in xterm", async ({ page }) => {
  await boot(page);

  // ── create a project and a real bash pane (the live_journeys creation flow) ──
  await page.getByText("New project").click();
  const modal = page.getByTestId("orbital-modal");
  await expect(modal).toBeVisible();
  await page.getByTestId("newproject-name").fill(PROJECT_NAME);
  await page.getByPlaceholder("~/code/notifications").fill("."); // a real cwd for the PTY spawn
  await modal.getByText("Open it up").click();

  const projRow = page.locator('[data-testid^="project-row-"]', { hasText: PROJECT_NAME });
  await expect(projRow).toBeVisible({ timeout: 15_000 });
  await projRow.click(); // make it the active project

  await page.getByTestId("pass-jot-input").fill(`typing ticket ${RUN}`);
  await page.getByTestId("pass-jot-add").click();
  const ticket = page.locator('[data-testid="pass-ticket"]', { hasText: `typing ticket ${RUN}` });
  await expect(ticket).toHaveCount(1);
  await ticket.getByTestId("pass-ticket-fire").click();
  await expect(modal).toBeVisible();
  await page.getByTestId("newpane-name").fill(PANE_NAME);
  await modal.getByText("Custom", { exact: true }).click(); // Custom preset → bash (exists everywhere)
  await modal.getByText("let 'em cook").click();            // pane-level Full Auto (harmless; pane_input is ungated)
  await modal.getByText("Fire it up").click();

  // create_pane defaults to Ask → server defers (202) → confirm at the pass. Tolerant of an Auto
  // resolution (then the card just appears), like live_journeys / live_kitchen.
  const actionDialog = page.getByTestId("action-dialog");
  await expect(actionDialog.or(paneCard(page).first())).toBeVisible({ timeout: 30_000 });
  if (await actionDialog.isVisible()) {
    await expect(actionDialog).toContainText("create_pane");
    await page.getByTestId("action-confirm").click();
  }
  await expect(paneCard(page)).toHaveCount(1, { timeout: 60_000 });

  // ── open the burner and wait for the PTY's shell prompt before typing (so bytes aren't dropped in
  //    the ConPTY spawn window) — more robust than a fixed sleep. ──
  await openBurner(page);
  const terminal = page.getByTestId("burner-terminal");
  await expect(terminal).toContainText(/[$#>]/, { timeout: 30_000 }); // the shell prompt is up

  // ── focus the xterm's ACTUAL key target (the helper <textarea> xterm renders inside the wrapper),
  //    then type a UNIQUELY-SEEDED command. The marker is unique to this run, so the assertion below
  //    cannot be satisfied by pre-existing scrollback — only bytes that completed the round-trip AFTER
  //    we typed can contain it. ──
  await terminal.click();
  await page.locator('[data-testid="burner-terminal"] textarea').focus();
  await page.keyboard.type(`echo ${MARKER}`);
  await page.keyboard.press("Enter");

  // ── assert: the unique marker comes back through the terminal, proving the full path:
  //    keyboard → TerminalView onInput → WS pane_input frame → server applyPaneInputFrame →
  //    term.writeRaw → real PTY → stdout echo → xterm display. ──
  await expect(terminal).toContainText(MARKER, { timeout: 30_000 });

  // ── clean our pane off the board: a running pane takes the two-tap "Sure, Chef?" confirm. Poll for
  //    the confirm state (data-confirming) BEFORE the second tap so it can't race the React re-render
  //    and get skipped — which would leak the pane onto the shared live board for the next file. ──
  const btn86 = page.getByTestId("burner-86");
  await btn86.click();
  await expect(btn86).toHaveAttribute("data-confirming", "true");
  await btn86.click();
  await expect(paneCard(page)).toHaveCount(0, { timeout: 30_000 });
});
