import { describe, it } from "node:test";
import assert from "node:assert";

import {
  deriveEffectiveGates,
  derivePostureWord,
  CAPABILITY_LABELS,
  CAPABILITY_CATEGORIES,
  type PostureWord,
} from "../src/gateSurface";
import type { CapabilityGate, GateValue, CapabilityGateMap } from "../src/types";

/**
 * gateSurface — pure, frontend-safe surface derivations (spec §4, §6, §7).
 *
 * deriveEffectiveGates: the 16 effective gate values per pane, honoring
 *   override -> spotlight -> global precedence (mirrors resolveCapabilityGateWithContext).
 * derivePostureWord: OPEN | GUARDED | LOCKED per spec §7.
 * CAPABILITY_LABELS + CAPABILITY_CATEGORIES: the plain-label map (spec §6) — TOTAL over the union,
 *   no operator-facing raw identifier.
 *
 * Pure functions only — no React / PTY / server. Every assertion maps to a spec row.
 */

// The full CapabilityGate union, as the canonical source for totality assertions.
// F4 (wsm-e2e-pinned-lqb): now the WHOLE 24-row matrix — the 16 original gates plus the 6 promoted
// capabilities (read_pane / read_notes / focus_pane / compose_draft / archive_pane / clear_history).
const ALL_CAPABILITIES: CapabilityGate[] = [
  "write_to_pane", "deliver_handoff", "create_pane", "close_pane",
  "delete_pane", "delete_project",
  "restart_pane", "set_pane_permissions", "set_global_permissions",
  "set_capability_gate", "add_watch_rule", "execute_plan",
  "apply_recipe", "create_project", "update_metadata",
  "switch_context", "set_voice_mute", "dismiss_attention",
  "read_pane", "read_notes", "focus_pane",
  "compose_draft", "archive_pane", "clear_history",
];

// ---------------------------------------------------------------------------
// §7 — derivePostureWord full table incl. boundaries
// ---------------------------------------------------------------------------
describe("gateSurface — derivePostureWord (spec §7)", () => {
  // A fully-Auto effective matrix (the OPEN baseline).
  function allAuto(): Record<CapabilityGate, GateValue> {
    const out = {} as Record<CapabilityGate, GateValue>;
    for (const c of ALL_CAPABILITIES) out[c] = "Auto";
    return out;
  }

  it("all Auto + Full Auto mode => OPEN", () => {
    assert.strictEqual(derivePostureWord(allAuto(), "Full Auto"), "OPEN");
  });

  it("all Auto + Human-in-the-Loop mode => OPEN (mode alone is not friction here)", () => {
    // Posture is derived from the EFFECTIVE GATES + Read-Only short-circuit. HiTL with an all-Auto
    // effective matrix means the spotlight/override already resolved everything to Auto.
    assert.strictEqual(derivePostureWord(allAuto(), "Human-in-the-Loop"), "OPEN");
  });

  it("write_to_pane Off => LOCKED (Janus literally can't type here)", () => {
    const e = allAuto();
    e.write_to_pane = "Off";
    assert.strictEqual(derivePostureWord(e, "Full Auto"), "LOCKED");
  });

  it("Read-Only mode => LOCKED even when every gate is Auto", () => {
    assert.strictEqual(derivePostureWord(allAuto(), "Read-Only"), "LOCKED");
  });

  it("write_to_pane Ask (not Off) => GUARDED, not LOCKED", () => {
    const e = allAuto();
    e.write_to_pane = "Ask";
    assert.strictEqual(derivePostureWord(e, "Full Auto"), "GUARDED");
  });

  it("a peripheral Off (close_pane) reads GUARDED, NOT LOCKED (LOCKED reserved for can't-type)", () => {
    const e = allAuto();
    e.close_pane = "Off";
    assert.strictEqual(derivePostureWord(e, "Full Auto"), "GUARDED");
  });

  it("any single Ask => GUARDED", () => {
    for (const c of ALL_CAPABILITIES) {
      if (c === "write_to_pane") continue; // write Off/Read-Only is the LOCKED branch; Ask here is fine
      const e = allAuto();
      e[c] = "Ask";
      assert.strictEqual(derivePostureWord(e, "Full Auto"), "GUARDED", `${c}=Ask should be GUARDED`);
    }
  });

  it("LOCKED short-circuits even with other Ask/Off present (write Off wins)", () => {
    const e = allAuto();
    e.write_to_pane = "Off";
    e.close_pane = "Ask";
    assert.strictEqual(derivePostureWord(e, "Full Auto"), "LOCKED");
  });
});

// ---------------------------------------------------------------------------
// §4 — deriveEffectiveGates honors override -> spotlight -> global precedence
// (mirror the existing resolveCapabilityGateWithContext tests)
// ---------------------------------------------------------------------------
describe("gateSurface — deriveEffectiveGates precedence (spec §4)", () => {
  it("absent matrices => every capability Auto (legacy back-compat)", () => {
    const e = deriveEffectiveGates(undefined, undefined, false);
    for (const c of ALL_CAPABILITIES) assert.strictEqual(e[c], "Auto", `${c} should default Auto`);
  });

  it("global default applies when no per-pane override (off-context)", () => {
    const global: CapabilityGateMap = { write_to_pane: "Ask", close_pane: "Off" };
    const e = deriveEffectiveGates(undefined, global, false);
    assert.strictEqual(e.write_to_pane, "Ask");
    assert.strictEqual(e.close_pane, "Off");
    assert.strictEqual(e.create_project, "Auto"); // unspecified => Auto
  });

  it("SPOTLIGHT loosens productive capabilities to Auto on the active pane", () => {
    const global: CapabilityGateMap = { write_to_pane: "Ask", deliver_handoff: "Ask", close_pane: "Ask" };
    const e = deriveEffectiveGates(undefined, global, true);
    assert.strictEqual(e.write_to_pane, "Auto", "spotlight loosens write_to_pane");
    assert.strictEqual(e.deliver_handoff, "Auto", "spotlight loosens deliver_handoff");
    assert.strictEqual(e.close_pane, "Ask", "spotlight does NOT loosen destructive capabilities");
  });

  it("explicit per-pane override BEATS spotlight (both directions)", () => {
    const pane: CapabilityGateMap = { write_to_pane: "Off" };
    const global: CapabilityGateMap = { write_to_pane: "Ask" };
    // active pane, productive capability — but the explicit Off override wins over the spotlight.
    assert.strictEqual(deriveEffectiveGates(pane, global, true).write_to_pane, "Off");
    // per-pane Auto override beats a stricter global Off (deliberate exception).
    const pane2: CapabilityGateMap = { close_pane: "Auto" };
    const global2: CapabilityGateMap = { close_pane: "Off" };
    assert.strictEqual(deriveEffectiveGates(pane2, global2, false).close_pane, "Auto");
  });

  it("off-context pane keeps the gated default (no spotlight)", () => {
    const global: CapabilityGateMap = { write_to_pane: "Ask" };
    assert.strictEqual(deriveEffectiveGates(undefined, global, false).write_to_pane, "Ask");
  });
});

// ---------------------------------------------------------------------------
// §6 — CAPABILITY_LABELS TOTAL over the union (no raw identifier ever surfaces)
// ---------------------------------------------------------------------------
describe("gateSurface — CAPABILITY_LABELS totality (spec §6, NO PRODUCT JARGON)", () => {
  it("has a plain label for EVERY capability in the union (no raw identifier)", () => {
    for (const c of ALL_CAPABILITIES) {
      const label = CAPABILITY_LABELS[c];
      assert.ok(typeof label === "string" && label.length > 0, `${c} must have a plain label`);
      // A plain label is human language — it must NOT just echo the raw snake_case identifier.
      assert.notStrictEqual(label, c, `${c} renders as a raw identifier`);
      assert.ok(!/_/.test(label), `${c} label "${label}" still contains a raw identifier token`);
    }
  });

  it("has NO labels for keys outside the union (map is exactly the union)", () => {
    const keys = Object.keys(CAPABILITY_LABELS).sort();
    assert.deepStrictEqual(keys, [...ALL_CAPABILITIES].sort());
  });
});

// ---------------------------------------------------------------------------
// §6 — CAPABILITY_CATEGORIES covers all 24 exactly once (F4: 16 original + 6 promoted)
// ---------------------------------------------------------------------------
describe("gateSurface — CAPABILITY_CATEGORIES (spec §6)", () => {
  it("covers every capability exactly once across categories", () => {
    const seen: CapabilityGate[] = [];
    for (const caps of Object.values(CAPABILITY_CATEGORIES)) {
      for (const c of caps) {
        assert.ok(!seen.includes(c), `${c} appears in more than one category`);
        seen.push(c);
      }
    }
    assert.deepStrictEqual(seen.slice().sort(), [...ALL_CAPABILITIES].sort());
    assert.strictEqual(seen.length, ALL_CAPABILITIES.length);
  });

  it("category names are plain language (no raw identifier tokens)", () => {
    for (const name of Object.keys(CAPABILITY_CATEGORIES)) {
      assert.ok(!/_/.test(name), `category "${name}" contains a raw identifier token`);
    }
  });

  it("matches the spec §6 category assignment", () => {
    // spec §6 explicit mapping — F4 folds the 6 promoted caps into the matching intent groups
    // (clear_history → Destructive; archive_pane/focus_pane/compose_draft → Orientation; reads → Reading).
    const expected: Record<string, CapabilityGate[]> = {
      "Acting in a pane": ["write_to_pane", "deliver_handoff"],
      "Destructive": ["close_pane", "delete_pane", "delete_project", "restart_pane", "clear_history"],
      "Changing the locks": ["set_pane_permissions", "set_global_permissions", "set_capability_gate"],
      "Spawning work": ["create_pane", "execute_plan", "apply_recipe", "add_watch_rule"],
      "Orientation (low-risk)": ["create_project", "update_metadata", "switch_context", "set_voice_mute", "dismiss_attention", "archive_pane", "focus_pane", "compose_draft"],
      "Reading": ["read_pane", "read_notes"],
    };
    for (const [cat, caps] of Object.entries(expected)) {
      assert.ok(CAPABILITY_CATEGORIES[cat], `missing category "${cat}"`);
      assert.deepStrictEqual([...CAPABILITY_CATEGORIES[cat]].sort(), [...caps].sort(), `category "${cat}" membership`);
    }
  });
});

// ---------------------------------------------------------------------------
// Type-level: PostureWord is the closed union the chip renders.
// ---------------------------------------------------------------------------
describe("gateSurface — PostureWord enum", () => {
  it("only ever returns OPEN | GUARDED | LOCKED", () => {
    const valid: PostureWord[] = ["OPEN", "GUARDED", "LOCKED"];
    const allAuto = {} as Record<CapabilityGate, GateValue>;
    for (const c of ALL_CAPABILITIES) allAuto[c] = "Auto";
    assert.ok(valid.includes(derivePostureWord(allAuto, "Full Auto")));
    assert.ok(valid.includes(derivePostureWord(allAuto, "Read-Only")));
  });
});
