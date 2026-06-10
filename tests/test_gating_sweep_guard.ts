// CARD 1C.4 (Phase 1 Track C): the TTL sweep must never be able to kill the process.
//
// AUDIT FINDING: startSweepTimer arms `setInterval(sweepExpiredApprovals, 30s)` and the sweep
// body hits better-sqlite3 (PendingApprovalStore.expired -> store.getExpiredApprovals) with no
// try/catch — a transient SQLITE_BUSY on a tick was an uncaughtException that took down the
// whole server. The fix wraps the sweep body (the exact function the interval invokes) in a
// non-fatal try/catch that logs `[gating] sweep failed (non-fatal): ...` and returns.
//
// Pure unit: createGating with a minimal structural deps bag (store: null so the boot hydration
// is a no-op), then force the approval store's expired() to throw exactly like a busy SQLite
// read would, and assert the sweep tick swallows it.

import { describe, it } from "node:test";
import assert from "node:assert";
import { createGating, type GatingDeps } from "../src/gating";

function makeDeps(): GatingDeps {
  const manager: any = {
    globalPermissionsMode: "Inherit",
    terminals: {},
    settings: { advanced: { capabilityGates: {} } },
    ledger: {
      activeProjectId: "default_project",
      getActiveProject: () => undefined,
      plans: [],
      watchRules: [],
      save: () => {},
    },
  };
  const coreState: any = {
    activeFrontendWs: null,
    activeLiveSession: null,
    clients: new Set(),
    activePaneId: null,
    frozen: false,
    lastStopAllFailed: [],
    setFrozen: () => {},
  };
  return {
    manager,
    store: null,
    broadcast: () => {},
    broadcastLedgerUpdate: () => {},
    broadcastDraft: () => {},
    coreState,
    announcementBus: { enqueue: () => true, stop: () => {} } as any,
    pushApprovalNarration: () => {},
    sanitizeSettingsForClient: (s: any) => s,
    addCommand: () => {},
  };
}

describe("1C.4 sweep guard — a throwing store must not escape the sweep tick", () => {
  it("a sweep tick whose approval store throws (SQLITE_BUSY) does not throw out of the callback", () => {
    const gating = createGating(makeDeps());
    // Simulate the durable read failing mid-tick exactly where the audit found it: the sweep's
    // first store touch (pendingApprovals.expired -> store.getExpiredApprovals).
    (gating.pendingApprovals as any).expired = () => {
      const err: any = new Error("database is locked");
      err.code = "SQLITE_BUSY";
      throw err;
    };
    assert.doesNotThrow(() => gating.sweepExpiredApprovals(), "the sweep tick must be non-fatal");
  });

  it("a healthy sweep tick still runs (guard does not mask normal operation)", () => {
    const gating = createGating(makeDeps());
    // No pending approvals/actions: the sweep is a clean no-op and must not throw either.
    assert.doesNotThrow(() => gating.sweepExpiredApprovals());
  });

  it("the pending-ACTIONS leg is covered by the same guard", () => {
    const gating = createGating(makeDeps());
    (gating.pendingActions as any).expired = () => {
      throw new Error("database is locked (actions leg)");
    };
    assert.doesNotThrow(() => gating.sweepExpiredApprovals(), "an actions-leg throw is also non-fatal");
  });
});
