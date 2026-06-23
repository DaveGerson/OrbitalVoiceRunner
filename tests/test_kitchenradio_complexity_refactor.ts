// tests/test_kitchenradio_complexity_refactor.ts
// Pins every branch of the pure helpers extracted from KitchenRadio.tsx
// during the cyclomatic-complexity burndown (CC 33→7 for KitchenRadio,
// CC 13→9 for Bubble).
//
// IMPORT STRATEGY: KitchenRadio.tsx → primitives.tsx → icons.svg?raw, plus react.
// The shared stub loader (helpers/viteStubLoader.ts) intercepts those Vite-only /
// React imports before the dynamic import below, so the module graph loads under
// the tsx/Node runner without Vite.
//
// Runner: npx tsx --test --test-force-exit tests/test_kitchenradio_complexity_refactor.ts

import { test, before } from "node:test";
import assert from "node:assert/strict";

import { registerViteStubs } from "./helpers/viteStubLoader.js";

// Register the shared Vite/React stub loader BEFORE importing the KitchenRadio
// graph (which transitively pulls in primitives.tsx → icons.svg?raw).
registerViteStubs();

// Resolved lazily so the hook above is active when the module is first loaded.
type KRModule = typeof import("../src/orbital/KitchenRadio.js");
let mod: KRModule;

before(async () => {
  mod = await import("../src/orbital/KitchenRadio.js") as KRModule;
});

// ── getChipBg ─────────────────────────────────────────────────────────────

test("getChipBg: off-air (not live) → muted amber", () => {
  assert.equal(mod.getChipBg(false, false, false, false), "#8a6a4f");
  assert.equal(mod.getChipBg(false, true, true, false), "#8a6a4f"); // not live wins
});

test("getChipBg: live + mic blocked → red", () => {
  assert.equal(mod.getChipBg(true, true, true, false), "#e23a3a");
});

test("getChipBg: live + mic ok + not connected → muted amber (tuning)", () => {
  assert.equal(mod.getChipBg(true, false, false, false), "#8a6a4f");
});

test("getChipBg: live + mic ok + connected + muted → muted amber", () => {
  assert.equal(mod.getChipBg(true, false, true, true), "#8a6a4f");
});

test("getChipBg: fully live (live + connected + unmuted + unblocked) → red", () => {
  assert.equal(mod.getChipBg(true, false, true, false), "#e23a3a");
});

// ── getChipLabel ─────────────────────────────────────────────────────────

test("getChipLabel: not live + not reconnecting → OFF AIR", () => {
  assert.equal(mod.getChipLabel(false, false, false, false, false), "OFF AIR");
});

test("getChipLabel: not live + reconnecting → ellipsis", () => {
  assert.equal(mod.getChipLabel(false, false, false, false, true), "…");
});

test("getChipLabel: live + mic blocked → MIC BLOCKED", () => {
  assert.equal(mod.getChipLabel(true, true, true, false, false), "MIC BLOCKED");
});

test("getChipLabel: live + not connected → TUNING IN…", () => {
  assert.equal(mod.getChipLabel(true, false, false, false, false), "TUNING IN…");
});

test("getChipLabel: live + connected + muted → MUTED", () => {
  assert.equal(mod.getChipLabel(true, false, true, true, false), "MUTED");
});

test("getChipLabel: fully live → ● LIVE", () => {
  assert.equal(mod.getChipLabel(true, false, true, false, false), "● LIVE");
});

// ── getMicBtnBg ───────────────────────────────────────────────────────────

test("getMicBtnBg: mic blocked → orange", () => {
  assert.equal(mod.getMicBtnBg(true, false), "#ff8a3d");
});

test("getMicBtnBg: muted (unblocked) → near-white", () => {
  assert.equal(mod.getMicBtnBg(false, true), "#fff9ec");
});

test("getMicBtnBg: active listening → green", () => {
  assert.equal(mod.getMicBtnBg(false, false), "#4db892");
});

// ── getMicBtnLabel ────────────────────────────────────────────────────────

test("getMicBtnLabel: mic blocked → permission error text", () => {
  assert.equal(mod.getMicBtnLabel(true, false), "Mic's blocked — check browser permissions");
});

test("getMicBtnLabel: muted (unblocked) → tap to talk text", () => {
  assert.equal(mod.getMicBtnLabel(false, true), "Mic off — tap to talk");
});

test("getMicBtnLabel: listening → chef text", () => {
  assert.equal(mod.getMicBtnLabel(false, false), "I'm listening, Chef");
});

// ── getMicBtnIconName ─────────────────────────────────────────────────────

test("getMicBtnIconName: muted → x", () => {
  assert.equal(mod.getMicBtnIconName(false, true), "x");
});

test("getMicBtnIconName: blocked → x", () => {
  assert.equal(mod.getMicBtnIconName(true, false), "x");
});

test("getMicBtnIconName: blocked AND muted → x", () => {
  assert.equal(mod.getMicBtnIconName(true, true), "x");
});

test("getMicBtnIconName: active → spark", () => {
  assert.equal(mod.getMicBtnIconName(false, false), "spark");
});

// ── getPanelBg ────────────────────────────────────────────────────────────

test("getPanelBg: dark → dark bg", () => {
  assert.equal(mod.getPanelBg(true), "#241409");
});

test("getPanelBg: light → cream bg", () => {
  assert.equal(mod.getPanelBg(false), "#fff4de");
});

// ── getWaveformSectionBg ──────────────────────────────────────────────────

test("getWaveformSectionBg: dark → dark bg", () => {
  assert.equal(mod.getWaveformSectionBg(true), "#2f1d12");
});

test("getWaveformSectionBg: light → light bg", () => {
  assert.equal(mod.getWaveformSectionBg(false), "#fff9ec");
});

// ── getWaveformColor ──────────────────────────────────────────────────────

test("getWaveformColor: dark → amber", () => {
  assert.equal(mod.getWaveformColor(true), "#ffc94a");
});

test("getWaveformColor: light → red", () => {
  assert.equal(mod.getWaveformColor(false), "#e23a3a");
});

// ── getMicControlBg ───────────────────────────────────────────────────────

test("getMicControlBg: dark → dark bg", () => {
  assert.equal(mod.getMicControlBg(true), "#2f1d12");
});

test("getMicControlBg: light → light bg", () => {
  assert.equal(mod.getMicControlBg(false), "#fff9ec");
});

// ── getBubbleBg ───────────────────────────────────────────────────────────

test("getBubbleBg: me (sender=User) → amber regardless of dark", () => {
  assert.equal(mod.getBubbleBg(true, false), "#ffc94a");
  assert.equal(mod.getBubbleBg(true, true), "#ffc94a");
});

test("getBubbleBg: not me, dark → dark brown", () => {
  assert.equal(mod.getBubbleBg(false, true), "#3a2415");
});

test("getBubbleBg: not me, light → cream", () => {
  assert.equal(mod.getBubbleBg(false, false), "#fff9ec");
});

// ── getBubbleColor ────────────────────────────────────────────────────────

test("getBubbleColor: me (sender=User) → INK regardless of dark", () => {
  // INK is the module constant; we just verify consistency between calls
  assert.equal(mod.getBubbleColor(true, false), mod.getBubbleColor(true, true));
});

test("getBubbleColor: not me, dark → light cream text", () => {
  assert.equal(mod.getBubbleColor(false, true), "#ffe9c7");
});

test("getBubbleColor: not me, light → INK", () => {
  // light-mode Janus text is INK (same as me), so they must match
  assert.equal(mod.getBubbleColor(false, false), mod.getBubbleColor(true, false));
});
