import { expect, test, type Page } from "@playwright/test";
import { armE2EWire } from "./fixtures";

// Wave P7 — The Pass (notes-backed tickets). A loose note becomes live work: jot → it lands on the
// pass instantly (optimistic) and POSTs to /api/projects/:id/notes for real; amend → PUT /api/notes/:id;
// 86 → DELETE /api/notes/:id. The bead jar (BeadsExplorer) is an honest disabled placeholder.

async function gotoKitchen(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await armE2EWire(page); // 3C.3b: mock-mode wires only fire on a Playwright-armed page
  await page.goto("/?ui=kitchen&mock=1");
  await page.waitForSelector("html[data-e2e-ready='1']");
  await expect(page.getByTestId("the-pass")).toBeVisible();
}

test.describe("Orbital Kitchen — The Pass", () => {
  test("the pass is present with a jot input", async ({ page }) => {
    await gotoKitchen(page);
    await expect(page.getByTestId("the-pass")).toContainText("The Pass");
    await expect(page.getByTestId("pass-jot-input")).toBeVisible();
  });

  test("jotting a note adds a ticket and POSTs it", async ({ page }) => {
    let body: any = null;
    await page.route(/\/api\/projects\/.+\/notes$/, (route) => {
      if (route.request().method() === "POST") body = route.request().postDataJSON();
      route.fulfill({ status: 200, contentType: "application/json", body: '{"output":"ok"}' });
    });
    await gotoKitchen(page);
    const postReq = page.waitForRequest((r) => /\/api\/projects\/.+\/notes$/.test(r.url()) && r.method() === "POST", { timeout: 10_000 });
    await page.getByTestId("pass-jot-input").fill("rerun the auth tests");
    await page.getByTestId("pass-jot-add").click();
    await postReq;
    expect(body?.note).toBe("rerun the auth tests");
    await expect(page.getByTestId("pass-ticket").first()).toContainText("rerun the auth tests");
  });

  test("86'ing a ticket removes it and DELETEs it", async ({ page }) => {
    await page.route(/\/api\/projects\/.+\/notes$/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"output":"ok"}' }));
    await page.route(/\/api\/notes\/.+$/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"output":"ok"}' }));
    await gotoKitchen(page);
    await page.getByTestId("pass-jot-input").fill("temporary note");
    await page.getByTestId("pass-jot-add").click();
    await expect(page.getByTestId("pass-ticket")).toHaveCount(1);
    const delReq = page.waitForRequest((r) => /\/api\/notes\/.+$/.test(r.url()) && r.method() === "DELETE", { timeout: 10_000 });
    await page.getByTestId("pass-ticket-delete").click();
    await delReq;
    await expect(page.getByTestId("pass-ticket")).toHaveCount(0);
  });

  test("amending a ticket PUTs the new text", async ({ page }) => {
    let putBody: any = null;
    await page.route(/\/api\/projects\/.+\/notes$/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"output":"ok"}' }));
    await page.route(/\/api\/notes\/.+$/, (route) => {
      if (route.request().method() === "PUT") putBody = route.request().postDataJSON();
      route.fulfill({ status: 200, contentType: "application/json", body: '{"output":"ok"}' });
    });
    await gotoKitchen(page);
    await page.getByTestId("pass-jot-input").fill("draft note");
    await page.getByTestId("pass-jot-add").click();
    await page.getByTestId("pass-ticket-edit-btn").click();
    await page.getByTestId("pass-ticket-edit").fill("amended note");
    const putReq = page.waitForRequest((r) => /\/api\/notes\/.+$/.test(r.url()) && r.method() === "PUT", { timeout: 10_000 });
    await page.getByTestId("pass-ticket-save").click();
    await putReq;
    expect(putBody?.text).toBe("amended note");
    await expect(page.getByTestId("pass-ticket").first()).toContainText("amended note");
  });

  test("the bead jar is an honest disabled placeholder", async ({ page }) => {
    await gotoKitchen(page);
    await page.getByTestId("pass-jar").click();
    await expect(page.getByTestId("beads-explorer")).toBeVisible();
    await expect(page.getByTestId("beads-explorer")).toContainText("no HTTP door");
  });
});
