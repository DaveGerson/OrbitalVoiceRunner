import { expect, test, type Page } from "@playwright/test";
import { armE2EWire } from "./fixtures";

// hwu.6 — the project export download button on The Pass. It GETs the deterministic Markdown
// export (the SAME composer the voice export_project tool writes to disk with) and hands the
// browser a Blob to save; it never writes anything server-side.

async function gotoKitchen(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await armE2EWire(page); // mock-mode wires only fire on a Playwright-armed page
  await page.goto("/?ui=kitchen&mock=1");
  await page.waitForSelector("html[data-e2e-ready='1']");
  await expect(page.getByTestId("the-pass")).toBeVisible();
}

test.describe("Orbital Kitchen — The Pass — project export", () => {
  test("the export button is present and enabled once a kitchen is picked", async ({ page }) => {
    await gotoKitchen(page);
    await expect(page.getByTestId("pass-export")).toBeVisible();
    await expect(page.getByTestId("pass-export")).toBeEnabled();
  });

  test("clicking the export button GETs the export route and downloads the returned markdown", async ({ page }) => {
    const markdown = "# Orbital Export — Mock Kitchen (mock_project)\n\n_Generated: 2026-07-06T00:00:00.000Z_\n\nsome body\n";
    await page.route(/\/api\/projects\/.+\/export$/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/markdown; charset=utf-8",
        headers: { "Content-Disposition": 'attachment; filename="ORBITAL_EXPORT.md"' },
        body: markdown,
      }));
    await gotoKitchen(page);
    const getReq = page.waitForRequest((r) => /\/api\/projects\/.+\/export$/.test(r.url()) && r.method() === "GET", { timeout: 10_000 });
    const downloadPromise = page.waitForEvent("download", { timeout: 10_000 });
    await page.getByTestId("pass-export").click();
    await getReq;
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("ORBITAL_EXPORT.md");
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      stream!.on("data", (c) => chunks.push(c as Buffer));
      stream!.on("end", () => resolve());
      stream!.on("error", reject);
    });
    const body = Buffer.concat(chunks).toString("utf8");
    expect(body).toContain("Orbital Export — Mock Kitchen");
  });
});
