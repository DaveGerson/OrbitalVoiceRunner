// tests/test_stationcard_complexity_refactor.ts — CHARACTERIZATION tests for the
// cyclomatic-complexity burndown refactor of src/orbital/StationCard.tsx (CC 48 → ≤10).
//
// Pins every branch of the ten pure helpers extracted into
// src/orbital/stationCardHelpers.ts:
//
//   - deriveCardColors          (dark → 4 colour tokens)
//   - deriveCardTag             (projectName → 4-letter tag or "—")
//   - deriveCardBoxShadow       (active/hover/needs → box-shadow string)
//   - deriveCardTransform       (hover/tilt → transform string)
//   - deriveSpineStyle          (accentHex/isRun → style object)
//   - deriveScribbleColor       (needs/dark → colour string)
//   - deriveScribbleBorderColor (dark → border colour)
//   - deriveOutputLineColor     (line prefix → colour string)
//   - deriveFooterBorderColor   (dark → dashed-border colour)
//   - deriveCueBorderColor      (dark → dotted-border colour)
//
// stationCardHelpers.ts imports only from ./theme (no Vite-only imports, no
// React), so no loader hook is needed.
//
// Runner: npx tsx --test --test-force-exit tests/test_stationcard_complexity_refactor.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  deriveCardColors,
  deriveCardTag,
  deriveCardBoxShadow,
  deriveCardTransform,
  deriveSpineStyle,
  deriveScribbleColor,
  deriveScribbleBorderColor,
  deriveOutputLineColor,
  deriveFooterBorderColor,
  deriveCueBorderColor,
} from "../src/orbital/stationCardHelpers";
// Import the REAL theme INK so assertions track theme.INK (no silent drift if the palette changes).
import { INK } from "../src/orbital/theme";

// ─────────────────────────────────────────────────────────────────────────────
// 1. deriveCardColors
// ─────────────────────────────────────────────────────────────────────────────
describe("deriveCardColors", () => {
  it("light mode returns correct four tokens", () => {
    const c = deriveCardColors(false);
    assert.equal(c.cardBg, "#fff9ec");
    assert.equal(c.fg, INK);
    assert.equal(c.sub, "#8a6a4f");
    assert.equal(c.sunken, "#fff4de");
  });

  it("dark mode returns correct four tokens", () => {
    const c = deriveCardColors(true);
    assert.equal(c.cardBg, "#2f1d12");
    assert.equal(c.fg, "#ffe9c7");
    assert.equal(c.sub, "#c89f74");
    assert.equal(c.sunken, "#241409");
  });

  it("light and dark fg differ", () => {
    const light = deriveCardColors(false);
    const dark = deriveCardColors(true);
    assert.notEqual(light.fg, dark.fg);
  });

  it("light and dark cardBg differ", () => {
    const light = deriveCardColors(false);
    const dark = deriveCardColors(true);
    assert.notEqual(light.cardBg, dark.cardBg);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. deriveCardTag
// ─────────────────────────────────────────────────────────────────────────────
describe("deriveCardTag", () => {
  it("empty string → '—' fallback", () => {
    assert.equal(deriveCardTag(""), "—");
  });

  it("all-numeric string → '—' fallback (non-alpha stripped)", () => {
    assert.equal(deriveCardTag("1234"), "—");
  });

  it("short alpha string is uppercased and returned whole", () => {
    assert.equal(deriveCardTag("ab"), "AB");
  });

  it("long alpha string is truncated to 4 chars", () => {
    assert.equal(deriveCardTag("helloworld"), "HELL");
  });

  it("mixed alphanumeric strips non-alpha then uppercases first 4", () => {
    // "My Project 2" → strip non-alpha → "MyProject" → slice 4 → "MyPr" → uppercase → "MYPR"
    assert.equal(deriveCardTag("My Project 2"), "MYPR");
  });

  it("exactly 4 alpha chars → all returned uppercase", () => {
    assert.equal(deriveCardTag("abcd"), "ABCD");
  });

  it("spaces only → '—' fallback", () => {
    assert.equal(deriveCardTag("   "), "—");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. deriveCardBoxShadow
// ─────────────────────────────────────────────────────────────────────────────
describe("deriveCardBoxShadow", () => {
  it("not active, not hover, not needs → plain ink shadow, no prefix", () => {
    const s = deriveCardBoxShadow(false, false, false);
    assert.equal(s, "3px 3px 0 0 " + INK);
  });

  it("hover → large ink shadow, no prefix", () => {
    const s = deriveCardBoxShadow(false, true, false);
    assert.equal(s, "6px 6px 0 0 " + INK);
  });

  it("needs input (not hover) → orange shadow, no prefix", () => {
    const s = deriveCardBoxShadow(false, false, true);
    assert.equal(s, "3px 3px 0 0 #ff8a3d");
  });

  it("hover wins over needs (hover=true, needs=true) → hover shadow takes precedence", () => {
    const s = deriveCardBoxShadow(false, true, true);
    assert.equal(s, "6px 6px 0 0 " + INK);
  });

  it("active and not hover → prefix + plain ink shadow", () => {
    const s = deriveCardBoxShadow(true, false, false);
    assert.equal(s, "0 0 0 3px var(--butter), 3px 3px 0 0 " + INK);
  });

  it("active and hover → prefix + hover shadow", () => {
    const s = deriveCardBoxShadow(true, true, false);
    assert.equal(s, "0 0 0 3px var(--butter), 6px 6px 0 0 " + INK);
  });

  it("active and needs → prefix + orange shadow", () => {
    const s = deriveCardBoxShadow(true, false, true);
    assert.equal(s, "0 0 0 3px var(--butter), 3px 3px 0 0 #ff8a3d");
  });

  it("active, hover, and needs → prefix + hover shadow (hover wins)", () => {
    const s = deriveCardBoxShadow(true, true, true);
    assert.equal(s, "0 0 0 3px var(--butter), 6px 6px 0 0 " + INK);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. deriveCardTransform
// ─────────────────────────────────────────────────────────────────────────────
describe("deriveCardTransform", () => {
  it("no hover, tilt 0 → 'rotate(0deg)'", () => {
    assert.equal(deriveCardTransform(false, 0), "rotate(0deg)");
  });

  it("no hover, non-zero tilt → 'rotate(<tilt>deg)'", () => {
    assert.equal(deriveCardTransform(false, 1.5), "rotate(1.5deg)");
    assert.equal(deriveCardTransform(false, -0.7), "rotate(-0.7deg)");
  });

  it("hover → translation prefix + rotate(0deg) regardless of tilt", () => {
    assert.equal(deriveCardTransform(true, 1.5), "translate(-1px,-2px) rotate(0deg)");
    assert.equal(deriveCardTransform(true, 0), "translate(-1px,-2px) rotate(0deg)");
  });

  it("hover=false, tilt=1.2 → 'rotate(1.2deg)'", () => {
    assert.equal(deriveCardTransform(false, 1.2), "rotate(1.2deg)");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. deriveSpineStyle
// ─────────────────────────────────────────────────────────────────────────────
describe("deriveSpineStyle", () => {
  it("returns position:absolute, width:5, left/top/bottom:0", () => {
    const s = deriveSpineStyle("#e23a3a", false);
    assert.equal(s.position, "absolute");
    assert.equal(s.width, 5);
    assert.equal(s.left, 0);
    assert.equal(s.top, 0);
    assert.equal(s.bottom, 0);
  });

  it("backgroundColor matches the accentHex passed in", () => {
    const s = deriveSpineStyle("#4db892", false);
    assert.equal(s.backgroundColor, "#4db892");
  });

  it("not running → backgroundImage:'none', animation:'none'", () => {
    const s = deriveSpineStyle("#e23a3a", false);
    assert.equal(s.backgroundImage, "none");
    assert.equal(s.animation, "none");
  });

  it("running → backgroundImage is the barber-pole gradient", () => {
    const s = deriveSpineStyle("#e23a3a", true);
    assert.ok(s.backgroundImage.includes("repeating-linear-gradient"), "should include gradient");
    assert.ok(s.backgroundImage.includes("135deg"), "should include 135deg");
  });

  it("running → animation is the orb-spine keyframe string", () => {
    const s = deriveSpineStyle("#e23a3a", true);
    assert.equal(s.animation, "orb-spine .6s linear infinite");
  });

  it("backgroundSize is always '14px 14px'", () => {
    assert.equal(deriveSpineStyle("#e23a3a", false).backgroundSize, "14px 14px");
    assert.equal(deriveSpineStyle("#e23a3a", true).backgroundSize, "14px 14px");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. deriveScribbleColor
// ─────────────────────────────────────────────────────────────────────────────
describe("deriveScribbleColor", () => {
  it("needs input (any dark) → '#e23a3a' (needs wins)", () => {
    assert.equal(deriveScribbleColor(true, false), "#e23a3a");
    assert.equal(deriveScribbleColor(true, true), "#e23a3a");
  });

  it("no needs, dark mode → '#ffc94a'", () => {
    assert.equal(deriveScribbleColor(false, true), "#ffc94a");
  });

  it("no needs, light mode → '#a8151a'", () => {
    assert.equal(deriveScribbleColor(false, false), "#a8151a");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. deriveScribbleBorderColor
// ─────────────────────────────────────────────────────────────────────────────
describe("deriveScribbleBorderColor", () => {
  it("light mode → INK ('#2a1a10')", () => {
    assert.equal(deriveScribbleBorderColor(false), INK);
  });

  it("dark mode → '#5b3a23'", () => {
    assert.equal(deriveScribbleBorderColor(true), "#5b3a23");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. deriveOutputLineColor
// ─────────────────────────────────────────────────────────────────────────────
describe("deriveOutputLineColor", () => {
  it("line starting with '$' → '#ffc94a' (command prompt colour)", () => {
    assert.equal(deriveOutputLineColor("$ npm install"), "#ffc94a");
    assert.equal(deriveOutputLineColor("$"), "#ffc94a");
  });

  it("line starting with '✓' → '#9be3c0' (success colour)", () => {
    assert.equal(deriveOutputLineColor("✓ build passed"), "#9be3c0");
    assert.equal(deriveOutputLineColor("✓"), "#9be3c0");
  });

  it("line starting with '⚠' → '#ff8a3d' (warning colour)", () => {
    assert.equal(deriveOutputLineColor("⚠ disk low"), "#ff8a3d");
    assert.equal(deriveOutputLineColor("⚠"), "#ff8a3d");
  });

  it("plain text → '#e9d9c0' (default output colour)", () => {
    assert.equal(deriveOutputLineColor("some output"), "#e9d9c0");
    assert.equal(deriveOutputLineColor(""), "#e9d9c0");
    assert.equal(deriveOutputLineColor("ERROR: something"), "#e9d9c0");
  });

  it("'$' must be the FIRST char (not mid-line) to trigger command colour", () => {
    assert.equal(deriveOutputLineColor("echo $HOME"), "#e9d9c0");
  });

  it("'✓' must be the FIRST char to trigger success colour", () => {
    assert.equal(deriveOutputLineColor("result ✓"), "#e9d9c0");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. deriveFooterBorderColor
// ─────────────────────────────────────────────────────────────────────────────
describe("deriveFooterBorderColor", () => {
  it("light mode → '#c9a97a'", () => {
    assert.equal(deriveFooterBorderColor(false), "#c9a97a");
  });

  it("dark mode → '#5b3a23'", () => {
    assert.equal(deriveFooterBorderColor(true), "#5b3a23");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. deriveCueBorderColor
// ─────────────────────────────────────────────────────────────────────────────
describe("deriveCueBorderColor", () => {
  it("light mode → '#d9bf94'", () => {
    assert.equal(deriveCueBorderColor(false), "#d9bf94");
  });

  it("dark mode → '#5b3a23'", () => {
    assert.equal(deriveCueBorderColor(true), "#5b3a23");
  });
});
