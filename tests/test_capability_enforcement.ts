// Capability-toggle honesty — PHASE 0 registry invariants.
//
// Pure structural tests over the CapabilityDef enforcement classification (no server boot, no PTY).
// Phase 0 is metadata-only: these tests pin the honest control-type class on every capability so
// later phases (which drive the 3-way / 2-way / read-only UI off it) and future drift are caught.
//
// Runner: npx tsx --test --test-force-exit tests/test_capability_enforcement.ts

import { describe, it } from "node:test";
import assert from "node:assert";

import {
  CAPABILITY_DEFS,
  enforcementOf,
  spotlightCapabilities,
} from "../src/actions/capabilities";
import type { CapabilityEnforcement } from "../src/actions/types";

// The exact Phase 0 classification golden (20 deferrable + 6 veto + 1 informational = 27).
const ENFORCEMENT_GOLDEN: Record<string, CapabilityEnforcement> = {
  // ── deferrable (20): side-effecting, can defer-and-return → full Auto/Ask/Off (3-way) ──
  write_to_pane: "deferrable",
  deliver_handoff: "deferrable",
  send_keys: "deferrable",
  create_pane: "deferrable",
  close_pane: "deferrable",
  delete_pane: "deferrable",
  delete_project: "deferrable",
  restart_pane: "deferrable",
  clear_history: "deferrable",
  delete_orchestrator_plan: "deferrable",
  set_pane_permissions: "deferrable",
  set_global_permissions: "deferrable",
  set_capability_gate: "deferrable",
  execute_plan: "deferrable",
  apply_recipe: "deferrable",
  add_watch_rule: "deferrable",
  remove_watch_rule: "deferrable",
  create_project: "deferrable",
  update_metadata: "deferrable",
  archive_pane: "deferrable",
  // ── veto (6): synchronous/return-style; only Off is meaningful (2-way Allow/Off) ──
  read_pane: "veto",
  read_notes: "veto",
  focus_pane: "veto",
  switch_context: "veto",
  compose_draft: "veto",
  dismiss_attention: "veto",
  // ── informational (1): gating is self-defeating; read-only badge, never gated ──
  set_voice_mute: "informational",
};

describe("Phase 0 — capability enforcement classification", () => {
  it("every CapabilityDef has a defined enforcement class", () => {
    for (const d of CAPABILITY_DEFS) {
      assert.ok(
        ["deferrable", "veto", "informational"].includes(d.enforcement),
        `missing/invalid enforcement for ${d.id}: ${String(d.enforcement)}`,
      );
    }
  });

  it("enforcement matches the Phase 0 golden classification (drift guard)", () => {
    const byId = new Map(CAPABILITY_DEFS.map((d) => [d.id, d.enforcement] as const));
    for (const [capId, cls] of Object.entries(ENFORCEMENT_GOLDEN)) {
      assert.strictEqual(
        byId.get(capId),
        cls,
        `enforcement mismatch for ${capId}: expected ${cls}, got ${byId.get(capId)}`,
      );
    }
    // Every CapabilityDef has a pinned golden class (catches a new capability with no pin).
    for (const d of CAPABILITY_DEFS) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(ENFORCEMENT_GOLDEN, d.id),
        `no golden enforcement pinned for ${d.id}`,
      );
    }
    // And the golden has no extra ids that the table no longer carries.
    const defIds = new Set(CAPABILITY_DEFS.map((d) => d.id));
    for (const capId of Object.keys(ENFORCEMENT_GOLDEN)) {
      assert.ok(defIds.has(capId), `golden pins unknown capability id: ${capId}`);
    }
  });

  it("classification counts are exactly 20 deferrable / 6 veto / 1 informational (27 total)", () => {
    const counts: Record<CapabilityEnforcement, number> = { deferrable: 0, veto: 0, informational: 0 };
    for (const d of CAPABILITY_DEFS) counts[d.enforcement] += 1;
    assert.deepStrictEqual(counts, { deferrable: 20, veto: 6, informational: 1 });
    assert.strictEqual(CAPABILITY_DEFS.length, 27);
  });

  it("coherence guard: every spotlight-eligible capability is deferrable", () => {
    // A veto/informational capability must NEVER be spotlight-eligible — the spotlight loosens to
    // Auto, which only makes sense for a 3-way (deferrable) control.
    for (const cap of spotlightCapabilities()) {
      assert.strictEqual(enforcementOf(cap), "deferrable", `spotlight-eligible ${cap} must be deferrable`);
    }
    // And specifically the two known spotlight caps.
    assert.strictEqual(enforcementOf("write_to_pane"), "deferrable");
    assert.strictEqual(enforcementOf("deliver_handoff"), "deferrable");
  });

  it("set_voice_mute is informational (never gated)", () => {
    assert.strictEqual(enforcementOf("set_voice_mute"), "informational");
  });

  it("enforcementOf falls back to deferrable for unknown ids (back-compat)", () => {
    assert.strictEqual(enforcementOf("some_unknown_capability_xyz"), "deferrable");
  });
});
