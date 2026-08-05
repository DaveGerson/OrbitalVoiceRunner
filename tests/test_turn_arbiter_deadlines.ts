// tests/test_turn_arbiter_deadlines.ts — Wave 2 RED: the FIVE gating timer narrations become
// class-2 arbiter submissions with honest deadlines (D1 "the deadline waits for you").
//
// Spec: docs/superpowers/specs/2026-07-29-turn-arbiter-design.md §3.3 rows 1-2, §4-W2;
// audit docs/design/2026-07-29-comm-flow-smoothness-audit.md §2.1 (the un-gated narration family).
// The Wave-1 arbiter (src/voice/turnArbiter.ts) is REAL here — these tests exercise the real
// createGating + the real createTurnArbiter with fake time; only true boundaries are faked
// (live session, store, broadcast sinks). A minimal capture-stub arbiter is used ONLY to pin the
// exact submission shape at the gating→arbiter seam.
//
// ── Pinned Wave-2 contract (the implementer builds EXACTLY this seam) ──────────────────────────
//   GatingDeps gains ONE new OPTIONAL member (the "one-signature change" at the injected-slot
//   indirection, src/gating/index.ts:110 area):
//     turnArbiter?: {
//       submit(item: { facts: string; cls: 0|1|2|3|4|5; paneId?: string; coalesceKey?: string;
//                      deadline?: { expiresAt: number; onExpirySwap: string } }): void;
//       floorPausedMs(coalesceKey: string): number;
//     }
//   With turnArbiter present, the FIVE timer-driven call sites STOP forcing an immediate spoken
//   turn through pushApprovalNarration and instead submit class-2 facts:
//     1. approval sweep last-call      → cls 2, coalesceKey "last-call:<messageId>",
//        deadline { expiresAt: sweepNow + APPROVAL_GRACE_MS, onExpirySwap: honest expiry facts }.
//        lastCallAt is stamped on a successful submit (3V.3 "heard" semantics carry over: the
//        arbiter is never-drop, so submission == guaranteed delivery).
//     2. pending-action sweep last-call → cls 2, coalesceKey containing the action id, same
//        deadline shape, lastCallAt stamped on submit.
//     3. autonomy-window T-minus warning → cls 2, deadline.expiresAt === window.expires_at,
//        onExpirySwap = the honest "window ended" facts; warned_at stamped on submit.
//     4. autonomy-window expiry notice  → cls 2 (facts: window ended, back to asking first).
//     5. approval TTL-expiry notice (renderExpired reached via the sweep's reject leg) → cls 2
//        with coalesceKey "last-call:<messageId>" — the SAME identity as the last-call, so a
//        stale queued last-call COALESCES into the honest expiry notice (latest-wins).
//   D1 floor-pause consult: before the sweep expires an approval (the "reject" leg), it consults
//   turnArbiter.floorPausedMs("last-call:<messageId>") and extends the grace by that span —
//   reject only when now - lastCallAt > APPROVAL_GRACE_MS + floorPausedMs.
//   Operator-initiated callers (approve/reject echoes, deferral ack, stop-all, spokenConfirm,
//   macro read-back, hands-free routing) are UNCHANGED: immediate delivery (the legacy slot, or
//   an exempt class-1 submit that drains on the very next evaluate even mid-floor).
//   With NO turnArbiter injected (legacy harnesses), behavior is byte-identical to today — the
//   existing suite (test_approval_defer, test_autonomy_windows) pins that fallback.
//
// Runner: npx tsx --test --test-force-exit tests/test_turn_arbiter_deadlines.ts

import { test } from "node:test";
import assert from "node:assert";
import { createGating } from "../src/gating";
import { APPROVAL_GRACE_MS } from "../src/pendingApprovals";
import { AUTONOMY_WARN_LEAD_MS } from "../src/gating/autonomyWindows";
import { createTurnArbiter } from "../src/voice/turnArbiter";

type AnyRec = Record<string, any>;

const T0 = 1_700_000_000_000;
const TTL = 5 * 60 * 1000; // gating's APPROVAL_TTL_MS (exposed on the seam; pinned by existing tests)
const GRACE = APPROVAL_GRACE_MS; // 60s
const S1 = T0 + TTL + 1; // the first sweep tick past the TTL — the last-call moment

// ── harness: real gating, fake boundaries, optional injected arbiter ───────────────────────────

function makeHarness(opts: { arbiter?: AnyRec } = {}) {
  const narrations: string[] = [];
  const broadcasts: AnyRec[] = [];
  const session = { sendClientContent: () => {} };
  const manager: AnyRec = {
    globalPermissionsMode: "Inherit",
    terminals: { t1: { status: "Running", writeInput: () => {}, stop: async () => {} } },
    settings: { advanced: { capabilityGates: {} } },
    ledger: {
      activeProjectId: "default_project",
      getActiveProject: () => undefined,
      plans: [],
      watchRules: [],
      save: () => {},
    },
  };
  const coreState: AnyRec = {
    activeFrontendWs: null,
    activeLiveSession: session, // autonomy + pending-action legs gate on this ref
    clients: new Set(),
    activePaneId: null,
    frozen: false,
    lastStopAllFailed: [],
    setFrozen: () => {},
  };
  // deps is `any` on purpose: `turnArbiter` does not exist on GatingDeps until Wave 2 lands.
  const deps: any = {
    manager,
    store: null,
    broadcast: (m: AnyRec) => broadcasts.push(m),
    broadcastLedgerUpdate: () => {},
    broadcastDraft: () => {},
    coreState,
    announcementBus: { enqueue: () => true, stop: () => {} },
    pushApprovalNarration: (_s: any, text: string) => { narrations.push(text); return true; },
    sanitizeSettingsForClient: (s: any) => s,
    addCommand: () => {},
    ...(opts.arbiter ? { turnArbiter: opts.arbiter } : {}),
  };
  const gating = createGating(deps);
  return { gating, narrations, broadcasts, session, coreState };
}

function addApproval(gating: AnyRec, session: AnyRec, id = "d1", ts = T0): void {
  gating.pendingApprovals.add(
    { messageId: id, instruction: "npm run deploy", kind: "shell", terminalId: "t1", callId: id, timestamp: ts } as any,
    session,
  );
}

/** Seam probe: records every submitted item; floor pause is scripted per coalesceKey. */
function captureArbiter(pausedByKey: Record<string, number> = {}) {
  const submitted: AnyRec[] = [];
  const removed: string[] = [];
  return {
    submitted,
    removed,
    submit: (item: AnyRec) => { submitted.push(item); },
    remove: (k: string) => { removed.push(k); },
    floorPausedMs: (k: string) => pausedByKey[k] ?? 0,
  };
}

// ── (1) approval sweep last-call: exact class-2 submission shape ───────────────────────────────

test("W2 site 1 — approval sweep last-call submits cls-2 with the pinned coalesceKey + honest deadline, no forced turn", () => {
  const cap = captureArbiter();
  const h = makeHarness({ arbiter: cap });
  addApproval(h.gating, h.session);

  h.gating.sweepExpiredApprovals(S1);

  assert.strictEqual(cap.submitted.length, 1,
    "Wave-2 feature absent: the sweep last-call must submit to the injected turnArbiter (spec §3.3 row 1)");
  const it = cap.submitted[0];
  assert.strictEqual(it.cls, 2, "deadline narrations are class 2");
  assert.strictEqual(it.coalesceKey, "last-call:d1", "the D1 pause/coalesce identity the sweep will consult");
  assert.match(it.facts, /npm run deploy|t1/, "facts name the command or pane (renderResumptionLine content)");
  assert.match(it.facts, /approve|drop/i, "facts convey the actionable last-call");
  assert.ok(it.deadline, "a last-call carries its TTL deadline (D1)");
  assert.strictEqual(it.deadline.expiresAt, S1 + GRACE,
    "the honest deadline is the DROP moment: grace measured from the last-call stamp");
  assert.match(it.deadline.onExpirySwap ?? "", /expir|cancel/i,
    "onExpirySwap carries the honest expiry-notice facts, never the stale last-call");
  assert.strictEqual(h.narrations.length, 0,
    "NO immediate forced spoken turn — the timer path must not bypass the arbiter");
  assert.strictEqual(h.gating.pendingApprovals.get("d1")!.lastCallAt, S1,
    "lastCallAt stamps on a successful arbiter submission (never-drop == heard)");

  // A later in-grace tick must not duplicate the submission (lastCallAt already stamped).
  h.gating.sweepExpiredApprovals(S1 + 10_000);
  assert.strictEqual(cap.submitted.length, 1, "no re-submission inside the grace window");
});

// ── (2) pending-action sweep last-call ─────────────────────────────────────────────────────────

test("W2 site 2 — pending-action sweep last-call submits cls-2 with deadline, slot stays silent", () => {
  const cap = captureArbiter();
  const h = makeHarness({ arbiter: cap });
  h.gating.pendingActions.add({ id: "act_1", capability: "create_pane", summary: "Create pane x", timestamp: T0, run: () => "ok" });

  h.gating.sweepExpiredApprovals(S1);

  assert.strictEqual(cap.submitted.length, 1,
    "Wave-2 feature absent: the pending-action last-call must submit to the injected turnArbiter");
  const it = cap.submitted[0];
  assert.strictEqual(it.cls, 2);
  assert.ok(typeof it.coalesceKey === "string" && it.coalesceKey.includes("act_1"),
    `coalesceKey must carry the action identity for D1 pause/coalescing, got ${JSON.stringify(it.coalesceKey)}`);
  assert.match(it.facts, /create_pane|Create pane x/, "facts name the staged action");
  assert.strictEqual(it.deadline?.expiresAt, S1 + GRACE, "honest drop deadline (grace from the stamp)");
  assert.match(it.deadline?.onExpirySwap ?? "", /expir|cancel|drop/i, "honest expiry-swap facts");
  assert.strictEqual(h.narrations.length, 0, "no immediate forced turn from the timer path");
  assert.strictEqual(h.gating.pendingActions.get("act_1")!.lastCallAt, S1, "lastCallAt stamped on submit");
});

// ── (3) autonomy-window T-minus warning ────────────────────────────────────────────────────────

test("W2 site 3 — autonomy warning submits cls-2 keyed to the window's real expiry, stamps warned_at once", () => {
  const cap = captureArbiter();
  const h = makeHarness({ arbiter: cap });
  const DUR = 20 * 60_000;
  h.gating.autonomyWindows.grant("p1", ["write_to_pane"], T0, DUR); // expires T0+DUR
  const warnAt = T0 + DUR - AUTONOMY_WARN_LEAD_MS + 1;

  h.gating.sweepExpiredApprovals(warnAt);

  assert.strictEqual(cap.submitted.length, 1,
    "Wave-2 feature absent: the autonomy T-minus warning must submit to the injected turnArbiter");
  const it = cap.submitted[0];
  assert.strictEqual(it.cls, 2, "the warning is a deadline narration (class 2)");
  assert.match(it.facts, /p1/, "facts name the pane");
  assert.match(it.facts, /minute|end/i, "facts convey the imminent window end");
  assert.strictEqual(it.deadline?.expiresAt, T0 + DUR,
    "the warning's deadline is the WINDOW's real expiry instant");
  assert.match(it.deadline?.onExpirySwap ?? "", /ended|ask/i,
    "a warning that expires while queued swaps to the honest 'window ended' facts");
  assert.strictEqual(h.narrations.length, 0, "no immediate forced turn");
  assert.strictEqual(h.gating.autonomyWindows.all()[0].warned_at, warnAt,
    "warned_at stamps on submit (fires exactly once)");

  h.gating.sweepExpiredApprovals(warnAt + 30_000);
  assert.strictEqual(cap.submitted.length, 1, "a second in-zone tick must NOT re-warn");
});

// ── (4) autonomy-window expiry notice ──────────────────────────────────────────────────────────

test("W2 site 4 — autonomy expiry submits cls-2 'back to asking first' facts; window still removed", () => {
  const cap = captureArbiter();
  const h = makeHarness({ arbiter: cap });
  const DUR = 20 * 60_000;
  h.gating.autonomyWindows.grant("p1", ["write_to_pane"], T0, DUR);

  h.gating.sweepExpiredApprovals(T0 + DUR + 1);

  assert.strictEqual(h.gating.autonomyWindows.all().length, 0, "expiry enforcement is unchanged: window removed");
  assert.strictEqual(cap.submitted.length, 1,
    "Wave-2 feature absent: the autonomy expiry notice must submit to the injected turnArbiter");
  const it = cap.submitted[0];
  assert.strictEqual(it.cls, 2);
  assert.match(it.facts, /p1/, "facts name the pane");
  assert.match(it.facts, /ended|asking/i, "facts convey the posture reversion");
  assert.strictEqual(h.narrations.length, 0, "no immediate forced turn from the timer path");
});

// ── (5) approval TTL-expiry notice + the stale-last-call collapse ──────────────────────────────

test("W2 site 5 — the TTL-expiry notice submits cls-2 under the SAME coalesceKey as the last-call (honest collapse)", () => {
  const cap = captureArbiter(); // floorPausedMs -> 0: the reject leg proceeds on today's clock
  const h = makeHarness({ arbiter: cap });
  addApproval(h.gating, h.session);

  h.gating.sweepExpiredApprovals(S1); // last-call
  h.gating.sweepExpiredApprovals(S1 + GRACE + 1); // grace elapsed, pause 0 -> reject -> renderExpired

  assert.strictEqual(h.gating.pendingApprovals.has("d1"), false, "the reject/expire enforcement itself is unchanged");
  assert.strictEqual(cap.submitted.length, 2,
    "Wave-2 feature absent: both the last-call AND the honest expiry notice must route through the arbiter");
  const exp = cap.submitted[1];
  assert.strictEqual(exp.cls, 2, "the expiry notice is a deadline narration (class 2)");
  assert.match(exp.facts, /expir/i, "facts convey the expiry");
  assert.match(exp.facts, /t1/, "facts name the pane");
  assert.strictEqual(exp.coalesceKey, "last-call:d1",
    "SAME identity as the last-call: a stale queued last-call must coalesce into the honest notice, never speak after the drop");
  assert.strictEqual(h.narrations.length, 0, "no immediate forced turn from the timer path");
});

// ── D1 end-to-end: the sweep consults the REAL arbiter's floor pause before expiring ───────────

test("W2 D1 — floor-held pause extends the approval's life: no reject inside the paused span, reject after it", () => {
  const arb = createTurnArbiter();
  const h = makeHarness({ arbiter: arb as any });
  addApproval(h.gating, h.session);

  h.gating.sweepExpiredApprovals(S1);
  assert.strictEqual(h.narrations.length, 0,
    "Wave-2 feature absent: the sweep last-call must route through the turn-arbiter, not the immediate slot");
  assert.strictEqual(h.gating.pendingApprovals.get("d1")!.lastCallAt, S1, "last-call stamped on submit");

  // The operator holds the floor for 30s while the last-call waits in the arbiter queue.
  assert.strictEqual(arb.evaluate({ now: S1, floorHeld: true, turnClear: false }).action, "hold");
  assert.strictEqual(arb.evaluate({ now: S1 + 30_000, floorHeld: true, turnClear: false }).action, "hold");
  assert.strictEqual(arb.floorPausedMs("last-call:d1"), 30_000,
    "the sweep submitted under the pinned key, so the arbiter tracks ITS pause");

  // Grace alone has elapsed — but 30s of it was the operator's floor. The deadline waited.
  h.gating.sweepExpiredApprovals(S1 + GRACE + 1);
  assert.ok(h.gating.pendingApprovals.has("d1"),
    "D1: the sweep must consult floorPausedMs before expiring — grace extends by the paused span");

  // Paused span consumed -> the normal reject closes it out.
  h.gating.sweepExpiredApprovals(S1 + GRACE + 30_000 + 1);
  assert.strictEqual(h.gating.pendingApprovals.has("d1"), false, "after the extension the honest drop proceeds");

  // The conversation hears ONE honest item about d1 — the expiry facts, never the stale last-call.
  const d: AnyRec = arb.evaluate({ now: S1 + GRACE + 30_002, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain");
  const all = [d.digest.headline, ...d.digest.tail];
  const d1Items = all.filter((i: AnyRec) => (i.coalesceKey ?? "").includes("d1"));
  assert.strictEqual(d1Items.length, 1, "exactly one spoken item about the dropped approval");
  assert.match(d1Items[0].facts, /expir|cancel/i, "the honest expiry notice speaks, not the dead last-call");
});

test("W2 D1 — a last-call arriving mid-floor defers and drains FIRST (headline) at turn-clear", () => {
  const arb = createTurnArbiter();
  const h = makeHarness({ arbiter: arb as any });
  addApproval(h.gating, h.session);

  h.gating.sweepExpiredApprovals(S1);
  assert.strictEqual(h.narrations.length, 0,
    "Wave-2 feature absent: the timer last-call must not force an immediate spoken turn");
  arb.submit({ facts: "context: pane p4 went idle", cls: 5, paneId: "p4" });

  assert.strictEqual(arb.evaluate({ now: S1 + 1_000, floorHeld: true, turnClear: false }).action, "hold",
    "mid-floor the last-call DEFERS — no jump-over");
  assert.ok(h.gating.pendingApprovals.has("d1"), "deferral never costs the approval its life inside the grace");

  const d: AnyRec = arb.evaluate({ now: S1 + 5_000, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain");
  assert.strictEqual(d.digest.headline.cls, 2, "the deadline narration outranks passive context");
  assert.strictEqual(d.digest.headline.coalesceKey, "last-call:d1", "the last-call drains FIRST at turn-clear");
  assert.deepStrictEqual(d.digest.tail.map((t: AnyRec) => t.facts), ["context: pane p4 went idle"]);
});

test("W2 expiry swap — a TTL that expires while queued drains as the honest notice, exactly once", () => {
  const arb = createTurnArbiter();
  const h = makeHarness({ arbiter: arb as any });
  addApproval(h.gating, h.session);

  h.gating.sweepExpiredApprovals(S1); // last-call into the queue
  // The turn never clears (model mid-answer; the operator is NOT holding the floor, so no pause).
  assert.strictEqual(arb.evaluate({ now: S1 + GRACE, floorHeld: false, turnClear: false }).action, "hold");

  h.gating.sweepExpiredApprovals(S1 + GRACE + 1); // grace elapsed, zero pause -> real drop
  assert.strictEqual(h.gating.pendingApprovals.has("d1"), false, "the approval genuinely dropped");

  const d: AnyRec = arb.evaluate({ now: S1 + GRACE + 2, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain",
    "Wave-2 feature absent: nothing reached the arbiter, so there is nothing honest to drain");
  const all = [d.digest.headline, ...d.digest.tail];
  const d1Items = all.filter((i: AnyRec) => (i.coalesceKey ?? "").includes("d1"));
  assert.strictEqual(d1Items.length, 1, "one item about d1 — the last-call and the notice coalesced");
  assert.match(d1Items[0].facts, /expir|cancel/i,
    "told-more honesty: the operator hears the drop, never a stale still-actionable last-call");
});

test("W2 D1 cap — the +60s extension consumed mid-floor interrupts at a phrase boundary BEFORE the drop", () => {
  const arb = createTurnArbiter();
  const h = makeHarness({ arbiter: arb as any });
  addApproval(h.gating, h.session);

  h.gating.sweepExpiredApprovals(S1); // deadline.expiresAt pinned = S1 + GRACE
  arb.evaluate({ now: S1, floorHeld: true, turnClear: false }); // baseline
  arb.evaluate({ now: S1 + 30_000, floorHeld: true, turnClear: false }); // +30s pause
  arb.evaluate({ now: S1 + 60_000, floorHeld: true, turnClear: false }); // capped at +60s

  // At the exact extended boundary the sweep must still hold its fire...
  h.gating.sweepExpiredApprovals(S1 + GRACE + 60_000);
  assert.ok(h.gating.pendingApprovals.has("d1"),
    "Wave-2 feature absent: with the cap consumed the approval must survive until the interrupt has spoken");

  // ...because the arbiter is about to force the turn at the next phrase boundary.
  const d: AnyRec = arb.evaluate({ now: S1 + GRACE + 60_000, floorHeld: true, turnClear: false });
  assert.strictEqual(d.action, "interrupt-at-phrase-boundary",
    "cap consumed + extended deadline reached with the floor held -> D1 interrupt");
  assert.ok((d.digest.headline.coalesceKey ?? "").includes("d1"), "the interrupt carries the last-call item");

  // Only after the interrupt moment does the honest drop proceed.
  h.gating.sweepExpiredApprovals(S1 + GRACE + 60_001);
  assert.strictEqual(h.gating.pendingApprovals.has("d1"), false, "the extension is a cap, not immortality");
});

// ── operator-initiated callers stay immediate (class-1 semantics unchanged) ────────────────────

test("W2 exemption — operator echoes stay immediate while the timer lane diverts through the arbiter", () => {
  const arb = createTurnArbiter();
  const h = makeHarness({ arbiter: arb as any });
  addApproval(h.gating, h.session);

  // Timer lane: diverted (RED today — the sweep still forces the slot).
  h.gating.sweepExpiredApprovals(S1);
  assert.strictEqual(h.narrations.length, 0,
    "Wave-2 feature absent: the timer last-call must divert to the arbiter");

  // Operator lane: the deferral ack is immediate — legacy slot OR an exempt class-1 drain that
  // fires on the very next evaluate even mid-floor. Either satisfies "semantics unchanged".
  const expectImmediateEcho = (re: RegExp, now: number) => {
    if (h.narrations.some((n) => re.test(n))) return;
    const d: AnyRec = arb.evaluate({ now, floorHeld: true, turnClear: false });
    assert.strictEqual(d.action, "drain",
      `operator echo ${re} must be delivered immediately (slot or class-1 exempt drain), even mid-floor`);
    assert.strictEqual(d.digest.headline.cls, 1, "operator responses are class 1 — never queued");
    assert.match(d.digest.headline.facts, re);
  };

  const out = h.gating.applyDeferral("d1", S1 + 1_000);
  assert.strictEqual(out.reason, "deferred");
  expectImmediateEcho(/Holding it/i, S1 + 1_001);

  h.gating.applyResolution("d1", "reject");
  expectImmediateEcho(/Reject/i, S1 + 1_002);
});

// ── use-case (c)+(d): the emergency brake — instant echoes, and no stale last-call survives it ─
//
// The brake (stopAll/releaseStopAll) is the ONE operator echo the spec singles out: it "bypasses
// the arbiter entirely" (spec §2 standing invariants, §3.4 — the narration path does not route
// through the arbiter AT ALL), so unlike the deferral/reject echoes above there is no class-1
// alternative here: the echo must land instantly through the legacy slot. AND the brake's freeze
// loop cancels every pending approval via applyResolution(id, "expire") (src/gating/index.ts:852)
// — the SAME renderExpired leg site 5 re-routes. If the implementer keys the re-route on
// renderExpired's SWEEP caller only and forgets the brake caller, a last-call already QUEUED in
// the arbiter outlives the approval the brake just killed and speaks later as a still-actionable
// "approve npm run deploy now" — the exact stale-claim lie this program exists to kill.

test("W2 brake — stop-all echoes are instant (never queued); a brake-cancelled approval's queued last-call never speaks as still-actionable", async () => {
  const arb = createTurnArbiter();
  const h = makeHarness({ arbiter: arb as any });
  addApproval(h.gating, h.session);

  // Timer lane diverts (RED anchor — today the sweep still forces the immediate slot).
  h.gating.sweepExpiredApprovals(S1);
  assert.strictEqual(h.narrations.length, 0,
    "Wave-2 feature absent: the timer last-call must divert to the arbiter, leaving the slot silent");
  // The last-call is QUEUED — the operator is mid-floor, nothing has drained.
  assert.strictEqual(arb.evaluate({ now: S1 + 100, floorHeld: true, turnClear: false }).action, "hold");

  // EMERGENCY BRAKE mid-floor. Echo must be instant via the slot — the brake bypasses the arbiter.
  const beforeFreeze = h.narrations.length;
  await h.gating.stopAll(false);
  assert.ok(h.narrations.slice(beforeFreeze).some((n) => /stop-all engaged/i.test(n)),
    "the freeze echo speaks INSTANTLY through the legacy slot — never queued, never a class-2 defer (use case c)");
  assert.strictEqual(h.gating.pendingApprovals.has("d1"), false, "the brake cancelled the pending approval");

  // The queued last-call must NEVER speak later as a stale still-actionable ask (use case d,
  // composed with the brake): the operator killed the line; "approve now or I'll drop it" is a lie.
  const d: AnyRec = arb.evaluate({ now: S1 + 1_000, floorHeld: false, turnClear: true });
  let spokeViaDrain = false;
  if (d.action !== "hold") {
    const d1Items = [d.digest.headline, ...d.digest.tail].filter(
      (i: AnyRec) => (i.coalesceKey ?? "").includes("d1"));
    const stale = d1Items.filter((i: AnyRec) => !/expir|cancel/i.test(i.facts));
    assert.deepStrictEqual(stale.map((i: AnyRec) => i.facts), [],
      "a brake-cancelled approval's queued last-call must coalesce into the cancellation truth, never drain as actionable");
    spokeViaDrain = d1Items.length > 0;
  }
  // Told-more floor: the cancellation of d1 is voiced SOMEWHERE — the instant slot line the brake
  // cascade produces today, or the honest coalesced item in the next drain. Silence is a defect.
  const spokeViaSlot = h.narrations.some((n) => /expir|cancel/i.test(n));
  assert.ok(spokeViaSlot || spokeViaDrain,
    "told-more beats silently-missed: the operator must hear that the pending command was cancelled");

  // Release echo: as instant as the freeze.
  const beforeRelease = h.narrations.length;
  h.gating.releaseStopAll();
  assert.ok(h.narrations.slice(beforeRelease).some((n) => /released/i.test(n)),
    "the release echo is instant through the slot (use case c)");

  // Stage-2 kill: the present-progressive truth speaks BEFORE the awaited kills — instant, unqueued.
  const beforeKill = h.narrations.length;
  await h.gating.stopAll(true);
  assert.ok(h.narrations.slice(beforeKill).some((n) => /stage two|killed|being killed/i.test(n)),
    "the kill-stage echo is instant through the slot (use case c)");
});

// ── I-1 (chain review): TurnArbiter.remove() — invalidated last-calls never drain as falsehoods ─
//
// The arbiter had no removal API, so two paths spoke falsehoods:
//   (a) RESOLUTION: the sweep queues a class-2 last-call while the operator holds the floor; the
//       operator approves BEFORE a turn-clear; resolveDecision never touches the arbiter queue →
//       the next drain speaks "approve now or I'll drop it" for an approval that no longer
//       exists, right after the "approving" narration.
//   (b) RECONNECT: reattachSession clears lastCallAt and re-opens a fresh TTL, but a stale queued
//       item keeps its old deadline.expiresAt → after a >grace disconnect the first drain speaks
//       the onExpirySwap "expired; I cancelled it" while the survivors digest says the SAME
//       command is still waiting — a direct spoken contradiction.
// remove(coalesceKey) is for INVALIDATED facts only (the fact is no longer true) — never-drop
// protects TRUE facts, and speaking a resolved approval's last-call IS the falsehood. It removes
// matching QUEUED items only: immediates and unrelated keys are never touched.

test("I-1 remove — an APPROVED approval's queued last-call never drains; the rest of the queue still speaks", () => {
  const arb = createTurnArbiter();
  const h = makeHarness({ arbiter: arb as any });
  addApproval(h.gating, h.session);

  h.gating.sweepExpiredApprovals(S1); // class-2 last-call queued under "last-call:d1"
  // The operator approves BEFORE any turn-clear drained the last-call.
  const res = h.gating.applyResolution("d1", "approve");
  assert.strictEqual(res.reason, "approved", "precondition: the resolution settled the approval");
  assert.ok(h.narrations.some((n) => /Approving/i.test(n)), "precondition: the approve echo spoke");

  // Something unrelated is also queued — remove() must be key-scoped, never a queue wipe.
  arb.submit({ facts: "context: pane p9 went idle", cls: 5, paneId: "p9" });

  const d: AnyRec = arb.evaluate({ now: S1 + 5_000, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain", "the unrelated context still drains at turn-clear");
  const all = [d.digest.headline, ...d.digest.tail];
  assert.deepStrictEqual(all.filter((i: AnyRec) => (i.coalesceKey ?? "").includes("d1")).map((i: AnyRec) => i.facts), [],
    "I-1 feature absent: a RESOLVED approval's last-call is no longer a true fact — it must never " +
      "drain as 'approve now or I'll drop it' right after the approve narration");
  assert.deepStrictEqual(all.map((i: AnyRec) => i.facts), ["context: pane p9 went idle"],
    "only the still-true fact drains");
});

test("I-1 remove — a REJECTED approval's queued last-call leaves the queue empty: next turn-clear HOLDS", () => {
  const arb = createTurnArbiter();
  const h = makeHarness({ arbiter: arb as any });
  addApproval(h.gating, h.session);

  h.gating.sweepExpiredApprovals(S1);
  const res = h.gating.applyResolution("d1", "reject");
  assert.strictEqual(res.reason, "rejected", "precondition: the resolution settled the approval");

  assert.strictEqual(arb.evaluate({ now: S1 + 5_000, floorHeld: false, turnClear: true }).action, "hold",
    "I-1 feature absent: with the invalidated last-call removed and nothing else queued, the " +
      "arbiter holds — it must not speak a last-call for a rejected approval");
});

test("I-1 remove — an operator-resolved pending ACTION's queued last-call never drains (confirm and cancel)", () => {
  const arb = createTurnArbiter();
  const h = makeHarness({ arbiter: arb as any });
  h.gating.pendingActions.add({ id: "act_1", capability: "create_pane", summary: "Create pane x", timestamp: T0, run: () => "ok" });
  h.gating.pendingActions.add({ id: "act_2", capability: "create_pane", summary: "Create pane y", timestamp: T0, run: () => "ok" });

  h.gating.sweepExpiredApprovals(S1); // both class-2 last-calls queued ("last-call:act_1"/"last-call:act_2")

  assert.strictEqual(h.gating.pendingActions.confirm("act_1").reason, "confirmed", "precondition: act_1 confirmed");
  assert.strictEqual(h.gating.pendingActions.cancel("act_2").reason, "cancelled", "precondition: act_2 cancelled");

  assert.strictEqual(arb.evaluate({ now: S1 + 5_000, floorHeld: false, turnClear: true }).action, "hold",
    "I-1 feature absent: confirm()/cancel() are the single settle points for pending actions — " +
      "both invalidated last-calls must be removed, so the arbiter holds instead of speaking " +
      "'approve now or I'll drop it' for actions that no longer exist");
});

test("I-1 remove — reattach resets the last-call: no stale expiry-swap after a long disconnect; a fresh sweep last-call still drains", () => {
  const arb = createTurnArbiter();
  const h = makeHarness({ arbiter: arb as any });
  addApproval(h.gating, h.session);

  h.gating.sweepExpiredApprovals(S1); // last-call queued with deadline S1+GRACE

  // Disconnect right after; the operator stays away past the queued item's ENTIRE grace deadline.
  h.gating.pendingApprovals.detachSession(h.session);
  h.gating.noteSessionDetached(S1 + 1_000);
  const sB = { sendClientContent: () => {} };
  const R = S1 + GRACE + 40_000; // ~99s absence: a genuine ceremony; the stale deadline is long past
  h.gating.reannounceSurvivors(sB, R);
  assert.notStrictEqual(h.gating.pendingApprovals.sessionFor("d1"), undefined, "precondition: re-attached");
  assert.strictEqual(h.gating.pendingApprovals.get("d1")!.lastCallAt, undefined,
    "precondition: re-attach opened a fresh window (lastCallAt cleared)");

  const d: AnyRec = arb.evaluate({ now: R + 1, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain", "the survivors digest drains at the first turn-clear");
  const all = [d.digest.headline, ...d.digest.tail];
  assert.deepStrictEqual(all.filter((i: AnyRec) => /expired; I cancelled/i.test(i.facts)).map((i: AnyRec) => i.facts), [],
    "I-1(b) feature absent: the STALE queued last-call (old deadline) must not fire its expiry-swap " +
      "— the survivors digest in the SAME drain says the command is still waiting (spoken contradiction)");
  assert.ok(all.some((i: AnyRec) => /welcome|waiting|still/i.test(i.facts)),
    "the survivors digest itself still speaks");

  // remove() must not poison resubmission: the next sweep re-opens a FRESH last-call that drains
  // normally on its new TTL (lastCallAt was cleared by the re-attach, so the sweep re-fires).
  const R2 = R + 30_000;
  h.gating.sweepExpiredApprovals(R2);
  assert.strictEqual(h.gating.pendingApprovals.get("d1")!.lastCallAt, R2, "fresh last-call stamped on the new window");
  const d2: AnyRec = arb.evaluate({ now: R2 + 1, floorHeld: false, turnClear: true });
  assert.strictEqual(d2.action, "drain");
  assert.strictEqual(d2.digest.headline.coalesceKey, "last-call:d1");
  assert.match(d2.digest.headline.facts, /approve now/i,
    "the fresh last-call drains as a live actionable ask — remove() only killed the stale item");
});

// ── p19o (I-1(b) sibling): defer re-arms the TTL — the queued last-call's deadline is stale ──
//
// applyDeferral re-arms the approval's TTL (timestamp = now, lastCallAt/lastCallFailures cleared)
// exactly like reattachSession does, but — unlike reattach — it never touched the arbiter queue.
// A last-call already queued from BEFORE the defer keeps its OLD deadline.expiresAt, so past that
// stale instant the honest-sounding factsForDrain expiry-swap ("expired; I cancelled it") would
// speak for a command that is HELD, not cancelled — the same TTL-reset falsehood as I-1(b).

test("p19o defer — a DEFERRED approval's stale queued last-call never drains its expiry-swap lie; the re-armed window re-earns a fresh last-call under the same key", () => {
  const arb = createTurnArbiter();
  const h = makeHarness({ arbiter: arb as any });
  addApproval(h.gating, h.session);

  h.gating.sweepExpiredApprovals(S1); // last-call queued, deadline.expiresAt = S1 + GRACE
  assert.strictEqual(h.gating.pendingApprovals.get("d1")!.lastCallAt, S1, "precondition: last-call stamped");
  assert.strictEqual(h.narrations.length, 0, "precondition: timer lane diverted to the arbiter");

  const out = h.gating.applyDeferral("d1", S1 + 1_000);
  assert.strictEqual(out.reason, "deferred", "precondition: the defer re-armed the window");
  assert.ok(h.narrations.some((n) => /Holding it/i.test(n)),
    "the defer echo lands on the SLOT (pushApprovalNarration), never the arbiter — untouched");

  // Past the STALE deadline (S1+GRACE) but well inside the re-armed window (S1+1_000+TTL).
  const d: AnyRec = arb.evaluate({ now: S1 + GRACE + 2_000, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "hold",
    "p19o feature absent: the defer re-armed the TTL but the queued last-call kept its stale " +
      "deadline — pre-fix this drains the factsForDrain expiry-swap 'expired; I cancelled it' for " +
      "a command that is HELD, not cancelled");

  // Never-drop resubmission: the re-armed window still earns a fresh last-call under the same key.
  const S2 = S1 + 1_000 + TTL + 1;
  h.gating.sweepExpiredApprovals(S2);
  assert.strictEqual(h.gating.pendingApprovals.get("d1")!.lastCallAt, S2, "fresh last-call stamped on the new window");
  const d2: AnyRec = arb.evaluate({ now: S2 + 1, floorHeld: false, turnClear: true });
  assert.strictEqual(d2.action, "drain");
  assert.strictEqual(d2.digest.headline.coalesceKey, "last-call:d1");
  assert.match(d2.digest.headline.facts, /approve now/i,
    "the fresh last-call drains as a live actionable ask — remove() only killed the stale item; never-drop holds");
});

test("p19o defer seam — the deferred branch removes 'last-call:<id>' exactly; defer_limit and not_found never remove; the fresh resubmit carries the new deadline", () => {
  const cap = captureArbiter();
  const h = makeHarness({ arbiter: cap });
  addApproval(h.gating, h.session);

  h.gating.sweepExpiredApprovals(S1);
  assert.strictEqual(cap.submitted.length, 1, "precondition: last-call submitted");
  assert.strictEqual(cap.removed.length, 0, "precondition: nothing removed yet");

  const out1 = h.gating.applyDeferral("d1", S1 + 1_000);
  assert.strictEqual(out1.reason, "deferred");
  assert.deepStrictEqual(cap.removed, ["last-call:d1"],
    "p19o feature absent: the deferred branch must remove the queued arbiter last-call — the " +
      "re-armed TTL invalidated its deadline, the same TTL-reset shape as I-1(b) reattach");

  const S2 = S1 + 1_000 + TTL + 1;
  h.gating.sweepExpiredApprovals(S2);
  assert.strictEqual(cap.submitted.length, 2, "the re-armed window re-earns a fresh submission");
  const fresh = cap.submitted[1];
  assert.strictEqual(fresh.cls, 2);
  assert.strictEqual(fresh.coalesceKey, "last-call:d1", "the sweep re-earns the SAME key");
  assert.strictEqual(fresh.deadline?.expiresAt, S2 + GRACE,
    "the fresh last-call carries the honest deadline measured from the new stamp");
  assert.strictEqual(h.gating.pendingApprovals.get("d1")!.lastCallAt, S2);

  // Drive to the cap (MAX_DEFERRALS = 3, src/approvalIntent.ts:23).
  const out2 = h.gating.applyDeferral("d1", S2 + 1_000);
  assert.strictEqual(out2.reason, "deferred");
  const out3 = h.gating.applyDeferral("d1", S2 + 2_000);
  assert.strictEqual(out3.reason, "deferred");
  assert.strictEqual(cap.removed.length, 3, "each successful defer fires the remove");
  assert.ok(cap.removed.every((k) => k === "last-call:d1"));

  // defer_limit: the window is UNTOUCHED — the queued last-call and its honest expiry-swap remain
  // TRUE facts and must keep their honest collapse; removing here would violate never-drop.
  const lenAtCap = cap.removed.length;
  const out4 = h.gating.applyDeferral("d1", S2 + 3_000);
  assert.strictEqual(out4.reason, "defer_limit");
  assert.strictEqual(cap.removed.length, lenAtCap, "defer_limit must never remove");

  // not_found: never removes.
  const out5 = h.gating.applyDeferral("nope", S2 + 4_000);
  assert.strictEqual(out5.reason, "not_found");
  assert.strictEqual(cap.removed.length, lenAtCap, "not_found must never remove");
});

test("I-1 remove — negatives: a non-matching key is a no-op; class-1 immediates and unrelated class-3 items on the same pane survive", () => {
  const arb: AnyRec = createTurnArbiter();
  assert.strictEqual(typeof arb.remove, "function",
    "I-1 feature absent: the TurnArbiter must expose remove(coalesceKey) for INVALIDATED facts");

  const lastCall = () => arb.submit({
    facts: "cmd on t1 — approve now or I'll drop it.", cls: 2, paneId: "t1", coalesceKey: "last-call:a1",
    deadline: { expiresAt: T0 + GRACE, onExpirySwap: "The command on pane t1 expired; I cancelled it." },
  });
  const completion = () => arb.submit({ facts: "pane t1 finished", cls: 3, paneId: "t1", coalesceKey: "pane-completion" });

  // Round 1: a NON-matching remove touches nothing.
  lastCall();
  completion();
  arb.remove("last-call:zzz");
  let d: AnyRec = arb.evaluate({ now: T0, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain");
  assert.deepStrictEqual([d.digest.headline, ...d.digest.tail].map((i: AnyRec) => i.coalesceKey).sort(),
    ["last-call:a1", "pane-completion"], "a non-matching remove() must be a strict no-op");

  // Round 2: a matching remove is KEY-scoped — the class-3 item on the SAME pane and a class-1
  // immediate both survive; only the invalidated last-call goes.
  lastCall();
  completion();
  arb.submit({ facts: "Holding it.", cls: 1 });
  arb.remove("last-call:a1");
  d = arb.evaluate({ now: T0 + 1, floorHeld: true, turnClear: false });
  assert.strictEqual(d.action, "drain", "the class-1 immediate is untouched by remove()");
  assert.strictEqual(d.digest.headline.cls, 1);
  assert.strictEqual(d.digest.headline.facts, "Holding it.");
  d = arb.evaluate({ now: T0 + 2, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain");
  assert.deepStrictEqual([d.digest.headline, ...d.digest.tail].map((i: AnyRec) => [i.cls, i.coalesceKey]),
    [[3, "pane-completion"]],
    "remove() is key-scoped: only the invalidated last-call goes; the unrelated class-3 on the same pane survives");
});

// ── okes: the brake's ACTION leg — same-key honest collapse, mirroring renderExpired's site-5 ──
//
// stopAllStage1Freeze's action loop (src/gating/index.ts:927) calls pendingActions.expire(a.id) for
// every staged action but — unlike the approvals loop's applyResolution(id,"expire") ->
// renderExpired, which re-submits under the SAME coalesceKey (line ~1298-1309) — never touches the
// arbiter. A queued action last-call ("approve now or I'll drop it") therefore keeps sounding
// actionable until its OWN stale deadline swaps, up to APPROVAL_GRACE_MS after "Stop-all engaged."

test("okes brake ACTION leg — a brake-expired action's queued last-call drains as 'cancelled by stop-all' BEFORE its stale deadline, exactly once", async () => {
  const arb = createTurnArbiter();
  const h = makeHarness({ arbiter: arb as any });
  h.gating.pendingActions.add({ id: "act_1", capability: "create_pane", summary: "Create pane x", timestamp: T0, run: () => "ok" });

  // Queue the last-call under last-call:act_1 (deadline S1+GRACE).
  h.gating.sweepExpiredApprovals(S1);
  assert.strictEqual(h.gating.pendingActions.get("act_1")!.lastCallAt, S1, "precondition: last-call stamped");
  assert.strictEqual(arb.evaluate({ now: S1 + 100, floorHeld: true, turnClear: false }).action, "hold",
    "precondition: mid-floor, nothing drained yet — the stale deadline is exactly S1+GRACE");

  // EMERGENCY BRAKE.
  await h.gating.stopAll(false);
  assert.strictEqual(h.gating.pendingActions.has("act_1"), false, "the brake expired the staged action");
  assert.ok(h.narrations.some((n) => /stop-all engaged/i.test(n)), "the instant slot echo is untouched (invariant 3)");

  // Observation BEFORE the stale deadline (S1+GRACE): pre-fix the queued item still sounds actionable.
  const d: AnyRec = arb.evaluate({ now: S1 + 1_000, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain", "holds pre- and post-fix — the failure must be the FACTS, not the drain");
  const items = [d.digest.headline, ...d.digest.tail].filter((i: AnyRec) => (i.coalesceKey ?? "").includes("act_1"));
  assert.strictEqual(items.length, 1,
    "exactly one act_1 item — a duplicate means the collapse submit minted a DIFFERENT identity " +
      "(the paneId trap: identityKey is key-<coalesceKey>--pane-<paneId??''>; sweepActionItem " +
      "submitted with NO paneId, the collapse must too)");
  assert.match(items[0].facts, /cancelled by stop-all/i,
    "okes feature absent: after the brake the queued action last-call must collapse to the " +
      "stop-all cancellation truth — today it drains as the stale still-actionable ask");
  assert.doesNotMatch(items[0].facts, /approve now/i, "a brake-killed action must never sound actionable");
  assert.match(items[0].facts, /create_pane|Create pane x/, "the honest item still names the action (told-more, not a generic line)");
});

test("okes shape — the brake's action collapse submits cls-2 under the SAME identity: coalesceKey last-call:<id>, paneId strictly undefined, deadline strictly undefined", async () => {
  const cap = captureArbiter();
  const h = makeHarness({ arbiter: cap });
  h.gating.pendingActions.add({ id: "act_1", capability: "create_pane", summary: "Create pane x", timestamp: T0, run: () => "ok" });
  h.gating.sweepExpiredApprovals(S1);
  assert.strictEqual(cap.submitted.length, 1, "precondition: the sweep last-call submitted");

  await h.gating.stopAll(false);

  assert.strictEqual(cap.submitted.length, 2,
    "okes feature absent: the brake's action leg must submit the honest collapse for the " +
      "brake-expired action (mirror of renderExpired's site-5 collapse on the approvals leg)");
  const it = cap.submitted[1];
  assert.strictEqual(it.cls, 2);
  assert.strictEqual(it.coalesceKey, "last-call:act_1", "SAME identity as sweepActionItem's last-call — latest-wins overwrite wipes the stale deadline");
  assert.match(it.facts, /create_pane/);
  assert.match(it.facts, /cancelled by stop-all/i);
  assert.strictEqual(it.paneId, undefined,
    "MUST omit paneId — sweepActionItem's submit carries none; passing one mints " +
      "key-...--pane-<id> instead of key-...--pane- and leaves the stale item alive");
  assert.strictEqual(it.deadline, undefined,
    "NO deadline — the collapse must never become a tickDeadlines interrupt candidate; the overwrite discards the stale expiresAt");
});

test("okes delta — a brake with NO queued last-call still voices one honest per-action cancellation (told-more parity with the approval leg)", async () => {
  const cap = captureArbiter();
  const h = makeHarness({ arbiter: cap });
  h.gating.pendingActions.add({ id: "act_1", capability: "create_pane", summary: "Create pane x", timestamp: T0, run: () => "ok" });
  // No sweep — no last-call was ever queued.

  await h.gating.stopAll(false);

  assert.strictEqual(cap.submitted.length, 1,
    "okes delta: the brake voices the cancellation of EVERY staged action at next turn-clear even " +
      "when no last-call was queued — exact parity with the approvals loop, whose " +
      "applyResolution('expire') -> renderExpired always submits; tailGroups digest-bounds the chattiness");
  assert.strictEqual(cap.submitted[0].coalesceKey, "last-call:act_1");
  assert.match(cap.submitted[0].facts, /cancelled by stop-all/i);
  assert.strictEqual(cap.submitted[0].cls, 2);
});

test("okes negative — a lost-race expire never fabricates a spoken cancel (claim-winner gate)", async () => {
  const cap = captureArbiter();
  const h = makeHarness({ arbiter: cap });
  h.gating.pendingActions.add({ id: "act_1", capability: "create_pane", summary: "Create pane x", timestamp: T0, run: () => "ok" });
  h.gating.sweepExpiredApprovals(S1);
  assert.strictEqual(cap.submitted.length, 1);

  // Simulate a concurrently-won claim — the only way to force expire() -> 'lost_race' through the
  // public surface, since confirm/cancel REMOVE the record before the brake could see it.
  h.gating.pendingActions.get("act_1")!.claimed = true;

  await h.gating.stopAll(false);

  assert.strictEqual(cap.submitted.length, 1,
    "a lost-race expire must NOT submit a cancellation — never-drop protects TRUE facts only, and " +
      "only the claim winner's expire is a truth (invariant 2); the collapse must gate on expire(...).reason === 'expired'");
});
