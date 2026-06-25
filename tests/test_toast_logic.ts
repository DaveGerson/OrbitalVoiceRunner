// tests/test_toast_logic.ts — CHARACTERIZATION tests for the pure tone→presentation derivation
// extracted out of src/App.tsx's ToastNotificationStack IIFE (App.tsx decomposition, chunk-1
// "warmup leaves"). Pins BOTH branches of the raw-control-key toast's `tone === "deferred"`
// selection verbatim: ONLY "deferred" → amber/⏳; every other tone ("blocked", "refused") → red/⛔.
//
// Runner: npx tsx --test --test-force-exit tests/test_toast_logic.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  rawKeyToneContainerClass,
  rawKeyToneTitleClass,
  rawKeyToneGlyph,
} from "../src/classic/helpers/toastLogic";

describe("toastLogic — rawKey tone derivation", () => {
  it("deferred → amber container classes", () => {
    assert.strictEqual(
      rawKeyToneContainerClass("deferred"),
      "border-amber-500/30 text-amber-400",
    );
  });

  it("blocked / refused → red container classes", () => {
    assert.strictEqual(
      rawKeyToneContainerClass("blocked"),
      "border-red-500/30 text-red-400",
    );
    assert.strictEqual(
      rawKeyToneContainerClass("refused"),
      "border-red-500/30 text-red-400",
    );
  });

  it("deferred → amber title class; others → red", () => {
    assert.strictEqual(rawKeyToneTitleClass("deferred"), "text-amber-500");
    assert.strictEqual(rawKeyToneTitleClass("blocked"), "text-red-500");
    assert.strictEqual(rawKeyToneTitleClass("refused"), "text-red-500");
  });

  it("deferred → hourglass glyph (with trailing space); others → no-entry glyph", () => {
    assert.strictEqual(rawKeyToneGlyph("deferred"), "⏳ ");
    assert.strictEqual(rawKeyToneGlyph("blocked"), "⛔ ");
    assert.strictEqual(rawKeyToneGlyph("refused"), "⛔ ");
  });
});
