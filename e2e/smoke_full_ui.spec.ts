import { expect, test, type Page } from "@playwright/test";
import { injectTranscript } from "./fixtures";

/**
 * wsm-e2e-pinned-zmu5 — full-UI smoke: one coherent journey across the WHOLE shell, driven
 * through the same ?mock=1 harness idiom the existing Orbital Kitchen specs use (see
 * orbital_line/orbital_radio/orbital_controls/orbital_burner.spec.ts). Deliberately goes to the
 * bare "/" entry point (no ?ui= override) — the kitchen is the real default (src/main.tsx), so
 * this also pins that a stray ?ui=classic default flip would be caught here. Stays UNARMED
 * (no armE2EWire): every interaction below (drafting, firing a pane) is proven to short-circuit
 * client-side under plain ?mock=1 (createPane/createProject gate on isMockModeRef unconditionally;
 * the Order Pad's onChange gates on isE2EWireArmed()), so the smoke run never depends on
 * intercepting or asserting a real network call — it only has to prove the RENDER paths are sane.
 *
 * Two run-wide guards apply across the entire journey, asserted once at the end:
 *   - zero `console.error` messages and zero `pageerror` events (no allowlist — none of the
 *     existing specs surveyed for this suite allowlist anything either);
 *   - the document never overflows horizontally at any point reached below.
 */

async function gotoDefaultApp(page: Page): Promise<void> {
  // Stills the kitchen's signature animations (All Hands orb-shake/siren, orb-pop-in) so the
  // layout + interaction assertions below are deterministic, matching every kitchen spec surveyed.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?mock=1");
  await page.waitForSelector("html[data-e2e-ready='1']", { timeout: 15_000 });
}

function assertNoOverflow(page: Page): Promise<void> {
  return page.evaluate(() => {
    const el = document.scrollingElement;
    if (!el) throw new Error("no document.scrollingElement");
    if (el.scrollWidth > el.clientWidth + 1) {
      throw new Error(`horizontal overflow: scrollWidth=${el.scrollWidth} clientWidth=${el.clientWidth}`);
    }
  });
}

test.describe("smoke: full UI journey", () => {
  test("boot renders every region, an interaction journey completes, no console errors, no overflow", async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    // Attached BEFORE navigation so nothing during boot is missed.
    page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
    page.on("pageerror", (err) => pageErrors.push(err.stack || err.message));

    await gotoDefaultApp(page);

    // ── boot: the kitchen chrome is the real default, and every key region is present ──
    await expect(page.getByTestId("tab-line")).toBeVisible();
    const stationCards = page.getByTestId("station-card");
    await expect(stationCards).toHaveCount(2); // the harness's two seeded panes
    await expect(page.getByTestId("kitchen-status")).toBeVisible(); // gate/status chip (posture + conn)
    await expect(page.getByTestId("service-hitl")).toBeVisible(); // ServiceMode posture chip
    await expect(page.getByTestId("kitchen-radio")).toBeVisible(); // transcript/radio region
    await expect(page.getByTestId("all-hands")).toBeVisible(); // primary emergency affordance
    await assertNoOverflow(page);

    // ── create a pane, the mock-harness idiom (orbital_controls.spec.ts): createPane
    // short-circuits to a toast under isMockModeRef, unconditionally — no real POST fires. ──
    await page.getByTitle("Open a new pane in this project").first().click();
    const modal = page.getByTestId("orbital-modal");
    await expect(modal).toBeVisible();
    await page.getByTestId("newpane-name").fill("Smoke Test Pane");
    await page.getByRole("button", { name: "Fire it up" }).click();
    await expect(modal).toHaveCount(0);
    await expect(page.getByTestId("toast")).toContainText("Fired up");

    // ── open a station (the burner) and type into its Order Pad — the kitchen's composer ──
    await stationCards.first().click();
    const burner = page.getByTestId("burner");
    await expect(burner).toBeVisible();
    const composer = page.getByTestId("burner-draft");
    await expect(composer).toBeVisible();
    await composer.fill("ship the webhook retries");
    await expect(composer).toHaveValue("ship the webhook retries");

    // ── transcript region renders injected entries (the same helper transcript.spec.ts /
    // orbital_radio.spec.ts use — see harnessNotes for why a chunked-fragment burst is NOT
    // exercised here) ──
    await injectTranscript(page, "User", "open the auth refactor");
    await injectTranscript(page, "Janus", "Heard, Chef — firing it up.");
    const feed = page.getByTestId("radio-transcript");
    await expect(feed).toContainText("open the auth refactor");
    await expect(feed).toContainText("Heard, Chef");

    // ── layout sanity: still no horizontal overflow with the burner + transcript populated,
    // and the composer + a primary action affordance both have real, non-zero boxes ──
    await assertNoOverflow(page);
    const composerBox = await composer.boundingBox();
    expect(composerBox?.width ?? 0).toBeGreaterThan(0);
    expect(composerBox?.height ?? 0).toBeGreaterThan(0);
    const allHandsBox = await page.getByTestId("all-hands").boundingBox();
    expect(allHandsBox?.width ?? 0).toBeGreaterThan(0);
    expect(allHandsBox?.height ?? 0).toBeGreaterThan(0);

    // ── run-wide guard: zero console errors / pageerrors across the ENTIRE journey above.
    // expect.soft so BOTH surface in one run instead of the first hiding the second. ──
    expect.soft(pageErrors, `pageerror events: ${JSON.stringify(pageErrors)}`).toHaveLength(0);
    expect.soft(consoleErrors, `console.error messages: ${JSON.stringify(consoleErrors)}`).toHaveLength(0);
  });
});
