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
import { APPROVAL_GRACE_MS } from "../src/pendingApprovals";

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

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// CARD 3V.3 — last-call ACK before reject. The pre-fix sweep stamped `lastCallAt = now` BEFORE
// narrating, and pushApprovalNarration swallows send failures — so an item could auto-reject after
// a grace window that started on a last-call NOBODY HEARD. Post-fix: the stamp follows a SUCCESSFUL
// narration push (the seam returns false on a swallowed failure); while un-narrated the item stays
// pre-last-call and the sweep retries next tick — bounded at 3 consecutive failed ticks with a
// connected session, after which we stamp anyway (a broken TTS must never hold approvals forever).
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("3V.3 last-call ack before reject — approvals leg", () => {
  const TTL = 5 * 60 * 1000;          // gating's APPROVAL_TTL_MS
  const GRACE = APPROVAL_GRACE_MS;    // 60_000
  const T0 = 1_000_000_000;

  function setup(narrate: (session: any, text: string) => boolean | void) {
    const deps = makeDeps();
    (deps as any).pushApprovalNarration = narrate;
    const gating = createGating(deps);
    const session = { sendClientContent: () => {} };
    gating.pendingApprovals.add(
      { messageId: "lc1", instruction: "rm -rf build", kind: "shell", terminalId: "t1", callId: "lc1", timestamp: T0 } as any,
      session,
    );
    return { gating, deps, session };
  }

  it("a FAILED narration does not stamp lastCallAt, and the item is NOT rejected after the would-be grace", () => {
    let narrationWorks = false;
    const spoken: string[] = [];
    const { gating } = setup((_s, text) => { if (narrationWorks) { spoken.push(text); return true; } return false; });

    // Tick 1: past TTL, connected — the sweep TRIES the last-call but the push fails.
    const t1 = T0 + TTL + 1;
    gating.sweepExpiredApprovals(t1);
    assert.strictEqual(gating.pendingApprovals.get("lc1")!.lastCallAt, undefined,
      "lastCallAt is NOT stamped on a failed narration");

    // Tick 2 — a full grace later, narration still failing: the item must STILL be pending
    // (pre-fix it would have been auto-rejected 60s after a last-call nobody heard).
    const t2 = t1 + GRACE + 1;
    gating.sweepExpiredApprovals(t2);
    assert.ok(gating.pendingApprovals.has("lc1"), "an un-narrated item is never rejected");
    assert.strictEqual(gating.pendingApprovals.get("lc1")!.lastCallAt, undefined, "still un-stamped after failure #2");

    // Tick 3: narration recovers — NOW the last-call is spoken and the stamp lands at THIS tick,
    // so the grace window starts from the moment the operator actually heard it.
    narrationWorks = true;
    const t3 = t2 + 1_000;
    gating.sweepExpiredApprovals(t3);
    assert.strictEqual(gating.pendingApprovals.get("lc1")!.lastCallAt, t3, "stamped at the SUCCESSFUL narration tick");
    assert.strictEqual(spoken.length, 1, "exactly one last-call was actually spoken");
    assert.match(spoken[0], /approve now or I'll drop it/, "the spoken line is the last-call");

    // Inside the (now real) grace: still pending. After it: the unchanged reject path runs.
    gating.sweepExpiredApprovals(t3 + GRACE);
    assert.ok(gating.pendingApprovals.has("lc1"), "inside the post-narration grace the item waits");
    gating.sweepExpiredApprovals(t3 + GRACE + 1);
    assert.strictEqual(gating.pendingApprovals.has("lc1"), false, "grace elapsed after a HEARD last-call -> rejected");
  });

  it("BOUNDED retry: 3 consecutive failed ticks with a connected session stamp lastCallAt anyway", () => {
    const { gating } = setup(() => false); // narration NEVER succeeds (broken TTS), session stays connected.

    const t1 = T0 + TTL + 1;
    const t2 = t1 + 30_000;
    const t3 = t2 + 30_000;
    gating.sweepExpiredApprovals(t1);      // failure #1
    gating.sweepExpiredApprovals(t2);      // failure #2
    assert.strictEqual(gating.pendingApprovals.get("lc1")!.lastCallAt, undefined, "two failures stay un-stamped");
    gating.sweepExpiredApprovals(t3);      // failure #3 -> stamp anyway (never wedge forever)
    assert.strictEqual(gating.pendingApprovals.get("lc1")!.lastCallAt, t3, "the 3rd consecutive failure stamps anyway");

    // The bounded stamp starts a REAL grace window; the unchanged reject path then closes it out.
    gating.sweepExpiredApprovals(t3 + GRACE + 1);
    assert.strictEqual(gating.pendingApprovals.has("lc1"), false, "a broken TTS cannot hold the approval forever");
  });
});

describe("3V.3 last-call ack before reject — pending-ACTIONS leg", () => {
  const TTL = 5 * 60 * 1000;
  const GRACE = APPROVAL_GRACE_MS;
  const T0 = 2_000_000_000;

  function setup(narrate: (session: any, text: string) => boolean | void) {
    const deps = makeDeps();
    (deps as any).pushApprovalNarration = narrate;
    (deps.coreState as any).activeLiveSession = { sendClientContent: () => {} }; // actions gate on this ref
    const gating = createGating(deps);
    gating.pendingActions.add({
      id: "act-lc", capability: "create_pane", summary: "Create pane x",
      timestamp: T0, ttlMs: TTL, run: () => "ran",
    });
    return { gating, deps };
  }

  it("a FAILED narration keeps the action pre-last-call (not expired); success stamps; then grace expires it", () => {
    let narrationWorks = false;
    const { gating } = setup(() => narrationWorks);

    const t1 = T0 + TTL + 1;
    gating.sweepExpiredApprovals(t1);                 // failed last-call: no stamp
    const t2 = t1 + GRACE + 1;
    gating.sweepExpiredApprovals(t2);                 // failure #2 — and crucially NOT expired
    assert.ok(gating.pendingActions.has("act-lc"), "an un-narrated action is never expired");

    narrationWorks = true;
    const t3 = t2 + 1_000;
    gating.sweepExpiredApprovals(t3);                 // spoken -> stamped at t3
    gating.sweepExpiredApprovals(t3 + GRACE);
    assert.ok(gating.pendingActions.has("act-lc"), "inside the post-narration grace the action waits");
    gating.sweepExpiredApprovals(t3 + GRACE + 1);
    assert.strictEqual(gating.pendingActions.has("act-lc"), false, "grace after a HEARD last-call -> expired");
  });

  it("BOUNDED retry on the actions leg: the 3rd consecutive failed tick stamps anyway", () => {
    const { gating } = setup(() => false);
    const t1 = T0 + TTL + 1;
    gating.sweepExpiredApprovals(t1);                 // failure #1
    gating.sweepExpiredApprovals(t1 + 30_000);        // failure #2
    gating.sweepExpiredApprovals(t1 + 60_000);        // failure #3 -> stamp anyway
    gating.sweepExpiredApprovals(t1 + 60_000 + GRACE + 1);
    assert.strictEqual(gating.pendingActions.has("act-lc"), false, "a broken TTS cannot hold the action forever");
  });
});
