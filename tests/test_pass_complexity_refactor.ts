// tests/test_pass_complexity_refactor.ts
//
// Pins every branch of the two pure helpers extracted from Pass.tsx to bring
// the three flagged functions (ThePass CC 25, TicketCard CC 12, TemplateForm CC 11)
// to ≤10 each:
//
//   - pluralSuffix(n)           — "" for 1, "s" for all other counts
//   - resolveTemplateInitial()  — maps optional `initial` prop to concrete defaults
//
// The test suite must shim three things that are Vite-only (not resolvable by tsx):
//   - icons.svg?raw  (imported by src/orbital/primitives.tsx)
//   - react / react/jsx-runtime (not installed as test deps)
//
// We use Node 22 module.register() with an inline data-URL hook to intercept
// these imports BEFORE loading the Pass module. The hook runs in a separate Worker
// thread (Node ESM loader protocol); the data URL encodes the hook source so no
// extra file is needed.
//
// Runner: npx tsx --test --test-force-exit tests/test_pass_complexity_refactor.ts

import { register } from "node:module";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Inline ESM loader hook to stub Vite-only / React imports ──────────────
// The hook intercepts any specifier matching our stub list and returns a
// synthetic module so the tsx runner can load Pass.tsx without Vite.
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
    // node can leak a ?raw query onto this synthetic data: URL (-> export default ""?raw, invalid
    // JS) — decode only up to the first '?'; the stub sources never contain one.
    const head = 'data:text/javascript,';
    const q = url.indexOf('?', head.length);
    const payload = q === -1 ? url.slice(head.length) : url.slice(head.length, q);
    return { format: 'module', source: decodeURIComponent(payload), shortCircuit: true };
  }
  // tsx strips the ?raw query on TRANSITIVE imports (component -> primitives ->
  // icons.svg?raw), so a bare .svg reaches load and Node dies on the unknown
  // extension. The resolve guard above only catches the literal '?raw' specifier;
  // stub the queryless .svg here too so transitive graphs load without Vite.
  if (url.endsWith('.svg') || url.includes('.svg?')) {
    return { format: 'module', source: 'export default ""', shortCircuit: true };
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
  pluralSuffix,
  resolveTemplateInitial,
} = await import("../src/orbital/views/Pass.js");

// ─── pluralSuffix ─────────────────────────────────────────────────────────────
// Signature: (n: number) => "" | "s"
// Semantics:
//   1        → ""   (singular — no suffix)
//   0        → "s"  (zero plural)
//   2+       → "s"  (plural)
//   negative → "s"  (non-1 → plural)

describe("pluralSuffix", () => {
  it("returns empty string for exactly 1 (singular)", () => {
    assert.equal(pluralSuffix(1), "");
  });

  it("returns 's' for 0 (zero plural)", () => {
    assert.equal(pluralSuffix(0), "s");
  });

  it("returns 's' for 2", () => {
    assert.equal(pluralSuffix(2), "s");
  });

  it("returns 's' for 3", () => {
    assert.equal(pluralSuffix(3), "s");
  });

  it("returns 's' for large numbers", () => {
    assert.equal(pluralSuffix(100), "s");
  });

  it("returns 's' for -1 (non-1 value)", () => {
    assert.equal(pluralSuffix(-1), "s");
  });

  // Spot-check: the chips in ThePass use this for plans/templates/layouts
  it("1 spec chip → no trailing 's'", () => {
    assert.equal(`spec${pluralSuffix(1)}`, "spec");
  });

  it("2 specs chip → trailing 's'", () => {
    assert.equal(`spec${pluralSuffix(2)}`, "specs");
  });

  it("1 template chip → no trailing 's'", () => {
    assert.equal(`template${pluralSuffix(1)}`, "template");
  });

  it("3 templates chip → trailing 's'", () => {
    assert.equal(`template${pluralSuffix(3)}`, "templates");
  });

  it("1 layout chip → no trailing 's'", () => {
    assert.equal(`layout${pluralSuffix(1)}`, "layout");
  });

  it("0 layouts chip → trailing 's'", () => {
    assert.equal(`layout${pluralSuffix(0)}`, "layouts");
  });
});

// ─── resolveTemplateInitial ───────────────────────────────────────────────────
// Signature: (initial?: { name: string; description: string; body: string })
//              => { name: string; description: string; body: string }
// Semantics:
//   undefined → all fields default to ""
//   provided  → each field passes through verbatim

describe("resolveTemplateInitial", () => {
  it("returns empty strings for all fields when initial is undefined", () => {
    const result = resolveTemplateInitial(undefined);
    assert.deepEqual(result, { name: "", description: "", body: "" });
  });

  it("returns empty strings for all fields when called with no argument", () => {
    const result = resolveTemplateInitial();
    assert.deepEqual(result, { name: "", description: "", body: "" });
  });

  it("passes through name when provided", () => {
    const result = resolveTemplateInitial({ name: "Review PR", description: "", body: "" });
    assert.equal(result.name, "Review PR");
  });

  it("passes through description when provided", () => {
    const result = resolveTemplateInitial({ name: "", description: "for code reviews", body: "" });
    assert.equal(result.description, "for code reviews");
  });

  it("passes through body when provided", () => {
    const result = resolveTemplateInitial({ name: "", description: "", body: "Review {{branch}} for {{focus}}" });
    assert.equal(result.body, "Review {{branch}} for {{focus}}");
  });

  it("passes through all fields when all are provided", () => {
    const initial = { name: "Deploy check", description: "verify before shipping", body: "Check {{service}} on {{env}}" };
    const result = resolveTemplateInitial(initial);
    assert.deepEqual(result, initial);
  });

  it("handles empty string values (not undefined) — passes through unchanged", () => {
    const result = resolveTemplateInitial({ name: "", description: "", body: "" });
    assert.deepEqual(result, { name: "", description: "", body: "" });
  });

  it("handles whitespace-only strings (not empty) — passes through unchanged", () => {
    const result = resolveTemplateInitial({ name: "  ", description: " ", body: "\t" });
    assert.deepEqual(result, { name: "  ", description: " ", body: "\t" });
  });

  it("handles slot-containing body — passes through verbatim", () => {
    const body = "Review the {{branch}} branch focusing on {{focus}} and {{quality}}";
    const result = resolveTemplateInitial({ name: "n", description: "d", body });
    assert.equal(result.body, body);
  });
});
