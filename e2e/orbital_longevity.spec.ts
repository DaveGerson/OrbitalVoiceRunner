import { expect, test, type Page } from "@playwright/test";
import { armE2EWire } from "./fixtures";

// Phase 4 Track U — longevity surfaces in the kitchen:
//   4U.1 Plans on The Pass (spec tickets: execute POST /api/plans/:id/execute, 86 DELETE /api/plans/:id)
//   4U.2 Per-pane "Ticket history" in the burner (GET /api/terminals/:id/history, clear POST …/history/clear)
//   4U.3 The Service log in the Pantry (GET /api/action-log) + the radio transcript surviving a reload
// All wires fire on the Playwright-armed page (3C.3b) and are intercepted + asserted here.

async function gotoKitchen(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await armE2EWire(page);
  await page.goto("/?ui=kitchen&mock=1");
  await page.waitForSelector("html[data-e2e-ready='1']");
  await expect(page.getByTestId("the-pass")).toBeVisible();
}

const MOCK_PLAN = {
  id: "plan_e2e_1",
  name: "Ship the hotfix",
  currentStepIndex: 0,
  status: "idle",
  steps: [
    { id: "s1", terminalId: "mock_pane_1", command: "npm test", expectedTransition: "idle", status: "pending" },
    { id: "s2", terminalId: "mock_pane_1", command: "git push", expectedTransition: "idle", status: "pending" },
  ],
};

async function injectPlans(page: Page, plans: unknown[]) {
  // plans_updated rides the REAL observe-lane switch (3C.1's injectWsFrame seam).
  await page.evaluate((p) => window.__ORBITAL_E2E__?.injectWsFrame({ type: "plans_updated", plans: p }), plans);
}

test.describe("Orbital Kitchen — 4U.1 plans on The Pass", () => {
  test("a voice-built plan renders as a spec ticket and Execute fires the classic route", async ({ page }) => {
    let executed = "";
    await page.route(/\/api\/plans\/[^/]+\/execute$/, (route) => {
      executed = route.request().url();
      route.fulfill({ status: 200, contentType: "application/json", body: '{"output":"Started execution"}' });
    });
    await gotoKitchen(page);
    await injectPlans(page, [MOCK_PLAN]);
    const spec = page.getByTestId("pass-spec");
    await expect(spec).toBeVisible();
    await expect(spec).toContainText("Ship the hotfix");
    await expect(spec).toContainText("0/2 steps");
    const req = page.waitForRequest((r) => /\/api\/plans\/plan_e2e_1\/execute$/.test(r.url()) && r.method() === "POST", { timeout: 10_000 });
    await page.getByTestId("pass-spec-fire").click();
    await req;
    expect(executed).toContain("/api/plans/plan_e2e_1/execute");
    await expect(page.getByTestId("toast")).toContainText("Spec's firing");
  });

  test("a 202-deferred execute is announced honestly (needs an ok), never a false fire", async ({ page }) => {
    await page.route(/\/api\/plans\/[^/]+\/execute$/, (route) =>
      route.fulfill({ status: 202, contentType: "application/json", body: '{"status":"pending_approval","messageId":"m1"}' }));
    await gotoKitchen(page);
    await injectPlans(page, [MOCK_PLAN]);
    await page.getByTestId("pass-spec-fire").click();
    await expect(page.getByTestId("toast")).toContainText("needs your ok");
  });

  test("86'ing a spec takes the two-tap confirm and DELETEs the plan", async ({ page }) => {
    await page.route(/\/api\/plans\/[^/]+$/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"output":"deleted"}' }));
    await gotoKitchen(page);
    await injectPlans(page, [MOCK_PLAN]);
    await expect(page.getByTestId("pass-spec")).toBeVisible();
    // first tap arms the confirm — nothing is deleted yet
    await page.getByTestId("pass-spec-delete").click();
    await expect(page.getByTestId("pass-spec-delete")).toContainText("Sure, Chef?");
    await expect(page.getByTestId("pass-spec")).toHaveCount(1);
    const del = page.waitForRequest((r) => /\/api\/plans\/plan_e2e_1$/.test(r.url()) && r.method() === "DELETE", { timeout: 10_000 });
    await page.getByTestId("pass-spec-delete").click();
    await del;
    await expect(page.getByTestId("pass-spec")).toHaveCount(0);
  });
});

const HISTORY_FIXTURE = [
  { command: "npm test", timestamp: "2026-06-10T10:00:00.000Z", output: "42 passing (3s)" },
  { command: "git status", timestamp: "2026-06-10T10:05:00.000Z", output: "nothing to commit, working tree clean" },
];

async function openBurnerHistory(page: Page) {
  await page.locator('[data-testid="station-card"]').first().click();
  await expect(page.getByTestId("burner")).toBeVisible();
  await page.getByTestId("burner-tab-history").click();
}

test.describe("Orbital Kitchen — 4U.2 ticket history in the burner", () => {
  test("lists recorded commands newest-first with a fold-out output peek", async ({ page }) => {
    await page.route(/\/api\/terminals\/[^/]+\/history$/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(HISTORY_FIXTURE) }));
    await gotoKitchen(page);
    await openBurnerHistory(page);
    const rows = page.getByTestId("burner-history-entry");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText("git status"); // newest leads
    await rows.first().click();
    await expect(page.getByTestId("burner-history-output")).toContainText("nothing to commit");
  });

  test("a pushed history_updated frame repaints the open ticket in place", async ({ page }) => {
    await page.route(/\/api\/terminals\/[^/]+\/history$/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(HISTORY_FIXTURE) }));
    await gotoKitchen(page);
    await openBurnerHistory(page);
    await expect(page.getByTestId("burner-history-entry")).toHaveCount(2);
    await page.evaluate((h) => window.__ORBITAL_E2E__?.injectWsFrame({ type: "history_updated", terminalId: "mock_pane_1", history: h }),
      [...HISTORY_FIXTURE, { command: "npm run build", timestamp: "2026-06-10T10:09:00.000Z", output: "built in 2.1s" }]);
    await expect(page.getByTestId("burner-history-entry")).toHaveCount(3);
    await expect(page.getByTestId("burner-history-entry").first()).toContainText("npm run build");
  });

  test("Clear history takes a two-tap confirm and wipes via the clear route", async ({ page }) => {
    await page.route(/\/api\/terminals\/[^/]+\/history$/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(HISTORY_FIXTURE) }));
    await page.route(/\/api\/terminals\/[^/]+\/history\/clear$/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"output":"History cleared"}' }));
    await gotoKitchen(page);
    await openBurnerHistory(page);
    await expect(page.getByTestId("burner-history-entry")).toHaveCount(2);
    await page.getByTestId("burner-history-clear").click(); // arm
    await expect(page.getByTestId("burner-history-clear")).toContainText("Sure, Chef?");
    const post = page.waitForRequest((r) => /\/history\/clear$/.test(r.url()) && r.method() === "POST", { timeout: 10_000 });
    await page.getByTestId("burner-history-clear").click(); // fire
    await post;
    await expect(page.getByTestId("burner-history-empty")).toBeVisible();
    await expect(page.getByTestId("toast")).toContainText("Ticket history wiped");
  });

  test("a frozen-brake refusal is surfaced honestly and the record stays", async ({ page }) => {
    await page.route(/\/api\/terminals\/[^/]+\/history$/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(HISTORY_FIXTURE) }));
    // clear_history checks the stop-all brake itself → kind:"error" → 500 {error} (resultToHttp)
    await page.route(/\/api\/terminals\/[^/]+\/history\/clear$/, (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"Stop-all is engaged — release it first."}' }));
    await gotoKitchen(page);
    await openBurnerHistory(page);
    await page.getByTestId("burner-history-clear").click();
    await page.getByTestId("burner-history-clear").click();
    await expect(page.getByTestId("toast")).toContainText("Stop-all is engaged");
    await expect(page.getByTestId("burner-history-entry")).toHaveCount(2); // nothing was wiped
  });
});

test.describe("Orbital Kitchen — 4U.3 the reviewable past", () => {
  test("the Pantry's Service log lists action-log rows from the real read route", async ({ page }) => {
    await page.route(/\/api\/action-log/, (route) =>
      route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ output: { rows: [
          { id: 2, ts: Date.now(), name: "create_pane", capability: "create_pane", result_kind: "ok", ms: 12.4, args_redacted: '{"pane_id":"mock_pane_1"}', surface: "rest", idempotency_key: null, interaction_id: null },
          { id: 1, ts: Date.now() - 60_000, name: "execute_plan", capability: "execute_plan", result_kind: "error", ms: 3.1, args_redacted: "{}", surface: "voice", idempotency_key: null, interaction_id: null },
        ] } }),
      }));
    await gotoKitchen(page);
    const get = page.waitForRequest((r) => /\/api\/action-log/.test(r.url()) && r.method() === "GET", { timeout: 10_000 });
    await page.getByTestId("tab-pantry").click();
    await get;
    const rows = page.getByTestId("service-log-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText("create_pane");
    await expect(rows.first()).toContainText("#mock_pane_1"); // pane pulled from the redacted args
    await expect(rows.nth(1)).toContainText("error"); // result kind, honestly rendered
  });

  test("the radio transcript survives a reload (sessionStorage, capped)", async ({ page }) => {
    await gotoKitchen(page);
    await page.evaluate(() => window.__ORBITAL_E2E__?.injectTranscript("User", "fire the smoke test on station one"));
    await expect(page.getByTestId("radio-transcript")).toContainText("fire the smoke test on station one");
    await page.reload();
    await page.waitForSelector("html[data-e2e-ready='1']");
    await expect(page.getByTestId("radio-transcript")).toContainText("fire the smoke test on station one");
  });
});

test.describe("Orbital Kitchen — bead apu: the health strip", () => {
  test("the Pantry's health strip renders the chips from the real /api/health route", async ({ page }) => {
    await page.route(/\/api\/health/, (route) =>
      route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ output: {
          frozen: true,
          panes: { total: 5, running: 2, idle: 2, exited: 1 },
          pending_approvals: 3,
          recent: { total: 100, errors: 7, error_rate: 0.07 },
          memory: { synthesizer: "live" },
        } }),
      }));
    await gotoKitchen(page);
    const get = page.waitForRequest((r) => /\/api\/health/.test(r.url()) && r.method() === "GET", { timeout: 10_000 });
    await page.getByTestId("tab-pantry").click();
    await get;
    const strip = page.getByTestId("health-strip");
    await expect(strip).toBeVisible();
    await expect(page.getByTestId("health-frozen")).toContainText("frozen");
    await expect(page.getByTestId("health-panes")).toContainText("5"); // total
    await expect(page.getByTestId("health-panes")).toContainText("2"); // running/idle
    await expect(page.getByTestId("health-pending")).toContainText("3"); // pending approvals
    await expect(page.getByTestId("health-error-rate")).toContainText("7%"); // error rate, honestly rendered
  });
});
