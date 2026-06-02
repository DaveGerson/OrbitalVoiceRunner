// Frozen short-circuit unit suite (bead 8sq BACKEND slice, spec §3 / §2.C).
//
// The two-stage STOP-ALL's Stage 1 sets a persisted `frozen` flag whose effect is a SINGLE
// choke-point short-circuit: while frozen, EVERY capability resolves Off (capability_forbidden),
// regardless of the underlying matrix. The matrix is NEVER mutated — Release is a clean clear.
//
// This pins the PURE primitive `applyFrozenShortCircuit` that the server's gate-resolution
// choke-point (effectiveCapabilityGateFor) calls. Pure => testable without the server/PTY/Gemini.

import { describe, it } from "node:test";
import assert from "node:assert";
import { applyFrozenShortCircuit } from "../src/pendingApprovals";
import type { GateValue } from "../src/pendingApprovals";

describe("frozen short-circuit (Stage-1 freeze)", () => {
  it("forces Off for every resolved gate value while frozen", () => {
    for (const resolved of ["Auto", "Ask", "Off"] as GateValue[]) {
      assert.strictEqual(applyFrozenShortCircuit(true, resolved), "Off", `frozen forces ${resolved} -> Off`);
    }
  });

  it("is a pure pass-through when NOT frozen (legacy path unaffected)", () => {
    for (const resolved of ["Auto", "Ask", "Off"] as GateValue[]) {
      assert.strictEqual(applyFrozenShortCircuit(false, resolved), resolved, `not frozen passes ${resolved} through`);
    }
  });

  it("never mutates: the underlying resolved value is read-only (Release restores exactly)", () => {
    // Freeze hides the real value but does not change the caller's input. We assert the contract
    // by toggling frozen on the SAME resolved value and getting the real value back when cleared.
    const real: GateValue = "Ask";
    assert.strictEqual(applyFrozenShortCircuit(true, real), "Off", "masked while frozen");
    assert.strictEqual(applyFrozenShortCircuit(false, real), "Ask", "real value re-exposed after release");
  });
});
