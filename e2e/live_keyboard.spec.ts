import { expect, test, type Page } from "@playwright/test";

/**
 * LIVE lane — keyboard-only operation against the real board (companion to
 * live_kitchen.spec.ts; same lane, same style, same honesty rules). Runs ONLY under the
 * "live" Playwright project (`npm run test:e2e:live` → real `tsx server.ts`, fresh temp
 * JANUS_DB, real PTYs). NO ?mock=1.
 *
 * Journeys (2K.5 — keyboard reachability, exercised end-to-end for real):
 *   1. All Hands by keyboard: Tab to the top-bar trigger → Enter freezes the line
 *      SERVER-side (POST /api/stop-all), the emergency dialog traps focus, and
 *      Tab → Enter on "Release the brake" releases it server-side.
 *   2. A station card is a real button: Tab reaches it (with the kitchen's loud
 *      :focus-visible ring actually painted), Enter opens the burner, Escape closes it.
 *
 * The lane shares ONE live server with the other live_*.spec.ts files (single worker,
 * filename order) — selectors are scoped to THIS file's unique names and the pane is 86'd
 * at the end (live_kitchen boots asserting an empty Line).
 */
test.describe.configure({ mode: "serial" });

const RUN = Math.random().toString(36).slice(2, 7);
const PROJECT_NAME = `Keys ${RUN}`;
const PANE_NAME = "keys pane"; // createPane slugs this → pane id "keys-pane-xxxx"
const PANE_ID_PREFIX = "keys-pane-";

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

/** What the keyboard is currently focused on (testid + pane id, if any). */
async function focusInfo(page: Page): Promise<{ testid: string | null; paneId: string | null }> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return {
      testid: el?.getAttribute("data-testid") ?? null,
      paneId: el?.getAttribute("data-pane-id") ?? null,
    };
  });
}

/** Press Tab until the focused element matches; honest failure if it never does. */
async function tabUntil(
  page: Page,
  match: (info: { testid: string | null; paneId: string | null }) => boolean,
  what: string,
  maxTabs = 100,
): Promise<void> {
  for (let i = 0; i < maxTabs; i++) {
    await page.keyboard.press("Tab");
    if (match(await focusInfo(page))) return;
  }
  throw new Error(`Tab travel never reached ${what} within ${maxTabs} stops — keyboard reachability is broken`);
}

/** The kitchen-wide :focus-visible ring (orbital.css 2K.5) must actually paint on Tab focus. */
async function expectFocusRing(page: Page) {
  const ring = await page.evaluate(() => {
    const s = getComputedStyle(document.activeElement as HTMLElement);
    return { style: s.outlineStyle, width: s.outlineWidth };
  });
  expect(ring.style).toBe("solid");
  expect(ring.width).toBe("3px");
}

test("All Hands by keyboard: Tab→Enter freezes the line server-side; Tab→Enter releases it", async ({ page }) => {
  await boot(page);

  // ── setup (mouse is fine here — the journey under test starts at the Tab travel): a
  //    project + a real bash pane of our own ──
  await page.getByText("New project").click();
  const modal = page.getByTestId("orbital-modal");
  await expect(modal).toBeVisible();
  await page.getByTestId("newproject-name").fill(PROJECT_NAME);
  await page.getByPlaceholder("~/code/notifications").fill(".");
  await modal.getByText("Open it up").click();
  const projRow = page.locator('[data-testid^="project-row-"]', { hasText: PROJECT_NAME });
  await expect(projRow).toBeVisible({ timeout: 15_000 });
  await projRow.click();

  await page.getByTestId("pass-jot-input").fill(`keys ticket ${RUN}`);
  await page.getByTestId("pass-jot-add").click();
  await page.locator('[data-testid="pass-ticket"]', { hasText: `keys ticket ${RUN}` })
    .getByTestId("pass-ticket-fire").click();
  await expect(modal).toBeVisible();
  await page.getByTestId("newpane-name").fill(PANE_NAME);
  await modal.getByText("Custom", { exact: true }).click(); // Custom preset → bash
  await modal.getByText("let 'em cook").click();
  await modal.getByText("Fire it up").click();
  const actionDialog = page.getByTestId("action-dialog");
  await expect(actionDialog.or(paneCard(page).first())).toBeVisible({ timeout: 30_000 });
  if (await actionDialog.isVisible()) {
    await expect(actionDialog).toContainText("create_pane");
    await page.getByTestId("action-confirm").click();
  }
  await expect(paneCard(page)).toHaveCount(1, { timeout: 60_000 });
  paneId = (await paneCard(page).first().getAttribute("data-pane-id"))!;

  // ── keyboard from a clean slate: reload so focus starts at the document, not a button ──
  await page.reload();
  await expect(page.getByTestId("kitchen-status")).toContainText("Kitchen open", { timeout: 30_000 });

  await tabUntil(page, (f) => f.testid === "all-hands", "the All Hands trigger");
  await expectFocusRing(page); // the 2K.5 ring is painted, not just declared
  await page.keyboard.press("Enter"); // POST /api/stop-all + the panic overlay
  await expect(page.getByTestId("emergency-stop")).toBeVisible();
  // The freeze is SERVER state, not a client costume.
  let status = await (await page.request.get("/api/stop-all/status")).json();
  expect(status.frozen).toBe(true);

  // The dialog took initial focus (useDialog: first focusable = the hold-to-kill switch);
  // one Tab lands on "Release the brake", Enter releases — a pure keyboard path. (A quick
  // Enter TAP on hold-to-kill must never fire the kill — that needs a full ~1s hold.)
  expect((await focusInfo(page)).testid).toBe("hold-to-kill");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("emergency-stop")).toHaveCount(0);
  await expect(page.getByTestId("frozen-banner")).toHaveCount(0);
  status = await (await page.request.get("/api/stop-all/status")).json();
  expect(status.frozen).toBe(false);
  // …and the pane survived Stage 1 (freeze ≠ kill).
  await expect(paneCard(page)).toHaveCount(1);
});

test("a station card is keyboard-reachable: Tab → focus ring → Enter opens the burner → Escape closes", async ({ page }) => {
  expect(paneId, "the All Hands test must have created the pane").toBeTruthy();
  await boot(page);

  await tabUntil(page, (f) => f.testid === "station-card" && f.paneId === paneId, "our station card");
  await expectFocusRing(page);
  await page.keyboard.press("Enter");
  const burner = page.getByTestId("burner");
  await expect(burner).toBeVisible();
  await expect(burner).toHaveAttribute("data-burner-pane", paneId);

  // Escape closes the burner (useDialog: top-most overlay only) — still no mouse.
  await page.keyboard.press("Escape");
  await expect(burner).toHaveCount(0);

  // ── cleanup: 86 the (live) pane — two-tap confirm — so the shared board is left clean ──
  await paneCard(page).first().click();
  await expect(burner).toBeVisible();
  await page.getByTestId("burner-86").click();
  await expect(page.getByTestId("burner-86")).toContainText("Sure, Chef?");
  await page.getByTestId("burner-86").click();
  await expect(paneCard(page)).toHaveCount(0, { timeout: 30_000 });
});
