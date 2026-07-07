import { expect, test, type Page } from "@playwright/test";
import { armE2EWire } from "./fixtures";

// Wave P6 — Back of House (settings rooms). Calm surface (no mascots). The Rulebook is the
// capability-gate matrix wired to settings.advanced.capabilityGates; Chef de Cuisine sets global
// autonomy + voice; the Walk-In holds the Gemini key; Loading Dock / Boss are honest disabled
// placeholders. Settings are seeded by the ?mock=1 harness; writes PUT /api/settings for real.

async function gotoBoH(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await armE2EWire(page); // 3C.3b: mock-mode wires only fire on a Playwright-armed page
  await page.goto("/?ui=kitchen&mock=1&view=boh");
  await page.waitForSelector("html[data-e2e-ready='1']");
  await expect(page.getByTestId("boh-body")).toBeVisible();
}

test.describe("Orbital Kitchen — Back of House", () => {
  test("opens on the Rulebook with the capability matrix", async ({ page }) => {
    await gotoBoH(page);
    await expect(page.getByTestId("boh-room-rulebook")).toHaveAttribute("aria-pressed", "true");
    // a real capability row with its Auto/Ask/Off segmented control
    await expect(page.getByTestId("rule-write_to_pane")).toBeVisible();
    await expect(page.getByTestId("rule-delete_project")).toBeVisible();
  });

  test("a Rulebook gate change persists via PUT /api/settings", async ({ page }) => {
    // Body read from the AWAITED request (below), not a route-captured variable — see the Walk-In
    // test for why the shared-`body` idiom races under parallel-worker load (bead wsm-e2e-pinned-3ss).
    await page.route(/\/api\/settings$/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, settings: {}, globalPermissionsMode: "Human-in-the-Loop" }) }));
    await gotoBoH(page);
    const putReq = page.waitForRequest((r) => /\/api\/settings$/.test(r.url()) && r.method() === "PUT", { timeout: 10_000 });
    // Set write_to_pane to Off ("not in my kitchen").
    await page.getByTestId("rule-write_to_pane").getByTestId("gate-Off").click();
    const body = (await putReq).postDataJSON();
    expect(body?.advanced?.capabilityGates?.write_to_pane).toBe("Off");
    // 1B.3: a successful settings write acks — never a silent maybe.
    await expect(page.getByTestId("toast")).toContainText("Rulebook updated");
  });

  // 1B.3: a FAILED settings write must say so (and reconcile the optimistic state) instead of the
  // old silent catch that left the operator believing the rulebook changed.
  test("a failed Rulebook write warns the operator instead of failing silently", async ({ page }) => {
    await page.route(/\/api\/settings$/, (route) => {
      if (route.request().method() === "PUT") return route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' });
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });
    await gotoBoH(page);
    await page.getByTestId("rule-write_to_pane").getByTestId("gate-Off").click();
    await expect(page.getByTestId("toast")).toContainText("didn't save");
  });

  test("Chef de Cuisine sets the global autonomy mode", async ({ page }) => {
    await page.route(/\/api\/settings$/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, settings: {}, globalPermissionsMode: "Full Auto" }) }));
    await gotoBoH(page);
    await page.getByTestId("boh-room-chef").click();
    await page.getByTestId("boh-mode-auto").click();
    await expect(page.getByTestId("boh-mode-auto")).toHaveAttribute("aria-pressed", "true");
  });

  test("the Walk-In takes a new key and stocks it", async ({ page }) => {
    // Mock the PUT response; the asserted body is read from the AWAITED request itself (below),
    // never from a route-handler-captured variable — the route callback and waitForRequest resolve
    // on independent event streams, so reading a shared `body` after `await putReq` races under
    // parallel-worker load (the geminiApiKey-undefined flake, bead wsm-e2e-pinned-3ss).
    await page.route(/\/api\/settings$/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, settings: {}, globalPermissionsMode: "Human-in-the-Loop" }) }));
    await gotoBoH(page);
    await page.getByTestId("boh-room-walkin").click();
    await page.getByTestId("boh-key-input").fill("AIzaTESTKEY123");
    const putReq = page.waitForRequest((r) => /\/api\/settings$/.test(r.url()) && r.method() === "PUT", { timeout: 10_000 });
    await page.getByRole("button", { name: "Stock it" }).click();
    const body = (await putReq).postDataJSON();
    expect(body?.secrets?.geminiApiKey).toBe("AIzaTESTKEY123");
  });

  test("the Loading Dock is an honest disabled placeholder", async ({ page }) => {
    await gotoBoH(page);
    await page.getByTestId("boh-room-dock").click();
    await expect(page.getByTestId("boh-disabled")).toBeVisible();
  });

  // ── f09.2: timed autonomy windows (the Rulebook's per-pane grant/end) ──────────────────────────
  // The kitchen ?mock=1 harness (armE2EWire) seeds stations `mock_pane_1`/`mock_pane_2` ("React
  // Frontend" / "Python Backend" — see e2e/fixtures.ts MOCK_TERMINAL_ID). Scoping the Rulebook to one
  // exposes the "Timed full-auto window" control. Granting POSTs /api/terminals/:id/autonomy-window (a
  // deliberate UI loosen → immediate on REST); the server would broadcast terminals_updated so the
  // countdown badge repaints from the refetched autonomy_until. The countdown → GUARDED revert on
  // expiry rides the same terminals refetch (server truth). NOTE (integrator): seeding a LIVE window
  // into the mock terminals payload (so the countdown badge + End control render) needs the kitchen
  // harness to carry `autonomy_until` on the seeded pane (e.g. a setAutonomyMock hook), mirroring
  // setPostureMock — that is why the countdown→revert case below stays skipped.
  const MOCK_PANE = "mock_pane_1";

  test("scoping the Rulebook to a station reveals the timed-autonomy control", async ({ page }) => {
    await gotoBoH(page);
    await page.getByTestId(`rulebook-scope-${MOCK_PANE}`).click();
    await expect(page.getByTestId("autonomy-window-controls")).toBeVisible();
    // No live window seeded → the GRANT affordance, not the End/countdown.
    await expect(page.getByTestId("autonomy-grant")).toBeVisible();
  });

  test("granting a window POSTs the autonomy-window endpoint and acks", async ({ page }) => {
    await page.route(/\/api\/terminals\/[^/]+\/autonomy-window$/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ output: "Autonomy window granted." }) }));
    await gotoBoH(page);
    await page.getByTestId(`rulebook-scope-${MOCK_PANE}`).click();
    const grantReq = page.waitForRequest(
      (r) => /\/api\/terminals\/[^/]+\/autonomy-window$/.test(r.url()) && r.method() === "POST",
      { timeout: 10_000 });
    await page.getByTestId("autonomy-grant").click();
    const req = await grantReq;
    expect(req.url()).toContain(`/api/terminals/${MOCK_PANE}/autonomy-window`);
    expect(req.postDataJSON()?.minutes).toBe(20); // default 20-minute window
    await expect(page.getByTestId("toast")).toContainText("Full-auto window opened");
  });

  // ── f09.3: posture profiles (the Rulebook's one-tap named gate bundles, global scope) ──────────
  test("the Rulebook shows one-tap posture pills in global scope", async ({ page }) => {
    await gotoBoH(page);
    await expect(page.getByTestId("posture-pills")).toBeVisible();
    // the three seed profiles
    await expect(page.getByTestId("posture-pill-headsdown")).toBeVisible();
    await expect(page.getByTestId("posture-pill-demo")).toBeVisible();
    await expect(page.getByTestId("posture-pill-locked")).toBeVisible();
    // the "save current as profile" affordance
    await expect(page.getByTestId("posture-save")).toBeVisible();
  });

  test("tapping the Locked posture flips every gate to Off and highlights the pill", async ({ page }) => {
    // The apply POSTs /api/posture (the deliberate UI loosen); mock it so the success toast stands.
    await page.route(/\/api\/posture$/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ output: "Applied the 'Locked' posture." }) }));
    await gotoBoH(page);
    // Before: a productive write is not Off.
    await expect(page.getByTestId("rule-write_to_pane").getByTestId("gate-Off")).toHaveAttribute("aria-pressed", "false");
    const postReq = page.waitForRequest((r) => /\/api\/posture$/.test(r.url()) && r.method() === "POST", { timeout: 10_000 });
    await page.getByTestId("posture-pill-locked").click();
    // The whole matrix reads Off (Locked = "not in my kitchen") and the pill is active.
    await expect(page.getByTestId("rule-write_to_pane").getByTestId("gate-Off")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("rule-delete_project").getByTestId("gate-Off")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("posture-pill-locked")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("toast")).toContainText("Posture set");
    // The apply routes through the dedicated posture endpoint with the profile name.
    const req = await postReq;
    expect(req.postDataJSON()?.name).toBe("Locked");
  });

  test("posture pills are global-scope only (hidden when a station is scoped)", async ({ page }) => {
    await gotoBoH(page);
    await expect(page.getByTestId("posture-pills")).toBeVisible();
    await page.getByTestId(`rulebook-scope-${MOCK_PANE}`).click();
    await expect(page.getByTestId("posture-pills")).toHaveCount(0);
  });

  test("save current as profile adds a new operator pill", async ({ page }) => {
    // Saving a profile writes the postureProfiles array via PUT /api/settings.
    await page.route(/\/api\/settings$/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true }) }));
    await gotoBoH(page);
    await page.getByTestId("posture-save-name").fill("Night shift");
    const putReq = page.waitForRequest((r) => /\/api\/settings$/.test(r.url()) && r.method() === "PUT", { timeout: 10_000 });
    await page.getByTestId("posture-save").click();
    // The write carries the new profile in advanced.postureProfiles.
    const body = (await putReq).postDataJSON();
    expect(body?.advanced?.postureProfiles?.some((p: { name: string }) => p.name === "Night shift")).toBe(true);
    // The new profile pill (folded name key) renders, with a delete affordance (operator-saved).
    await expect(page.getByTestId("posture-pill-nightshift")).toBeVisible();
    await expect(page.getByTestId("posture-delete-nightshift")).toBeVisible();
    // Seeds never carry a delete affordance.
    await expect(page.getByTestId("posture-delete-locked")).toHaveCount(0);
  });

  // The countdown badge + auto-revert to GUARDED. Requires the harness to reflect a live window on the
  // seeded pane (autonomy_until on the terminals payload). Skipped until that harness hook lands so the
  // suite stays green; unskip alongside the setAutonomyMock harness seed (integrator).
  test.skip("a granted window shows a countdown badge that reverts to GUARDED on expiry", async ({ page }) => {
    await gotoBoH(page);
    await page.getByTestId(`rulebook-scope-${MOCK_PANE}`).click();
    await page.getByTestId("autonomy-grant").click();
    // Countdown badge appears while the window is live.
    await expect(page.getByTestId("autonomy-countdown")).toBeVisible();
    // Force expiry through the harness (window removed → terminals_updated → refetch drops autonomy_until).
    // The badge disappears and the pane posture reverts.
    await expect(page.getByTestId("autonomy-countdown")).toHaveCount(0);
  });
});
