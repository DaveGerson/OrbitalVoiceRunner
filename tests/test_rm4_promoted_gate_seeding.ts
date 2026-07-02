// rm4 — seed the 6 promoted capabilities into DEFAULT_CAPABILITY_GATES so get_pane_gates reports
// their DECLARED CAPABILITY_DEFS default instead of the resolver's `?? "Auto"` fallback.
//
// Scope, strictly: promoted caps ONLY (read_pane, read_notes, focus_pane, compose_draft,
// archive_pane, clear_history). The resolver fallback itself (resolveCapabilityGateWithContext /
// gateSurface.resolveOne) is UNTOUCHED — this test proves the seeding is a no-op for EFFECTIVE
// gating (seeded value === prior fallback value for every promoted cap on a fresh/unseeded pane),
// and that the 16 original capabilities' reported defaults are byte-identical to before.
//
// Runner: npx tsx --test --test-force-exit tests/test_rm4_promoted_gate_seeding.ts

import { describe, it } from "node:test";
import assert from "node:assert";

import { DEFAULT_CAPABILITY_GATES } from "../src/types";
import type { CapabilityGate, GateValue } from "../src/types";
import { CAPABILITY_DEFS, CAPABILITY_DEF_BY_ID } from "../src/actions/capabilities";
import { ALL_CAPABILITIES } from "../src/gateSurface";
import { resolveCapabilityGateWithContext } from "../src/pendingApprovals";
import { getPaneGates } from "../src/actions/defs/reads";
import type { ActionContext } from "../src/actions/types";
import { PendingApprovalStore } from "../src/pendingApprovals";
import { PendingActionStore } from "../src/pendingActions";

const PROMOTED: CapabilityGate[] = [
  "read_pane",
  "read_notes",
  "focus_pane",
  "compose_draft",
  "archive_pane",
  "clear_history",
];

// The 16 original capabilities' DEFAULT_CAPABILITY_GATES entries, captured BEFORE this rm4 seeding
// change (types.ts). rm4 scope is strictly the 6 promoted caps — these must stay byte-identical.
const ORIGINAL_16_SNAPSHOT: Record<string, GateValue> = {
  write_to_pane: "Ask",
  deliver_handoff: "Ask",
  create_pane: "Ask",
  close_pane: "Ask",
  delete_pane: "Ask",
  delete_project: "Ask",
  restart_pane: "Ask",
  set_pane_permissions: "Ask",
  set_global_permissions: "Ask",
  set_capability_gate: "Ask",
  add_watch_rule: "Ask",
  execute_plan: "Ask",
  apply_recipe: "Ask",
  create_project: "Auto",
  update_metadata: "Auto",
  switch_context: "Auto",
  set_voice_mute: "Auto",
  dismiss_attention: "Auto",
};

describe("rm4 — promoted-capability gate seeding", () => {
  it("all 6 promoted caps are now EXPLICITLY present in DEFAULT_CAPABILITY_GATES", () => {
    for (const cap of PROMOTED) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(DEFAULT_CAPABILITY_GATES, cap),
        `${cap} must be seeded in DEFAULT_CAPABILITY_GATES (was previously absent, relying on the resolver fallback)`
      );
    }
  });

  it("each seeded promoted-cap value matches its CAPABILITY_DEFS declared defaultGate", () => {
    for (const cap of PROMOTED) {
      const declared = CAPABILITY_DEF_BY_ID.get(cap)?.defaultGate;
      assert.ok(declared, `CAPABILITY_DEFS must declare a defaultGate for ${cap}`);
      assert.strictEqual(
        DEFAULT_CAPABILITY_GATES[cap],
        declared,
        `DEFAULT_CAPABILITY_GATES.${cap} must equal CAPABILITY_DEFS defaultGate (${declared})`
      );
    }
  });

  it("the 16 original capabilities' DEFAULT_CAPABILITY_GATES entries are UNCHANGED (rm4 scope: promoted caps only)", () => {
    for (const [cap, expected] of Object.entries(ORIGINAL_16_SNAPSHOT)) {
      assert.strictEqual(
        DEFAULT_CAPABILITY_GATES[cap as CapabilityGate],
        expected,
        `${cap}'s default must be untouched by the rm4 promoted-cap seeding`
      );
    }
  });

  it("HARD CONSTRAINT: seeding is a no-op for EFFECTIVE gating — resolver output is IDENTICAL with vs. without the seed, for every NEWLY-seeded promoted cap, on a fresh/unseeded pane (no override), active or inactive", () => {
    // clear_history was already seeded pre-rm4 (2S.1) — it is not part of THIS change's "was
    // absent, now present" delta, so it is excluded from the before/after fallback comparison
    // (its no-op property was already pinned by the 2S.1 change, not this one).
    const NEWLY_SEEDED = PROMOTED.filter((c) => c !== "clear_history");
    for (const cap of NEWLY_SEEDED) {
      for (const isActivePane of [false, true]) {
        const withoutSeed = resolveCapabilityGateWithContext(
          undefined, // no pane override (fresh/unseeded pane)
          undefined, // pre-rm4: capability absent from the global map -> resolver falls back
          cap,
          isActivePane
        );
        const withSeed = resolveCapabilityGateWithContext(
          undefined,
          DEFAULT_CAPABILITY_GATES[cap], // post-rm4: explicit seeded global value
          cap,
          isActivePane
        );
        assert.strictEqual(
          withSeed,
          withoutSeed,
          `${cap} (isActivePane=${isActivePane}): seeding must not change the resolved effective gate`
        );
      }
    }
  });

  it("no orphans: DEFAULT_CAPABILITY_GATES only ever contains real CapabilityGate keys and CAPABILITY_DEFS' promoted rows are all covered", () => {
    const capabilityDefIds = new Set(CAPABILITY_DEFS.map((d) => d.id));
    for (const key of Object.keys(DEFAULT_CAPABILITY_GATES)) {
      assert.ok(capabilityDefIds.has(key as CapabilityGate), `DEFAULT_CAPABILITY_GATES key ${key} must be a real capability`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// get_pane_gates reports the DECLARED default for a fresh/unseeded pane on an unseeded store
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A bare ActionContext whose effectiveCapabilityGateFor is wired to the REAL resolver
 * (resolveCapabilityGateWithContext) fed by the REAL DEFAULT_CAPABILITY_GATES as the global map and
 * NO pane override (paneGate always undefined) — i.e. exactly what a fresh, unseeded store/pane
 * resolves to. isActivePane is always false (no spotlight loosening in play for this assertion).
 */
function makeFreshStoreCtx(): ActionContext {
  const manager = {} as unknown as ActionContext["manager"];
  return {
    manager,
    session: null,
    callId: "call_test",
    trigger: "test",
    surface: "voice",
    userUtterance: "",
    broadcast: () => {},
    broadcastLedgerUpdate: () => {},
    gateOrDefer: () => ({ disposition: "run" }),
    dispatchProposal: (a) => ({ kind: "executed", text: `executed on ${a.targetId}` }),
    gateCapability: () => ({ forbidden: false, gate: "Auto" }),
    redact: (s) => s,
    getActivePaneId: () => null,
    setActivePane: () => {},
    activeDraftTarget: () => null,
    broadcastDraft: () => {},
    broadcastTerminalsUpdated: () => {},
    effectiveCapabilityGateFor: (_paneId: string | null | undefined, capability: CapabilityGate): GateValue =>
      resolveCapabilityGateWithContext(undefined, DEFAULT_CAPABILITY_GATES[capability], capability, false),
    pruneAttention: () => {},
    pendingApprovals: new PendingApprovalStore(null),
    pendingActions: new PendingActionStore(null),
    applyResolution: () => ({ reason: "not_found", doWrite: false }),
    store: {} as unknown as ActionContext["store"],
    sanitizeSettingsForClient: (settings) => settings,
    recipes: [],
    stopAll: async () => [],
    releaseStopAll: () => {},
    isFrozen: () => false,
    runningPaneIds: () => [],
    posturePayloadForPane: (id) => ({ id, effective_gates: {} as never, posture: undefined }),
  };
}

describe("rm4 — get_pane_gates reports declared defaults on a fresh/unseeded store", () => {
  it("every promoted cap reports its CAPABILITY_DEFS declared default (not a stale/undeclared Auto-by-coincidence)", async () => {
    const ctx = makeFreshStoreCtx();
    const res = await getPaneGates.handler({ pane_id: "p1" }, ctx);
    assert.strictEqual(res.kind, "ok");
    const out = (res as { output: { gates: Record<string, GateValue> } }).output;
    for (const cap of PROMOTED) {
      const declared = CAPABILITY_DEF_BY_ID.get(cap)?.defaultGate;
      assert.strictEqual(out.gates[cap], declared, `get_pane_gates must report ${cap}'s declared default (${declared})`);
    }
  });

  it("every original (non-promoted) capability's reported default is unchanged from its CAPABILITY_DEFS declared default", async () => {
    const ctx = makeFreshStoreCtx();
    const res = await getPaneGates.handler({ pane_id: "p1" }, ctx);
    assert.strictEqual(res.kind, "ok");
    const out = (res as { output: { gates: Record<string, GateValue> } }).output;
    for (const cap of ALL_CAPABILITIES) {
      if (PROMOTED.includes(cap)) continue;
      const declared = CAPABILITY_DEF_BY_ID.get(cap)?.defaultGate;
      assert.strictEqual(out.gates[cap], declared, `${cap}'s report must still equal its declared default`);
    }
  });
});
