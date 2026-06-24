import { expect, test, type Page } from "@playwright/test";
import { armE2EWire } from "./fixtures";

// Wave P8 — The Pantry (per-project tracker). Calm surface (no mascots). Picker + banner + panes are
// live from the ledger; the About is the editable project summary (PUT /api/projects/:id {summary});
// the repo card is an honest disabled placeholder. Clicking a pane opens its burner.

async function gotoPantry(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await armE2EWire(page); // 3C.3b: mock-mode wires only fire on a Playwright-armed page
  await page.goto("/?ui=kitchen&mock=1&view=pantry");
  await page.waitForSelector("html[data-e2e-ready='1']");
  await expect(page.getByTestId("pantry")).toBeVisible();
}

test.describe("Orbital Kitchen — The Pantry", () => {
  test("shows the project banner and its panes", async ({ page }) => {
    await gotoPantry(page);
    await expect(page.getByTestId("pantry-banner")).toContainText("Mock Project");
    // the seeded ledger has two panes in the mock project
    await expect(page.getByTestId("pantry-pane")).toHaveCount(2);
  });

  test("editing the About PUTs the project summary", async ({ page }) => {
    // Body read from the AWAITED request (below), not a route-captured variable — a shared `body`
    // read after the await races against the route handler under parallel-worker load (bead
    // wsm-e2e-pinned-3ss).
    await page.route(/\/api\/projects\/[^/]+$/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
    await gotoPantry(page);
    const putReq = page.waitForRequest((r) => /\/api\/projects\/[^/]+$/.test(r.url()) && r.method() === "PUT", { timeout: 10_000 });
    await page.getByTestId("pantry-about").fill("Ships the notifications service.");
    await page.getByTestId("pantry-about").blur();
    const body = (await putReq).postDataJSON();
    expect(body?.summary).toBe("Ships the notifications service.");
  });

  test("clicking a pane opens its burner", async ({ page }) => {
    await gotoPantry(page);
    await page.getByTestId("pantry-pane").first().click();
    await expect(page.getByTestId("burner")).toBeVisible();
  });

  test("the repo card is an honest disabled placeholder", async ({ page }) => {
    await gotoPantry(page);
    await expect(page.getByTestId("pantry-repo-disabled")).toBeVisible();
    await expect(page.getByRole("button", { name: "Commit" })).toBeDisabled();
  });
});
