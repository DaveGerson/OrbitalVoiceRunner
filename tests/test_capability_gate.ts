import { describe, it } from "node:test";
import assert from "node:assert";

import {
  decideProposal,
  resolveCapabilityGate,
  type EffectiveMode,
  type GateValue,
  type ProposalDecision,
} from "../src/pendingApprovals";

/**
 * Capability-gate MODULATION — exhaustive behavior test.
 *
 * Proves the two composable mechanisms documented in
 * docs/design/capability-gate-worksheet.md:
 *   1. resolveCapabilityGate(paneGate, globalGate) — resolution precedence.
 *   2. decideProposal(...) — the AND-veto (most-restrictive-wins) over (mode × gate).
 *
 * Pure functions only — no PTY, no Gemini, no server. Every assertion maps to a worksheet row.
 */

// Shared fixture: a clean agent_instruction on an interactive_cli pane that exists, with a
// non-empty instruction and an allowlist that is irrelevant for agent_instruction. This isolates
// the (mode × gate) modulation from the kind/allowlist checks (covered in test_approvals_wse.ts).
const allow = new Set<string>(["git", "ls"]);
function decide(effectiveMode: EffectiveMode, gate: GateValue | undefined, over: Partial<Parameters<typeof decideProposal>[0]> = {}): ProposalDecision {
  return decideProposal({
    kind: "agent_instruction",
    instruction: "add a retry to the fetch",
    effectiveMode,
    runtimeType: "interactive_cli",
    paneExists: true,
    allowlist: allow,
    capability: "deliver_handoff",
    gate,
    ...over,
  });
}

// ---------------------------------------------------------------------------
// Mechanism 2 — the full 3×3 AND-veto truth table (the heart of the worksheet)
// ---------------------------------------------------------------------------
describe("capability gate — AND-veto truth table (mode × gate)", () => {
  // [effectiveMode, gate, expected decision type]
  const TABLE: Array<[EffectiveMode, GateValue, ProposalDecision["type"]]> = [
    ["Full Auto",          "Auto", "auto_execute"],
    ["Full Auto",          "Ask",  "pending_approval"],
    ["Full Auto",          "Off",  "capability_forbidden"],
    ["Human-in-the-Loop",  "Auto", "pending_approval"],
    ["Human-in-the-Loop",  "Ask",  "pending_approval"],
    ["Human-in-the-Loop",  "Off",  "capability_forbidden"],
    ["Read-Only",          "Auto", "blocked_read_only"],
    ["Read-Only",          "Ask",  "blocked_read_only"],
    ["Read-Only",          "Off",  "capability_forbidden"],
  ];

  for (const [mode, gate, expected] of TABLE) {
    it(`${mode} × ${gate} => ${expected}`, () => {
      assert.strictEqual(decide(mode, gate).type, expected);
    });
  }
});

// ---------------------------------------------------------------------------
// The named safety invariants the table encodes (explicit, so a regression names itself)
// ---------------------------------------------------------------------------
describe("capability gate — safety invariants", () => {
  it("Off forbids in EVERY mode (Off is top of the lattice)", () => {
    for (const mode of ["Full Auto", "Human-in-the-Loop", "Read-Only"] as EffectiveMode[]) {
      assert.strictEqual(decide(mode, "Off").type, "capability_forbidden");
    }
  });

  it("Off BEATS Read-Only (forbidden, not blocked_read_only)", () => {
    const d = decide("Read-Only", "Off");
    assert.strictEqual(d.type, "capability_forbidden");
    // and it carries the capability for the operator-facing message
    assert.strictEqual((d as any).capability, "deliver_handoff");
  });

  it("Ask CANNOT loosen Read-Only into a pending write", () => {
    assert.strictEqual(decide("Read-Only", "Ask").type, "blocked_read_only");
  });

  it("Ask TIGHTENS Full Auto (no silent auto_execute)", () => {
    assert.strictEqual(decide("Full Auto", "Ask").type, "pending_approval");
    // contrast: Auto gate leaves Full Auto transparent
    assert.strictEqual(decide("Full Auto", "Auto").type, "auto_execute");
  });

  it("a gate only ever TIGHTENS, never loosens, the mode", () => {
    // For every mode, the gated decision must be >= as restrictive as the Auto-gate baseline.
    const RANK: Record<string, number> = {
      auto_execute: 0, pending_approval: 1, blocked_read_only: 2, capability_forbidden: 3,
    };
    for (const mode of ["Full Auto", "Human-in-the-Loop", "Read-Only"] as EffectiveMode[]) {
      const base = RANK[decide(mode, "Auto").type];
      for (const gate of ["Ask", "Off"] as GateValue[]) {
        assert.ok(RANK[decide(mode, gate).type] >= base, `${mode} × ${gate} loosened the mode`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Back-compat: omitting the gate reproduces the pre-matrix (mode-only) behavior
// ---------------------------------------------------------------------------
describe("capability gate — back-compat (gate omitted => Auto/mode-only)", () => {
  const EXPECT: Array<[EffectiveMode, ProposalDecision["type"]]> = [
    ["Full Auto", "auto_execute"],
    ["Human-in-the-Loop", "pending_approval"],
    ["Read-Only", "blocked_read_only"],
  ];
  for (const [mode, expected] of EXPECT) {
    it(`${mode} with gate=undefined => ${expected} (legacy)`, () => {
      assert.strictEqual(decide(mode, undefined).type, expected);
    });
  }
});

// ---------------------------------------------------------------------------
// Edge cases: existence/empty checks outrank the gate
// ---------------------------------------------------------------------------
describe("capability gate — edge cases (precedence over the gate)", () => {
  it("missing pane => error_no_pane even with gate=Off", () => {
    assert.strictEqual(decide("Full Auto", "Off", { paneExists: false }).type, "error_no_pane");
  });

  it("empty instruction => clarify in every mode, before auto_execute can fire", () => {
    assert.strictEqual(decide("Full Auto", "Auto", { instruction: "   " }).type, "clarify_shell");
  });
});

// ---------------------------------------------------------------------------
// Mechanism 1 — resolution precedence (pane override > global > Auto)
// ---------------------------------------------------------------------------
describe("capability gate — resolveCapabilityGate precedence", () => {
  const CASES: Array<[GateValue | undefined, GateValue | undefined, GateValue, string]> = [
    ["Ask",  undefined, "Ask",  "pane override wins (no global)"],
    ["Ask",  "Auto",    "Ask",  "pane override wins over global"],
    ["Off",  "Auto",    "Off",  "pane override wins even when global is looser"],
    ["Auto", "Off",     "Auto", "pane override wins even when global is stricter (explicit exception)"],
    [undefined, "Ask",  "Ask",  "no pane override => global default applies"],
    [undefined, "Off",  "Off",  "no pane override => global Off applies"],
    [undefined, undefined, "Auto", "absent matrix => Auto (legacy mode-only)"],
  ];
  for (const [pane, global, expected, why] of CASES) {
    it(`pane=${pane ?? "—"} global=${global ?? "—"} => ${expected}  (${why})`, () => {
      assert.strictEqual(resolveCapabilityGate(pane, global), expected);
    });
  }
});

// ---------------------------------------------------------------------------
// End-to-end modulation: resolve THEN decide (the two mechanisms composed, as the server does)
// ---------------------------------------------------------------------------
describe("capability gate — resolve+decide composed (server path shape)", () => {
  it("global Auto + per-pane Off on a Full-Auto pane => forbidden (the director's gate dial)", () => {
    const gate = resolveCapabilityGate("Off", "Auto");
    assert.strictEqual(decide("Full Auto", gate).type, "capability_forbidden");
  });

  it("global Off + per-pane Auto on a Full-Auto pane => auto_execute (per-pane exception holds)", () => {
    const gate = resolveCapabilityGate("Auto", "Off");
    assert.strictEqual(decide("Full Auto", gate).type, "auto_execute");
  });

  it("global Ask, no per-pane, on a Full-Auto pane => pending (matrix default tightens the pane)", () => {
    const gate = resolveCapabilityGate(undefined, "Ask");
    assert.strictEqual(decide("Full Auto", gate).type, "pending_approval");
  });
});
