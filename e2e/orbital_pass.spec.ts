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
    // Body read from the AWAITED request (below), not a route-captured variable — a shared `body`
    // read after the await races against the route handler under parallel-worker load (bead
    // wsm-e2e-pinned-3ss).
    await page.route(/\/api\/projects\/.+\/notes$/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"output":"ok"}' }));
    await gotoKitchen(page);
    const postReq = page.waitForRequest((r) => /\/api\/projects\/.+\/notes$/.test(r.url()) && r.method() === "POST", { timeout: 10_000 });
    await page.getByTestId("pass-jot-input").fill("rerun the auth tests");
    await page.getByTestId("pass-jot-add").click();
    const body = (await postReq).postDataJSON();
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
    // putBody read from the AWAITED request (below), not a route-captured variable — a shared
    // variable read after the await races against the route handler under parallel-worker load
    // (bead wsm-e2e-pinned-3ss).
    await page.route(/\/api\/projects\/.+\/notes$/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"output":"ok"}' }));
    await page.route(/\/api\/notes\/.+$/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"output":"ok"}' }));
    await gotoKitchen(page);
    await page.getByTestId("pass-jot-input").fill("draft note");
    await page.getByTestId("pass-jot-add").click();
    await page.getByTestId("pass-ticket-edit-btn").click();
    await page.getByTestId("pass-ticket-edit").fill("amended note");
    const putReq = page.waitForRequest((r) => /\/api\/notes\/.+$/.test(r.url()) && r.method() === "PUT", { timeout: 10_000 });
    await page.getByTestId("pass-ticket-save").click();
    const putBody = (await putReq).postDataJSON();
    expect(putBody?.text).toBe("amended note");
    await expect(page.getByTestId("pass-ticket").first()).toContainText("amended note");
  });

  test("the bead jar is an honest disabled placeholder", async ({ page }) => {
    await gotoKitchen(page);
    await page.getByTestId("pass-jar").click();
    await expect(page.getByTestId("beads-explorer")).toBeVisible();
    await expect(page.getByTestId("beads-explorer")).toContainText("no HTTP door");
  });

  // hwu.5: the type/author/date filter chip row. NOTE: the ?mock=1 harness's jot flow always seeds
  // optimistic notes as type="note"/author="user" (src/orbital/useOrbitalData.ts addNote) — there is
  // no harness hook to seed a decision/todo/warning/handoff-typed fixture client-side, so this spec
  // proves the filter MECHANISM (chips present, exclusive selection narrows the visible tickets, the
  // count label updates, "all" restores) using the note type/author the harness can actually produce.
  test.describe("ticket filter chips (type/author/date)", () => {
    async function seedNotes(page: Page, texts: string[]) {
      await page.route(/\/api\/projects\/.+\/notes$/, (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: '{"output":"ok"}' }));
      await gotoKitchen(page);
      for (const t of texts) {
        await page.getByTestId("pass-jot-input").fill(t);
        await page.getByTestId("pass-jot-add").click();
      }
      await expect(page.getByTestId("pass-ticket")).toHaveCount(texts.length);
    }

    test("the filter row appears once there is at least one ticket", async ({ page }) => {
      await gotoKitchen(page);
      await expect(page.getByTestId("pass-filters")).toHaveCount(0);
      await seedNotes(page, ["first jot"]);
      await expect(page.getByTestId("pass-filters")).toBeVisible();
      await expect(page.getByTestId("pass-filter-type-all")).toBeVisible();
      await expect(page.getByTestId("pass-filter-author-all")).toBeVisible();
      await expect(page.getByTestId("pass-filter-date-all")).toBeVisible();
    });

    test("clicking a non-matching type chip hides every ticket and the count label updates", async ({ page }) => {
      await seedNotes(page, ["alpha jot", "beta jot"]);
      await expect(page.getByTestId("pass-filter-count")).toContainText("2 of 2");

      // Every jotted note is type="note" — the "decision" chip must narrow the visible strip to zero.
      await page.getByTestId("pass-filter-type-decision").click();
      await expect(page.getByTestId("pass-ticket")).toHaveCount(0);
      await expect(page.getByTestId("pass-filter-count")).toContainText("0 of 2");

      // "note" (the real type) restores both.
      await page.getByTestId("pass-filter-type-note").click();
      await expect(page.getByTestId("pass-ticket")).toHaveCount(2);
      await expect(page.getByTestId("pass-filter-count")).toContainText("2 of 2");

      // "all" also restores (and is the default).
      await page.getByTestId("pass-filter-type-decision").click();
      await expect(page.getByTestId("pass-ticket")).toHaveCount(0);
      await page.getByTestId("pass-filter-type-all").click();
      await expect(page.getByTestId("pass-ticket")).toHaveCount(2);
    });

    test("the author chip narrows to the jotted 'you' (operator) notes", async ({ page }) => {
      await seedNotes(page, ["operator jot"]);
      // Every jotted note is author="user" ("you") — the "janus" chip must narrow to zero.
      await page.getByTestId("pass-filter-author-janus").click();
      await expect(page.getByTestId("pass-ticket")).toHaveCount(0);
      await page.getByTestId("pass-filter-author-you").click();
      await expect(page.getByTestId("pass-ticket")).toHaveCount(1);
    });

    test("the date chip's 'today' bucket keeps a freshly-jotted note visible", async ({ page }) => {
      await seedNotes(page, ["fresh jot"]);
      await page.getByTestId("pass-filter-date-today").click();
      await expect(page.getByTestId("pass-ticket")).toHaveCount(1);
      await page.getByTestId("pass-filter-date-week").click();
      await expect(page.getByTestId("pass-ticket")).toHaveCount(1);
      await page.getByTestId("pass-filter-date-all").click();
      await expect(page.getByTestId("pass-ticket")).toHaveCount(1);
    });
  });
});
