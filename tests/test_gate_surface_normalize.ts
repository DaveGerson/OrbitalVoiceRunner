import { describe, it } from "node:test";
import assert from "node:assert";

import {
  normalizePostureWord,
  normalizeGateValue,
  normalizeEffectiveGates,
  sanitizePartialGateMap,
  ALL_CAPABILITIES,
} from "../src/gateSurface";
import type { CapabilityGate, GateValue } from "../src/types";

/**
 * n2r (bead wsm-e2e-pinned-n2r) — crash-safety normalizers for the gate UI (plan §4.1).
 *
 * The chip + matrix render directly off server-provided posture / effective_gates. A malformed
 * payload (a posture word that isn't OPEN|GUARDED|LOCKED, a gate value that isn't Auto|Ask|Off, or a
 * non-object effective_gates) used to index an undefined style record and throw during render,
 * white-screening the whole cockpit through the global ErrorBoundary. These pure normalizers are the
 * single boundary choke-point: they coerce ANY input to a known-good shape and NEVER throw.
 *
 * Decision table (plan §3): unknown posture → GUARDED (D1, fail-safe), unknown gate value → Ask (D2),
 * absent posture → null (D3, render-nothing back-compat signal), non-object gates → all-Auto (D6),
 * pane-scope invalid override entries stripped, not crashed/phantomed (D7).
 */

// A no-throw assertion helper: the whole point is these are total + never throw.
function neverThrows(fn: () => unknown, label: string): unknown {
  let out: unknown;
  assert.doesNotThrow(() => { out = fn(); }, `${label} must never throw`);
  return out;
}

// ---------------------------------------------------------------------------
// normalizePostureWord (D1 / D3)
// ---------------------------------------------------------------------------
describe("gateSurface — normalizePostureWord (n2r §4.1, D1/D3)", () => {
  it("valid words are identity (OPEN | GUARDED | LOCKED)", () => {
    assert.strictEqual(normalizePostureWord("OPEN"), "OPEN");
    assert.strictEqual(normalizePostureWord("GUARDED"), "GUARDED");
    assert.strictEqual(normalizePostureWord("LOCKED"), "LOCKED");
  });

  it("present-but-bad / wrong-case / empty → GUARDED (D1 fail-safe)", () => {
    assert.strictEqual(normalizePostureWord("FROZEN"), "GUARDED");
    assert.strictEqual(normalizePostureWord("open"), "GUARDED");   // wrong case is NOT canonical
    assert.strictEqual(normalizePostureWord(""), "GUARDED");
  });

  it("non-string present values → GUARDED (D1)", () => {
    assert.strictEqual(normalizePostureWord(123), "GUARDED");
    assert.strictEqual(normalizePostureWord({}), "GUARDED");
    assert.strictEqual(normalizePostureWord([]), "GUARDED");
    assert.strictEqual(normalizePostureWord(true), "GUARDED");
  });

  it("genuinely absent (null | undefined) → null (D3 render-nothing signal)", () => {
    assert.strictEqual(normalizePostureWord(null), null);
    assert.strictEqual(normalizePostureWord(undefined), null);
  });

  it("never throws for any input", () => {
    for (const input of ["OPEN", "FROZEN", "", 0, NaN, {}, [], true, null, undefined]) {
      neverThrows(() => normalizePostureWord(input), `normalizePostureWord(${String(input)})`);
    }
  });
});

// ---------------------------------------------------------------------------
// normalizeGateValue (D2)
// ---------------------------------------------------------------------------
describe("gateSurface — normalizeGateValue (n2r §4.1, D2)", () => {
  it("valid values are identity (Auto | Ask | Off)", () => {
    assert.strictEqual(normalizeGateValue("Auto"), "Auto");
    assert.strictEqual(normalizeGateValue("Ask"), "Ask");
    assert.strictEqual(normalizeGateValue("Off"), "Off");
  });

  it("present-but-bad / wrong-case → Ask (D2 fail-safe friction)", () => {
    assert.strictEqual(normalizeGateValue("Allow"), "Ask");
    assert.strictEqual(normalizeGateValue("auto"), "Ask");
    assert.strictEqual(normalizeGateValue("OFF"), "Ask");
  });

  it("absent (null | undefined) → Auto (legacy default)", () => {
    assert.strictEqual(normalizeGateValue(null), "Auto");
    assert.strictEqual(normalizeGateValue(undefined), "Auto");
  });

  it("non-string present values → Ask (D2)", () => {
    assert.strictEqual(normalizeGateValue(5), "Ask");
    assert.strictEqual(normalizeGateValue({}), "Ask");
    assert.strictEqual(normalizeGateValue([]), "Ask");
  });

  it("never throws for any input", () => {
    for (const input of ["Auto", "Allow", "", 5, {}, [], true, null, undefined]) {
      neverThrows(() => normalizeGateValue(input), `normalizeGateValue(${String(input)})`);
    }
  });
});

// ---------------------------------------------------------------------------
// normalizeEffectiveGates (D6) — TOTAL, well-typed, every capability in ALL_CAPABILITIES
// (F4: the matrix is now 22 caps — assert against ALL_CAPABILITIES.length, not a literal 16).
// ---------------------------------------------------------------------------
describe("gateSurface — normalizeEffectiveGates (n2r §4.1, D6)", () => {
  function assertTotalAllAuto(out: Record<CapabilityGate, GateValue>) {
    assert.strictEqual(Object.keys(out).length, ALL_CAPABILITIES.length, "must be a TOTAL cap map");
    for (const cap of ALL_CAPABILITIES) assert.strictEqual(out[cap], "Auto", `${cap} should default Auto`);
  }

  it("undefined / null / string / number / array → TOTAL all-Auto map (D6)", () => {
    assertTotalAllAuto(normalizeEffectiveGates(undefined));
    assertTotalAllAuto(normalizeEffectiveGates(null));
    assertTotalAllAuto(normalizeEffectiveGates("not-an-object"));
    assertTotalAllAuto(normalizeEffectiveGates(7));
    assertTotalAllAuto(normalizeEffectiveGates([]));
  });

  it("partial valid map → keeps valid, coerces bad values (D2), drops unknown keys, fills rest Auto", () => {
    const out = normalizeEffectiveGates({ write_to_pane: "Off", close_pane: "Allow", bogus_cap: "Auto" });
    assert.strictEqual(out.write_to_pane, "Off", "valid value kept");
    assert.strictEqual(out.close_pane, "Ask", "bad value 'Allow' coerced to Ask (D2)");
    assert.ok(!("bogus_cap" in out), "unknown key dropped (not in the canonical union)");
    // Every other canonical cap present and Auto.
    for (const cap of ALL_CAPABILITIES) {
      if (cap === "write_to_pane" || cap === "close_pane") continue;
      assert.strictEqual(out[cap], "Auto", `${cap} unspecified → Auto`);
    }
    // Totality: exactly the full capability union, no extras.
    const keys = Object.keys(out).sort();
    assert.deepStrictEqual(keys, [...ALL_CAPABILITIES].sort());
    assert.strictEqual(keys.length, ALL_CAPABILITIES.length);
  });

  it("never throws for any input", () => {
    for (const input of [undefined, null, "x", 7, [], {}, true, { write_to_pane: 99 }]) {
      neverThrows(() => normalizeEffectiveGates(input), `normalizeEffectiveGates(${JSON.stringify(input)})`);
    }
  });
});

// ---------------------------------------------------------------------------
// sanitizePartialGateMap (D7) — keep partial-map "absent = follow global" semantics
// ---------------------------------------------------------------------------
describe("gateSurface — sanitizePartialGateMap (n2r §4.1, D7)", () => {
  it("keeps valid entries, drops bad-value entries, drops unknown keys (stays PARTIAL)", () => {
    const out = sanitizePartialGateMap({ write_to_pane: "Ask", close_pane: "Allow", bogus: "Auto" });
    assert.deepStrictEqual(out, { write_to_pane: "Ask" });
    // Crucially NOT total — every other cap stays ABSENT (= follow global), unlike normalizeEffectiveGates.
    assert.strictEqual(Object.keys(out).length, 1);
  });

  it("non-object / array / primitive → {} (no crash, empty partial)", () => {
    assert.deepStrictEqual(sanitizePartialGateMap(undefined), {});
    assert.deepStrictEqual(sanitizePartialGateMap(null), {});
    assert.deepStrictEqual(sanitizePartialGateMap("x"), {});
    assert.deepStrictEqual(sanitizePartialGateMap([]), {});
    assert.deepStrictEqual(sanitizePartialGateMap(7), {});
  });

  it("an all-valid partial map round-trips unchanged", () => {
    const out = sanitizePartialGateMap({ write_to_pane: "Off", deliver_handoff: "Ask" });
    assert.deepStrictEqual(out, { write_to_pane: "Off", deliver_handoff: "Ask" });
  });

  it("never throws for any input", () => {
    for (const input of [undefined, null, "x", 7, [], {}, { write_to_pane: 99 }]) {
      neverThrows(() => sanitizePartialGateMap(input), `sanitizePartialGateMap(${JSON.stringify(input)})`);
    }
  });
});
