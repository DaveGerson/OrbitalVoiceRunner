// tests/test_gate_owning_project.ts
//
// BUG (surfaced by e2e/live_gates.spec.ts): per-pane capability-gate overrides only governed panes
// of the ACTIVE project. effectiveCapabilityGateFor resolved the pane override via
// `manager.ledger.getActiveProject()?.panes?.[paneId]`, so an operator's "lock down that pane" edit
// on a pane in a NON-active project was written fine but silently fell through to the global
// default until something switched server context.
//
// FIX UNDER TEST: the resolver finds the pane's OWNING project (findPaneOwningProject,
// src/gating/index.ts): live pane → manager.terminals[paneId].projectId → ledger.getProject;
// fallback → the active project; fallback → scan every ledger project for the pane id
// (ledger-only panes). Everything else is UNCHANGED: spotlight semantics still key on
// coreState.activePaneId, resolution stays the pure resolveCapabilityGateWithContext, and the
// frozen short-circuit still wins over everything.
//
// Pure unit: createGating with a structural deps bag (store: null), two projects in the fake
// ledger — "front" ACTIVE, "back" NON-active and owning the panes under test.

import { describe, it } from "node:test";
import assert from "node:assert";
import { createGating, type GatingDeps, type Gating } from "../src/gating";
import type { CapabilityGateMap } from "../src/types";

type Fixture = {
  gating: Gating;
  manager: any;
  coreState: any;
  broadcasts: Array<Record<string, unknown>>;
  /** Pane metas, mutable per test (set capabilityGates before resolving). */
  frontPane: any;
  backLive: any;
  backCold: any;
};

/**
 * Two projects: "front" is the ACTIVE project; "back" is NOT active and owns the panes under test.
 *  - back-live: a LIVE pane (manager.terminals entry carries projectId — src/terminal.ts).
 *  - back-cold: LEDGER-ONLY (no live terminal) — exercises the workspace-scan fallback.
 *  - front-1:   a live pane in the active project (regression guard for the legacy lookup).
 */
function makeFixture(globalGates: CapabilityGateMap = { restart_pane: "Ask" }): Fixture {
  const broadcasts: Array<Record<string, unknown>> = [];
  const frontPane: any = { pane_id: "front-1", permissions_mode: "Human-in-the-Loop", capabilityGates: {} };
  const backLive: any = { pane_id: "back-live", permissions_mode: "Human-in-the-Loop", capabilityGates: {} };
  const backCold: any = { pane_id: "back-cold", permissions_mode: "Human-in-the-Loop", capabilityGates: {} };
  const front: any = { id: "front", panes: { "front-1": frontPane } };
  const back: any = { id: "back", panes: { "back-live": backLive, "back-cold": backCold } };
  const workspaces: Record<string, any> = { front, back };
  const manager: any = {
    globalPermissionsMode: "Inherit",
    terminals: {
      "front-1": { projectId: "front", permissionsMode: "Human-in-the-Loop", status: "Idle" },
      "back-live": { projectId: "back", permissionsMode: "Human-in-the-Loop", status: "Idle" },
      // back-cold deliberately has NO live terminal.
    },
    settings: { advanced: { capabilityGates: globalGates } },
    ledger: {
      activeProjectId: "front",
      workspaces,
      getActiveProject: () => front,
      getProject: (id: string) => workspaces[id] ?? null,
      updatePane: () => {},
      save: () => {},
      plans: [],
      watchRules: [],
    },
  };
  const coreState: any = {
    activeFrontendWs: null,
    activeLiveSession: null,
    clients: new Set(),
    activePaneId: null,
    frozen: false,
    lastStopAllFailed: [],
    setFrozen(v: boolean) { this.frozen = v; },
  };
  const deps: GatingDeps = {
    manager,
    store: null,
    broadcast: (m: any) => broadcasts.push(m),
    broadcastLedgerUpdate: () => {},
    broadcastDraft: () => {},
    coreState,
    announcementBus: { enqueue: () => true, stop: () => {} } as any,
    pushApprovalNarration: () => {},
    sanitizeSettingsForClient: (s: any) => s,
    addCommand: () => {},
  };
  return { gating: createGating(deps), manager, coreState, broadcasts, frontPane, backLive, backCold };
}

// ---------------------------------------------------------------------------
// The bug itself: an override on a pane in a NON-active project must govern.
// ---------------------------------------------------------------------------
describe("owning-project gate resolution — overrides govern WITHOUT a context switch", () => {
  it("Auto override on a LIVE pane in a non-active project resolves Auto (not the global Ask)", () => {
    const f = makeFixture({ restart_pane: "Ask" });
    f.backLive.capabilityGates = { restart_pane: "Auto" };
    assert.strictEqual(f.gating.effectiveCapabilityGateFor("back-live", "restart_pane"), "Auto");
  });

  it("Off override ('lock down that pane') on a LIVE pane in a non-active project resolves Off", () => {
    // Global write_to_pane is absent => global default Auto; the operator's Off must still bite.
    const f = makeFixture({});
    f.backLive.capabilityGates = { write_to_pane: "Off" };
    assert.strictEqual(f.gating.effectiveCapabilityGateFor("back-live", "write_to_pane"), "Off");
  });

  it("LEDGER-ONLY pane (no live terminal) in a non-active project resolves via the project scan", () => {
    const f = makeFixture({ restart_pane: "Ask" });
    f.backCold.capabilityGates = { restart_pane: "Auto" };
    assert.strictEqual(f.gating.effectiveCapabilityGateFor("back-cold", "restart_pane"), "Auto");
    // …and the Off direction too (the safety-critical half).
    f.backCold.capabilityGates = { restart_pane: "Off" };
    assert.strictEqual(f.gating.effectiveCapabilityGateFor("back-cold", "restart_pane"), "Off");
  });

  it("a pane in the ACTIVE project still resolves its override (legacy lookup unchanged)", () => {
    const f = makeFixture({ restart_pane: "Ask" });
    f.frontPane.capabilityGates = { restart_pane: "Auto" };
    assert.strictEqual(f.gating.effectiveCapabilityGateFor("front-1", "restart_pane"), "Auto");
  });

  it("an UNKNOWN pane falls through to the global default (no phantom override)", () => {
    const f = makeFixture({ restart_pane: "Ask" });
    assert.strictEqual(f.gating.effectiveCapabilityGateFor("ghost-pane", "restart_pane"), "Ask");
  });
});

// ---------------------------------------------------------------------------
// Spotlight semantics are UNTOUCHED: keyed on coreState.activePaneId only.
// ---------------------------------------------------------------------------
describe("owning-project gate resolution — spotlight still keys on the genuinely active pane", () => {
  it("spotlight loosens Ask->Auto ONLY for the active pane; a sibling stays Ask", () => {
    const f = makeFixture({ write_to_pane: "Ask" });
    f.coreState.activePaneId = "back-live";
    assert.strictEqual(f.gating.effectiveCapabilityGateFor("back-live", "write_to_pane"), "Auto",
      "the spotlit pane is loosened");
    assert.strictEqual(f.gating.effectiveCapabilityGateFor("back-cold", "write_to_pane"), "Ask",
      "a non-active pane keeps the global default");
  });

  it("the owning project's explicit Off override BEATS the spotlight", () => {
    const f = makeFixture({ write_to_pane: "Ask" });
    f.coreState.activePaneId = "back-live";
    f.backLive.capabilityGates = { write_to_pane: "Off" };
    assert.strictEqual(f.gating.effectiveCapabilityGateFor("back-live", "write_to_pane"), "Off",
      "an explicit per-pane Off must never be spotlight-loosened — even from a non-active project");
  });
});

// ---------------------------------------------------------------------------
// The frozen short-circuit still wins over everything (STOP-ALL Stage 1).
// ---------------------------------------------------------------------------
describe("owning-project gate resolution — frozen still wins", () => {
  it("while frozen, an owning-project Auto override still resolves Off", () => {
    const f = makeFixture({ restart_pane: "Ask" });
    f.backLive.capabilityGates = { restart_pane: "Auto" };
    f.coreState.frozen = true;
    assert.strictEqual(f.gating.effectiveCapabilityGateFor("back-live", "restart_pane"), "Off");
    // Release re-exposes the matrix exactly.
    f.coreState.frozen = false;
    assert.strictEqual(f.gating.effectiveCapabilityGateFor("back-live", "restart_pane"), "Auto");
  });
});

// ---------------------------------------------------------------------------
// Lockstep mirrors: the posture surface + the action_pending payload source the
// SAME owning-project pane gates as the resolver.
// ---------------------------------------------------------------------------
describe("owning-project gate resolution — lockstep mirrors", () => {
  it("effectiveGatesForPane (chips/posture surface) reflects a non-active project's override", () => {
    const f = makeFixture({ restart_pane: "Ask" });
    f.backLive.capabilityGates = { restart_pane: "Auto", write_to_pane: "Off" };
    const gates = f.gating.effectiveGatesForPane("back-live");
    assert.strictEqual(gates.restart_pane, "Auto");
    assert.strictEqual(gates.write_to_pane, "Off");
  });

  it("gateOrDefer's action_pending payload carries the OWNING project's pane gates", () => {
    const f = makeFixture({ set_pane_permissions: "Ask" });
    f.backLive.capabilityGates = { write_to_pane: "Off" };
    const res = f.gating.gateOrDefer("set_pane_permissions", "back-live", "switch mode", () => "ran");
    assert.strictEqual(res.disposition, "deferred", "global Ask defers the action");
    const evt = f.broadcasts.find((b) => b.type === "action_pending");
    assert.ok(evt, "an action_pending frame was broadcast");
    const effectiveGates = evt!.effective_gates as Record<string, string>;
    assert.strictEqual(effectiveGates.write_to_pane, "Off",
      "the dialog's effective_gates map must reflect the owning project's override");
  });
});
