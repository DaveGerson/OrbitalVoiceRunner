// Capability-toggle honesty — PHASE 2 lockstep + control-selection invariants.
//
// Pure structural tests (no server boot, no PTY, no browser). Two concerns:
//   1. LOCKSTEP: the frontend-safe CAPABILITY_ENFORCEMENT map in src/gateSurface.ts (the SINGLE source
//      the React bundle reads) must equal enforcementOf() in src/actions/capabilities.ts for ALL 27
//      caps. The map is a hand-list mirror (see gateSurface docblock for why it can't import back), so
//      this guard is what prevents the two from drifting.
//   2. CONTROL SELECTION: controlForEnforcement(cap) maps each enforcement class to the honest control
//      the matrix/chip render (deferrable→three-way, veto→two-way, informational→badge). This is the
//      browserless coverage of the per-class UI mapping (Part C).
//
// Runner: npx tsx --test --test-force-exit tests/test_capability_enforcement_lockstep.ts

import { describe, it } from "node:test";
import assert from "node:assert";

import { CAPABILITY_DEFS, enforcementOf } from "../src/actions/capabilities";
import { ALL_CAPABILITIES, CAPABILITY_ENFORCEMENT, controlForEnforcement } from "../src/gateSurface";

describe("Phase 2 — gateSurface enforcement lockstep with capabilities.ts", () => {
  it("CAPABILITY_ENFORCEMENT === enforcementOf for every capability (no drift)", () => {
    for (const cap of ALL_CAPABILITIES) {
      assert.strictEqual(
        CAPABILITY_ENFORCEMENT[cap],
        enforcementOf(cap),
        `enforcement drift for ${cap}: gateSurface=${CAPABILITY_ENFORCEMENT[cap]} capabilities=${enforcementOf(cap)}`,
      );
    }
  });

  it("CAPABILITY_ENFORCEMENT keys === the CAPABILITY_DEFS id set (27, no orphans)", () => {
    const mapKeys = Object.keys(CAPABILITY_ENFORCEMENT).slice().sort();
    const defIds = CAPABILITY_DEFS.map((d) => d.id).slice().sort();
    assert.deepStrictEqual(mapKeys, defIds, "CAPABILITY_ENFORCEMENT keys must equal the CAPABILITY_DEFS id set");
    assert.strictEqual(mapKeys.length, 27, "expected exactly 27 capabilities");
  });

  it("CAPABILITY_ENFORCEMENT keys === ALL_CAPABILITIES (frontend matrix authority)", () => {
    const mapKeys = Object.keys(CAPABILITY_ENFORCEMENT).slice().sort();
    const all = [...ALL_CAPABILITIES].slice().sort();
    assert.deepStrictEqual(mapKeys, all);
  });
});

describe("Phase 2 — controlForEnforcement honest per-class mapping", () => {
  it("maps each enforcement class to its honest control", () => {
    // deferrable → three-way
    assert.strictEqual(controlForEnforcement("write_to_pane"), "three-way");
    assert.strictEqual(controlForEnforcement("clear_history"), "three-way");
    // veto → two-way
    assert.strictEqual(controlForEnforcement("read_pane"), "two-way");
    assert.strictEqual(controlForEnforcement("focus_pane"), "two-way");
    assert.strictEqual(controlForEnforcement("switch_context"), "two-way");
    assert.strictEqual(controlForEnforcement("compose_draft"), "two-way");
    assert.strictEqual(controlForEnforcement("dismiss_attention"), "two-way");
    assert.strictEqual(controlForEnforcement("read_notes"), "two-way");
    // informational → badge
    assert.strictEqual(controlForEnforcement("set_voice_mute"), "badge");
  });

  it("every capability resolves to a valid control kind", () => {
    const valid = new Set(["three-way", "two-way", "badge"]);
    for (const cap of ALL_CAPABILITIES) {
      assert.ok(valid.has(controlForEnforcement(cap)), `${cap} → invalid control`);
    }
  });

  it("control kind agrees with the enforcement class for all 27 caps", () => {
    const expect: Record<string, string> = { deferrable: "three-way", veto: "two-way", informational: "badge" };
    for (const cap of ALL_CAPABILITIES) {
      assert.strictEqual(controlForEnforcement(cap), expect[enforcementOf(cap)], `mismatch for ${cap}`);
    }
  });

  it("falls back to three-way for an unknown capability (back-compat, never under-reports a gate)", () => {
    assert.strictEqual(controlForEnforcement("some_unknown_capability_xyz" as never), "three-way");
  });
});
