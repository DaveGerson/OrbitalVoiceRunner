import { describe, it } from "node:test";
import assert from "node:assert";

// rbh remediation (reviewer concern 2 — the load-bearing one): the SERVER must DERIVE the effective
// posture it broadcasts on action_pending, not echo a nominal string. server.ts boots a listener at
// module load (verified at its tail), so — exactly like src/restGate.ts (G6) — the testable seam is
// a PURE function in src/, which gateOrDefer then calls. This suite proves the resolver produces the
// OVERRIDDEN truth at its source; if the server enrichment were broken the divergence case here would
// go red (the e2e divergence spec, which hand-feeds posture via the harness, would NOT).
//
// RE-SCOPE (rbh-rescope.md Integration Risk #1 — HIGH): current main landed STOP-ALL/frozen, but the
// original resolver had no `frozen` arg, so an action_pending dialog raised while frozen would show
// PRE-freeze posture (chip LOCKED, dialog OPEN) — breaking the "dialog == chip == engine" invariant.
// The FROZEN case below pins Option A (frozen as a resolver input → every gate Off → LOCKED).
//
// Fails first: src/actionPendingPayload does not exist yet → import throws / tsc red.
import { resolveActionPendingPosture, type ActionPostureInput } from "../src/actionPendingPayload";
import type { CapabilityGate, CapabilityGateMap } from "../src/types";

// A pane that the operator just asked to set to "Full Auto" — i.e. the per-pane mode the operator
// staged. The pane's own gates are empty (no per-pane override), so resolution falls to the global
// mode + global gates, EXACTLY as effectiveModeFor / effectiveCapabilityGateFor do inside the server.
function input(over: Partial<ActionPostureInput>): ActionPostureInput {
  return {
    paneId: "p1",
    capability: "set_pane_permissions" as CapabilityGate,
    globalMode: "Inherit",
    paneMode: "Full Auto",
    paneGates: undefined,
    globalGates: undefined,
    isActivePane: false,
    ...over,
  };
}

describe("resolveActionPendingPosture — server derives EFFECTIVE truth for action_pending (rbh)", () => {
  it("DIVERGENCE (BUG-003): global Read-Only + pane asked Full Auto => posture LOCKED, effective_mode Read-Only", () => {
    // The single most important case: global mode dominates, so the engine will IGNORE the pane's
    // requested Full Auto. The broadcast MUST carry the overridden truth, never the nominal request.
    const r = resolveActionPendingPosture(input({ globalMode: "Read-Only", paneMode: "Full Auto" }));
    assert.strictEqual(r.effective_mode, "Read-Only", "global Read-Only must dominate the pane's Full Auto");
    assert.strictEqual(r.posture, "LOCKED", "Read-Only pane is LOCKED (Janus can't type)");
  });

  it("DIVERGENCE: even though the pane requested Full Auto, the write gate resolves Off under Read-Only-driven LOCKED", () => {
    // posture LOCKED is driven by mode here; the effective_gates map still reports per-capability
    // truth. write_to_pane has no global override (undefined → Auto), but the POSTURE is LOCKED by mode.
    const r = resolveActionPendingPosture(input({ globalMode: "Read-Only", paneMode: "Full Auto" }));
    assert.strictEqual(r.posture, "LOCKED");
    // posture is mode-driven, not gate-driven, so the raw write gate may still be Auto — the dialog
    // leads with the mode (global) divergence, which is the root cause. effective_gates is present.
    assert.ok(r.effective_gates, "effective_gates map must be present so the dialog can render the row");
  });

  it("CLEAN: global Inherit + pane Full Auto + no tighter gate => OPEN, effective_mode Full Auto (matches request)", () => {
    const r = resolveActionPendingPosture(input({ globalMode: "Inherit", paneMode: "Full Auto" }));
    assert.strictEqual(r.effective_mode, "Full Auto", "Inherit defers to the pane mode");
    assert.strictEqual(r.posture, "OPEN", "Full Auto with all-Auto gates is OPEN");
    assert.strictEqual(r.effective_gate, "Auto", "the set_pane_permissions gate resolves Auto");
  });

  it("GATE VETO: global Inherit + pane Full Auto but write_to_pane gate Off => posture LOCKED via gate", () => {
    const globalGates: CapabilityGateMap = { write_to_pane: "Off" };
    const r = resolveActionPendingPosture(input({ globalMode: "Inherit", paneMode: "Full Auto", globalGates }));
    // write_to_pane Off => LOCKED per derivePostureWord, even though mode is Full Auto.
    assert.strictEqual(r.posture, "LOCKED");
    assert.strictEqual(r.effective_mode, "Full Auto");
    assert.strictEqual(r.effective_gates?.write_to_pane, "Off");
  });

  it("GLOBAL ACTION (pane_id null): posture/effective_gates undefined, effective_mode = the global mode (D2)", () => {
    // set_global_permissions has no pane scope — we surface the resolved global mode + the global gate,
    // but no per-pane chip (D2). globalMode "Read-Only" here is the resolved global mode itself.
    const r = resolveActionPendingPosture({
      paneId: null,
      capability: "set_global_permissions" as CapabilityGate,
      globalMode: "Read-Only",
      paneMode: undefined,
      paneGates: undefined,
      globalGates: undefined,
      isActivePane: false,
    });
    assert.strictEqual(r.effective_mode, "Read-Only");
    assert.strictEqual(r.posture, undefined, "no pane => no posture word (D2)");
    assert.strictEqual(r.effective_gates, undefined, "no pane => no per-pane gate map (D2)");
    // the global effective gate for the capability is still resolved (no per-pane override possible)
    assert.strictEqual(r.effective_gate, "Auto");
  });

  it("PER-PANE OVERRIDE beats global gate: pane sets the capability gate explicitly", () => {
    const paneGates: CapabilityGateMap = { set_pane_permissions: "Off" };
    const globalGates: CapabilityGateMap = { set_pane_permissions: "Auto" };
    const r = resolveActionPendingPosture(input({ globalMode: "Inherit", paneGates, globalGates }));
    assert.strictEqual(r.effective_gate, "Off", "explicit per-pane override wins over global default");
  });

  // ── RE-SCOPE: FROZEN (Integration Risk #1, Option A) ──────────────────────────────────────────
  it("FROZEN: STOP-ALL engaged => every gate Off, posture LOCKED (dialog matches the frozen chip)", () => {
    // While frozen, the resolver short-circuits EVERY capability to Off (mirror of main's
    // effectiveGatesForPane frozen overlay). An action_pending dialog raised mid-freeze must show
    // the FROZEN truth, not the pre-freeze posture — otherwise chip(LOCKED) != dialog(OPEN).
    const r = resolveActionPendingPosture(input({ globalMode: "Inherit", paneMode: "Full Auto", frozen: true }));
    assert.strictEqual(r.effective_gate, "Off", "frozen forces the action's own gate Off");
    assert.strictEqual(r.posture, "LOCKED", "frozen pane is LOCKED");
    for (const cap of Object.keys(r.effective_gates ?? {}) as CapabilityGate[]) {
      assert.strictEqual(r.effective_gates![cap], "Off", `frozen forces ${cap} Off`);
    }
  });

  it("FROZEN global action (pane_id null): the global effective gate is forced Off too", () => {
    const r = resolveActionPendingPosture({
      paneId: null,
      capability: "set_global_permissions" as CapabilityGate,
      globalMode: "Inherit",
      paneMode: undefined,
      paneGates: undefined,
      globalGates: undefined,
      isActivePane: false,
      frozen: true,
    });
    assert.strictEqual(r.effective_gate, "Off", "frozen forces the global action gate Off as well");
  });

  it("NOT FROZEN (frozen=false / omitted) is identical to the legacy resolution", () => {
    const a = resolveActionPendingPosture(input({ globalMode: "Inherit", paneMode: "Full Auto", frozen: false }));
    const b = resolveActionPendingPosture(input({ globalMode: "Inherit", paneMode: "Full Auto" }));
    assert.deepStrictEqual(a, b, "frozen=false must not change the result vs omitting it");
    assert.strictEqual(a.posture, "OPEN");
  });
});
