// tests/test_primitives_complexity_refactor.ts — CHARACTERIZATION tests for the
// cyclomatic-complexity burndown refactor of src/orbital/primitives.tsx (Button CC 21 → ≤10).
//
// These tests pin the PURE logic extracted into `getButtonPalette`, `getButtonSizing`,
// `getButtonShadow`, `getButtonTransform`, and `getButtonStyle` — every variant × size × state
// combination — so the behavior-preserving refactor changes nothing observable. Tests pass
// against BOTH the pre-refactor inline logic AND the post-refactor exports.
//
// The test suite must shim three things that are Vite-only (not resolvable by tsx):
//   - icons.svg?raw  (imported by src/orbital/primitives.tsx)
//   - react / react/jsx-runtime (not installed as test deps)
//
// We use Node 22 module.register() with an inline data-URL hook to intercept
// these imports BEFORE loading the primitives module. The hook runs in a separate
// Worker thread (Node ESM loader protocol); the data URL encodes the hook source
// so no extra file is needed.
//
// Runner: npx tsx --test --test-force-exit tests/test_primitives_complexity_refactor.ts

import { register } from "node:module";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Inline ESM loader hook to stub Vite-only / React imports ──────────────
// The hook intercepts any specifier matching our stub list and returns a
// synthetic module so the tsx runner can load primitives.tsx without Vite.
const hookSource = /* js */`
export async function resolve(specifier, context, nextResolve) {
  // Vite ?raw suffix (icons.svg?raw used by primitives.tsx)
  if (specifier.endsWith('?raw')) {
    return { url: 'data:text/javascript,export default ""', shortCircuit: true };
  }
  // React stub — pure-value helpers don't call React at all
  if (specifier === 'react') {
    return { url: 'data:text/javascript,export default {};export function useState(){}export function useRef(){}export function useEffect(){}export const Fragment=Symbol("Fragment")', shortCircuit: true };
  }
  if (specifier === 'react/jsx-runtime') {
    return { url: 'data:text/javascript,export function jsx(){}export function jsxs(){}export const Fragment=Symbol("Fragment");export default {}', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
  if (url.startsWith('data:text/javascript,')) {
    const source = decodeURIComponent(url.slice('data:text/javascript,'.length));
    return { format: 'module', source, shortCircuit: true };
  }
  return nextLoad(url, context);
}
`;

register(
  `data:text/javascript,${encodeURIComponent(hookSource)}`,
  { parentURL: import.meta.url },
);

// ── Import pure helpers (after hook registration) ─────────────────────────
// Dynamic import so the loader hook is active before the module graph loads.
const {
  getButtonPalette,
  getButtonSizing,
  getButtonShadow,
  getButtonTransform,
  getButtonStyle,
} = await import("../src/orbital/primitives.js");

// INK must match the theme constant exactly.
const INK = "#2a1a10";

// ─────────────────────────────────────────────────────────────────────────────
// All tests live inside a single top-level describe so they are all registered
// synchronously in one microtask after the await, preventing --test-force-exit
// from racing ahead of later describe() calls.
// ─────────────────────────────────────────────────────────────────────────────
describe("Button pure helpers", () => {

  // ── 1. getButtonPalette — all 6 variants ─────────────────────────────────
  describe("getButtonPalette", () => {
    it("default → bg=#fff9ec, fg=INK", () => {
      const p = getButtonPalette("default");
      assert.equal(p.bg, "#fff9ec");
      assert.equal(p.fg, INK);
    });

    it("primary → bg=#e23a3a, fg=#fff4de", () => {
      const p = getButtonPalette("primary");
      assert.equal(p.bg, "#e23a3a");
      assert.equal(p.fg, "#fff4de");
    });

    it("butter → bg=#ffc94a, fg=INK", () => {
      const p = getButtonPalette("butter");
      assert.equal(p.bg, "#ffc94a");
      assert.equal(p.fg, INK);
    });

    it("mint → bg=#4db892, fg=INK", () => {
      const p = getButtonPalette("mint");
      assert.equal(p.bg, "#4db892");
      assert.equal(p.fg, INK);
    });

    it("blueberry → bg=#4b3bb3, fg=#fff4de", () => {
      const p = getButtonPalette("blueberry");
      assert.equal(p.bg, "#4b3bb3");
      assert.equal(p.fg, "#fff4de");
    });

    it("ghost → bg=transparent, fg=INK", () => {
      const p = getButtonPalette("ghost");
      assert.equal(p.bg, "transparent");
      assert.equal(p.fg, INK);
    });

    it("unknown variant falls back to default palette", () => {
      // Cast to ButtonVariant to exercise the `|| palettes.default` guard branch.
      const p = getButtonPalette("unknown" as any);
      assert.equal(p.bg, "#fff9ec");
      assert.equal(p.fg, INK);
    });
  });

  // ── 2. getButtonSizing — all 3 sizes ────────────────────────────────────
  describe("getButtonSizing", () => {
    it("sm → pad='5px 10px', fs=12", () => {
      const s = getButtonSizing("sm");
      assert.equal(s.pad, "5px 10px");
      assert.equal(s.fs, 12);
    });

    it("md → pad='8px 14px', fs=13", () => {
      const s = getButtonSizing("md");
      assert.equal(s.pad, "8px 14px");
      assert.equal(s.fs, 13);
    });

    it("lg → pad='12px 20px', fs=15", () => {
      const s = getButtonSizing("lg");
      assert.equal(s.pad, "12px 20px");
      assert.equal(s.fs, 15);
    });
  });

  // ── 3. getButtonShadow — all variant × hover × press combinations ────────
  describe("getButtonShadow", () => {
    // ghost always returns "none" regardless of interaction state
    it("ghost, hover=false, press=false → 'none'", () => {
      assert.equal(getButtonShadow("ghost", false, false), "none");
    });
    it("ghost, hover=true, press=false → 'none'", () => {
      assert.equal(getButtonShadow("ghost", true, false), "none");
    });
    it("ghost, hover=false, press=true → 'none'", () => {
      assert.equal(getButtonShadow("ghost", false, true), "none");
    });
    it("ghost, hover=true, press=true → 'none'", () => {
      assert.equal(getButtonShadow("ghost", true, true), "none");
    });

    // Non-ghost variants: press → "none"
    it("default, hover=false, press=true → 'none'", () => {
      assert.equal(getButtonShadow("default", false, true), "none");
    });
    it("primary, hover=true, press=true → 'none' (press wins)", () => {
      assert.equal(getButtonShadow("primary", true, true), "none");
    });

    // Non-ghost variants: hover (no press) → raised shadow
    it("default, hover=true, press=false → '4px 4px 0 0 <INK>'", () => {
      assert.equal(getButtonShadow("default", true, false), "4px 4px 0 0 " + INK);
    });
    it("primary, hover=true, press=false → '4px 4px 0 0 <INK>'", () => {
      assert.equal(getButtonShadow("primary", true, false), "4px 4px 0 0 " + INK);
    });
    it("butter, hover=true, press=false → '4px 4px 0 0 <INK>'", () => {
      assert.equal(getButtonShadow("butter", true, false), "4px 4px 0 0 " + INK);
    });
    it("mint, hover=true, press=false → '4px 4px 0 0 <INK>'", () => {
      assert.equal(getButtonShadow("mint", true, false), "4px 4px 0 0 " + INK);
    });
    it("blueberry, hover=true, press=false → '4px 4px 0 0 <INK>'", () => {
      assert.equal(getButtonShadow("blueberry", true, false), "4px 4px 0 0 " + INK);
    });

    // Non-ghost variants: no hover, no press → resting shadow
    it("default, hover=false, press=false → '2px 2px 0 0 <INK>'", () => {
      assert.equal(getButtonShadow("default", false, false), "2px 2px 0 0 " + INK);
    });
    it("primary, hover=false, press=false → '2px 2px 0 0 <INK>'", () => {
      assert.equal(getButtonShadow("primary", false, false), "2px 2px 0 0 " + INK);
    });
    it("butter, hover=false, press=false → '2px 2px 0 0 <INK>'", () => {
      assert.equal(getButtonShadow("butter", false, false), "2px 2px 0 0 " + INK);
    });
    it("mint, hover=false, press=false → '2px 2px 0 0 <INK>'", () => {
      assert.equal(getButtonShadow("mint", false, false), "2px 2px 0 0 " + INK);
    });
    it("blueberry, hover=false, press=false → '2px 2px 0 0 <INK>'", () => {
      assert.equal(getButtonShadow("blueberry", false, false), "2px 2px 0 0 " + INK);
    });
  });

  // ── 4. getButtonTransform — all 4 hover × press combinations ─────────────
  describe("getButtonTransform", () => {
    it("hover=false, press=false → 'translate(0,0)'", () => {
      assert.equal(getButtonTransform(false, false), "translate(0,0)");
    });

    it("hover=true, press=false → 'translate(-1px,-1px)'", () => {
      assert.equal(getButtonTransform(true, false), "translate(-1px,-1px)");
    });

    it("hover=false, press=true → 'translate(2px,2px)'", () => {
      assert.equal(getButtonTransform(false, true), "translate(2px,2px)");
    });

    it("hover=true, press=true → 'translate(2px,2px)' (press wins)", () => {
      assert.equal(getButtonTransform(true, true), "translate(2px,2px)");
    });
  });

  // ── 5. getButtonStyle — structural invariants ────────────────────────────
  describe("getButtonStyle — structural invariants", () => {
    it("always has required layout fields", () => {
      const s = getButtonStyle("default", "md", false, false, false, {});
      assert.equal(s.display, "inline-flex");
      assert.equal(s.alignItems, "center");
      assert.equal(s.justifyContent, "center");
      assert.equal(s.gap, 6);
      assert.equal(s.borderRadius, 10);
      assert.equal(s.fontFamily, "DM Sans, sans-serif");
      assert.equal(s.fontWeight, 800);
      assert.equal(s.letterSpacing, ".01em");
      assert.equal(s.whiteSpace, "nowrap");
      assert.equal(s.lineHeight, 1.2);
      assert.equal(s.transition, "transform 120ms cubic-bezier(.34,1.56,.64,1), box-shadow 120ms");
    });
  });

  // ── 6. getButtonStyle — size × padding × fontSize ────────────────────────
  describe("getButtonStyle — size × padding × fontSize", () => {
    it("sm: padding='5px 10px', fontSize=12", () => {
      const s = getButtonStyle("default", "sm", false, false, false, {});
      assert.equal(s.padding, "5px 10px");
      assert.equal(s.fontSize, 12);
    });

    it("md: padding='8px 14px', fontSize=13", () => {
      const s = getButtonStyle("default", "md", false, false, false, {});
      assert.equal(s.padding, "8px 14px");
      assert.equal(s.fontSize, 13);
    });

    it("lg: padding='12px 20px', fontSize=15", () => {
      const s = getButtonStyle("default", "lg", false, false, false, {});
      assert.equal(s.padding, "12px 20px");
      assert.equal(s.fontSize, 15);
    });
  });

  // ── 7. getButtonStyle — variant × palette × border ───────────────────────
  describe("getButtonStyle — variant × palette × border", () => {
    it("default: bg=#fff9ec, fg=INK, solid border", () => {
      const s = getButtonStyle("default", "md", false, false, false, {});
      assert.equal(s.background, "#fff9ec");
      assert.equal(s.color, INK);
      assert.equal(s.border, `2px solid ${INK}`);
    });

    it("primary: bg=#e23a3a, fg=#fff4de, solid border", () => {
      const s = getButtonStyle("primary", "md", false, false, false, {});
      assert.equal(s.background, "#e23a3a");
      assert.equal(s.color, "#fff4de");
      assert.equal(s.border, `2px solid ${INK}`);
    });

    it("butter: bg=#ffc94a, fg=INK, solid border", () => {
      const s = getButtonStyle("butter", "md", false, false, false, {});
      assert.equal(s.background, "#ffc94a");
      assert.equal(s.color, INK);
      assert.equal(s.border, `2px solid ${INK}`);
    });

    it("mint: bg=#4db892, fg=INK, solid border", () => {
      const s = getButtonStyle("mint", "md", false, false, false, {});
      assert.equal(s.background, "#4db892");
      assert.equal(s.color, INK);
      assert.equal(s.border, `2px solid ${INK}`);
    });

    it("blueberry: bg=#4b3bb3, fg=#fff4de, solid border", () => {
      const s = getButtonStyle("blueberry", "md", false, false, false, {});
      assert.equal(s.background, "#4b3bb3");
      assert.equal(s.color, "#fff4de");
      assert.equal(s.border, `2px solid ${INK}`);
    });

    it("ghost: bg=transparent, fg=INK, dashed border", () => {
      const s = getButtonStyle("ghost", "md", false, false, false, {});
      assert.equal(s.background, "transparent");
      assert.equal(s.color, INK);
      assert.equal(s.border, `2px dashed ${INK}55`);
    });
  });

  // ── 8. getButtonStyle — disabled state ───────────────────────────────────
  describe("getButtonStyle — disabled state", () => {
    it("disabled=true: cursor=not-allowed, boxShadow=none, transform=none, opacity=0.5", () => {
      const s = getButtonStyle("default", "md", true, false, false, {});
      assert.equal(s.cursor, "not-allowed");
      assert.equal(s.boxShadow, "none");
      assert.equal(s.transform, "none");
      assert.equal(s.opacity, 0.5);
    });

    it("disabled=true overrides hover shadow and translate", () => {
      const s = getButtonStyle("default", "md", true, true, false, {});
      assert.equal(s.boxShadow, "none");
      assert.equal(s.transform, "none");
      assert.equal(s.opacity, 0.5);
    });

    it("disabled=true overrides press shadow and translate", () => {
      const s = getButtonStyle("default", "md", true, false, true, {});
      assert.equal(s.boxShadow, "none");
      assert.equal(s.transform, "none");
      assert.equal(s.opacity, 0.5);
    });

    it("disabled=false (no hover, no press): cursor=pointer, resting shadow, no translate, opacity=1", () => {
      const s = getButtonStyle("default", "md", false, false, false, {});
      assert.equal(s.cursor, "pointer");
      assert.equal(s.boxShadow, "2px 2px 0 0 " + INK);
      assert.equal(s.transform, "translate(0,0)");
      assert.equal(s.opacity, 1);
    });

    it("disabled=undefined: treated as falsy → cursor=pointer, opacity=1", () => {
      const s = getButtonStyle("default", "md", undefined, false, false, {});
      assert.equal(s.cursor, "pointer");
      assert.equal(s.opacity, 1);
    });
  });

  // ── 9. getButtonStyle — hover × press interaction states (non-disabled) ──
  describe("getButtonStyle — hover × press interaction states", () => {
    it("hover=true, press=false: raised shadow and lift translate", () => {
      const s = getButtonStyle("default", "md", false, true, false, {});
      assert.equal(s.boxShadow, "4px 4px 0 0 " + INK);
      assert.equal(s.transform, "translate(-1px,-1px)");
    });

    it("hover=false, press=true: no shadow, pressed translate", () => {
      const s = getButtonStyle("default", "md", false, false, true, {});
      assert.equal(s.boxShadow, "none");
      assert.equal(s.transform, "translate(2px,2px)");
    });

    it("hover=true, press=true: press wins for both shadow and translate", () => {
      const s = getButtonStyle("default", "md", false, true, true, {});
      assert.equal(s.boxShadow, "none");
      assert.equal(s.transform, "translate(2px,2px)");
    });

    it("ghost hover=true: boxShadow=none (ghost never gets shadow)", () => {
      const s = getButtonStyle("ghost", "md", false, true, false, {});
      assert.equal(s.boxShadow, "none");
      assert.equal(s.transform, "translate(-1px,-1px)");
    });

    it("ghost press=true: boxShadow=none, pressed translate", () => {
      const s = getButtonStyle("ghost", "md", false, false, true, {});
      assert.equal(s.boxShadow, "none");
      assert.equal(s.transform, "translate(2px,2px)");
    });
  });

  // ── 10. getButtonStyle — extraStyle merging ───────────────────────────────
  describe("getButtonStyle — extraStyle merging", () => {
    it("extraStyle is spread last, overriding computed values", () => {
      const s = getButtonStyle("default", "md", false, false, false, { color: "red", borderRadius: 99 });
      assert.equal(s.color, "red");
      assert.equal(s.borderRadius, 99);
    });

    it("empty extraStyle leaves all computed values intact", () => {
      const s = getButtonStyle("default", "md", false, false, false, {});
      assert.equal(s.background, "#fff9ec");
    });
  });

  // ── 11. getButtonStyle — representative cross-product snapshots ───────────
  describe("getButtonStyle — cross-product snapshots", () => {
    it("primary sm disabled: correct bg, font-size, cursor, opacity", () => {
      const s = getButtonStyle("primary", "sm", true, false, false, {});
      assert.equal(s.background, "#e23a3a");
      assert.equal(s.fontSize, 12);
      assert.equal(s.cursor, "not-allowed");
      assert.equal(s.opacity, 0.5);
      assert.equal(s.boxShadow, "none");
    });

    it("blueberry lg hover: correct bg, font-size, raised shadow, lift", () => {
      const s = getButtonStyle("blueberry", "lg", false, true, false, {});
      assert.equal(s.background, "#4b3bb3");
      assert.equal(s.fontSize, 15);
      assert.equal(s.boxShadow, "4px 4px 0 0 " + INK);
      assert.equal(s.transform, "translate(-1px,-1px)");
      assert.equal(s.opacity, 1);
    });

    it("mint md pressed: correct bg, resting font-size, no shadow, pressed translate", () => {
      const s = getButtonStyle("mint", "md", false, false, true, {});
      assert.equal(s.background, "#4db892");
      assert.equal(s.fontSize, 13);
      assert.equal(s.boxShadow, "none");
      assert.equal(s.transform, "translate(2px,2px)");
    });

    it("ghost sm active (not disabled): dashed border, transparent bg, no shadow even when hovered", () => {
      const s = getButtonStyle("ghost", "sm", false, true, false, {});
      assert.equal(s.background, "transparent");
      assert.equal(s.border, `2px dashed ${INK}55`);
      assert.equal(s.boxShadow, "none");
      assert.equal(s.fontSize, 12);
      assert.equal(s.transform, "translate(-1px,-1px)");
    });

    it("butter lg disabled hover: disabled wins over hover", () => {
      const s = getButtonStyle("butter", "lg", true, true, false, {});
      assert.equal(s.background, "#ffc94a");
      assert.equal(s.fontSize, 15);
      assert.equal(s.cursor, "not-allowed");
      assert.equal(s.boxShadow, "none");
      assert.equal(s.transform, "none");
      assert.equal(s.opacity, 0.5);
    });

    it("default md normal state: complete snapshot", () => {
      const s = getButtonStyle("default", "md", false, false, false, {});
      assert.equal(s.display, "inline-flex");
      assert.equal(s.alignItems, "center");
      assert.equal(s.justifyContent, "center");
      assert.equal(s.gap, 6);
      assert.equal(s.padding, "8px 14px");
      assert.equal(s.borderRadius, 10);
      assert.equal(s.border, `2px solid ${INK}`);
      assert.equal(s.background, "#fff9ec");
      assert.equal(s.color, INK);
      assert.equal(s.fontFamily, "DM Sans, sans-serif");
      assert.equal(s.fontSize, 13);
      assert.equal(s.fontWeight, 800);
      assert.equal(s.letterSpacing, ".01em");
      assert.equal(s.cursor, "pointer");
      assert.equal(s.whiteSpace, "nowrap");
      assert.equal(s.lineHeight, 1.2);
      assert.equal(s.boxShadow, "2px 2px 0 0 " + INK);
      assert.equal(s.transform, "translate(0,0)");
      assert.equal(s.opacity, 1);
      assert.equal(s.transition, "transform 120ms cubic-bezier(.34,1.56,.64,1), box-shadow 120ms");
    });
  });

}); // end "Button pure helpers"
