// tests/helpers/viteStubLoader.ts — the ONE shared ESM stub loader for the
// orbital complexity-refactor characterization tests (bead wsm-e2e-pinned-cdo).
//
// WHY THIS EXISTS
// Those tests import .tsx component graphs to pin pure helpers. Under the tsx/Node
// test runner (no Vite) two kinds of imports can't resolve:
//   - `./assets/icons.svg?raw` (Vite ?raw text import, used by primitives.tsx)
//   - `react` / `react/jsx-runtime`
// Each test used to carry its own inline copy of the register() hook below. The
// copies DRIFTED — only some had the .svg/?raw fix — and the bug hid in the one
// that lagged. This file is the single source of truth; `test_complexity_loader_shared.ts`
// guards that no test re-inlines it.
//
// HOW IT WORKS
// `module.register()` installs a loader hook (running in a separate Worker thread)
// that intercepts the un-resolvable specifiers and returns synthetic modules:
//   - resolve(): map ?raw / .svg → empty-default module; map react → a hermetic
//     stub rich enough to satisfy module-EVAL usage (memo/forwardRef/createContext
//     at module scope) without rendering anything.
//   - load(): (a) when Node leaks a `?raw` query onto our synthetic data: URL
//     (-> `export default ""?raw`, invalid JS) decode only up to the first '?';
//     (b) stub a bare `.svg` that reaches load directly after tsx strips ?raw on a
//     TRANSITIVE import hop (component -> primitives -> icons.svg?raw).
//
// The react stub is deliberately a SUPERSET of every prior inline copy: the pure
// helpers under test never call React, but switching kitchenradio off real-react
// means the stub must cover any symbol a component references at module scope.
//
// USAGE
//   import { registerViteStubs } from "./helpers/viteStubLoader.js";
//   registerViteStubs();                              // BEFORE the dynamic import
//   const { foo } = await import("../src/orbital/Bar.js");

import { register } from "node:module";

// Empty-default module (for ?raw / .svg). Percent-encoded so the data: URL is
// well-formed; the load() hook decodes it back.
const EMPTY_MOD = `data:text/javascript,${encodeURIComponent('export default ""')}`;

// Hermetic React stub. Hooks exist as exports (so `import { useState }` resolves);
// memo/forwardRef/createContext are callable (so module-scope component
// definitions don't throw). Nothing here is ever rendered by these tests.
const REACT_STUB_SRC = [
  'const noop = () => {};',
  'export const useState = (v) => [typeof v === "function" ? v() : v, noop];',
  'export const useReducer = (_r, v) => [v, noop];',
  'export const useRef = (v) => ({ current: v });',
  'export const useMemo = (f) => f();',
  'export const useCallback = (f) => f;',
  'export const useContext = () => ({});',
  'export const useEffect = noop;',
  'export const useLayoutEffect = noop;',
  'export const useId = () => "id";',
  'export const memo = (c) => c;',
  'export const forwardRef = (c) => c;',
  'export const createContext = (v) => ({ Provider: noop, Consumer: noop, _currentValue: v });',
  'export const createElement = noop;',
  'export const cloneElement = noop;',
  'export const isValidElement = () => false;',
  'export const Children = { map: noop, forEach: noop, count: () => 0, toArray: () => [], only: (x) => x };',
  'export const Fragment = Symbol("Fragment");',
  'export const StrictMode = Symbol("StrictMode");',
  'export const Suspense = Symbol("Suspense");',
  'const React = { useState, useReducer, useRef, useMemo, useCallback, useContext, useEffect, useLayoutEffect, useId, memo, forwardRef, createContext, createElement, cloneElement, isValidElement, Children, Fragment, StrictMode, Suspense };',
  'export default React;',
].join('\n');
const REACT_MOD = `data:text/javascript,${encodeURIComponent(REACT_STUB_SRC)}`;

const JSX_MOD = `data:text/javascript,${encodeURIComponent(
  'export function jsx(){}export function jsxs(){}export const Fragment=Symbol("Fragment");export default {}',
)}`;

// The hook source runs in the loader Worker thread. The three synthetic module
// URLs are embedded as JS string literals via JSON.stringify (escape-safe).
const hookSource = `
export async function resolve(specifier, context, nextResolve) {
  // Vite text imports + bare/queried .svg (icons.svg?raw used by primitives.tsx).
  if (specifier.endsWith('?raw') || specifier.endsWith('.svg') || specifier.includes('.svg?')) {
    return { url: ${JSON.stringify(EMPTY_MOD)}, shortCircuit: true };
  }
  if (specifier === 'react') {
    return { url: ${JSON.stringify(REACT_MOD)}, shortCircuit: true };
  }
  if (specifier === 'react/jsx-runtime') {
    return { url: ${JSON.stringify(JSX_MOD)}, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
  if (url.startsWith('data:text/javascript,')) {
    // Node can leak a ?raw query onto our synthetic data: URL (-> ...""?raw,
    // invalid JS). Decode only up to the first literal '?'; our encoded payloads
    // never contain one (encodeURIComponent maps '?' -> %3F).
    const head = 'data:text/javascript,';
    const q = url.indexOf('?', head.length);
    const payload = q === -1 ? url.slice(head.length) : url.slice(head.length, q);
    return { format: 'module', source: decodeURIComponent(payload), shortCircuit: true };
  }
  // tsx strips ?raw on TRANSITIVE hops, so a bare .svg can reach load directly.
  if (url.endsWith('.svg') || url.includes('.svg?')) {
    return { format: 'module', source: 'export default ""', shortCircuit: true };
  }
  return nextLoad(url, context);
}
`;

let registered = false;

/**
 * Install the Vite/React stub ESM loader for the current test process.
 * Idempotent. Call it BEFORE dynamically importing the .tsx-backed module so the
 * hook is active when the module graph loads.
 */
export function registerViteStubs(): void {
  if (registered) return;
  registered = true;
  register(`data:text/javascript,${encodeURIComponent(hookSource)}`, {
    parentURL: import.meta.url,
  });
}
