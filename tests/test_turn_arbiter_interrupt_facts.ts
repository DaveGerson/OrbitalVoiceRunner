// tests/test_turn_arbiter_interrupt_facts.ts — bead 7qb1 RED: evaluate()'s INTERRUPT arm must
// re-derive its facts at interrupt time, exactly like the drain arm already does.
//
// Layer: J0 conversational coherence (JOURNEYS_DESIGN.md §4) — the utterance ⇄ state divergence
// defect class. The arbiter is an OUTBOX of pre-written letters; when the world changes you must
// pull or re-word the letter, not just update your own records.
//
// ── The defect (chain review M-1, 2026-08-04) ──────────────────────────────────────────────────
//   src/voice/turnArbiter.ts buildQueueDrain() maps every item through factsForDrain(it, now), so a
//   class-2 deadline whose (floor-extended) expiry has genuinely passed drains as its honest
//   `deadline.onExpirySwap` notice. evaluate()'s interrupt arm does NOT:
//
//       if (interruptCandidate) {
//         queue.delete(interruptCandidate.key);
//         const headline = toDigestItem(interruptCandidate, false);   // <-- it.facts, verbatim
//
//   toDigestItem copies `it.facts` — the text composed at QUEUE time. That is honest only when the
//   interrupt fires as designed: the floor was held tick-by-tick, the +60s extension was consumed,
//   and `now` has just caught up to the extended boundary (the D1 "last chance before the drop"
//   pinned in tests/test_turn_arbiter_core.ts "D1 cap" / the 90s-monologue scenario).
//
//   It is a LIE the moment drain ticks stop arriving. The arbiter has no clock of its own — the
//   caller supplies `now` — and the drain loop in src/voice/index.ts:2787 opens with a
//   session-mismatch guard (`if (coreState.activeLiveSession !== justConnected) return;`, line 2792)
//   that returns BEFORE evaluate(). A dropped Live socket nulls coreState.activeLiveSession
//   (src/voice/index.ts:1895) while the prior closure's timer stays armed until the next hoist
//   clears it (line 2713), so the SHARED arbiter (one instance, injected once into both
//   createGating and attachVoiceSession) can go un-ticked for the whole reconnect window while the
//   gating sweep — a SEPARATE timer — keeps running and drops the staged item for real.
//
//   On the first tick after that blackout, `advancePause` credits the whole gap (floorHeld is
//   `!turnClear`, and a just-resumed session is not turn-clear), the extension saturates at its
//   60s cap, `now >= deadline.expiresAt + pausedMs` is true by a country mile — and the arbiter
//   interrupts the operator with a minutes-dead "approve now or I'll drop it" for a command the
//   ledger cancelled long ago.
//
// ── The pinned contract (what the implementer must make true) ──────────────────────────────────
//   1. STALE: when the interrupt fires long past the item's floor-extended expiry, the operator
//      hears the honest expiry facts (deadline.onExpirySwap), never the queue-time actionable ask.
//      Delivery-arm-agnostic: swapping the interrupt's facts (the bead's fix shape — "route the
//      interrupt digest through factsForDrain too") and declining to interrupt for a long-dead item
//      (it then drains honestly at the next turn-clear) both satisfy this. Silence does not:
//      never-drop still applies, the item must surface exactly once.
//   2. HONEST: an interrupt that fires because the extension was genuinely consumed still delivers
//      the ORIGINAL last-call. Tick cadence means the interrupt lands a fraction of a tick PAST the
//      extended boundary in the field, so the fix must discriminate a long-dead deadline from one
//      that just reached its boundary — a blanket swap (or an `expiresAt + CAP` cutoff) would make
//      D1's "last chance before the drop" unreachable in production and would break the two
//      interrupt pins in tests/test_turn_arbiter_core.ts.
//
// Reference pattern for the whole J0 invariant: removeStaleLastCallOnTtlReset in src/gating/index.ts.
//
// Runner: npx tsx --test --test-force-exit tests/test_turn_arbiter_interrupt_facts.ts

import { test } from "node:test";
import assert from "node:assert";
import { createGating } from "../src/gating";
import { APPROVAL_GRACE_MS } from "../src/pendingApprovals";
import { createTurnArbiter } from "../src/voice/turnArbiter";

type AnyRec = Record<string, any>;

const T0 = 1_700_000_000_000;
const TTL = 5 * 60 * 1000; // gating's APPROVAL_TTL_MS
const GRACE = APPROVAL_GRACE_MS; // 60s
const S1 = T0 + TTL + 1; // the first sweep tick past the TTL — the last-call moment
/** src/voice/index.ts arms the drain loop on the OPERATOR_HOLD_MS settle cadence. */
const TICK = 1_000;

// ── harness: real gating + the real arbiter, only true boundaries faked (mirrors
//    tests/test_turn_arbiter_deadlines.ts makeHarness) ──────────────────────────────────────────

function makeHarness(arbiter: AnyRec) {
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
    activeLiveSession: session, // the action leg's connectivity ref
    clients: new Set(),
    activePaneId: null,
    frozen: false,
    lastStopAllFailed: [],
    setFrozen: () => {},
  };
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
    turnArbiter: arbiter,
  };
  return { gating: createGating(deps), narrations, broadcasts, session, coreState };
}

/** Everything the operator actually HEARS out of one evaluate() — both deliverable arms. */
function heard(decision: AnyRec): string[] {
  if (decision.action === "hold") return [];
  return [decision.digest.headline, ...decision.digest.tail].map((i: AnyRec) => i.facts);
}

// ── (1) end-to-end: a staged action the gating sweep already dropped, spoken minutes later ─────
//
// The pending-ACTION sweep's reject leg (src/gating/index.ts:1655) is `pendingActions.expire(id)` +
// broadcast — no honest-collapse submit (unlike the approvals leg's renderExpired, and unlike the
// brake's action leg after okes). So the queued last-call keeps its stale deadline and relies
// ENTIRELY on the arbiter re-deriving facts at delivery time.

test("7qb1 e2e — after a drain-tick blackout, a staged action the sweep already cancelled must never be interrupted with 'approve now'", () => {
  const arb = createTurnArbiter();
  const h = makeHarness(arb as any);
  h.gating.pendingActions.add({ id: "act_1", capability: "create_pane", summary: "Create pane x", timestamp: T0, run: () => "ok" });

  // Gating sweep tick 1 (its own timer): the class-2 last-call is queued, deadline S1 + GRACE.
  h.gating.sweepExpiredApprovals(S1);
  assert.strictEqual(h.gating.pendingActions.get("act_1")!.lastCallAt, S1,
    "precondition: the sweep stamped the last-call and queued it in the arbiter");
  assert.strictEqual(h.narrations.length, 0, "precondition: the timer lane routes through the arbiter, not the slot");

  // ── BLACKOUT ── the drain loop's session-mismatch guard returns before evaluate() for the whole
  // reconnect window: NO arbiter tick happens here. The gating sweep is a separate timer and runs on.
  h.gating.sweepExpiredApprovals(S1 + GRACE + 1);
  assert.strictEqual(h.gating.pendingActions.has("act_1"), false,
    "precondition: zero floor pause was ever observed, so the sweep genuinely dropped the staged action");

  // ~10 minutes later the resumed session's drain loop ticks again. floorHeld === !turnClear
  // (src/voice/index.ts:2794) and a just-resumed session is not turn-clear, so the FIRST tick back
  // is floor-held — which is precisely what makes the un-ticked gap saturate the +60s extension.
  const RESUME = S1 + GRACE + 10 * 60_000;
  const spoken = [
    ...heard(arb.evaluate({ now: RESUME, floorHeld: true, turnClear: false })),
    ...heard(arb.evaluate({ now: RESUME + TICK, floorHeld: false, turnClear: true })),
  ];

  assert.strictEqual(spoken.length, 1,
    `told-more + exactly-once: act_1 must surface exactly once (never-drop protects TRUE facts, and ` +
      `the cancellation IS true) — heard ${JSON.stringify(spoken)}`);
  assert.doesNotMatch(spoken[0], /approve now/i,
    "7qb1 feature absent: the interrupt arm speaks it.facts verbatim (toDigestItem, turnArbiter.ts:349) " +
      "instead of re-deriving them like buildQueueDrain's factsForDrain — so ~10 minutes after the " +
      "sweep cancelled act_1 the arbiter interrupts the operator with the queue-time " +
      "'approve now or I'll drop it' for an action that no longer exists");
  assert.match(spoken[0], /expir|cancel/i,
    "the operator must hear the honest deadline.onExpirySwap outcome instead");
  assert.match(spoken[0], /create_pane|Create pane x/,
    "told-more: the honest line still names the action, never a generic notice");
});

// ── (2) the mechanism, at the pure arbiter surface ──────────────────────────────────────────────

const LAST_CALL = "npm run deploy on pane t1 - approve now or I'll drop it.";
const EXPIRY_SWAP = "The command on pane t1 expired; I cancelled it.";

test("7qb1 core — an interrupt fired long past the floor-extended expiry speaks the expiry swap, exactly once", () => {
  const arb = createTurnArbiter();
  const EXPIRES_AT = T0 + GRACE;
  arb.submit({
    facts: LAST_CALL,
    cls: 2,
    paneId: "t1",
    coalesceKey: "last-call:d1",
    deadline: { expiresAt: EXPIRES_AT, onExpirySwap: EXPIRY_SWAP },
  });

  // One healthy floor-held tick while the deadline is still live.
  assert.strictEqual(arb.evaluate({ now: T0 + TICK, floorHeld: true, turnClear: false }).action, "hold",
    "precondition: mid-floor, inside the deadline — the last-call waits");

  // ── BLACKOUT ── ten minutes with no evaluate() at all, straight across the real expiry.
  const RESUME = EXPIRES_AT + 10 * 60_000;
  const spoken = [
    ...heard(arb.evaluate({ now: RESUME, floorHeld: true, turnClear: false })),
    ...heard(arb.evaluate({ now: RESUME + TICK, floorHeld: false, turnClear: true })),
  ];

  assert.deepStrictEqual(spoken, [EXPIRY_SWAP],
    "7qb1: the item's floor-extended expiry (expiresAt + pausedMs, capped at +60s) passed ~9 minutes " +
      "before this tick, so its facts are dead. The interrupt arm must re-derive them at delivery " +
      "time (factsForDrain) — or decline to interrupt and let the honest drain speak — and either " +
      "way surface the item EXACTLY ONCE. Pre-fix it speaks the queue-time actionable ask.");
});

// ── (3) the guard the fix must not trample: a genuinely-earned interrupt keeps its original facts ─

test("7qb1 guard — an interrupt earned by a continuous floor hold still delivers the ORIGINAL last-call", () => {
  const arb = createTurnArbiter();
  const EXPIRES_AT = T0 + GRACE;
  arb.submit({
    facts: LAST_CALL,
    cls: 2,
    paneId: "t1",
    coalesceKey: "last-call:d1",
    deadline: { expiresAt: EXPIRES_AT, onExpirySwap: EXPIRY_SWAP },
  });

  // The operator monologues without a break. The loop ticks on its real cadence, phase-offset from
  // the deadline by 137ms exactly as a wall-clock timer would be — so the interrupt necessarily
  // lands a fraction of a tick PAST the extended boundary. That overshoot is not staleness.
  const PHASE = 137;
  let decision: AnyRec = { action: "hold" };
  let firedAt = 0;
  for (let now = T0 + PHASE; now <= T0 + 10 * 60_000; now += TICK) {
    decision = arb.evaluate({ now, floorHeld: true, turnClear: false });
    if (decision.action !== "hold") { firedAt = now; break; }
  }

  assert.strictEqual(decision.action, "interrupt-at-phrase-boundary",
    "D1: the +60s extension consumed tick-by-tick with the floor still held must still interrupt");
  assert.strictEqual(firedAt, EXPIRES_AT + 60_000 + PHASE,
    "the interrupt fires on the first tick at/after expiresAt + the 60s cap");
  assert.strictEqual(decision.digest.headline.facts, LAST_CALL,
    "the D1 interrupt exists to DELIVER the last chance BEFORE the drop (gating still holds the item " +
      "at this instant — decideSweepAction rejects only once now - lastCallAt > grace + floorPausedMs), " +
      "so a genuinely-earned interrupt keeps the actionable ask. The 7qb1 fix must discriminate a " +
      "long-dead deadline from one that just reached its boundary: an unconditional swap — or an " +
      "`expiresAt + CAP` cutoff, which every real phase-offset tick trips — would make D1's last " +
      "chance unreachable in the field and break the two interrupt pins in test_turn_arbiter_core.ts.");
});
