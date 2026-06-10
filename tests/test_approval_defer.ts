// CARD 4D.3 (Phase 4 Track D) — the voice "defer" verb.
//
// AUDIT FINDING: src/approvalIntent.ts REJECT_WEAK includes "skip"/"nevermind"/"stop"/"cancel" — an
// eyes-off "skip that for now, ask me later" permanently CANCELLED the staged command (claim+delete,
// unrecoverable). The trichotomy was approve/reject/clarify: there was no way to say "not now".
//
// FIX under test:
//   (a) parseApprovalIntent grows a DEFER intent (phrase table documented in src/approvalIntent.ts):
//       "later" (short utterance / "ask|remind me later" / "again later" / "it|that later"),
//       "not now"/"not right now"/"not yet", "hold on|off|that|it"/"on hold",
//       "in a minute|moment|bit|second", and "<skip|hold|wait|leave|park|pass|not> … for now".
//       Defer is checked FIRST (non-destructive, so it wins mixed signals); a NEGATOR immediately
//       before a phrase suppresses it. Bare "skip"/"skip it" resolves REJECT (card-pinned).
//   (b) gating.applyDeferral(messageId) re-arms the TTL window IN-MEMORY (rec.timestamp = now;
//       lastCallAt/lastCallFailures cleared) WITHOUT claiming/deleting, narrates "Holding it…",
//       and caps at MAX_DEFERRALS (3): the 4th defer leaves the window untouched so the normal
//       last-call → grace → expire flow proceeds (no infinite parking).
//   (c) resolvePendingActionByVoice routes defer for staged pendingActions the same way (re-arm,
//       never cancel) — previously a defer-shaped utterance would have fallen into the CANCEL branch.
//
// Runner: npx tsx --test --test-force-exit tests/test_approval_defer.ts

import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { parseApprovalIntent, MAX_DEFERRALS } from "../src/approvalIntent";
import { resolvePendingActionByVoice } from "../src/voiceApprovalRouting";
import { PendingActionStore } from "../src/pendingActions";
import { createGating, type GatingDeps } from "../src/gating";
import { APPROVAL_GRACE_MS } from "../src/pendingApprovals";
import { JanusStore } from "../src/store/sqliteStore";

const TTL = 5 * 60 * 1000; // gating's APPROVAL_TTL_MS

// ─────────────────────────────────────────────────────────────────────────────
// (a) Intent matcher — the defer phrase table, with the reject family pinned.
// ─────────────────────────────────────────────────────────────────────────────
describe("4D.3 parseApprovalIntent — defer phrases", () => {
  const deferCases: string[] = [
    "later",
    "maybe later",
    "ask me later",
    "remind me later",
    "ask again later",
    "do it later",
    "not now",
    "not right now",
    "not yet",
    "hold on",
    "hold that",
    "hold it",
    "hold off",
    "put it on hold",
    "in a minute",
    "in a moment",
    "in a bit",
    "skip for now",
    "skip that for now",
    "skip that for now, ask me later", // the exact card scenario — must NOT cancel
    "leave it for now",
    "not for now",
  ];
  for (const utter of deferCases) {
    it(`"${utter}" -> defer`, () => {
      assert.strictEqual(parseApprovalIntent(utter).intent, "defer");
    });
  }

  // Card-pinned: the bare skip family stays in the REJECT lane (no "for now" rider).
  const rejectPins: string[] = ["skip", "skip it", "skip that", "skip the command"];
  for (const utter of rejectPins) {
    it(`"${utter}" -> reject (pinned: bare skip stays reject)`, () => {
      assert.strictEqual(parseApprovalIntent(utter).intent, "reject");
    });
  }

  it("pre-existing pins keep their intent (defer must not leak into them)", () => {
    // These mirror tests/test_approvals_wse.ts rows that contain defer-adjacent words.
    assert.strictEqual(parseApprovalIntent("let me think about cancelling later maybe").intent, "none",
      "ambient speech with an embedded 'later' stays none");
    assert.strictEqual(parseApprovalIntent("cancel that command").intent, "reject");
    assert.strictEqual(parseApprovalIntent("no").intent, "reject");
    assert.strictEqual(parseApprovalIntent("yes").intent, "approve");
    assert.strictEqual(parseApprovalIntent("stop").intent, "none");
    assert.strictEqual(parseApprovalIntent("cancel").intent, "none");
  });

  it("a negator immediately before a hold-phrase suppresses the defer (conservative)", () => {
    assert.notStrictEqual(parseApprovalIntent("dont hold it").intent, "defer");
  });

  it("defer still extracts a fragment target hint (the defer keywords are not the fragment)", () => {
    const p = parseApprovalIntent("skip the npm install for now");
    assert.strictEqual(p.intent, "defer");
    assert.ok(p.targetHint?.fragment?.includes("npm install"),
      `fragment should name the target, got: ${JSON.stringify(p.targetHint)}`);
  });

  it("MAX_DEFERRALS is 3 (the no-infinite-parking cap)", () => {
    assert.strictEqual(MAX_DEFERRALS, 3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) gating.applyDeferral — TTL re-arm without claim/delete, capped at 3.
// ─────────────────────────────────────────────────────────────────────────────
const stores: JanusStore[] = [];
afterEach(() => { while (stores.length) { try { stores.pop()!.close(); } catch { /* best-effort */ } } });

function makeDeps(store: JanusStore | null, narrations: string[]): GatingDeps {
  const manager: any = {
    globalPermissionsMode: "Inherit",
    terminals: { t1: { status: "Running", writeInput: () => {} } },
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
    store,
    broadcast: () => {},
    broadcastLedgerUpdate: () => {},
    broadcastDraft: () => {},
    coreState,
    announcementBus: { enqueue: () => true, stop: () => {} } as any,
    pushApprovalNarration: (_s: any, text: string) => { narrations.push(text); return true; },
    sanitizeSettingsForClient: (s: any) => s,
    addCommand: () => {},
  };
}

describe("4D.3 gating.applyDeferral — approvals", () => {
  const T0 = 1_700_000_000_000;

  function setup(store: JanusStore | null = null) {
    const narrations: string[] = [];
    const gating = createGating(makeDeps(store, narrations));
    const session = { sendClientContent: () => {} };
    gating.pendingApprovals.add(
      { messageId: "d1", instruction: "npm run deploy", kind: "shell", terminalId: "t1", callId: "d1", timestamp: T0 } as any,
      session,
    );
    return { gating, narrations, session };
  }

  it("defer re-arms the TTL: narrates 'Holding it', clears lastCallAt, keeps the record UNCLAIMED", () => {
    const { gating, narrations } = setup();
    const rec = gating.pendingApprovals.get("d1")!;
    rec.lastCallAt = T0 + TTL + 5; // pretend a last-call already went out
    const D = T0 + TTL + 10;

    const out = gating.applyDeferral("d1", D);

    assert.strictEqual(out.reason, "deferred");
    assert.ok(gating.pendingApprovals.has("d1"), "record NOT deleted by defer");
    assert.ok(!rec.claimed, "record NOT claimed by defer (still approvable later)");
    assert.strictEqual(rec.timestamp, D, "TTL window re-armed off the defer moment");
    assert.strictEqual(rec.lastCallAt, undefined, "lastCallAt cleared — a fresh window earns a fresh last-call");
    assert.match(narrations.at(-1) ?? "", /Holding it — I'll ask again in 5 minutes\./);
  });

  it("a deferred record SURVIVES a sweep inside the old (pre-defer) expiry window", () => {
    const { gating, narrations } = setup();
    const D = T0 + TTL - 1_000; // defer just before the original TTL would cross
    gating.applyDeferral("d1", D);
    narrations.length = 0;

    // Sweep at what WOULD have been past the original TTL: must neither last-call nor expire.
    gating.sweepExpiredApprovals(T0 + TTL + 1);
    assert.ok(gating.pendingApprovals.has("d1"), "still pending inside the re-armed window");
    assert.strictEqual(gating.pendingApprovals.get("d1")!.lastCallAt, undefined, "no last-call inside the re-armed window");
    assert.strictEqual(narrations.length, 0, "sweep stays silent inside the re-armed window");

    // The re-armed window expires normally: last-call, then grace, then the unchanged expire path.
    gating.sweepExpiredApprovals(D + TTL + 1);
    assert.strictEqual(gating.pendingApprovals.get("d1")!.lastCallAt, D + TTL + 1, "fresh window earns a fresh last-call");
    gating.sweepExpiredApprovals(D + TTL + 1 + APPROVAL_GRACE_MS + 1);
    assert.strictEqual(gating.pendingApprovals.has("d1"), false, "re-armed window still ends in the normal expiry");
  });

  it("the 4th defer hits the cap: window untouched, normal last-call flow proceeds", () => {
    const { gating, narrations } = setup();
    let now = T0;
    for (let i = 0; i < MAX_DEFERRALS; i++) {
      now += 1_000;
      assert.strictEqual(gating.applyDeferral("d1", now).reason, "deferred", `defer #${i + 1} re-arms`);
    }
    const lastArm = now;
    narrations.length = 0;

    const fourth = gating.applyDeferral("d1", now + 2_000);
    assert.strictEqual(fourth.reason, "defer_limit", "the 4th defer does NOT re-arm");
    assert.strictEqual(gating.pendingApprovals.get("d1")!.timestamp, lastArm, "window left untouched at the cap");
    assert.match(narrations.at(-1) ?? "", /held|hold/i, "operator is told the hold limit is reached");
    assert.ok(gating.pendingApprovals.has("d1"), "record still pending (cap refuses the re-arm, not the record)");

    // Normal flow from the LAST armed window: last-call at TTL, expire after grace.
    gating.sweepExpiredApprovals(lastArm + TTL + 1);
    assert.strictEqual(gating.pendingApprovals.get("d1")!.lastCallAt, lastArm + TTL + 1, "normal last-call fires");
    gating.sweepExpiredApprovals(lastArm + TTL + 1 + APPROVAL_GRACE_MS + 1);
    assert.strictEqual(gating.pendingApprovals.has("d1"), false, "no infinite parking — the normal expiry closes it out");
  });

  it("unknown messageId -> not_found, no narration, no throw", () => {
    const { gating, narrations } = setup();
    narrations.length = 0;
    assert.strictEqual(gating.applyDeferral("nope").reason, "not_found");
    assert.strictEqual(narrations.length, 0);
  });

  it("durable backend: defer keeps the durable row addressable and the sweep honors the re-arm", () => {
    const store = new JanusStore(":memory:"); store.init(); stores.push(store);
    const { gating } = setup(store);
    const D = T0 + TTL + 50; // already past the durable expires_at
    gating.applyDeferral("d1", D);
    // Sweep inside the re-armed window: the durable row is enumerated (stale expires_at) but the
    // in-memory re-arm must keep it pre-last-call and pending.
    gating.sweepExpiredApprovals(D + 1_000);
    assert.ok(gating.pendingApprovals.has("d1"), "durable-backed record survives the sweep after defer");
    assert.strictEqual(gating.pendingApprovals.get("d1")!.lastCallAt, undefined, "no last-call inside the re-armed window");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) resolvePendingActionByVoice — defer must never fall into the CANCEL branch.
// ─────────────────────────────────────────────────────────────────────────────
describe("4D.3 resolvePendingActionByVoice — defer on staged actions", () => {
  function makeRoutingDeps() {
    const broadcasts: any[] = [];
    const narrations: string[] = [];
    return {
      broadcasts,
      narrations,
      deps: {
        broadcast: (m: any) => broadcasts.push(m),
        narrate: (t: string) => narrations.push(t),
        redact: (s: string) => s,
      },
    };
  }

  it("'later' on a staged action re-arms it (no cancel, no confirm, narrates Holding)", () => {
    const store = new PendingActionStore();
    let ran = 0;
    const T0 = Date.now() - 60_000;
    store.add({ id: "act_1", capability: "create_pane", summary: "Create pane x", timestamp: T0, run: () => { ran++; return "ok"; } });
    store.get("act_1")!.lastCallAt = T0 + 1; // a stale last-call must be cleared by the re-arm
    const { broadcasts, narrations, deps } = makeRoutingDeps();

    resolvePendingActionByVoice("ask me later", store, deps);

    assert.strictEqual(ran, 0, "defer never runs the effect");
    assert.ok(store.has("act_1"), "defer never cancels/claims the action");
    assert.ok(!store.get("act_1")!.claimed, "record stays unclaimed");
    assert.ok(store.get("act_1")!.timestamp > T0, "TTL window re-armed");
    assert.strictEqual(store.get("act_1")!.lastCallAt, undefined, "lastCallAt cleared on re-arm");
    assert.strictEqual(broadcasts.length, 0, "no action_resolved frame — nothing resolved");
    assert.match(narrations.at(-1) ?? "", /Holding it — I'll ask again in 5 minutes\./);
  });

  it("the 4th defer on an action refuses the re-arm (normal expiry flow takes over)", () => {
    const store = new PendingActionStore();
    store.add({ id: "act_1", capability: "create_pane", summary: "Create pane x", timestamp: Date.now(), run: () => "ok" });
    const { narrations, deps } = makeRoutingDeps();

    for (let i = 0; i < MAX_DEFERRALS; i++) resolvePendingActionByVoice("not now", store, deps);
    const armed = store.get("act_1")!.timestamp;
    narrations.length = 0;

    resolvePendingActionByVoice("not now", store, deps);
    assert.strictEqual(store.get("act_1")!.timestamp, armed, "4th defer leaves the window untouched");
    assert.ok(store.has("act_1"), "record still pending at the cap");
    assert.match(narrations.at(-1) ?? "", /held|hold/i, "operator hears the hold limit");
  });

  it("bare 'skip' still cancels a staged action (the reject lane is preserved)", () => {
    const store = new PendingActionStore();
    store.add({ id: "act_1", capability: "create_pane", summary: "Create pane x", timestamp: Date.now(), run: () => "ok" });
    const { broadcasts, deps } = makeRoutingDeps();

    resolvePendingActionByVoice("skip", store, deps);

    assert.strictEqual(store.has("act_1"), false, "bare skip stays a reject (cancel)");
    assert.deepStrictEqual(broadcasts, [{ type: "action_resolved", actionId: "act_1", outcome: "cancelled" }]);
  });
});
