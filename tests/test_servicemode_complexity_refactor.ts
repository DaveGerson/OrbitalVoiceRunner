// tests/test_servicemode_complexity_refactor.ts
//
// Pins every branch of the five pure helpers extracted from ServiceMode.tsx to
// bring the map-callback CC from 13 → ≤10.
//
// The test suite must shim three things that are Vite-only (not resolvable by tsx):
//   - icons.svg?raw  (imported by src/orbital/primitives.tsx)
//   - react / react/jsx-runtime (not installed as test deps)
//   - type-only runtime shapes
//
// We use Node 22 module.register() with an inline data-URL hook to intercept
// these imports BEFORE loading the ServiceMode module. The hook runs in a
// separate Worker thread (Node ESM loader protocol); the data URL encodes the
// hook source so no extra file is needed.
//
// Runner: npx tsx --test --test-force-exit tests/test_servicemode_complexity_refactor.ts

import { register } from "node:module";
import { test } from "node:test";
import assert from "node:assert";

// ── Inline ESM loader hook to stub Vite-only / React imports ──────────────
// The hook intercepts any specifier matching our stub list and returns a
// synthetic module so the tsx runner can load ServiceMode.tsx without Vite.
const hookSource = /* js */`
export async function resolve(specifier, context, nextResolve) {
  // Vite ?raw suffix
  if (specifier.endsWith('?raw')) {
    return { url: 'data:text/javascript,export default ""', shortCircuit: true };
  }
  // React and react/jsx-runtime stubs (pure-value helpers don't call them)
  if (specifier === 'react') {
    return { url: 'data:text/javascript,export default {};export function useState(){}export function useRef(){}export function useEffect(){}', shortCircuit: true };
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
  getButtonTitle,
  getButtonBorder,
  getButtonBackground,
  getButtonColor,
  getConfirmingAttr,
} = await import("../src/orbital/ServiceMode.js");

// ── getButtonTitle ────────────────────────────────────────────────────────

test("getButtonTitle: confirming=false returns the mode label", () => {
  assert.strictEqual(
    getButtonTitle(false, "Full Auto"),
    "Full Auto",
  );
});

test("getButtonTitle: confirming=false returns any label unchanged", () => {
  assert.strictEqual(
    getButtonTitle(false, "Human-in-the-Loop"),
    "Human-in-the-Loop",
  );
});

test("getButtonTitle: confirming=true returns the warn tooltip regardless of label", () => {
  assert.strictEqual(
    getButtonTitle(true, "anything"),
    "Full Auto lets every station fire without asking — tap again to confirm",
  );
});

// ── getButtonBorder ───────────────────────────────────────────────────────

test("getButtonBorder: confirming=false → 'none'", () => {
  assert.strictEqual(getButtonBorder(false), "none");
});

test("getButtonBorder: confirming=true → dashed border string", () => {
  assert.strictEqual(getButtonBorder(true), "2px dashed #fff4de");
});

// ── getButtonBackground ───────────────────────────────────────────────────

test("getButtonBackground: on=true uses the mode color regardless of confirming", () => {
  assert.strictEqual(getButtonBackground(true, false, "#e23a3a"), "#e23a3a");
  assert.strictEqual(getButtonBackground(true, true, "#e23a3a"), "#e23a3a");
});

test("getButtonBackground: on=false, confirming=true uses the danger red", () => {
  assert.strictEqual(getButtonBackground(false, true, "#e23a3a"), "#a8151a");
});

test("getButtonBackground: on=false, confirming=false uses transparent", () => {
  assert.strictEqual(getButtonBackground(false, false, "#e23a3a"), "transparent");
});

// ── getButtonColor ────────────────────────────────────────────────────────

test("getButtonColor: on=false always returns the inactive tint", () => {
  assert.strictEqual(getButtonColor(false, "auto"), "#ffe9c7");
  assert.strictEqual(getButtonColor(false, "hitl"), "#ffe9c7");
  assert.strictEqual(getButtonColor(false, "read"), "#ffe9c7");
});

test("getButtonColor: on=true with id='read' returns light cream", () => {
  assert.strictEqual(getButtonColor(true, "read"), "#fff4de");
});

test("getButtonColor: on=true with id='auto' returns INK", () => {
  assert.strictEqual(getButtonColor(true, "auto"), "#2a1a10");
});

test("getButtonColor: on=true with id='hitl' returns INK", () => {
  assert.strictEqual(getButtonColor(true, "hitl"), "#2a1a10");
});

// ── getConfirmingAttr ─────────────────────────────────────────────────────

test("getConfirmingAttr: confirming=false returns undefined (omits attribute)", () => {
  assert.strictEqual(getConfirmingAttr(false), undefined);
});

test("getConfirmingAttr: confirming=true returns true (sets attribute)", () => {
  assert.strictEqual(getConfirmingAttr(true), true);
});
