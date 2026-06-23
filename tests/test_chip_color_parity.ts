// tests/test_chip_color_parity.ts
//
// bead m9v — single source of truth for chip/pill colors.
//
// Two surfaces show the SAME voice-channel state in different shells: the velocity-mech radio
// status Chip (getChipBg, KitchenRadio.tsx, boolean args) and the velocity-design conversational
// pill dot (OrbitalApp's nav, keyed on ConversationalKind). Before this change the pill carried a
// local placeholder color map (CONVO_DOT) that could silently diverge from getChipBg. This test
// pins the invariant: BOTH paths resolve through chipColorForKind, so the same state can never
// render two different colors.
//
// IMPORT STRATEGY: useConversationalState.ts pulls in nothing transitive (no primitives.tsx /
// icons.svg?raw) for its pure exports, but KitchenRadio.tsx → primitives.tsx → icons.svg?raw, so
// importing getChipBg needs the same SVG resolve hook test_kitchenradio_complexity_refactor.ts uses.
//
// Runner: npx tsx --test --test-force-exit tests/test_chip_color_parity.ts

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import {
  chipColorForKind,
  deriveConversationalState,
  type ConversationalSignals,
  type ConversationalKind,
} from "../src/orbital/useConversationalState";

// SVG stub BEFORE any dynamic import of KitchenRadio (transitively pulls primitives.tsx → icons.svg?raw).
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
let kr: KRModule;
before(async () => {
  kr = await import("../src/orbital/KitchenRadio.js") as KRModule;
});

// Build the signals object that resolves to exactly `kind` via the precedence ladder, so we can
// drive getChipBg (the radio chip) for the four states the chip can actually reach.
function signalsForKind(kind: ConversationalKind): ConversationalSignals {
  const base: ConversationalSignals = {
    live: true, connected: true, micBlocked: false, muted: false, reconnecting: false, toolActive: false,
  };
  switch (kind) {
    case "offline": return { ...base, live: false };
    case "blocked": return { ...base, micBlocked: true };
    case "tuning": return { ...base, connected: false };
    case "muted": return { ...base, muted: true };
    case "thinking": return { ...base, toolActive: true };
    case "listening": return base;
  }
}

test("chipColorForKind covers every ConversationalKind with a non-empty hex", () => {
  const kinds: ConversationalKind[] = ["offline", "tuning", "blocked", "muted", "thinking", "listening"];
  for (const k of kinds) {
    const c = chipColorForKind(k);
    assert.match(c, /^#[0-9a-fA-F]{6}$/, `color for ${k} must be a 6-digit hex, got ${c}`);
  }
});

// PARITY: for every state the radio Chip can reach, getChipBg (boolean ladder) and the pill dot
// (chipColorForKind by kind) MUST agree. "thinking" is design-only (the radio chip has no
// tool-activity input) so it is not in this set — but it is still covered by the helper above.
test("getChipBg (mech chip) and chipColorForKind (design pill) agree for every shared state", () => {
  const shared: ConversationalKind[] = ["offline", "tuning", "blocked", "muted", "listening"];
  for (const k of shared) {
    const s = signalsForKind(k);
    // sanity: this signals object really does resolve to k
    assert.equal(deriveConversationalState(s).kind, k);
    const mech = kr.getChipBg(s.live, s.micBlocked, s.connected, s.muted);
    const design = chipColorForKind(k);
    assert.equal(mech, design, `chip/pill color diverged for state "${k}": chip=${mech} pill=${design}`);
  }
});

// Regression-pin the canonical hexes so a future edit to the shared map can't silently repaint the UI.
test("canonical chip/pill colors are pinned", () => {
  assert.equal(chipColorForKind("offline"), "#8a6a4f");
  assert.equal(chipColorForKind("tuning"), "#8a6a4f");
  assert.equal(chipColorForKind("blocked"), "#e23a3a");
  assert.equal(chipColorForKind("muted"), "#8a6a4f");
  assert.equal(chipColorForKind("thinking"), "#4b3bb3");
  assert.equal(chipColorForKind("listening"), "#e23a3a");
});
