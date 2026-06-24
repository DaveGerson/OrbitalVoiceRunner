// tests/test_app_context_size.ts — CHARACTERIZATION tests for the context-size resolution +
// meter-fill-percent helpers extracted out of src/App.tsx (bead dbt4 — App.tsx decomposition,
// round 3). App.tsx's grid-card `.map` derived each card's context size with the SAME
// `term?.context_size !== undefined ? term.context_size : (pane.context_size || 0)` fallback that
// `sumContextSize` already reduces over, and rendered two meter-fill bars as
// `Math.min((n / DENOM) * 100, 100)` with DISTINCT denominators (20000 per-pane, 100000 cumulative).
// Each was relocated VERBATIM into a pure helper in src/appHelpers.ts so App.tsx renders a single
// import call and the BYTE-EXACT value is independently testable. Nothing observable differs.
//
// Runner: npx tsx --test --test-force-exit tests/test_app_context_size.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  resolveCardContextSize,
  contextMeterPercent,
  totalContextBarPercent,
  sumContextSize,
} from "../src/appHelpers";
import type { Terminal, PaneMeta } from "../src/types";

// Minimal fixtures — only the fields the helpers read are populated; the rest are not touched.
function makeTerm(context_size: number | undefined): Pick<Terminal, "context_size"> {
  return { context_size };
}
function makePane(context_size: number): Pick<PaneMeta, "context_size"> {
  return { context_size };
}

// ═════════════════════════════════════════════════════════════════════════════
// resolveCardContextSize — live-terminal size wins WHEN DEFINED, else pane (`|| 0`).
// The precedence is `!== undefined`, NOT truthiness: a live `0` must beat the pane value.
// ═════════════════════════════════════════════════════════════════════════════
describe("appHelpers — resolveCardContextSize (term wins when defined, else pane || 0)", () => {
  it("uses the live terminal's context_size when it is defined", () => {
    assert.strictEqual(resolveCardContextSize(makeTerm(1234), makePane(99)), 1234);
  });

  it("a live context_size of 0 STILL wins over the pane (uses !== undefined, not truthiness)", () => {
    // The boundary that a `|| 0` short-circuit would get wrong: term defined as 0 must win.
    assert.strictEqual(resolveCardContextSize(makeTerm(0), makePane(5000)), 0);
  });

  it("falls back to the pane's context_size when the term's is undefined", () => {
    assert.strictEqual(resolveCardContextSize(makeTerm(undefined), makePane(750)), 750);
  });

  it("falls back to the pane's context_size when there is no live term at all", () => {
    assert.strictEqual(resolveCardContextSize(undefined, makePane(640)), 640);
  });

  it("falls back to 0 when neither side has a usable value (pane `|| 0`)", () => {
    assert.strictEqual(resolveCardContextSize(undefined, makePane(0)), 0);
    assert.strictEqual(resolveCardContextSize(makeTerm(undefined), makePane(0)), 0);
  });

  it("agrees with the per-pane term used inside sumContextSize's reducer", () => {
    // sumContextSize now reduces with resolveCardContextSize; pin that the aggregate equals the
    // sum of the per-card resolutions (no divergence between the single-card and aggregate paths).
    const panes: Record<string, PaneMeta> = {
      a: { context_size: 100 } as PaneMeta, // pane "a" — no live term, uses 100
      b: { context_size: 200 } as PaneMeta, // pane "b" — live term defined as 0, uses 0
    };
    (panes.a as any).pane_id = "a";
    (panes.b as any).pane_id = "b";
    const terminals = [{ id: "b", context_size: 0 } as Terminal];
    assert.strictEqual(sumContextSize(panes, terminals), 100 + 0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// contextMeterPercent — Math.min((n / 20000) * 100, 100). Per-pane card meter fill.
// ═════════════════════════════════════════════════════════════════════════════
describe("appHelpers — contextMeterPercent (per-pane, /20000, clamp 100)", () => {
  it("0 -> 0%", () => {
    assert.strictEqual(contextMeterPercent(0), 0);
  });
  it("linear below the cap (10000 -> 50%, 5000 -> 25%)", () => {
    assert.strictEqual(contextMeterPercent(10000), 50);
    assert.strictEqual(contextMeterPercent(5000), 25);
  });
  it("exactly at the budget (20000) -> 100%", () => {
    assert.strictEqual(contextMeterPercent(20000), 100);
  });
  it("clamps ABOVE the budget to 100% (40000 would be 200% unclamped)", () => {
    assert.strictEqual(contextMeterPercent(40000), 100);
    assert.strictEqual(contextMeterPercent(999999), 100);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// totalContextBarPercent — Math.min((n / 100000) * 100, 100). Header cumulative bar (distinct denom).
// ═════════════════════════════════════════════════════════════════════════════
describe("appHelpers — totalContextBarPercent (cumulative, /100000, clamp 100)", () => {
  it("0 -> 0%", () => {
    assert.strictEqual(totalContextBarPercent(0), 0);
  });
  it("linear below the cap (50000 -> 50%, 25000 -> 25%)", () => {
    assert.strictEqual(totalContextBarPercent(50000), 50);
    assert.strictEqual(totalContextBarPercent(25000), 25);
  });
  it("exactly at the budget (100000) -> 100%", () => {
    assert.strictEqual(totalContextBarPercent(100000), 100);
  });
  it("clamps ABOVE the budget to 100% (200000 would be 200% unclamped)", () => {
    assert.strictEqual(totalContextBarPercent(200000), 100);
  });
  it("uses a DIFFERENT denominator than contextMeterPercent (20000 -> 20%, not 100%)", () => {
    // The same input that pegs the per-pane meter at 100% sits at only 20% on the cumulative bar.
    assert.strictEqual(totalContextBarPercent(20000), 20);
    assert.strictEqual(contextMeterPercent(20000), 100);
  });
});
