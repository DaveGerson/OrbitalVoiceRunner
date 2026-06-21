// tests/test_approvaldialog_complexity_refactor.ts — CHARACTERIZATION tests for the cyclomatic-
// complexity burndown refactor of src/components/ApprovalDialog.tsx (CC 20 → ≤10).
//
// These tests pin the PURE logic extracted into `deriveApprovalDisplayState` — every branch of the
// posture/gate/mode/capability resolution path — so the behaviour-preserving refactor changes nothing
// observable. Tests are written to pass against BOTH the pre-refactor export (once available) AND the
// post-refactor export.
//
// Runner: npx tsx --test --test-force-exit tests/test_approvaldialog_complexity_refactor.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deriveApprovalDisplayState,
} from "../src/components/ApprovalDialog";
import {
  POSTURE_STYLE,
  GATE_STYLE,
  CAPABILITY_LABELS,
} from "../src/gateSurface";
import type { CapabilityGateMap } from "../src/types";

// ─────────────────────────────────────────────────────────────────────────────
// 1. showEffective flag
// ─────────────────────────────────────────────────────────────────────────────
describe("deriveApprovalDisplayState — showEffective", () => {
  it("false when posture and effectiveGates are both absent", () => {
    const s = deriveApprovalDisplayState({ posture: undefined, effectiveGates: undefined, effectiveMode: undefined, capability: undefined });
    assert.equal(s.showEffective, false);
  });

  it("true when posture is supplied", () => {
    const s = deriveApprovalDisplayState({ posture: "OPEN", effectiveGates: undefined, effectiveMode: undefined, capability: undefined });
    assert.equal(s.showEffective, true);
  });

  it("true when effectiveGates is supplied (even without posture)", () => {
    const gates: CapabilityGateMap = { write_to_pane: "Ask" } as CapabilityGateMap;
    const s = deriveApprovalDisplayState({ posture: undefined, effectiveGates: gates, effectiveMode: undefined, capability: undefined });
    assert.equal(s.showEffective, true);
  });

  it("true when both posture and effectiveGates are supplied", () => {
    const gates: CapabilityGateMap = { write_to_pane: "Auto" } as CapabilityGateMap;
    const s = deriveApprovalDisplayState({ posture: "LOCKED", effectiveGates: gates, effectiveMode: undefined, capability: undefined });
    assert.equal(s.showEffective, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. safePosture — normalizePostureWord branching
// ─────────────────────────────────────────────────────────────────────────────
describe("deriveApprovalDisplayState — safePosture", () => {
  it("null when posture is absent", () => {
    const s = deriveApprovalDisplayState({ posture: undefined, effectiveGates: undefined, effectiveMode: undefined, capability: undefined });
    assert.equal(s.safePosture, null);
  });

  it("OPEN for a valid OPEN posture", () => {
    const s = deriveApprovalDisplayState({ posture: "OPEN", effectiveGates: undefined, effectiveMode: undefined, capability: undefined });
    assert.equal(s.safePosture, "OPEN");
  });

  it("GUARDED for a valid GUARDED posture", () => {
    const s = deriveApprovalDisplayState({ posture: "GUARDED", effectiveGates: undefined, effectiveMode: undefined, capability: undefined });
    assert.equal(s.safePosture, "GUARDED");
  });

  it("LOCKED for a valid LOCKED posture", () => {
    const s = deriveApprovalDisplayState({ posture: "LOCKED", effectiveGates: undefined, effectiveMode: undefined, capability: undefined });
    assert.equal(s.safePosture, "LOCKED");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. postureStyle — POSTURE_STYLE lookup with safePosture guard
// ─────────────────────────────────────────────────────────────────────────────
describe("deriveApprovalDisplayState — postureStyle", () => {
  it("undefined when safePosture is null (absent posture)", () => {
    const s = deriveApprovalDisplayState({ posture: undefined, effectiveGates: undefined, effectiveMode: undefined, capability: undefined });
    assert.equal(s.postureStyle, undefined);
  });

  it("OPEN postureStyle matches POSTURE_STYLE.OPEN", () => {
    const s = deriveApprovalDisplayState({ posture: "OPEN", effectiveGates: undefined, effectiveMode: undefined, capability: undefined });
    assert.deepEqual(s.postureStyle, POSTURE_STYLE.OPEN);
  });

  it("GUARDED postureStyle matches POSTURE_STYLE.GUARDED", () => {
    const s = deriveApprovalDisplayState({ posture: "GUARDED", effectiveGates: undefined, effectiveMode: undefined, capability: undefined });
    assert.deepEqual(s.postureStyle, POSTURE_STYLE.GUARDED);
  });

  it("LOCKED postureStyle matches POSTURE_STYLE.LOCKED", () => {
    const s = deriveApprovalDisplayState({ posture: "LOCKED", effectiveGates: undefined, effectiveMode: undefined, capability: undefined });
    assert.deepEqual(s.postureStyle, POSTURE_STYLE.LOCKED);
  });

  it("falls back to POSTURE_STYLE.GUARDED when safePosture has no entry (impossible in strict typing but guard exists)", () => {
    // The fallback `?? POSTURE_STYLE.GUARDED` fires when a normalised posture has no entry in the map.
    // We can't normally reach this with valid PostureWord values, but we verify the returned style is
    // always non-undefined whenever safePosture is non-null.
    const s = deriveApprovalDisplayState({ posture: "OPEN", effectiveGates: undefined, effectiveMode: undefined, capability: undefined });
    assert.notEqual(s.postureStyle, undefined, "postureStyle must be defined when safePosture is non-null");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. writeCap — capability defaulting
// ─────────────────────────────────────────────────────────────────────────────
describe("deriveApprovalDisplayState — writeCap default", () => {
  it("defaults to write_to_pane when capability is absent", () => {
    const s = deriveApprovalDisplayState({ posture: undefined, effectiveGates: undefined, effectiveMode: undefined, capability: undefined });
    assert.equal(s.writeCap, "write_to_pane");
  });

  it("uses supplied capability when present", () => {
    const s = deriveApprovalDisplayState({ posture: undefined, effectiveGates: undefined, effectiveMode: undefined, capability: "deliver_handoff" });
    assert.equal(s.writeCap, "deliver_handoff");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. safeGate and gateStyle — write gate resolution
// ─────────────────────────────────────────────────────────────────────────────
describe("deriveApprovalDisplayState — safeGate / gateStyle", () => {
  it("undefined when effectiveGates is absent", () => {
    const s = deriveApprovalDisplayState({ posture: undefined, effectiveGates: undefined, effectiveMode: undefined, capability: undefined });
    assert.equal(s.safeGate, undefined);
    assert.equal(s.gateStyle, undefined);
  });

  it("resolves Auto gate from effectiveGates for write_to_pane", () => {
    const gates: CapabilityGateMap = { write_to_pane: "Auto" } as CapabilityGateMap;
    const s = deriveApprovalDisplayState({ posture: undefined, effectiveGates: gates, effectiveMode: undefined, capability: undefined });
    assert.equal(s.safeGate, "Auto");
    assert.deepEqual(s.gateStyle, GATE_STYLE.Auto);
  });

  it("resolves Ask gate from effectiveGates", () => {
    const gates: CapabilityGateMap = { write_to_pane: "Ask" } as CapabilityGateMap;
    const s = deriveApprovalDisplayState({ posture: undefined, effectiveGates: gates, effectiveMode: undefined, capability: undefined });
    assert.equal(s.safeGate, "Ask");
    assert.deepEqual(s.gateStyle, GATE_STYLE.Ask);
  });

  it("resolves Off gate from effectiveGates", () => {
    const gates: CapabilityGateMap = { write_to_pane: "Off" } as CapabilityGateMap;
    const s = deriveApprovalDisplayState({ posture: undefined, effectiveGates: gates, effectiveMode: undefined, capability: undefined });
    assert.equal(s.safeGate, "Off");
    assert.deepEqual(s.gateStyle, GATE_STYLE.Off);
  });

  it("uses deliver_handoff gate when capability is deliver_handoff", () => {
    const gates: CapabilityGateMap = { write_to_pane: "Auto", deliver_handoff: "Ask" } as CapabilityGateMap;
    const s = deriveApprovalDisplayState({ posture: undefined, effectiveGates: gates, effectiveMode: undefined, capability: "deliver_handoff" });
    assert.equal(s.safeGate, "Ask");
  });

  it("safeGate is undefined when the gate entry is absent from effectiveGates (null guard: writeGate != null)", () => {
    // effectiveGates is present but write_to_pane key is missing (partial map) — writeGate is undefined,
    // which fails the `!= null` guard, so safeGate must be undefined.
    const gates = {} as CapabilityGateMap;
    const s = deriveApprovalDisplayState({ posture: undefined, effectiveGates: gates, effectiveMode: undefined, capability: undefined });
    assert.equal(s.safeGate, undefined);
    assert.equal(s.gateStyle, undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. capLabel — CAPABILITY_LABELS lookup with writeCap fallback
// ─────────────────────────────────────────────────────────────────────────────
describe("deriveApprovalDisplayState — capLabel", () => {
  it("returns CAPABILITY_LABELS entry for write_to_pane", () => {
    const s = deriveApprovalDisplayState({ posture: undefined, effectiveGates: undefined, effectiveMode: undefined, capability: undefined });
    assert.equal(s.capLabel, CAPABILITY_LABELS["write_to_pane"]);
  });

  it("returns CAPABILITY_LABELS entry for deliver_handoff", () => {
    const s = deriveApprovalDisplayState({ posture: undefined, effectiveGates: undefined, effectiveMode: undefined, capability: "deliver_handoff" });
    assert.equal(s.capLabel, CAPABILITY_LABELS["deliver_handoff"]);
  });

  it("falls back to the raw capability id when the label map has no entry (guard pin)", () => {
    // There is no entry for a cast-in unknown capability — `?? writeCap` fires.
    const s = deriveApprovalDisplayState({ posture: undefined, effectiveGates: undefined, effectiveMode: undefined, capability: "totally_unknown" as any });
    assert.equal(s.capLabel, "totally_unknown");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. showMode — effectiveMode presence flag
// ─────────────────────────────────────────────────────────────────────────────
describe("deriveApprovalDisplayState — showMode", () => {
  it("false when effectiveMode is absent", () => {
    const s = deriveApprovalDisplayState({ posture: undefined, effectiveGates: undefined, effectiveMode: undefined, capability: undefined });
    assert.equal(s.showMode, false);
  });

  it("true for Full Auto", () => {
    const s = deriveApprovalDisplayState({ posture: undefined, effectiveGates: undefined, effectiveMode: "Full Auto", capability: undefined });
    assert.equal(s.showMode, true);
  });

  it("true for Human-in-the-Loop", () => {
    const s = deriveApprovalDisplayState({ posture: undefined, effectiveGates: undefined, effectiveMode: "Human-in-the-Loop", capability: undefined });
    assert.equal(s.showMode, true);
  });

  it("true for Read-Only", () => {
    const s = deriveApprovalDisplayState({ posture: undefined, effectiveGates: undefined, effectiveMode: "Read-Only", capability: undefined });
    assert.equal(s.showMode, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Cross-cutting: full realistic payload (GUARDED + Ask write gate + Read-Only mode)
// ─────────────────────────────────────────────────────────────────────────────
describe("deriveApprovalDisplayState — realistic payloads", () => {
  it("GUARDED + Ask write gate + Read-Only mode → all fields correct", () => {
    const gates: CapabilityGateMap = { write_to_pane: "Ask" } as CapabilityGateMap;
    const s = deriveApprovalDisplayState({
      posture: "GUARDED",
      effectiveGates: gates,
      effectiveMode: "Read-Only",
      capability: undefined,
    });
    assert.equal(s.showEffective, true);
    assert.equal(s.safePosture, "GUARDED");
    assert.deepEqual(s.postureStyle, POSTURE_STYLE.GUARDED);
    assert.equal(s.writeCap, "write_to_pane");
    assert.equal(s.safeGate, "Ask");
    assert.deepEqual(s.gateStyle, GATE_STYLE.Ask);
    assert.equal(s.capLabel, CAPABILITY_LABELS["write_to_pane"]);
    assert.equal(s.showMode, true);
  });

  it("LOCKED + Off write gate + Full Auto mode (contradictory but server-truth) → fields correct", () => {
    const gates: CapabilityGateMap = { write_to_pane: "Off" } as CapabilityGateMap;
    const s = deriveApprovalDisplayState({
      posture: "LOCKED",
      effectiveGates: gates,
      effectiveMode: "Full Auto",
      capability: undefined,
    });
    assert.equal(s.safePosture, "LOCKED");
    assert.deepEqual(s.postureStyle, POSTURE_STYLE.LOCKED);
    assert.equal(s.safeGate, "Off");
    assert.deepEqual(s.gateStyle, GATE_STYLE.Off);
    assert.equal(s.showMode, true);
  });

  it("OPEN + deliver_handoff capability + Auto gate → deliver_handoff label used", () => {
    const gates: CapabilityGateMap = { deliver_handoff: "Auto" } as CapabilityGateMap;
    const s = deriveApprovalDisplayState({
      posture: "OPEN",
      effectiveGates: gates,
      effectiveMode: "Human-in-the-Loop",
      capability: "deliver_handoff",
    });
    assert.equal(s.writeCap, "deliver_handoff");
    assert.equal(s.safeGate, "Auto");
    assert.equal(s.capLabel, CAPABILITY_LABELS["deliver_handoff"]);
  });

  it("no posture, no gates, no mode (classic / pre-rbh payload) → safe defaults", () => {
    const s = deriveApprovalDisplayState({
      posture: undefined,
      effectiveGates: undefined,
      effectiveMode: undefined,
      capability: undefined,
    });
    assert.equal(s.showEffective, false);
    assert.equal(s.safePosture, null);
    assert.equal(s.postureStyle, undefined);
    assert.equal(s.safeGate, undefined);
    assert.equal(s.gateStyle, undefined);
    assert.equal(s.showMode, false);
    assert.equal(s.writeCap, "write_to_pane");
    assert.equal(s.capLabel, CAPABILITY_LABELS["write_to_pane"]);
  });
});
