// tests/test_vcd_producer_dispatch.ts — fikj.11 RED, producer 1: renderApproved records the
// "Dispatching now" DISPATCH claim + the a2tp ships-now ordering fix (Exited pane -> honest
// renderDeadPane FIRST claim, never an optimistic claim needing retraction).
//
// Harness: the tests/test_turn_arbiter_deadlines.ts real-gating/fake-boundaries idiom.
// Runner: npx tsx --test --test-force-exit tests/test_vcd_producer_dispatch.ts
import { test } from "node:test";
import assert from "node:assert";
import { createGating } from "../src/gating";

type AnyRec = Record<string, any>;
const T0 = 1_700_000_000_000;

function captureLedger() {
  const records: AnyRec[] = [];
  const invalidations: AnyRec[] = [];
  return {
    records, invalidations,
    record: (c: AnyRec) => { records.push(c); },
    invalidate: (ref: string, groundTruth: string, opts?: AnyRec) => {
      invalidations.push({ ref, groundTruth, opts });
      return { corrected: true };
    },
    latestSpokenClaim: (_p: string) => undefined,
  };
}

function makeHarness(opts: { ledger?: AnyRec; paneStatus?: string; pushOk?: boolean } = {}) {
  const narrations: string[] = [];
  const broadcasts: AnyRec[] = [];
  const writes: string[] = [];
  const session = { sendClientContent: () => {} };
  const manager: AnyRec = {
    globalPermissionsMode: "Inherit",
    terminals: {
      t1: {
        status: opts.paneStatus ?? "Running",
        writeInput: (cmd: string) => { writes.push(cmd); },
        stop: async () => {},
      },
    },
    settings: { advanced: { capabilityGates: {} } },
    ledger: {
      activeProjectId: "default_project",
      getActiveProject: () => undefined,
      getDraft: () => undefined,
      setDraft: () => {},
      plans: [], watchRules: [], save: () => {},
    },
  };
  const coreState: AnyRec = {
    activeFrontendWs: null, activeLiveSession: session, clients: new Set(),
    activePaneId: null, frozen: false, lastStopAllFailed: [], setFrozen: () => {},
  };
  const deps: any = {
    manager, store: null,
    broadcast: (m: AnyRec) => broadcasts.push(m),
    broadcastLedgerUpdate: () => {}, broadcastDraft: () => {},
    coreState,
    announcementBus: { enqueue: () => true, stop: () => {} },
    pushApprovalNarration: (_s: any, text: string) => { narrations.push(text); return opts.pushOk ?? true; },
    sanitizeSettingsForClient: (s: any) => s,
    addCommand: () => {},
    ...(opts.ledger ? { correctionLedger: opts.ledger } : {}),
  };
  const gating: AnyRec = createGating(deps);
  return { gating, narrations, broadcasts, writes, session, manager };
}

function addApproval(h: AnyRec, id = "d1", session: AnyRec | null = h.session): void {
  h.gating.pendingApprovals.add(
    { messageId: id, instruction: "npm run deploy", kind: "shell", terminalId: "t1", callId: id, timestamp: T0 } as any,
    session,
  );
}

test("AC1: an approved dispatch records ONE spoken dispatch claim after the write + narration", () => {
  const led = captureLedger();
  const h = makeHarness({ ledger: led });
  addApproval(h);
  h.gating.applyResolution("d1", "approve");
  assert.deepStrictEqual(h.writes, ["npm run deploy"], "the write landed");
  assert.ok(h.narrations.some(n => n.includes("Dispatching now")), "the post-dispatch narration fired");
  assert.strictEqual(led.records.length, 1, "fikj.11 feature absent: renderApproved must record the dispatch claim");
  const claim = led.records[0];
  assert.strictEqual(claim.claimId, "dispatch:d1", "claimId is the approval messageId — the a2tp invalidate handle");
  assert.strictEqual(claim.paneId, "t1");
  assert.strictEqual(claim.kind, "dispatch");
  assert.strictEqual(claim.spoken, true, "a successful narration push == a spoken claim");
  assert.ok(claim.assertedText.includes("Dispatching now"));
  assert.strictEqual(led.invalidations.length, 0, "negative fixture: a clean dispatch is never self-corrected");
});

test("a failed narration push records spoken:false (3V.3 — the operator never heard the claim)", () => {
  const led = captureLedger();
  const h = makeHarness({ ledger: led, pushOk: false });
  addApproval(h);
  h.gating.applyResolution("d1", "approve");
  assert.strictEqual(led.records.length, 1);
  assert.strictEqual(led.records[0].spoken, false, "unheard -> a later invalidate must skip (never-spoken rule)");
});

test("no live session records spoken:false (bookkeeping only — nothing to retract)", () => {
  const led = captureLedger();
  const h = makeHarness({ ledger: led });
  addApproval(h, "d1", null);
  h.gating.applyResolution("d1", "approve");
  assert.strictEqual(led.records.length, 1);
  assert.strictEqual(led.records[0].spoken, false);
  assert.strictEqual(h.narrations.length, 0);
});

test("ships-now ordering: an Exited-but-present pane renders the DEAD-PANE truth, no write, no claim", () => {
  const led = captureLedger();
  const h = makeHarness({ ledger: led, paneStatus: "Exited" });
  addApproval(h);
  h.gating.applyResolution("d1", "approve");
  assert.deepStrictEqual(h.writes, [], "writeInput must NOT buffer into a dead pane");
  assert.ok(h.narrations.some(n => n.includes("could not dispatch")),
    "the honest failure is the FIRST claim (renderDeadPane), not a retraction-needing 'Dispatching now'");
  assert.ok(!h.narrations.some(n => n.includes("Dispatching now")));
  assert.strictEqual(led.records.length, 0, "no optimistic claim exists to retract");
  // renderDeadPane's REAL broadcast: WS_EVT.BLOCKED === "command_blocked" + the exact reason string
  // (src/gating/index.ts renderDeadPane) — intent preserved: the UI sees the blocked outcome.
  assert.ok(h.broadcasts.some(b => b.type === "command_blocked" && b.reason === "Target pane missing."),
    "the UI sees the blocked outcome");
});

test("no ledger injected (legacy harness) -> byte-identical approve behavior, no throw", () => {
  const h = makeHarness({});
  addApproval(h);
  const r = h.gating.applyResolution("d1", "approve");
  assert.strictEqual(r.reason, "approved");
  assert.deepStrictEqual(h.writes, ["npm run deploy"]);
});
