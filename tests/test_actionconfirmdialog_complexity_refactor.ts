// tests/test_actionconfirmdialog_complexity_refactor.ts — CHARACTERIZATION tests for the
// cyclomatic-complexity burndown refactor of src/components/ActionConfirmDialog.tsx (CC 21 → ≤10).
//
// These tests pin the PURE logic extracted into `deriveActionDisplayState` and
// `deriveDivergenceText` — every branch of the posture/gate/scope/divergence resolution path —
// so the behaviour-preserving refactor changes nothing observable. Tests are written to pass
// against BOTH the pre-refactor logic (as inline code) AND the post-refactor exports.
//
// Runner: npx tsx --test --test-force-exit tests/test_actionconfirmdialog_complexity_refactor.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deriveActionDisplayState,
  deriveDivergenceText,
} from "../src/components/ActionConfirmDialog";
import {
  POSTURE_STYLE,
  GATE_STYLE,
  CAPABILITY_LABELS,
} from "../src/gateSurface";

// ─────────────────────────────────────────────────────────────────────────────
// 1. showEffective flag — deriveActionDisplayState
// ─────────────────────────────────────────────────────────────────────────────
describe("deriveActionDisplayState — showEffective", () => {
  it("false when posture and effectiveGate are both absent", () => {
    const s = deriveActionDisplayState(undefined, undefined, "write_to_pane", undefined);
    assert.equal(s.showEffective, false);
  });

  it("true when posture is supplied", () => {
    const s = deriveActionDisplayState("OPEN", undefined, "write_to_pane", undefined);
    assert.equal(s.showEffective, true);
  });

  it("true when effectiveGate is supplied (even without posture)", () => {
    const s = deriveActionDisplayState(undefined, "Ask", "write_to_pane", undefined);
    assert.equal(s.showEffective, true);
  });

  it("true when both posture and effectiveGate are supplied", () => {
    const s = deriveActionDisplayState("LOCKED", "Off", "write_to_pane", undefined);
    assert.equal(s.showEffective, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. safePosture — normalizePostureWord branching
// ─────────────────────────────────────────────────────────────────────────────
describe("deriveActionDisplayState — safePosture", () => {
  it("null when posture is absent", () => {
    const s = deriveActionDisplayState(undefined, undefined, "write_to_pane", undefined);
    assert.equal(s.safePosture, null);
  });

  it("OPEN for a valid OPEN posture", () => {
    const s = deriveActionDisplayState("OPEN", undefined, "write_to_pane", undefined);
    assert.equal(s.safePosture, "OPEN");
  });

  it("GUARDED for a valid GUARDED posture", () => {
    const s = deriveActionDisplayState("GUARDED", undefined, "write_to_pane", undefined);
    assert.equal(s.safePosture, "GUARDED");
  });

  it("LOCKED for a valid LOCKED posture", () => {
    const s = deriveActionDisplayState("LOCKED", undefined, "write_to_pane", undefined);
    assert.equal(s.safePosture, "LOCKED");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. postureStyle — POSTURE_STYLE lookup with safePosture guard
// ─────────────────────────────────────────────────────────────────────────────
describe("deriveActionDisplayState — postureStyle", () => {
  it("undefined when safePosture is null (absent posture)", () => {
    const s = deriveActionDisplayState(undefined, undefined, "write_to_pane", undefined);
    assert.equal(s.postureStyle, undefined);
  });

  it("OPEN postureStyle matches POSTURE_STYLE.OPEN", () => {
    const s = deriveActionDisplayState("OPEN", undefined, "write_to_pane", undefined);
    assert.deepEqual(s.postureStyle, POSTURE_STYLE.OPEN);
  });

  it("GUARDED postureStyle matches POSTURE_STYLE.GUARDED", () => {
    const s = deriveActionDisplayState("GUARDED", undefined, "write_to_pane", undefined);
    assert.deepEqual(s.postureStyle, POSTURE_STYLE.GUARDED);
  });

  it("LOCKED postureStyle matches POSTURE_STYLE.LOCKED", () => {
    const s = deriveActionDisplayState("LOCKED", undefined, "write_to_pane", undefined);
    assert.deepEqual(s.postureStyle, POSTURE_STYLE.LOCKED);
  });

  it("postureStyle always defined when safePosture is non-null (fallback ?? POSTURE_STYLE.GUARDED guard)", () => {
    const s = deriveActionDisplayState("OPEN", undefined, "write_to_pane", undefined);
    assert.notEqual(s.postureStyle, undefined, "postureStyle must be defined when safePosture is non-null");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. safeGate and gateStyle — effectiveGate resolution
// ─────────────────────────────────────────────────────────────────────────────
describe("deriveActionDisplayState — safeGate / gateStyle", () => {
  it("undefined safeGate and gateStyle when effectiveGate is absent", () => {
    const s = deriveActionDisplayState(undefined, undefined, "write_to_pane", undefined);
    assert.equal(s.safeGate, undefined);
    assert.equal(s.gateStyle, undefined);
  });

  it("Auto gate → safeGate=Auto, gateStyle=GATE_STYLE.Auto", () => {
    const s = deriveActionDisplayState(undefined, "Auto", "write_to_pane", undefined);
    assert.equal(s.safeGate, "Auto");
    assert.deepEqual(s.gateStyle, GATE_STYLE.Auto);
  });

  it("Ask gate → safeGate=Ask, gateStyle=GATE_STYLE.Ask", () => {
    const s = deriveActionDisplayState(undefined, "Ask", "write_to_pane", undefined);
    assert.equal(s.safeGate, "Ask");
    assert.deepEqual(s.gateStyle, GATE_STYLE.Ask);
  });

  it("Off gate → safeGate=Off, gateStyle=GATE_STYLE.Off", () => {
    const s = deriveActionDisplayState(undefined, "Off", "write_to_pane", undefined);
    assert.equal(s.safeGate, "Off");
    assert.deepEqual(s.gateStyle, GATE_STYLE.Off);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. capLabel — CAPABILITY_LABELS lookup with raw-capability fallback
// ─────────────────────────────────────────────────────────────────────────────
describe("deriveActionDisplayState — capLabel", () => {
  it("returns CAPABILITY_LABELS entry for write_to_pane", () => {
    const s = deriveActionDisplayState(undefined, undefined, "write_to_pane", undefined);
    assert.equal(s.capLabel, CAPABILITY_LABELS["write_to_pane"]);
  });

  it("returns CAPABILITY_LABELS entry for deliver_handoff", () => {
    const s = deriveActionDisplayState(undefined, undefined, "deliver_handoff", undefined);
    assert.equal(s.capLabel, CAPABILITY_LABELS["deliver_handoff"]);
  });

  it("falls back to the raw capability string when the label map has no entry (guard pin)", () => {
    // `?? capability` fires for an unknown capability id.
    const s = deriveActionDisplayState(undefined, undefined, "totally_unknown_cap", undefined);
    assert.equal(s.capLabel, "totally_unknown_cap");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. scopeLabel — paneId-based scope rendering
// ─────────────────────────────────────────────────────────────────────────────
describe("deriveActionDisplayState — scopeLabel", () => {
  it("'Effective globally:' when paneId is undefined (global action)", () => {
    const s = deriveActionDisplayState(undefined, undefined, "write_to_pane", undefined);
    assert.equal(s.scopeLabel, "Effective globally:");
  });

  it("'Effective globally:' when paneId is null (D2: global action)", () => {
    const s = deriveActionDisplayState(undefined, undefined, "write_to_pane", null);
    assert.equal(s.scopeLabel, "Effective globally:");
  });

  it("'Effective on p1:' when paneId is 'p1'", () => {
    const s = deriveActionDisplayState(undefined, undefined, "write_to_pane", "p1");
    assert.equal(s.scopeLabel, "Effective on p1:");
  });

  it("'Effective on myPane:' when paneId is 'myPane'", () => {
    const s = deriveActionDisplayState(undefined, undefined, "write_to_pane", "myPane");
    assert.equal(s.scopeLabel, "Effective on myPane:");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. deriveDivergenceText — all three divergence branches
// ─────────────────────────────────────────────────────────────────────────────
describe("deriveDivergenceText", () => {
  it("returns empty string for divergence='none'", () => {
    const text = deriveDivergenceText("none", undefined, null, "Type a command into a pane");
    assert.equal(text, "");
  });

  it("divergence='global' with known posture → mentions effectiveMode and posture word", () => {
    const text = deriveDivergenceText("global", "Read-Only", "GUARDED", "Type a command into a pane");
    assert.ok(text.includes("Read-Only"), "should include effectiveMode");
    assert.ok(text.includes("GUARDED"), "should include posture word");
    assert.ok(text.includes("global mode"), "should mention global mode");
  });

  it("divergence='global' with null posture → falls back to LOCKED in the message", () => {
    const text = deriveDivergenceText("global", "Full Auto", null, "Type a command into a pane");
    assert.ok(text.includes("Full Auto"), "should include effectiveMode");
    assert.ok(text.includes("LOCKED"), "should use 'LOCKED' fallback when safePosture is null");
  });

  it("divergence='global' with undefined posture → falls back to LOCKED in the message", () => {
    // safePosture=undefined triggers `?? 'LOCKED'` (same null-coalescing path as null)
    const text = deriveDivergenceText("global", "Human-in-the-Loop", undefined as unknown as null, "cap");
    assert.ok(text.includes("LOCKED"), "should use 'LOCKED' fallback when safePosture is falsy");
  });

  it("divergence='gate' → mentions capLabel and 'Blocked'", () => {
    const text = deriveDivergenceText("gate", undefined, null, "Create a pane");
    assert.ok(text.includes("Create a pane"), "should include capLabel");
    assert.ok(text.includes("Blocked"), "should mention Blocked");
  });

  it("divergence='gate' exact message format check", () => {
    const capLabel = CAPABILITY_LABELS["write_to_pane"];
    const text = deriveDivergenceText("gate", undefined, null, capLabel);
    assert.equal(text, `The '${capLabel}' gate is Blocked — this stays Blocked even after you confirm.`);
  });

  it("divergence='global' exact message format check with OPEN posture", () => {
    const text = deriveDivergenceText("global", "Read-Only", "OPEN", "cap");
    assert.equal(text, "Global mode is Read-Only — this pane stays OPEN until you change the global mode.");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Cross-cutting: full realistic payloads for deriveActionDisplayState
// ─────────────────────────────────────────────────────────────────────────────
describe("deriveActionDisplayState — realistic payloads", () => {
  it("GUARDED + Ask gate + per-pane scope → all fields correct", () => {
    const s = deriveActionDisplayState("GUARDED", "Ask", "write_to_pane", "p1");
    assert.equal(s.showEffective, true);
    assert.equal(s.safePosture, "GUARDED");
    assert.deepEqual(s.postureStyle, POSTURE_STYLE.GUARDED);
    assert.equal(s.safeGate, "Ask");
    assert.deepEqual(s.gateStyle, GATE_STYLE.Ask);
    assert.equal(s.capLabel, CAPABILITY_LABELS["write_to_pane"]);
    assert.equal(s.scopeLabel, "Effective on p1:");
  });

  it("LOCKED + Off gate + global action (null paneId) → all fields correct", () => {
    const s = deriveActionDisplayState("LOCKED", "Off", "set_global_permissions", null);
    assert.equal(s.showEffective, true);
    assert.equal(s.safePosture, "LOCKED");
    assert.deepEqual(s.postureStyle, POSTURE_STYLE.LOCKED);
    assert.equal(s.safeGate, "Off");
    assert.deepEqual(s.gateStyle, GATE_STYLE.Off);
    assert.equal(s.scopeLabel, "Effective globally:");
  });

  it("OPEN + Auto gate + global action (undefined paneId) → global scope label", () => {
    const s = deriveActionDisplayState("OPEN", "Auto", "write_to_pane", undefined);
    assert.equal(s.scopeLabel, "Effective globally:");
    assert.equal(s.safePosture, "OPEN");
    assert.deepEqual(s.postureStyle, POSTURE_STYLE.OPEN);
    assert.equal(s.safeGate, "Auto");
  });

  it("no posture, no gate, no pane (classic / pre-rbh payload) → safe defaults", () => {
    const s = deriveActionDisplayState(undefined, undefined, "write_to_pane", undefined);
    assert.equal(s.showEffective, false);
    assert.equal(s.safePosture, null);
    assert.equal(s.postureStyle, undefined);
    assert.equal(s.safeGate, undefined);
    assert.equal(s.gateStyle, undefined);
    assert.equal(s.capLabel, CAPABILITY_LABELS["write_to_pane"]);
    assert.equal(s.scopeLabel, "Effective globally:");
  });
});
