// tests/test_pantry_complexity_refactor.ts — CHARACTERIZATION tests for the cyclomatic-
// complexity burndown refactor of src/orbital/views/Pantry.tsx.
//
// Pins every branch of the four pure helpers extracted from Pantry.tsx:
//   - extractPaneIdFromArgs  (from paneOf, CC 12 → ≤10)
//   - paneOf                 (now thin wrapper, tested end-to-end via helper)
//   - kindSkinFor            (from ServiceLogLine, CC 14 → ≤10)
//   - resolveLogLabel        (from ServiceLogLine)
//   - resolvePid             (from ThePantry, CC 17 → ≤10)
//
// The suite must shim three things that are Vite-only (not resolvable by tsx):
//   - icons.svg?raw  (imported by src/orbital/primitives.tsx)
//   - react / react/jsx-runtime (not installed as test deps)
//
// We use Node 22 module.register() with an inline data-URL hook to intercept
// these imports BEFORE loading Pantry.tsx. The hook runs in a separate Worker
// thread (Node ESM loader protocol); the data URL encodes the hook source so no
// extra file is needed.
//
// Runner: npx tsx --test --test-force-exit tests/test_pantry_complexity_refactor.ts

import { register } from "node:module";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Inline ESM loader hook to stub Vite-only / React imports ──────────────
const hookSource = /* js */`
export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('?raw') || specifier.endsWith('.svg')) {
    return { url: 'data:text/javascript,export default ""', shortCircuit: true };
  }
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

// ── Import pure helpers (after hook registration) ──────────────────────────
// Dynamic import so the loader hook is active before the module graph loads.
const {
  extractPaneIdFromArgs,
  paneOf,
  kindSkinFor,
  resolveLogLabel,
  resolvePid,
} = await import("../src/orbital/views/Pantry.js");

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeRow(overrides: Record<string, unknown> = {}): any {
  return {
    id: 1,
    ts: 1_700_000_000_000,
    name: null,
    capability: null,
    result_kind: null,
    ms: null,
    args_redacted: null,
    surface: null,
    ...overrides,
  };
}

function makeProject(id: string): any {
  return { id, name: id, emoji: "🍕", color: "#ff0000", cwd: "/tmp/" + id };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. extractPaneIdFromArgs — every branch of the field-probe + type check
// ─────────────────────────────────────────────────────────────────────────────
describe("extractPaneIdFromArgs", () => {
  it("returns null for null input", () => {
    assert.strictEqual(extractPaneIdFromArgs(null), null);
  });

  it("returns null for non-object primitives (string)", () => {
    assert.strictEqual(extractPaneIdFromArgs("string"), null);
  });

  it("returns null for non-object primitives (number)", () => {
    assert.strictEqual(extractPaneIdFromArgs(42), null);
  });

  it("returns null for undefined", () => {
    assert.strictEqual(extractPaneIdFromArgs(undefined), null);
  });

  it("returns null when none of the 4 keys are present", () => {
    assert.strictEqual(extractPaneIdFromArgs({}), null);
  });

  it("returns null when only unrelated keys are present", () => {
    assert.strictEqual(extractPaneIdFromArgs({ unrelated: "val" }), null);
  });

  it("returns pane_id when present and non-empty string", () => {
    assert.strictEqual(extractPaneIdFromArgs({ pane_id: "abc" }), "abc");
  });

  it("returns paneId when pane_id absent", () => {
    assert.strictEqual(extractPaneIdFromArgs({ paneId: "pid1" }), "pid1");
  });

  it("returns terminalId when pane_id and paneId absent", () => {
    assert.strictEqual(extractPaneIdFromArgs({ terminalId: "tid" }), "tid");
  });

  it("returns terminal_id when the first three are absent", () => {
    assert.strictEqual(extractPaneIdFromArgs({ terminal_id: "t_id" }), "t_id");
  });

  it("pane_id takes precedence over paneId (left-to-right ?? chain)", () => {
    assert.strictEqual(extractPaneIdFromArgs({ pane_id: "first", paneId: "second" }), "first");
  });

  it("returns null when value is an empty string (falsy gate)", () => {
    assert.strictEqual(extractPaneIdFromArgs({ pane_id: "" }), null);
  });

  it("returns null when paneId is empty string", () => {
    assert.strictEqual(extractPaneIdFromArgs({ paneId: "" }), null);
  });

  it("returns null when value is a number (not string)", () => {
    assert.strictEqual(extractPaneIdFromArgs({ pane_id: 42 }), null);
  });

  it("returns null when value is boolean true (not string)", () => {
    assert.strictEqual(extractPaneIdFromArgs({ pane_id: true }), null);
  });

  it("returns null when value is null", () => {
    assert.strictEqual(extractPaneIdFromArgs({ pane_id: null }), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. paneOf — end-to-end: wraps extractPaneIdFromArgs with JSON.parse + null guard
// ─────────────────────────────────────────────────────────────────────────────
describe("paneOf", () => {
  it("returns null when args_redacted is null", () => {
    assert.strictEqual(paneOf(makeRow({ args_redacted: null })), null);
  });

  it("returns null when args_redacted is empty string (falsy early-return)", () => {
    assert.strictEqual(paneOf(makeRow({ args_redacted: "" })), null);
  });

  it("returns null on invalid JSON (swallows error)", () => {
    assert.strictEqual(paneOf(makeRow({ args_redacted: "{not json" })), null);
  });

  it("returns null when parsed JSON has no pane field", () => {
    assert.strictEqual(paneOf(makeRow({ args_redacted: '{"foo":"bar"}' })), null);
  });

  it("extracts pane_id from valid JSON", () => {
    assert.strictEqual(paneOf(makeRow({ args_redacted: '{"pane_id":"pane-1"}' })), "pane-1");
  });

  it("extracts paneId from valid JSON", () => {
    assert.strictEqual(paneOf(makeRow({ args_redacted: '{"paneId":"p2"}' })), "p2");
  });

  it("extracts terminalId from valid JSON", () => {
    assert.strictEqual(paneOf(makeRow({ args_redacted: '{"terminalId":"t3"}' })), "t3");
  });

  it("extracts terminal_id from valid JSON", () => {
    assert.strictEqual(paneOf(makeRow({ args_redacted: '{"terminal_id":"t4"}' })), "t4");
  });

  it("returns null when JSON value is empty string", () => {
    assert.strictEqual(paneOf(makeRow({ args_redacted: '{"pane_id":""}' })), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. kindSkinFor — all 4 branches of the if-chain
// ─────────────────────────────────────────────────────────────────────────────
describe("kindSkinFor", () => {
  it("error branch: dark-red bg, cream fg", () => {
    const skin = kindSkinFor("error");
    assert.strictEqual(skin.bg, "#e23a3a");
    assert.strictEqual(skin.fg, "#fff4de");
  });

  it("blocked branch: orange bg", () => {
    const skin = kindSkinFor("blocked");
    assert.strictEqual(skin.bg, "#ff8a3d");
    assert.strictEqual(typeof skin.fg, "string");
  });

  it("pending branch: yellow bg", () => {
    const skin = kindSkinFor("pending");
    assert.strictEqual(skin.bg, "#ffc94a");
  });

  it("ok branch: mint green bg", () => {
    const skin = kindSkinFor("ok");
    assert.strictEqual(skin.bg, "#4db892");
  });

  it("unknown kind falls through to default (mint green)", () => {
    const skin = kindSkinFor("some_unknown_kind");
    assert.strictEqual(skin.bg, "#4db892");
  });

  it("all four branches return distinct bg colours", () => {
    const bgs = ["error", "blocked", "pending", "ok"].map((k) => kindSkinFor(k).bg);
    assert.strictEqual(new Set(bgs).size, 4, "all four bg colours must be distinct");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. resolveLogLabel — the || chain: name → capability → "—"
// ─────────────────────────────────────────────────────────────────────────────
describe("resolveLogLabel", () => {
  it("returns name when name is present", () => {
    assert.strictEqual(resolveLogLabel(makeRow({ name: "run_tests", capability: "cap" })), "run_tests");
  });

  it("falls back to capability when name is null", () => {
    assert.strictEqual(resolveLogLabel(makeRow({ name: null, capability: "send_keys" })), "send_keys");
  });

  it("falls back to capability when name is empty string", () => {
    assert.strictEqual(resolveLogLabel(makeRow({ name: "", capability: "send_keys" })), "send_keys");
  });

  it("falls back to em-dash when both name and capability are null", () => {
    assert.strictEqual(resolveLogLabel(makeRow({ name: null, capability: null })), "—");
  });

  it("falls back to em-dash when both are empty strings", () => {
    assert.strictEqual(resolveLogLabel(makeRow({ name: "", capability: "" })), "—");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. resolvePid — all 3 branches of the priority ladder
// ─────────────────────────────────────────────────────────────────────────────
describe("resolvePid", () => {
  const projects = [
    makeProject("alpha"),
    makeProject("beta"),
    makeProject("gamma"),
  ];

  it("returns picked when it is valid (present in projects)", () => {
    assert.strictEqual(resolvePid("beta", "alpha", projects), "beta");
  });

  it("falls through to selectedProject when picked is null", () => {
    assert.strictEqual(resolvePid(null, "gamma", projects), "gamma");
  });

  it("falls through to selectedProject when picked is not in projects", () => {
    assert.strictEqual(resolvePid("unknown-id", "alpha", projects), "alpha");
  });

  it("falls through to first project when selectedProject is 'all'", () => {
    assert.strictEqual(resolvePid(null, "all", projects), "alpha");
  });

  it("falls through to first project when both picked and selectedProject are invalid", () => {
    assert.strictEqual(resolvePid("gone", "also-gone", projects), "alpha");
  });

  it("returns empty string when projects array is empty", () => {
    assert.strictEqual(resolvePid(null, "alpha", []), "");
  });

  it("selectedProject 'all' with empty projects returns empty string", () => {
    assert.strictEqual(resolvePid(null, "all", []), "");
  });

  it("picked takes precedence over a valid selectedProject", () => {
    assert.strictEqual(resolvePid("beta", "alpha", projects), "beta");
  });

  it("selectedProject takes precedence over first-project fallback", () => {
    assert.strictEqual(resolvePid(null, "gamma", projects), "gamma");
    assert.notStrictEqual(resolvePid(null, "gamma", projects), "alpha");
  });
});
