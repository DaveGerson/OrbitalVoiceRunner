import { test, expect, gotoMockedApp, injectStdoutChunk, MOCK_TERMINAL_ID } from "./fixtures";

test.describe("terminal fidelity", () => {
  test("renders the mocked backfill (raw bytes) in the xterm viewport on load", async ({ page }) => {
    await gotoMockedApp(page);
    // MOCKTERM_READY is wrapped in an ANSI color sequence in the seeded backfill;
    // its appearance as text proves xterm rendered the raw bytes (ANSI interpreted,
    // not shown literally and not stripped away).
    await expect(page.getByTestId("terminal-pane")).toContainText("MOCKTERM_READY", { timeout: 10_000 });
    // The literal escape introducer must NOT be visible (it was interpreted).
    await expect(page.getByTestId("terminal-pane")).not.toContainText("[32mMOCKTERM");
  });

  test("live stdout chunks appear in the xterm viewport", async ({ page }) => {
    await gotoMockedApp(page);
    await injectStdoutChunk(page, MOCK_TERMINAL_ID, "LIVE_CHUNK_OK\r\n");
    await expect(page.getByTestId("terminal-pane")).toContainText("LIVE_CHUNK_OK", { timeout: 10_000 });
  });

  test("a viewport change sends a debounced POST /api/terminals/:id/resize with {cols,rows}", async ({ page }) => {
    // Silence the POST (no backend under the vite harness) so it doesn't 404-noise;
    // the assertion reads the body straight from the captured request.
    await page.route(/\/api\/terminals\/.+\/resize$/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"success":true}' }));

    const resizeReq = page.waitForRequest(
      (req) => /\/api\/terminals\/.+\/resize$/.test(req.url()) && req.method() === "POST",
      { timeout: 10_000 },
    );

    await gotoMockedApp(page);
    // Force a grid change: a different viewport reflows fit() -> xterm onResize -> POST.
    await page.setViewportSize({ width: 700, height: 480 });

    const body = (await resizeReq).postDataJSON();
    expect(body).toBeTruthy();
    expect(typeof body.cols).toBe("number");
    expect(typeof body.rows).toBe("number");
    expect(body.cols).toBeGreaterThan(0);
    expect(body.rows).toBeGreaterThan(0);
  });
});
