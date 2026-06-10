import { expect, test, type Page } from "@playwright/test";
import "./fixtures"; // the shared window.__ORBITAL_E2E__ declaration (incl. the 3C hooks)

// Phase 3 Track C2 — the terminal never lies.
//   3C.1: pane_status / pane_quiescing frames patch the board IN PLACE through the real WS switch
//         (no full refetch round-trip — under ?mock=1 a refetch is a no-op, so the chip flipping
//         at all PROVES the in-place patch).
//   3C.2: an observe-socket reconnect rebuilds the burner xterm from snapshot truth and stamps a
//         visible "reconnected" marker; a radio toggle does NOT tear the stream down (no marker,
//         no cleared/duplicated content).
//   3C.3: plain ?mock=1 WITHOUT the Playwright arm flag stays fully client-side — the settings
//         PUT (which used to fire unconditionally and could clobber a live deployment) never hits
//         the wire. (The armed counterpart — the PUT firing + asserted body — is orbital_boh.)
// NOTE: gotoKitchen here deliberately does NOT call armE2EWire — these specs pin the unarmed,
// human-typed-?mock=1 behavior.

async function gotoKitchen(page: Page, params = "") {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/?ui=kitchen&mock=1${params}`);
  await page.waitForSelector("html[data-e2e-ready='1']");
}

async function openBurner(page: Page, paneId = "mock_pane_1") {
  await page.locator(`[data-testid="station-card"][data-pane-id="${paneId}"]`).first().click();
  await expect(page.getByTestId("burner")).toBeVisible();
}

async function injectWsFrame(page: Page, frame: Record<string, unknown>) {
  await page.evaluate((f) => window.__ORBITAL_E2E__?.injectWsFrame(f), frame);
}

async function injectStdoutChunk(page: Page, terminalId: string, chunk: string) {
  await page.evaluate(
    ([id, c]) => window.__ORBITAL_E2E__?.injectStdoutChunk(id, c),
    [terminalId, chunk] as const,
  );
}

test.describe("Orbital Kitchen — Phase 3C: status pushes, stream truth, mock containment", () => {
  // 3C.1 — the pane_status frame patches the matching pane in place. Under ?mock=1 every
  // refetchTerminals() is a no-op (the harness owns state), so the old refetch-on-pane_status
  // code could never flip this chip — the flip itself pins the in-place patch. The fetch counter
  // double-checks no /api/terminals round-trip was attempted.
  test("a pane_status frame flips the station in place — no refetch round-trip", async ({ page }) => {
    let terminalsFetches = 0;
    await page.route(/\/api\/terminals$/, (route) => {
      terminalsFetches++;
      return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await gotoKitchen(page);
    await openBurner(page);
    await expect(page.getByTestId("burner")).toHaveAttribute("data-status", "Running");

    await injectWsFrame(page, { type: "pane_status", terminalId: "mock_pane_1", status: "Idle" });
    await expect(page.getByTestId("burner")).toHaveAttribute("data-status", "Idle");

    // No flap: a rapid Running edge lands cleanly on top (latest frame wins, in order).
    await injectWsFrame(page, { type: "pane_status", terminalId: "mock_pane_1", status: "Running" });
    await expect(page.getByTestId("burner")).toHaveAttribute("data-status", "Running");
    expect(terminalsFetches).toBe(0);
  });

  // 3C.1 — pane_quiescing sets the overlay flag in place and the next pane_status clears it;
  // neither flips the real status (the pane stays Running through a "cooking…" window).
  test("a pane_quiescing frame never disturbs the pane's real status", async ({ page }) => {
    await gotoKitchen(page);
    await openBurner(page);
    await injectWsFrame(page, { type: "pane_quiescing", terminalId: "mock_pane_1" });
    await expect(page.getByTestId("burner")).toHaveAttribute("data-status", "Running");
    await injectWsFrame(page, { type: "pane_status", terminalId: "mock_pane_1", status: "Idle" });
    await expect(page.getByTestId("burner")).toHaveAttribute("data-status", "Idle");
  });

  // 3C.2(b/c) — after a socket drop + reopen the burner is REBUILT from the snapshot (reset +
  // rewrite, so live bytes that aren't in the snapshot disappear instead of leaving a lying
  // screen) and the gap is stamped with a visible marker — never a silent hole.
  test("a stream reconnect rewrites the burner from snapshot truth with a visible marker", async ({ page }) => {
    await gotoKitchen(page);
    await openBurner(page);
    const term = page.getByTestId("burner-terminal");
    await expect(term).toContainText("MOCKTERM_READY", { timeout: 10_000 });

    await injectStdoutChunk(page, "mock_pane_1", "PRE_DROP_LIVE\r\n");
    await expect(term).toContainText("PRE_DROP_LIVE");

    // Drop, then reopen: the harness bumps the same stream generation a real reconnect bumps.
    await page.evaluate(() => window.__ORBITAL_E2E__?.setConnMock({ stream: false }));
    await page.evaluate(() => window.__ORBITAL_E2E__?.simulateStreamReconnect());

    await expect(term).toContainText("reconnected; replayed from snapshot", { timeout: 10_000 });
    // The screen was rebuilt from the (seeded) snapshot — backfill present, the un-snapshotted
    // live chunk gone. The terminal shows truth, not the old paint with a hole appended.
    await expect(term).toContainText("MOCKTERM_READY");
    await expect(term).not.toContainText("PRE_DROP_LIVE");
  });

  // 3C.2(a) — tuning the radio in is NOT a stream event: no reconnect marker, the live lane keeps
  // flowing, and content is neither cleared nor duplicated.
  test("a radio toggle never clears, duplicates, or marks the terminal stream", async ({ page }) => {
    await gotoKitchen(page);
    await page.getByTestId("radio-golive").click();
    await expect(page.getByTestId("kitchen-radio")).toContainText("LIVE");

    await openBurner(page);
    const term = page.getByTestId("burner-terminal");
    await expect(term).toContainText("MOCKTERM_READY", { timeout: 10_000 });
    await injectStdoutChunk(page, "mock_pane_1", "TOGGLE_SURVIVOR\r\n");
    await expect(term).toContainText("TOGGLE_SURVIVOR");
    await expect(term).not.toContainText("reconnected; replayed from snapshot");
    // exactly once — the toggle must not have re-seeded/duplicated the buffer
    const text = (await term.textContent()) ?? "";
    expect(text.split("TOGGLE_SURVIVOR").length - 1).toBe(1);
  });

  // 3C.3(b) — plain ?mock=1 (no Playwright arm flag) is fully client-side: the Rulebook click
  // still acks optimistically, but NO real PUT leaves the page. This is the guard that stops a
  // human's ?mock=1 visit from overwriting a live deployment's settings with the mock fixture.
  test("unarmed ?mock=1 never fires the real settings PUT", async ({ page }) => {
    let puts = 0;
    await page.route(/\/api\/settings$/, (route) => {
      if (route.request().method() === "PUT") puts++;
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });
    await gotoKitchen(page, "&view=boh");
    await expect(page.getByTestId("boh-body")).toBeVisible();
    await page.getByTestId("rule-write_to_pane").getByTestId("gate-Off").click();
    // The optimistic ack still lands (the kitchen is honest about what IT did)…
    await expect(page.getByTestId("toast")).toContainText("Rulebook updated");
    // …but nothing touched the wire.
    expect(puts).toBe(0);
  });
});
