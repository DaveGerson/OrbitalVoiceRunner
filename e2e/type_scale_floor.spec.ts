import type { Page } from "@playwright/test";
import { test, expect, gotoMockedApp } from "./fixtures";

/**
 * TYPE-SCALE FLOOR — runtime visual-regression guard (bead 5n7, operator decision D3).
 *
 * The static guard (tests/test_type_scale_floor.ts) proves no sub-12px Tailwind LITERAL survives the
 * source sweep. THIS spec is the complementary RUNTIME proof: it walks every VISIBLE text node the
 * classic app actually renders and fails if any computes a font-size below the 12px floor — catching
 * regressions a source grep can't (inherited sizes, a stray inline style, a future component).
 *
 * Zoom: the floor is expressed in CSS px, which `getComputedStyle().fontSize` reports independent of
 * browser zoom, so the same px assertion holds at 100% AND 80% zoom. We additionally apply a root
 * `zoom` transform at 80% to prove nothing in the tree is sized in zoom-relative units that would dip
 * a visible glyph under the floor when the operator zooms OUT.
 *
 * Floor = 12px (`text-xs`). The ONE sanctioned sub-floor escape is `--text-nano` (10px); the assertion
 * allows exactly that value (with a hair of float tolerance) and nothing between 10px and 12px.
 */

const FLOOR_PX = 12;
const NANO_PX = 10; // --text-nano (.625rem at the default 16px root)
const EPSILON = 0.5; // sub-pixel rounding tolerance

/**
 * Collect, in the page, every VISIBLE element that directly renders non-whitespace text, with its
 * computed font-size (px) and a short text/identity snippet for diagnostics. Runs entirely in the
 * browser to avoid hundreds of round-trips.
 */
async function collectTextFontSizes(page: Page): Promise<{ size: number; tag: string; text: string }[]> {
  return page.evaluate(() => {
    const out: { size: number; tag: string; text: string }[] = [];
    const els = Array.from(document.body.querySelectorAll<HTMLElement>("*"));
    for (const el of els) {
      // Direct text only: skip elements whose text comes entirely from children (we'll visit those).
      const direct = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => (n.textContent ?? "").trim())
        .join("");
      if (!direct) continue;

      const cs = window.getComputedStyle(el);
      // Only assert on text the operator can actually SEE.
      if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;

      const size = parseFloat(cs.fontSize);
      if (!Number.isFinite(size)) continue;
      out.push({ size, tag: el.tagName.toLowerCase(), text: direct.slice(0, 40) });
    }
    return out;
  });
}

function assertNoSubFloorText(samples: { size: number; tag: string; text: string }[], label: string): void {
  // A reading is OK if it is at/above the 12px floor, OR it is exactly the sanctioned 10px nano escape.
  const offenders = samples.filter((s) => {
    const atFloor = s.size >= FLOOR_PX - EPSILON;
    const isNano = Math.abs(s.size - NANO_PX) <= EPSILON;
    return !atFloor && !isNano;
  });
  expect(samples.length, `${label}: expected to have sampled visible text`).toBeGreaterThan(0);
  expect(
    offenders.map((o) => `${o.size}px <${o.tag}> "${o.text}"`),
    `${label}: visible text rendered below the ${FLOOR_PX}px floor (only the ${NANO_PX}px --text-nano escape is allowed)`,
  ).toEqual([]);
}

test.describe("type-scale floor — runtime (no visible text below 12px)", () => {
  test("classic app: no visible text below the floor at 100% zoom", async ({ page }) => {
    await gotoMockedApp(page);
    const samples = await collectTextFontSizes(page);
    assertNoSubFloorText(samples, "100% zoom");
  });

  test("classic app: no visible text below the floor at 80% zoom", async ({ page }) => {
    await gotoMockedApp(page);
    // Emulate the operator zooming the page OUT to 80% (CSS zoom is how Chromium models browser zoom).
    await page.evaluate(() => {
      (document.documentElement.style as unknown as { zoom: string }).zoom = "0.8";
    });
    // Re-read after the zoom takes effect.
    const samples = await collectTextFontSizes(page);
    assertNoSubFloorText(samples, "80% zoom");
  });

  test("the GateChip popover (a dense sub-floor hotspot pre-migration) honors the floor", async ({ page }) => {
    await gotoMockedApp(page);
    // The popover packed the most text-[8px]/text-[9px] before the sweep — open it and re-assert.
    await page.getByTestId("gate-chip-trigger").first().dispatchEvent("click");
    await expect(page.getByTestId("gate-chip-popover")).toBeVisible();
    const popover = page.getByTestId("gate-chip-popover");
    const samples = await popover.evaluate((root) => {
      const out: { size: number; tag: string; text: string }[] = [];
      for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
        const direct = Array.from(el.childNodes)
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => (n.textContent ?? "").trim())
          .join("");
        if (!direct) continue;
        const cs = window.getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none") continue;
        out.push({ size: parseFloat(cs.fontSize), tag: el.tagName.toLowerCase(), text: direct.slice(0, 40) });
      }
      return out;
    });
    assertNoSubFloorText(samples, "gate-chip popover");
  });
});
