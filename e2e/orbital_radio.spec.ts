import { expect, test, type Page } from "@playwright/test";

// Wave P5b — Kitchen Radio (the voice channel). The radio rail renders the live transcript feed
// (operator ASR + Janus turns + grounded sources), the "what're my calls?" sheet (voice parity), and
// the tune-in / mute controls. The audio pipeline + Gemini session are exercised by the server suite
// and manual; here we drive the OBSERVABLE UI through the same ?mock=1 harness the classic voice e2e
// uses (injectTranscript / injectGrounding) + the in-mock go-live UI transition.

async function gotoKitchen(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?ui=kitchen&mock=1");
  await page.waitForSelector("html[data-e2e-ready='1']");
}
async function injectTranscript(page: Page, sender: "User" | "Janus", text: string) {
  await page.evaluate(
    ([s, t]) => (window as unknown as { __ORBITAL_E2E__?: { injectTranscript: (s: "User" | "Janus", t: string) => void } }).__ORBITAL_E2E__?.injectTranscript(s as "User" | "Janus", t),
    [sender, text] as const,
  );
}
async function injectGrounding(page: Page, queries: string[], sources: { uri: string; title: string }[]) {
  await page.evaluate(
    ([q, s]) => (window as unknown as { __ORBITAL_E2E__?: { injectGrounding: (q: string[], s: { uri: string; title: string }[]) => void } }).__ORBITAL_E2E__?.injectGrounding(q as string[], s as { uri: string; title: string }[]),
    [queries, sources] as const,
  );
}

test.describe("Orbital Kitchen — Kitchen Radio (voice)", () => {
  test("the radio rail is present and off-air until tuned in", async ({ page }) => {
    await gotoKitchen(page);
    const radio = page.getByTestId("kitchen-radio");
    await expect(radio).toBeVisible();
    await expect(radio).toContainText("Kitchen Radio");
    await expect(radio).toContainText("OFF AIR");
    await expect(page.getByTestId("radio-golive")).toBeVisible();
  });

  test("transcript renders operator + Chef turns with attribution", async ({ page }) => {
    await gotoKitchen(page);
    await injectTranscript(page, "User", "open the auth refactor");
    await injectTranscript(page, "Janus", "Heard, Chef — firing it up.");
    const feed = page.getByTestId("radio-transcript");
    await expect(feed).toContainText("open the auth refactor");
    await expect(feed).toContainText("Heard, Chef");
    await expect(feed).toContainText("Chef de Cuisine"); // the Janus bubble label
  });

  test("a grounded Chef turn shows its sources", async ({ page }) => {
    await gotoKitchen(page);
    await injectTranscript(page, "Janus", "The latest stable is 2.1.0.");
    await injectGrounding(page, ["pandas latest version"], [{ uri: "https://pypi.org/project/pandas", title: "pandas · PyPI" }]);
    const grounding = page.getByTestId("radio-grounding");
    await expect(grounding).toBeVisible();
    await expect(grounding).toContainText("grounded via");
    await expect(grounding.getByRole("link", { name: "pandas · PyPI" })).toBeVisible();
  });

  test("the call sheet lists hands-free calls (voice parity)", async ({ page }) => {
    await gotoKitchen(page);
    await page.getByRole("button", { name: "🎙 calls" }).click();
    const calls = page.getByTestId("radio-calls");
    await expect(calls).toBeVisible();
    await expect(calls).toContainText("What're my calls?");
    await expect(calls).toContainText("fire it, Chef");
  });

  test("tuning in flips to live, and mute toggles", async ({ page }) => {
    await gotoKitchen(page);
    await page.getByTestId("radio-golive").click();
    // In mock the socket is skipped, but the UI transitions to live (mic toggle appears).
    const mute = page.getByTestId("radio-mute");
    await expect(mute).toBeVisible();
    await expect(page.getByTestId("kitchen-radio")).toContainText("LIVE");
    await mute.click();
    await expect(page.getByTestId("kitchen-radio")).toContainText("MUTED");
  });

  // 1B.5: LIVE means live — between the tune-in click and the voice socket opening the chip reads
  // "TUNING IN…". The harness has no real socket, so setConnMock stages the connection states.
  test("the chip reads TUNING IN… until the voice channel actually opens", async ({ page }) => {
    await gotoKitchen(page);
    await page.getByTestId("radio-golive").click();
    await page.evaluate(() =>
      (window as unknown as { __ORBITAL_E2E__?: { setConnMock: (s: { voice?: boolean }) => void } }).__ORBITAL_E2E__?.setConnMock({ voice: false }));
    await expect(page.getByTestId("kitchen-radio")).toContainText("TUNING IN…");
    await expect(page.getByTestId("kitchen-radio")).not.toContainText("● LIVE");
    await page.evaluate(() =>
      (window as unknown as { __ORBITAL_E2E__?: { setConnMock: (s: { voice?: boolean }) => void } }).__ORBITAL_E2E__?.setConnMock({ voice: true }));
    await expect(page.getByTestId("kitchen-radio")).toContainText("● LIVE");
  });

  // 1B.5: a denied mic must be LOUD — the chip names it instead of claiming "I'm listening, Chef".
  // (The real getUserMedia denial path — toast + earcon from startMic's catch — needs a real browser
  // permission denial and is verified manually; this pins the honest render-state.)
  test("a blocked mic is named on the chip — never a false 'listening'", async ({ page }) => {
    await gotoKitchen(page);
    await page.getByTestId("radio-golive").click();
    await page.evaluate(() =>
      (window as unknown as { __ORBITAL_E2E__?: { setConnMock: (s: { micBlocked?: boolean }) => void } }).__ORBITAL_E2E__?.setConnMock({ micBlocked: true }));
    await expect(page.getByTestId("kitchen-radio")).toContainText("MIC BLOCKED");
    await expect(page.getByTestId("radio-mute")).toContainText("Mic's blocked");
    await expect(page.getByTestId("radio-mute")).not.toContainText("I'm listening");
  });
});
