/**
 * Pure-helper unit tests for GateChip complexity refactor.
 *
 * These tests pin the behavior of every extracted pure function across
 * all relevant branches (gate states Auto/Ask/Off, per control kind,
 * spotlight/non-spotlight, active/inactive pane, disabled states, etc.).
 *
 * No DOM / React required — these are pure function calls.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// We import the helpers that will be exported from the refactored GateChip.tsx.
// NOTE: because GateChip.tsx is a .tsx file (React JSX), we import it via tsx loader.
import {
  deriveDisplayValue,
  deriveDisplayWord,
  isViaFocus,
} from "../src/components/GateChip.tsx";

// ─── deriveDisplayValue ───────────────────────────────────────────────────────
// Signature: (control: GateControlKind, value: GateValue) => GateValue
// Semantics:
//   two-way + Auto  → Auto   (not Off, so collapses to Auto)
//   two-way + Ask   → Auto   (not Off, so collapses to Auto)
//   two-way + Off   → Off    (stays Off)
//   three-way + *   → value  (unchanged)
//   badge + *       → value  (unchanged; badge path exits before this is called in practice)

describe("deriveDisplayValue", () => {
  // two-way control
  it("two-way Auto → Auto", () => {
    assert.equal(deriveDisplayValue("two-way", "Auto"), "Auto");
  });
  it("two-way Ask → Auto (Ask collapses, veto can only block not defer)", () => {
    assert.equal(deriveDisplayValue("two-way", "Ask"), "Auto");
  });
  it("two-way Off → Off (blocked is blocked)", () => {
    assert.equal(deriveDisplayValue("two-way", "Off"), "Off");
  });

  // three-way control: value passes through unchanged
  it("three-way Auto → Auto", () => {
    assert.equal(deriveDisplayValue("three-way", "Auto"), "Auto");
  });
  it("three-way Ask → Ask", () => {
    assert.equal(deriveDisplayValue("three-way", "Ask"), "Ask");
  });
  it("three-way Off → Off", () => {
    assert.equal(deriveDisplayValue("three-way", "Off"), "Off");
  });

  // badge control: value passes through (badge rows short-circuit before display, but helper is total)
  it("badge Auto → Auto (no transformation)", () => {
    assert.equal(deriveDisplayValue("badge", "Auto"), "Auto");
  });
  it("badge Off → Off (no transformation)", () => {
    assert.equal(deriveDisplayValue("badge", "Off"), "Off");
  });
});

// ─── deriveDisplayWord ───────────────────────────────────────────────────────
// Signature: (control: GateControlKind, gStyleWord: string, displayValue: GateValue) => string
// Semantics:
//   two-way → use the GATE_STYLE word (e.g. "Allowed" / "Blocked")
//   anything else → use the raw displayValue string ("Auto" / "Ask" / "Off")

describe("deriveDisplayWord", () => {
  it("two-way → uses gStyle.word (passes through the style word)", () => {
    assert.equal(deriveDisplayWord("two-way", "Allowed", "Auto"), "Allowed");
    assert.equal(deriveDisplayWord("two-way", "Blocked", "Off"), "Blocked");
    assert.equal(deriveDisplayWord("two-way", "Blocked", "Ask"), "Blocked");
  });

  it("three-way → uses displayValue (ignores gStyle.word)", () => {
    assert.equal(deriveDisplayWord("three-way", "Allowed", "Auto"), "Auto");
    assert.equal(deriveDisplayWord("three-way", "Allowed", "Ask"), "Ask");
    assert.equal(deriveDisplayWord("three-way", "Allowed", "Off"), "Off");
  });

  it("badge → uses displayValue (badge rows are handled before this in practice)", () => {
    assert.equal(deriveDisplayWord("badge", "Always on", "Auto"), "Auto");
  });
});

// ─── isViaFocus ──────────────────────────────────────────────────────────────
// Signature: (isActivePane: boolean, cap: CapabilityGate, value: GateValue) => boolean
// Semantics:
//   true  iff isActivePane AND cap is spotlight-eligible (write_to_pane | deliver_handoff) AND value === "Auto"
//   false otherwise (any condition false → false)

describe("isViaFocus", () => {
  // Positive cases: spotlight-eligible caps on active pane with Auto
  it("write_to_pane + active pane + Auto → true", () => {
    assert.equal(isViaFocus(true, "write_to_pane", "Auto"), true);
  });
  it("deliver_handoff + active pane + Auto → true", () => {
    assert.equal(isViaFocus(true, "deliver_handoff", "Auto"), true);
  });

  // Gate value not Auto
  it("write_to_pane + active pane + Ask → false", () => {
    assert.equal(isViaFocus(true, "write_to_pane", "Ask"), false);
  });
  it("write_to_pane + active pane + Off → false", () => {
    assert.equal(isViaFocus(true, "write_to_pane", "Off"), false);
  });

  // Not active pane
  it("write_to_pane + inactive pane + Auto → false", () => {
    assert.equal(isViaFocus(false, "write_to_pane", "Auto"), false);
  });
  it("deliver_handoff + inactive pane + Auto → false", () => {
    assert.equal(isViaFocus(false, "deliver_handoff", "Auto"), false);
  });

  // Non-spotlight capability
  it("create_pane + active pane + Auto → false (not spotlight-eligible)", () => {
    assert.equal(isViaFocus(true, "create_pane", "Auto"), false);
  });
  it("set_pane_permissions + active pane + Auto → false (not spotlight-eligible)", () => {
    assert.equal(isViaFocus(true, "set_pane_permissions", "Auto"), false);
  });
  it("read_pane + active pane + Auto → false (not spotlight-eligible)", () => {
    assert.equal(isViaFocus(true, "read_pane", "Auto"), false);
  });

  // All false: non-spotlight + inactive + Ask
  it("close_pane + inactive pane + Ask → false", () => {
    assert.equal(isViaFocus(false, "close_pane", "Ask"), false);
  });
});
