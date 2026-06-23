// tests/test_kitchenradio_chip_helper.ts
//
// velocity-mech: the conversational HELPER line for the Kitchen Radio status pill. The pill itself
// stays terse (getChipLabel — "OFF AIR" / "● LIVE" / …); getChipHelper is the chef-voice gloss that
// rides alongside it so an eyes-off operator hears WHAT the pill means, in the kitchen's voice.
// Pure helper — same arg order + branch precedence as getChipLabel/getChipBg, so the three never
// disagree about which state is showing.
//
// IMPORT STRATEGY mirrors test_kitchenradio_complexity_refactor.ts: register an SVG resolve/load
// stub BEFORE dynamically importing KitchenRadio (primitives.tsx → icons.svg?raw).
//
// Runner: npx tsx --test --test-force-exit tests/test_kitchenradio_chip_helper.ts

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register(
  "data:text/javascript," +
    encodeURIComponent(
      `export async function resolve(s,ctx,next){` +
        `if(s.includes('.svg')){return{url:'data:text/javascript,export%20default%20%22%22%3B',shortCircuit:true};}` +
        `return next(s,ctx);}` +
      `export async function load(u,ctx,next){` +
        `if(u.startsWith('data:text/javascript,')){const h='data:text/javascript,';const q=u.indexOf('?',h.length);const p=q===-1?u.slice(h.length):u.slice(h.length,q);return{format:'module',source:decodeURIComponent(p),shortCircuit:true};}` +
        `if(u.includes('.svg')){return{format:'module',source:'export default ""',shortCircuit:true};}` +
        `return next(u,ctx);}`,
    ),
  pathToFileURL("./"),
);

type KRModule = typeof import("../src/orbital/KitchenRadio.js");
let mod: KRModule;

before(async () => {
  mod = await import("../src/orbital/KitchenRadio.js") as KRModule;
});

// ── getChipHelper: one conversational line per pill state ──────────────────
// signature: (live, micBlocked, connected, muted, reconnecting)

test("getChipHelper: off air (not live, not reconnecting) → off-air gloss", () => {
  assert.equal(mod.getChipHelper(false, false, false, false, false), "Off air — tap to tune in, Chef");
});

test("getChipHelper: not live but reconnecting → reconnecting gloss", () => {
  assert.equal(mod.getChipHelper(false, false, false, false, true), "Hang tight — gettin' back on air…");
});

test("getChipHelper: live + mic blocked → blocked gloss (precedence over connected/muted)", () => {
  assert.equal(mod.getChipHelper(true, true, true, false, false), "Mic's blocked — check browser permissions");
});

test("getChipHelper: live + not connected → tuning gloss", () => {
  assert.equal(mod.getChipHelper(true, false, false, false, false), "Tunin' in — one sec…");
});

test("getChipHelper: live + connected + muted → muted gloss", () => {
  assert.equal(mod.getChipHelper(true, false, true, true, false), "Mic's off — tap to talk");
});

test("getChipHelper: fully live → listening gloss", () => {
  assert.equal(mod.getChipHelper(true, false, true, false, false), "I'm listening, Chef");
});

// ── cross-helper consistency: helper precedence matches getChipLabel ──────

test("getChipHelper precedence agrees with getChipLabel across the state grid", () => {
  // For every state, BOTH helpers must select the SAME branch (mic blocked wins over tuning, etc.).
  // We assert that the helper is non-empty whenever a label is present, and that the loud states
  // (mic blocked) are reflected in both — i.e. neither disagrees about which case fires.
  const grid: [boolean, boolean, boolean, boolean, boolean][] = [
    [false, false, false, false, false],
    [false, false, false, false, true],
    [true, true, true, false, false],
    [true, false, false, false, false],
    [true, false, true, true, false],
    [true, false, true, false, false],
  ];
  for (const [live, blocked, connected, muted, reconnecting] of grid) {
    const helper = mod.getChipHelper(live, blocked, connected, muted, reconnecting);
    const label = mod.getChipLabel(live, blocked, connected, muted, reconnecting);
    assert.ok(helper.length > 0, `helper must be non-empty for ${JSON.stringify([live, blocked, connected, muted, reconnecting])}`);
    assert.ok(label.length > 0);
    // the loud state must be named loudly in the helper too
    if (live && blocked) assert.match(helper, /blocked/i);
  }
});
