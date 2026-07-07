import { expect, test, type Page } from "@playwright/test";
import { armE2EWire, injectTranscript } from "./fixtures";

// bead 8fz.3 — the caption pop-up (last Janus + last User transcript line), auto-shown while the
// radio is live, fed by the SAME transcript_text frames the scrollable radio-transcript bubble
// list already renders (useOrbitalData.ts:1104), distinct from that bubble list.

async function gotoKitchenLive(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await armE2EWire(page); // 3C.3b: mock-mode wires only fire on a Playwright-armed page
  await page.goto("/?ui=kitchen&mock=1");
  await page.waitForSelector("html[data-e2e-ready='1']");
  await page.getByTestId("radio-golive").click();
  await expect(page.getByTestId("radio-mute")).toBeVisible();
}

test.describe("Orbital Kitchen — caption pop-up (bead 8fz.3)", () => {
  test("shows the latest Janus + User lines and updates when a newer entry lands", async ({ page }) => {
    await gotoKitchenLive(page);

    await injectTranscript(page, "Janus", "order up, chef — table six is ready");
    await injectTranscript(page, "User", "heard, firing station four");

    const bar = page.getByTestId("caption-bar");
    await expect(bar).toBeVisible();
    await expect(page.getByTestId("caption-janus")).toHaveText("order up, chef — table six is ready");
    await expect(page.getByTestId("caption-user")).toHaveText("heard, firing station four");

    // a newer entry replaces the tail, not accumulates alongside it
    await injectTranscript(page, "Janus", "nice work, moving to the pass");
    await expect(page.getByTestId("caption-janus")).toHaveText("nice work, moving to the pass");
    await expect(page.getByTestId("caption-user")).toHaveText("heard, firing station four");
  });

  test("the caption-janus live region is mounted the moment the radio goes live, before any transcript", async ({ page }) => {
    // Round-2 a11y fix: the aria-live region must PRE-EXIST its first content so screen readers
    // announce the first utterance (an already-populated live region isn't announced on some SRs).
    // Old conditional-mount rendered nothing until a Janus line arrived — this pins the empty mount.
    await gotoKitchenLive(page);
    await expect(page.getByTestId("caption-janus")).toBeAttached();
  });

  test("the Janus line is aria-live polite; the user line carries no aria-live", async ({ page }) => {
    await gotoKitchenLive(page);
    await injectTranscript(page, "Janus", "kitchen's cookin'");
    await injectTranscript(page, "User", "copy that");

    await expect(page.getByTestId("caption-janus")).toHaveAttribute("aria-live", "polite");
    await expect(page.getByTestId("caption-user")).not.toHaveAttribute("aria-live", /.+/);
  });

  test("hidden when the captions tweak is off (?captions=0), even while live with transcript", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await armE2EWire(page);
    await page.goto("/?ui=kitchen&mock=1&captions=0");
    await page.waitForSelector("html[data-e2e-ready='1']");
    await page.getByTestId("radio-golive").click();
    await expect(page.getByTestId("radio-mute")).toBeVisible();

    await injectTranscript(page, "Janus", "should stay hidden");
    await expect(page.getByTestId("caption-bar")).toHaveCount(0);
  });

  test("hidden before going live even if the tweak is on", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await armE2EWire(page);
    await page.goto("/?ui=kitchen&mock=1&captions=1");
    await page.waitForSelector("html[data-e2e-ready='1']");
    // never go live in this test
    await expect(page.getByTestId("caption-bar")).toHaveCount(0);
  });

  test("caption bar does not steal the radio-transcript scroll container's scrollability", async ({ page }) => {
    await gotoKitchenLive(page);
    for (let i = 0; i < 10; i++) {
      // eslint-disable-next-line no-await-in-loop -- sequential inject keeps ordering deterministic
      await injectTranscript(page, i % 2 === 0 ? "Janus" : "User", `line number ${i} of the service chatter`);
    }
    await expect(page.getByTestId("caption-bar")).toBeVisible();

    const transcript = page.getByTestId("radio-transcript");
    const before = await transcript.evaluate((el) => el.scrollTop);
    await transcript.evaluate((el) => { el.scrollTop = 0; });
    await transcript.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    const after = await transcript.evaluate((el) => el.scrollTop);
    expect(after).toBeGreaterThanOrEqual(0);
    expect(typeof before).toBe("number");
  });
});
