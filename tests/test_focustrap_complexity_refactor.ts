// tests/test_focustrap_complexity_refactor.ts — CHARACTERIZATION tests for the
// cyclomatic-complexity burndown refactor of src/orbital/useFocusTrap.ts.
//
// Pins the pure decision helper (handleFocusTrapKey) across every branch of the
// original onKey handler so the refactor is behaviour-preserving:
//   - Escape (top / not top / hitl-mounted / no onClose)
//   - Tab (no focusables, single element, forward wrap, backward wrap)
//   - Shift+Tab (focus-inside-at-first, focus-outside, wrap to last)
//   - Focus currently outside the trap (both directions)
//   - Non-trap keys (should be noop)
//
// Written GREEN against the PRE-refactor helper shape first (per D-6); the
// helper is extracted verbatim from the existing handler logic.
//
// Runner: npx tsx --test --test-force-exit tests/test_focustrap_complexity_refactor.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import { handleFocusTrapKey, type FocusTrapKeyDecision } from "../src/orbital/useFocusTrap";

// ─── tiny DOM-element stub ────────────────────────────────────────────────────
// We only need identity equality (focus cycling returns element references)
// so a plain object with a label is sufficient — no real DOM needed.
function el(label: string): HTMLElement {
  return { _label: label } as unknown as HTMLElement;
}

// ─── helper to build the common "3 focusables, active=middle" scenario ────────
function threeEls() {
  const [a, b, c] = [el("a"), el("b"), el("c")];
  return { a, b, c, els: [a, b, c] };
}

// =============================================================================
// 1. NOT the top-most overlay — every key is a pure noop
// =============================================================================
describe("handleFocusTrapKey — not top-most overlay", () => {
  it("returns noop for Escape when not top-most", () => {
    const dec = handleFocusTrapKey({
      isTopOverlay: false,
      key: "Escape", shiftKey: false,
      hitlMounted: false, hasOnClose: true,
      focusables: [el("x")], activeElement: el("x"), containerContainsActive: true,
    });
    assert.strictEqual(dec.type, "noop");
  });

  it("returns noop for Tab when not top-most", () => {
    const { els } = threeEls();
    const dec = handleFocusTrapKey({
      isTopOverlay: false,
      key: "Tab", shiftKey: false,
      hitlMounted: false, hasOnClose: false,
      focusables: els, activeElement: els[2], containerContainsActive: true,
    });
    assert.strictEqual(dec.type, "noop");
  });
});

// =============================================================================
// 2. Escape handling
// =============================================================================
describe("handleFocusTrapKey — Escape key", () => {
  it("returns 'escape-close' when top-most, no HiTL dialog, and onClose is set", () => {
    const dec = handleFocusTrapKey({
      isTopOverlay: true,
      key: "Escape", shiftKey: false,
      hitlMounted: false, hasOnClose: true,
      focusables: [], activeElement: null, containerContainsActive: false,
    });
    assert.strictEqual(dec.type, "escape-close");
  });

  it("returns 'noop' for Escape when HiTL dialog is mounted (HiTL owns Escape)", () => {
    const dec = handleFocusTrapKey({
      isTopOverlay: true,
      key: "Escape", shiftKey: false,
      hitlMounted: true, hasOnClose: true,
      focusables: [], activeElement: null, containerContainsActive: false,
    });
    assert.strictEqual(dec.type, "noop");
  });

  it("returns 'noop' for Escape when there is no onClose handler", () => {
    const dec = handleFocusTrapKey({
      isTopOverlay: true,
      key: "Escape", shiftKey: false,
      hitlMounted: false, hasOnClose: false,
      focusables: [], activeElement: null, containerContainsActive: false,
    });
    assert.strictEqual(dec.type, "noop");
  });

  it("returns 'noop' for Escape when both HiTL mounted and no onClose", () => {
    const dec = handleFocusTrapKey({
      isTopOverlay: true,
      key: "Escape", shiftKey: false,
      hitlMounted: true, hasOnClose: false,
      focusables: [], activeElement: null, containerContainsActive: false,
    });
    assert.strictEqual(dec.type, "noop");
  });
});

// =============================================================================
// 3. Tab — no focusable elements
// =============================================================================
describe("handleFocusTrapKey — Tab with no focusables", () => {
  it("returns 'prevent-default-only' when there are no focusable elements", () => {
    const dec = handleFocusTrapKey({
      isTopOverlay: true,
      key: "Tab", shiftKey: false,
      hitlMounted: false, hasOnClose: false,
      focusables: [], activeElement: null, containerContainsActive: false,
    });
    assert.strictEqual(dec.type, "prevent-default-only");
  });

  it("Shift+Tab with no focusables also returns 'prevent-default-only'", () => {
    const dec = handleFocusTrapKey({
      isTopOverlay: true,
      key: "Tab", shiftKey: true,
      hitlMounted: false, hasOnClose: false,
      focusables: [], activeElement: null, containerContainsActive: false,
    });
    assert.strictEqual(dec.type, "prevent-default-only");
  });
});

// =============================================================================
// 4. Tab — single focusable element
// =============================================================================
describe("handleFocusTrapKey — Tab with single focusable element", () => {
  it("Tab forward on the only element wraps to itself (first === last)", () => {
    const only = el("only");
    const dec = handleFocusTrapKey({
      isTopOverlay: true,
      key: "Tab", shiftKey: false,
      hitlMounted: false, hasOnClose: false,
      focusables: [only], activeElement: only, containerContainsActive: true,
    });
    assert.strictEqual(dec.type, "focus");
    assert.strictEqual((dec as { type: "focus"; element: HTMLElement }).element, only);
  });

  it("Shift+Tab on the only element wraps to itself (first === last)", () => {
    const only = el("only");
    const dec = handleFocusTrapKey({
      isTopOverlay: true,
      key: "Tab", shiftKey: true,
      hitlMounted: false, hasOnClose: false,
      focusables: [only], activeElement: only, containerContainsActive: true,
    });
    assert.strictEqual(dec.type, "focus");
    assert.strictEqual((dec as { type: "focus"; element: HTMLElement }).element, only);
  });
});

// =============================================================================
// 5. Tab forward — focus cycling
// =============================================================================
describe("handleFocusTrapKey — Tab forward (no shiftKey)", () => {
  it("Tab when active is the LAST element wraps to first", () => {
    const { a, c, els } = threeEls();
    const dec = handleFocusTrapKey({
      isTopOverlay: true,
      key: "Tab", shiftKey: false,
      hitlMounted: false, hasOnClose: false,
      focusables: els, activeElement: c, containerContainsActive: true,
    });
    assert.strictEqual(dec.type, "focus");
    assert.strictEqual((dec as { type: "focus"; element: HTMLElement }).element, a);
  });

  it("Tab when active is NOT the last element does nothing (noop — browser handles natural tab)", () => {
    const { a, b, els } = threeEls();
    const dec = handleFocusTrapKey({
      isTopOverlay: true,
      key: "Tab", shiftKey: false,
      hitlMounted: false, hasOnClose: false,
      focusables: els, activeElement: a, containerContainsActive: true,
    });
    // active === first, but Tab forward (not shiftKey) — the forward condition only
    // fires when active === LAST or focus is outside. a !== last (c), so: noop.
    assert.strictEqual(dec.type, "noop");
  });

  it("Tab when active is the middle element does nothing", () => {
    const { b, els } = threeEls();
    const dec = handleFocusTrapKey({
      isTopOverlay: true,
      key: "Tab", shiftKey: false,
      hitlMounted: false, hasOnClose: false,
      focusables: els, activeElement: b, containerContainsActive: true,
    });
    assert.strictEqual(dec.type, "noop");
  });

  it("Tab when focus is OUTSIDE the container wraps to first", () => {
    const { a, els } = threeEls();
    const outside = el("outside");
    const dec = handleFocusTrapKey({
      isTopOverlay: true,
      key: "Tab", shiftKey: false,
      hitlMounted: false, hasOnClose: false,
      focusables: els, activeElement: outside, containerContainsActive: false,
    });
    assert.strictEqual(dec.type, "focus");
    assert.strictEqual((dec as { type: "focus"; element: HTMLElement }).element, a);
  });
});

// =============================================================================
// 6. Shift+Tab — reverse focus cycling
// =============================================================================
describe("handleFocusTrapKey — Shift+Tab (reverse)", () => {
  it("Shift+Tab when active is the FIRST element wraps to last", () => {
    const { a, c, els } = threeEls();
    const dec = handleFocusTrapKey({
      isTopOverlay: true,
      key: "Tab", shiftKey: true,
      hitlMounted: false, hasOnClose: false,
      focusables: els, activeElement: a, containerContainsActive: true,
    });
    assert.strictEqual(dec.type, "focus");
    assert.strictEqual((dec as { type: "focus"; element: HTMLElement }).element, c);
  });

  it("Shift+Tab when active is NOT the first element does nothing (browser handles it)", () => {
    const { b, els } = threeEls();
    const dec = handleFocusTrapKey({
      isTopOverlay: true,
      key: "Tab", shiftKey: true,
      hitlMounted: false, hasOnClose: false,
      focusables: els, activeElement: b, containerContainsActive: true,
    });
    assert.strictEqual(dec.type, "noop");
  });

  it("Shift+Tab when active is the LAST element does nothing (not first, not outside)", () => {
    const { c, els } = threeEls();
    const dec = handleFocusTrapKey({
      isTopOverlay: true,
      key: "Tab", shiftKey: true,
      hitlMounted: false, hasOnClose: false,
      focusables: els, activeElement: c, containerContainsActive: true,
    });
    assert.strictEqual(dec.type, "noop");
  });

  it("Shift+Tab when focus is OUTSIDE the container wraps to last", () => {
    const { c, els } = threeEls();
    const outside = el("outside");
    const dec = handleFocusTrapKey({
      isTopOverlay: true,
      key: "Tab", shiftKey: true,
      hitlMounted: false, hasOnClose: false,
      focusables: els, activeElement: outside, containerContainsActive: false,
    });
    assert.strictEqual(dec.type, "focus");
    assert.strictEqual((dec as { type: "focus"; element: HTMLElement }).element, c);
  });
});

// =============================================================================
// 7. Non-trap keys (Enter, ArrowDown, etc.) — always noop
// =============================================================================
describe("handleFocusTrapKey — non-trap keys", () => {
  it("Enter key is a noop", () => {
    const dec = handleFocusTrapKey({
      isTopOverlay: true,
      key: "Enter", shiftKey: false,
      hitlMounted: false, hasOnClose: true,
      focusables: [el("x")], activeElement: el("x"), containerContainsActive: true,
    });
    assert.strictEqual(dec.type, "noop");
  });

  it("ArrowDown key is a noop", () => {
    const dec = handleFocusTrapKey({
      isTopOverlay: true,
      key: "ArrowDown", shiftKey: false,
      hitlMounted: false, hasOnClose: false,
      focusables: [el("x")], activeElement: el("x"), containerContainsActive: true,
    });
    assert.strictEqual(dec.type, "noop");
  });

  it("Space key is a noop", () => {
    const dec = handleFocusTrapKey({
      isTopOverlay: true,
      key: " ", shiftKey: false,
      hitlMounted: false, hasOnClose: false,
      focusables: [el("x")], activeElement: el("x"), containerContainsActive: true,
    });
    assert.strictEqual(dec.type, "noop");
  });
});

// =============================================================================
// 8. Tab with node=null (the original guard was `e.key === "Tab" && node`)
// =============================================================================
describe("handleFocusTrapKey — Tab with no container node", () => {
  // When the ref.current is null, the original code's `if (e.key === "Tab" && node)`
  // guard short-circuits — nothing happens at all. The pure helper receives
  // hasNode: false to represent this, and must return noop (NOT prevent-default).
  it("Tab with hasNode=false is a noop (original code skips the Tab branch entirely)", () => {
    const dec = handleFocusTrapKey({
      isTopOverlay: true,
      key: "Tab", shiftKey: false,
      hitlMounted: false, hasOnClose: false,
      hasNode: false,
      focusables: [], activeElement: null, containerContainsActive: false,
    });
    assert.strictEqual(dec.type, "noop");
  });

  it("Shift+Tab with hasNode=false is also a noop", () => {
    const dec = handleFocusTrapKey({
      isTopOverlay: true,
      key: "Tab", shiftKey: true,
      hitlMounted: false, hasOnClose: false,
      hasNode: false,
      focusables: [], activeElement: null, containerContainsActive: false,
    });
    assert.strictEqual(dec.type, "noop");
  });
});
