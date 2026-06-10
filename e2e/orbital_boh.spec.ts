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
    let body: any = null;
    await page.route(/\/api\/settings$/, (route) => {
      if (route.request().method() === "PUT") body = route.request().postDataJSON();
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, settings: {}, globalPermissionsMode: "Human-in-the-Loop" }) });
    });
    await gotoBoH(page);
    const putReq = page.waitForRequest((r) => /\/api\/settings$/.test(r.url()) && r.method() === "PUT", { timeout: 10_000 });
    // Set write_to_pane to Off ("not in my kitchen").
    await page.getByTestId("rule-write_to_pane").getByTestId("gate-Off").click();
    await putReq;
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
    let body: any = null;
    await page.route(/\/api\/settings$/, (route) => {
      if (route.request().method() === "PUT") body = route.request().postDataJSON();
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, settings: {}, globalPermissionsMode: "Human-in-the-Loop" }) });
    });
    await gotoBoH(page);
    await page.getByTestId("boh-room-walkin").click();
    await page.getByTestId("boh-key-input").fill("AIzaTESTKEY123");
    const putReq = page.waitForRequest((r) => /\/api\/settings$/.test(r.url()) && r.method() === "PUT", { timeout: 10_000 });
    await page.getByRole("button", { name: "Stock it" }).click();
    await putReq;
    expect(body?.secrets?.geminiApiKey).toBe("AIzaTESTKEY123");
  });

  test("the Loading Dock is an honest disabled placeholder", async ({ page }) => {
    await gotoBoH(page);
    await page.getByTestId("boh-room-dock").click();
    await expect(page.getByTestId("boh-disabled")).toBeVisible();
  });
});
