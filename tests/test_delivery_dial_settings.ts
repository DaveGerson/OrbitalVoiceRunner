// tests/test_delivery_dial_settings.ts — fikj.12 RED: the SettingsDialog dial helpers.
// Runner: npx tsx --test --test-force-exit tests/test_delivery_dial_settings.ts
import { test } from "node:test";
import assert from "node:assert";
import * as helpersModule from "../src/components/settingsDialogHelpers";

type AnyRec = Record<string, any>;
const helpers = helpersModule as AnyRec;

test("dialModeOptions enforces the floor structurally: classes 0/2 never offer passive-context", () => {
  assert.strictEqual(typeof helpers.dialModeOptions, "function", "fikj.12 feature absent: dialModeOptions");
  assert.deepStrictEqual(helpers.dialModeOptions("0"), ["forced-turn", "steered-digest"]);
  assert.deepStrictEqual(helpers.dialModeOptions("2"), ["forced-turn", "steered-digest"]);
  assert.deepStrictEqual(helpers.dialModeOptions("3"), ["forced-turn", "steered-digest", "passive-context"]);
  assert.deepStrictEqual(helpers.dialModeOptions("5"), ["forced-turn", "steered-digest", "passive-context"]);
});

test("deriveDialFields: null settings -> spec defaults; persisted under-floor values CLAMP for display", () => {
  assert.strictEqual(typeof helpers.deriveDialFields, "function", "fikj.12 feature absent: deriveDialFields");
  const defaults = helpers.deriveDialFields(null);
  assert.deepStrictEqual(defaults.deliveryMatrix, {
    "0": "forced-turn", "2": "forced-turn", "3": "steered-digest", "4": "steered-digest", "5": "passive-context",
  });
  assert.strictEqual(defaults.completionAnnounce, "dispatched");
  const clamped = helpers.deriveDialFields({ voiceAi: { deliveryMatrix: { "0": "passive-context" }, completionAnnounce: "focused" } } as AnyRec);
  assert.strictEqual(clamped.deliveryMatrix["0"], "steered-digest", "the dialog never DISPLAYS an under-floor value");
  assert.strictEqual(clamped.completionAnnounce, "dispatched", "retired tier normalizes to the default");
});

test("deriveVoiceFields carries the dial fields (so applyInitialSettings + compile-in round-trip them)", () => {
  const v = helpers.deriveVoiceFields({ voiceAi: { deliveryMatrix: { "3": "forced-turn" }, completionAnnounce: "all" } } as AnyRec);
  assert.strictEqual(v.deliveryMatrix["3"], "forced-turn");
  assert.strictEqual(v.completionAnnounce, "all");
});

test("jsonVoicePatch round-trips the dial fields from the JSON tab", () => {
  const patch = helpers.jsonVoicePatch({ voiceAi: { deliveryMatrix: { "0": "passive-context" }, completionAnnounce: "off" } });
  assert.strictEqual(patch.deliveryMatrix["0"], "steered-digest", "JSON-tab input clamps too");
  assert.strictEqual(patch.completionAnnounce, "off");
  assert.deepStrictEqual(helpers.jsonVoicePatch({ voiceAi: { voice: "Zephyr" } }).deliveryMatrix, undefined,
    "absent in JSON -> absent in the patch (never overwrites form state)");
});
