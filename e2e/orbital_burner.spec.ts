import { expect, test, type Page } from "@playwright/test";

// Wave P4 — The Burner (TerminalWindow). Opening a station card mounts the REAL
// xterm (backfill scrollback + live raw-chunk stream) and wires every control to
// the real backend: control keys → /raw-input, restart → /restart, the Order Pad
// draft → /draft/send, grid → /resize. Driven through the ?mock=1 harness; the
// burner's action wires fire the real POSTs so we intercept + assert them.

async function gotoKitchen(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?ui=kitchen&mock=1");
  await page.waitForSelector("html[data-e2e-ready='1']");
}

async function openBurner(page: Page) {
  await gotoKitchen(page);
  await page.locator('[data-testid="station-card"][data-pane-id="mock_pane_1"]').first().click();
  await expect(page.getByTestId("burner")).toBeVisible();
}

async function injectStdoutChunk(page: Page, terminalId: string, chunk: string) {
  await page.evaluate(
    ([id, c]) => (window as unknown as { __ORBITAL_E2E__?: { injectStdoutChunk: (i: string, c: string) => void } }).__ORBITAL_E2E__?.injectStdoutChunk(id, c),
    [terminalId, chunk] as const,
  );
}

test.describe("Orbital Kitchen — The Burner", () => {
  test("opening a station mounts the real xterm with backfill scrollback", async ({ page }) => {
    await openBurner(page);
    // MOCKTERM_READY is wrapped in an ANSI color sequence in the seeded backfill; its appearance as
    // plain text proves the real xterm rendered the raw bytes (interpreted, not shown literally).
    await expect(page.getByTestId("burner-terminal")).toContainText("MOCKTERM_READY", { timeout: 10_000 });
    await expect(page.getByTestId("burner-terminal")).not.toContainText("[32mMOCKTERM");
  });

  test("live stdout chunks stream into the burner", async ({ page }) => {
    await openBurner(page);
    await injectStdoutChunk(page, "mock_pane_1", "BURNER_LIVE_OK\r\n");
    await expect(page.getByTestId("burner-terminal")).toContainText("BURNER_LIVE_OK", { timeout: 10_000 });
  });

  test("a control key POSTs its raw bytes to /raw-input", async ({ page }) => {
    await page.route(/\/api\/terminals\/.+\/raw-input$/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"success":true}' }));
    await openBurner(page);

    const rawReq = page.waitForRequest(
      (r) => /\/api\/terminals\/.+\/raw-input$/.test(r.url()) && r.method() === "POST",
      { timeout: 10_000 },
    );
    await page.getByTestId("burner-key-ctrlc").click();
    const body = (await rawReq).postDataJSON();
    expect(body.bytes).toBe("\x03"); // the canonical Ctrl+C — emergency brake, always allowed
  });

  test("Re-fire POSTs to the restart route", async ({ page }) => {
    await page.route(/\/api\/terminals\/.+\/restart$/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"success":true}' }));
    await openBurner(page);

    const restartReq = page.waitForRequest(
      (r) => /\/api\/terminals\/.+\/restart$/.test(r.url()) && r.method() === "POST",
      { timeout: 10_000 },
    );
    await page.getByTestId("burner-restart").click();
    await restartReq;
  });

  test("the Order Pad sends a draft to the line", async ({ page }) => {
    // PUT (per-keystroke persist) and POST …/draft/send both round-trip to the real routes.
    await page.route(/\/api\/panes\/.+\/draft$/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"success":true,"draft":{"text":""}}' }));
    await page.route(/\/api\/panes\/.+\/draft\/send$/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"success":true}' }));
    await openBurner(page);

    const sendReq = page.waitForRequest(
      (r) => /\/api\/panes\/.+\/draft\/send$/.test(r.url()) && r.method() === "POST",
      { timeout: 10_000 },
    );
    await page.getByTestId("burner-draft").fill("ship the webhook retries");
    await page.getByRole("button", { name: "Send to the line" }).click();
    await sendReq;
    await expect(page.getByTestId("toast")).toContainText("Sent to the line");
  });

  test("a viewport change syncs the PTY grid via /resize", async ({ page }) => {
    await page.route(/\/api\/terminals\/.+\/resize$/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"success":true}' }));
    const resizeReq = page.waitForRequest(
      (r) => /\/api\/terminals\/.+\/resize$/.test(r.url()) && r.method() === "POST",
      { timeout: 10_000 },
    );
    await openBurner(page);
    // The initial xterm fit on mount already reports a grid → debounced resize POST.
    const body = (await resizeReq).postDataJSON();
    expect(typeof body.cols).toBe("number");
    expect(typeof body.rows).toBe("number");
    expect(body.cols).toBeGreaterThan(0);
    expect(body.rows).toBeGreaterThan(0);
  });

  test("the Notes tab jots a real per-pane note", async ({ page }) => {
    await page.route(/\/api\/projects\/.+\/panes\/.+\/notes$/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"output":"ok"}' }));
    await openBurner(page);
    await page.getByTestId("burner-tab-notes").click();
    const postReq = page.waitForRequest((r) => /\/api\/projects\/.+\/panes\/.+\/notes$/.test(r.url()) && r.method() === "POST", { timeout: 10_000 });
    await page.getByTestId("burner-note-input").fill("watch the retry backoff");
    await page.getByTestId("burner-note-add").click();
    await postReq;
    await expect(page.getByTestId("burner-note").first()).toContainText("watch the retry backoff");
  });

  test("the burner closes from the red light", async ({ page }) => {
    await openBurner(page);
    await page.getByTestId("burner-close").click();
    await expect(page.getByTestId("burner")).toHaveCount(0);
  });
});
