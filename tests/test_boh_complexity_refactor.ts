// tests/test_boh_complexity_refactor.ts — CHARACTERIZATION tests for the
// cyclomatic-complexity burndown refactor of src/orbital/views/BackOfHouse.tsx
// (BackOfHouse CC 32 → 7).
//
// Pins every branch of the five pure helpers extracted from BackOfHouse.tsx:
//   - resolveGateScope      (scope → pane lookup)
//   - resolveGates          (globalGates + scopedPane → merged CapabilityGateMap)
//   - formatVolumePercent   (volume → display %)
//   - formatVolumeSlider    (volume → slider integer 0-100)
//   - isServiceModeActive   (globalMode + target → boolean, collapses Inherit)
//
// The suite must shim three things that are Vite-only (not resolvable by tsx):
//   - icons.svg?raw  (imported by src/orbital/primitives.tsx)
//   - react / react/jsx-runtime (not installed as test deps)
//
// We use Node 22 module.register() with an inline data-URL hook to intercept
// these imports BEFORE loading BackOfHouse.tsx. The hook runs in a separate Worker
// thread (Node ESM loader protocol); the data URL encodes the hook source so no
// extra file is needed.
//
// Runner: npx tsx --test --test-force-exit tests/test_boh_complexity_refactor.ts

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
  resolveGateScope,
  resolveGates,
  formatVolumePercent,
  formatVolumeSlider,
  isServiceModeActive,
} = await import("../src/orbital/views/BackOfHouse.js");

import type { RulebookPane } from "../src/orbital/views/BackOfHouse";
import type { CapabilityGateMap } from "../src/types";

// ─────────────────────────────────────────────────────────────────────────────
// 1. resolveGateScope
// Original inline code:
//   scope !== "kitchen" ? panes.find((p) => p.id === scope) : undefined
// ─────────────────────────────────────────────────────────────────────────────
describe("resolveGateScope", () => {
  const panes: RulebookPane[] = [
    { id: "p1", name: "Alpha", project: "proj-a" },
    { id: "p2", name: "Beta",  project: "proj-b" },
  ];

  it("returns undefined when scope is 'kitchen'", () => {
    assert.equal(resolveGateScope("kitchen", panes), undefined);
  });

  it("returns undefined when scope is 'kitchen' and panes is empty", () => {
    assert.equal(resolveGateScope("kitchen", []), undefined);
  });

  it("returns undefined when scope matches no pane id", () => {
    assert.equal(resolveGateScope("p999", panes), undefined);
  });

  it("returns the matching pane when scope equals its id", () => {
    const result = resolveGateScope("p1", panes);
    assert.deepEqual(result, panes[0]);
  });

  it("returns the second pane when scope equals 'p2'", () => {
    const result = resolveGateScope("p2", panes);
    assert.deepEqual(result, panes[1]);
  });

  it("returns undefined when panes array is empty and scope is not 'kitchen'", () => {
    assert.equal(resolveGateScope("p1", []), undefined);
  });

  it("does NOT return a pane when scope is 'kitchen' even if a pane id is 'kitchen'", () => {
    // Unusual but ensures the guard is on scope !== "kitchen", not a pane lookup.
    const weird: RulebookPane[] = [{ id: "kitchen", name: "Odd", project: "proj-c" }];
    assert.equal(resolveGateScope("kitchen", weird), undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. resolveGates
// Original inline code:
//   scopedPane ? { ...globalGates, ...(scopedPane.overrides ?? {}) } : globalGates
// ─────────────────────────────────────────────────────────────────────────────
describe("resolveGates", () => {
  const global: CapabilityGateMap = {
    write_to_pane: "Ask",
    create_pane: "Auto",
  };

  it("returns globalGates reference unchanged when scopedPane is undefined", () => {
    const result = resolveGates(global, undefined);
    assert.deepEqual(result, global);
  });

  it("returns a merged map with pane overrides winning when scopedPane is defined", () => {
    const pane: RulebookPane = {
      id: "p1", name: "Alpha", project: "proj-a",
      overrides: { write_to_pane: "Off" },
    };
    const result = resolveGates(global, pane);
    assert.equal(result.write_to_pane, "Off", "pane override wins");
    assert.equal(result.create_pane, "Auto", "global value preserved for unoverridden cap");
  });

  it("uses empty overrides ({}) when scopedPane.overrides is undefined (the ?? {} arm)", () => {
    const pane: RulebookPane = { id: "p1", name: "Alpha", project: "proj-a" }; // no overrides
    const result = resolveGates(global, pane);
    assert.deepEqual(result, global, "no overrides → same as global map");
  });

  it("merges ALL pane overrides into the result", () => {
    const pane: RulebookPane = {
      id: "p1", name: "Alpha", project: "proj-a",
      overrides: { write_to_pane: "Off", create_pane: "Off" },
    };
    const result = resolveGates(global, pane);
    assert.equal(result.write_to_pane, "Off");
    assert.equal(result.create_pane, "Off");
  });

  it("pane overrides can add capabilities not in globalGates", () => {
    const pane: RulebookPane = {
      id: "p1", name: "Alpha", project: "proj-a",
      overrides: { close_pane: "Off" },
    };
    const result = resolveGates(global, pane);
    assert.equal(result.close_pane, "Off", "extra key from override is present");
    assert.equal(result.write_to_pane, "Ask", "original global key preserved");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. formatVolumePercent
// Original inline expression (label):
//   Math.round((settings.voiceAi.volume ?? 1) * (settings.voiceAi.volume > 1 ? 1 : 100))
// ─────────────────────────────────────────────────────────────────────────────
describe("formatVolumePercent", () => {
  it("fractional volume 0.5 → 50%", () => {
    assert.equal(formatVolumePercent(0.5), 50);
  });

  it("fractional volume 1.0 → 100%", () => {
    // volume ≤ 1: uses * 100 path; 1 * 100 = 100
    assert.equal(formatVolumePercent(1.0), 100);
  });

  it("fractional volume 0.0 → 0%", () => {
    assert.equal(formatVolumePercent(0), 0);
  });

  it("volume > 1 (stored as 0-100) → treated as percent directly (* 1)", () => {
    // volume > 1: uses * 1 path; Math.round(75 * 1) = 75
    assert.equal(formatVolumePercent(75), 75);
  });

  it("volume > 1 at 100 → 100%", () => {
    assert.equal(formatVolumePercent(100), 100);
  });

  it("rounds fractional result (0.555 → 56%)", () => {
    // 0.555 ≤ 1 so * 100 → 55.5 → rounds to 56
    assert.equal(formatVolumePercent(0.555), 56);
  });

  it("uses ?? 1 fallback: volume=0 (falsy) does NOT trigger nullish fallback (0 is defined)", () => {
    // The ?? operator only fires for null/undefined, not 0.
    // Original: (volume ?? 1) — so 0 stays 0.
    assert.equal(formatVolumePercent(0), 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. formatVolumeSlider
// Original inline expression (input value):
//   Math.round((settings.voiceAi.volume > 1 ? settings.voiceAi.volume : settings.voiceAi.volume * 100))
// ─────────────────────────────────────────────────────────────────────────────
describe("formatVolumeSlider", () => {
  it("fractional 0.5 → 50 (slider 0-100 range)", () => {
    assert.equal(formatVolumeSlider(0.5), 50);
  });

  it("fractional 1.0 → 100", () => {
    assert.equal(formatVolumeSlider(1.0), 100);
  });

  it("fractional 0.0 → 0", () => {
    assert.equal(formatVolumeSlider(0), 0);
  });

  it("volume > 1 (already 0-100): returns the value unchanged", () => {
    assert.equal(formatVolumeSlider(75), 75);
  });

  it("volume > 1 at 100: returns 100", () => {
    assert.equal(formatVolumeSlider(100), 100);
  });

  it("rounds: 0.556 → 56", () => {
    assert.equal(formatVolumeSlider(0.556), 56);
  });

  it("fractional near-1 boundary: 0.999 → 100", () => {
    // 0.999 ≤ 1 so path is * 100 → 99.9 → rounds to 100
    assert.equal(formatVolumeSlider(0.999), 100);
  });

  it("boundary: volume exactly 1.0001 (> 1) → returns 1 (not 100)", () => {
    // volume > 1 path: Math.round(1.0001) = 1
    assert.equal(formatVolumeSlider(1.0001), 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. isServiceModeActive
// Original inline expression:
//   (globalMode === "Inherit" ? "Human-in-the-Loop" : globalMode) === m.mode
// ─────────────────────────────────────────────────────────────────────────────
describe("isServiceModeActive", () => {
  it("'Inherit' mode → active for 'Human-in-the-Loop' (Inherit collapses)", () => {
    assert.equal(isServiceModeActive("Inherit", "Human-in-the-Loop"), true);
  });

  it("'Inherit' mode → NOT active for 'Full Auto'", () => {
    assert.equal(isServiceModeActive("Inherit", "Full Auto"), false);
  });

  it("'Inherit' mode → NOT active for 'Read-Only'", () => {
    assert.equal(isServiceModeActive("Inherit", "Read-Only"), false);
  });

  it("'Full Auto' mode → active for 'Full Auto'", () => {
    assert.equal(isServiceModeActive("Full Auto", "Full Auto"), true);
  });

  it("'Full Auto' mode → NOT active for 'Human-in-the-Loop'", () => {
    assert.equal(isServiceModeActive("Full Auto", "Human-in-the-Loop"), false);
  });

  it("'Full Auto' mode → NOT active for 'Read-Only'", () => {
    assert.equal(isServiceModeActive("Full Auto", "Read-Only"), false);
  });

  it("'Human-in-the-Loop' mode → active for 'Human-in-the-Loop'", () => {
    assert.equal(isServiceModeActive("Human-in-the-Loop", "Human-in-the-Loop"), true);
  });

  it("'Human-in-the-Loop' mode → NOT active for 'Full Auto'", () => {
    assert.equal(isServiceModeActive("Human-in-the-Loop", "Full Auto"), false);
  });

  it("'Read-Only' mode → active for 'Read-Only'", () => {
    assert.equal(isServiceModeActive("Read-Only", "Read-Only"), true);
  });

  it("'Read-Only' mode → NOT active for 'Human-in-the-Loop'", () => {
    assert.equal(isServiceModeActive("Read-Only", "Human-in-the-Loop"), false);
  });

  it("'Read-Only' mode → NOT active for 'Full Auto'", () => {
    assert.equal(isServiceModeActive("Read-Only", "Full Auto"), false);
  });
});
