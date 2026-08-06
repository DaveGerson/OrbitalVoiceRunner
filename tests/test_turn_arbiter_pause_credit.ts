// tests/test_turn_arbiter_pause_credit.ts — J0 RED (bead rz7k): the D1 floor-pause LEDGER.
//
// Layer: JOURNEYS_DESIGN.md §4 "Cross-Cutting Layer: Conversational Coherence (J0)" — utterance ⇄
// state divergence. Sibling suites this one deliberately does NOT duplicate: test_turn_arbiter_core
// (D1 accrual + the 60s cap), test_turn_arbiter_deadlines / _journeys (the gating sweep's
// floorPausedMs consult end-to-end). Same idiom as those files: the module under test is REAL
// (src/voice/turnArbiter.ts), the ONLY fake is time — the caller supplies `now` on every evaluate().
//
// ── What is under test ─────────────────────────────────────────────────────────────────────────
// `lastKnownPausedMs` (turnArbiter.ts) is the ledger behind the public `floorPausedMs(coalesceKey)`
// seam. It is not an internal curiosity: the gating sweep reads it EVERY tick and widens a staged
// item's grace by exactly that number (`sweepApprovalItem` / `sweepActionItem`, src/gating/index.ts
// — `extraGraceMs = turnArbiter.floorPausedMs(coalesceKey)`), and the arbiter itself re-derives a
// class-2 item's spoken facts through it (`factsForDrain`: past `deadline.expiresAt + pausedMs` the
// last-call swaps to the honest expiry notice). A wrong number therefore shows up in the two places
// this program cares about: how long a dead item lives, and WHICH SENTENCE the operator hears.
//
// Two defects, one ledger:
//
//   (a) IT NEVER PRUNES. The only deleter is `remove(coalesceKey)` — the invalidated-fact retraction
//       path (gating's `removeStaleLastCallOnTtlReset`, the reference pattern for the whole J0
//       invariant). Every OTHER exit is silent: a drained item (`queue.clear()` in buildQueueDrain)
//       and a cap-interrupt-delivered item (`queue.delete` in evaluate) both leave their map entry
//       behind for the life of the process — one leaked entry per staged approval/action, and
//       floorPausedMs keeps reporting a credit for a deadline that no longer exists. Note gating
//       CANNOT clean this up on the timeout path: `removeQueuedLastCall` deliberately EXCLUDES
//       `expired` (renderExpired re-submits under the same key so the stale last-call collapses into
//       truth), so the arbiter is the only place that can release a dead deadline's credit.
//
//   (b) A DRAIN-TICK BLACKOUT IS FULLY PAUSE-CREDITED. `advancePause` credits the whole span since
//       the previous observation whenever `floorHeld` is true AT THE RESUME TICK — the floor state
//       when the loop LAST looked is never consulted. The drain loop is per-connection and ticks on
//       the OPERATOR_HOLD_MS (1.5s) cadence (src/voice/index.ts drainArbiterTick), and it evaluates
//       with `floorHeld: !turnClear` — so a starved loop (disconnect/reconnect gap, blocked event
//       loop, superseded-session guard) that resumes while the model happens to be mid-turn donates
//       the ENTIRE gap to the deadline, up to the 60s cap. Direction is benign (it delays rather
//       than rushes) but the number is a fiction: the arbiter never observed the operator holding
//       the floor for that time, and it spends that fiction on a real utterance — the operator hears
//       "approve now or I'll drop it" for a command the sweep already dropped.
//
// ── Pinned contract ────────────────────────────────────────────────────────────────────────────
//   1. Pause credit is only ever the floor time the arbiter OBSERVED. A span is observed floor-held
//      when the floor was held at BOTH ends of it; a gap the loop simply did not look across is
//      worth ~0, whatever `floorHeld` reads at the resume tick.
//   2. When a class-2 item leaves the queue with its (extended) deadline ALREADY REACHED — the
//      expiry-swap drain, or the D1 cap interrupt — its ledger entry is released.
//   3. When a class-2 item leaves the queue with its deadline STILL LIVE (an in-extension drain),
//      the credit SURVIVES: the sweep is still widening that approval's grace by it, and the
//      operator's response window must not be cut in half. Prune the dead deadline, not the map.
//
// Runner: npx tsx --test --test-force-exit tests/test_turn_arbiter_pause_credit.ts

import { test } from "node:test";
import assert from "node:assert";
import { createTurnArbiter, TTL_FLOOR_EXTENSION_CAP_MS } from "../src/voice/turnArbiter";

type AnyRec = Record<string, any>;
type Arb = ReturnType<typeof createTurnArbiter>;

const T0 = 1_700_000_000_000;

const LAST_CALL_FACTS = "approve the deploy now or I'll drop it";

/** Slack allowed for a span the arbiter never OBSERVED the floor across. The honest credit is 0;
 *  ~3 drain ticks (OPERATOR_HOLD_MS = 1.5s) of tolerance keeps this test agnostic about how the fix
 *  treats the single unknown-state tick at the resume edge, while still failing a wholesale gap credit. */
const MAX_UNOBSERVED_CREDIT_MS = 5_000;

function submitLastCall(arb: Arb, key: string, expiresAt: number, onExpirySwap: string): void {
  arb.submit({
    facts: LAST_CALL_FACTS,
    cls: 2,
    paneId: "t1",
    coalesceKey: key,
    deadline: { expiresAt, onExpirySwap },
  });
}

function evaluateAt(arb: Arb, now: number, floorHeld: boolean, turnClear = false): AnyRec {
  return arb.evaluate({ now, floorHeld, turnClear });
}

// ── (a) the ledger prunes when a deadline dies ─────────────────────────────────────────────────

test("rz7k(a) — the expiry-swap drain RELEASES the key's floor-pause credit", () => {
  const arb = createTurnArbiter();
  const key = "last-call:appr-swap";
  const swap = "the deploy approval expired — I cancelled it";
  submitLastCall(arb, key, T0 + 1_000, swap);

  assert.strictEqual(evaluateAt(arb, T0, true).action, "hold", "baseline observation, floor held");
  assert.strictEqual(evaluateAt(arb, T0 + 5_000, true).action, "hold", "5s of OBSERVED floor — the deadline waits (D1)");
  assert.strictEqual(arb.floorPausedMs(key), 5_000, "precondition: an observed floor span is credited");
  assert.strictEqual(evaluateAt(arb, T0 + 5_100, false).action, "hold", "the operator yields the floor");

  const d: AnyRec = evaluateAt(arb, T0 + 20_000, false, true);
  assert.strictEqual(d.action, "drain");
  assert.strictEqual(
    d.digest.headline.facts,
    swap,
    "precondition: the floor-extended deadline is genuinely past, so THIS drain is the honest expiry swap",
  );

  assert.strictEqual(
    arb.floorPausedMs(key),
    0,
    "rz7k(a): the item has left the queue with its extended deadline already past — the deadline is " +
      "DEAD, so the ledger must release the key. Today the entry survives for the whole process " +
      "lifetime (one per staged item, nothing ever prunes it) and floorPausedMs keeps reporting a " +
      "grace-widening credit for a deadline nobody can act on.",
  );
});

test("rz7k(a) — 200 staged deadlines run their full lifecycle: NOT ONE key retains a credit", () => {
  const arb = createTurnArbiter();
  const keys: string[] = [];

  for (let i = 0; i < 200; i++) {
    const base = T0 + i * 100_000;
    const key = `last-call:appr-${i}`;
    const swap = `approval ${i} expired — I cancelled it`;
    keys.push(key);
    submitLastCall(arb, key, base + 1_000, swap);
    evaluateAt(arb, base, true); // baseline
    evaluateAt(arb, base + 5_000, true); // observed floor -> credit accrues
    evaluateAt(arb, base + 5_100, false); // floor released
    const d: AnyRec = evaluateAt(arb, base + 20_000, false, true);
    assert.strictEqual(d.action, "drain", `cycle ${i}: the queued last-call must drain at turn-clear`);
    assert.strictEqual(d.digest.headline.facts, swap, `cycle ${i}: precondition — this drain is the expiry swap`);
  }

  const retained = keys.filter((k) => arb.floorPausedMs(k) !== 0);
  assert.strictEqual(
    retained.length,
    0,
    `rz7k(a): ${retained.length}/200 dead last-call keys still hold a floor-pause credit ` +
      `(e.g. ${retained.slice(0, 3).join(", ")}). The ledger behind floorPausedMs grows one entry per ` +
      "staged item and is never pruned — unbounded across a long operator session.",
  );
});

// ── (a') THE DOMINANT REAL LIFECYCLE — the shape-based prune cannot see it ──────────────────────
//
// Verifier finding (major): the tests above only exercise the case where the collapse item still
// CARRIES a deadline, so `releaseDeadDeadline` can recognise it as dead. Production almost never
// looks like that. Gating submits a last-call with expiresAt = now + APPROVAL_GRACE_MS, it drains a
// tick or two later while the deadline is STILL LIVE (credit correctly retained), and only later does
// the sweep expire it — at which point renderExpired resubmits the honest collapse under the SAME
// coalesceKey with NO `deadline` field. A deadline-less item cannot be judged terminal by shape (a
// resubmitted undelivered digest is also deadline-less but still LIVE and still owed its credit), so
// the entry survives for the life of the process. That is the leak the bead was actually filed for.
//
// The fix is therefore an EXPLICIT release seam the terminal caller invokes, not a smarter shape
// heuristic. These two tests pin the seam and the wiring separately.

test("rz7k(a') — a LIVE drain followed by a deadline-less expiry collapse leaks without an explicit release", () => {
  const arb = createTurnArbiter();
  const key = "last-call:appr-dominant";
  const swap = "the deploy approval expired — I cancelled it";

  // stage a last-call whose deadline is comfortably in the future
  submitLastCall(arb, key, T0 + 90_000, swap);
  evaluateAt(arb, T0, true);            // baseline observation, floor held
  evaluateAt(arb, T0 + 8_000, true);    // observed floor -> real, NONZERO credit banked
  const banked = arb.floorPausedMs(key);
  assert.ok(
    banked > 0,
    `precondition: an observed floor hold must bank a nonzero credit (got ${banked}). This test is ` +
      "worthless against a zero credit — 'released' and 'present with 0' are indistinguishable " +
      "through floorPausedMs, which is exactly why the 200-key test above could not detect the leak.",
  );

  // the item drains while its deadline is STILL LIVE — credit must survive (contract clause 3)
  const live: AnyRec = evaluateAt(arb, T0 + 9_000, false, true);
  assert.strictEqual(live.action, "drain", "precondition: the queued last-call drains at turn-clear");
  assert.strictEqual(
    live.digest.headline.facts,
    LAST_CALL_FACTS,
    "precondition: the deadline is still live, so this drain speaks the ORIGINAL last-call, not the swap",
  );
  assert.strictEqual(
    arb.floorPausedMs(key),
    banked,
    "rz7k clause 3: an in-extension drain must KEEP the credit — the gating sweep is still widening " +
      "that approval's grace by it.",
  );

  // ...then the sweep expires it and renderExpired resubmits the collapse WITHOUT a deadline
  arb.submit({ facts: swap, cls: 2, paneId: "t1", coalesceKey: key });
  const collapsed: AnyRec = evaluateAt(arb, T0 + 20_000, false, true);
  assert.strictEqual(collapsed.action, "drain", "precondition: the collapse item drains");
  assert.strictEqual(
    arb.floorPausedMs(key),
    banked,
    "documents WHY the explicit seam exists: a deadline-less collapse is indistinguishable by shape " +
      "from a resubmitted-but-still-live digest, so the arbiter must NOT auto-release here.",
  );

  // the terminal caller releases explicitly
  assert.strictEqual(
    typeof arb.releaseFloorPause,
    "function",
    "rz7k(a'): the arbiter must expose releaseFloorPause(coalesceKey) so a terminal site (renderExpired, " +
      "the brake's action collapse) can drop the credit without remove()ing the TRUE collapse fact it " +
      "just submitted.",
  );
  arb.releaseFloorPause!(key);
  assert.strictEqual(
    arb.floorPausedMs(key),
    0,
    "rz7k(a'): after the terminal site releases, the ledger entry is gone — this is what bounds the map " +
      "across a long operator session.",
  );
});

test("rz7k(a') — releaseFloorPause is a strict no-op on an unknown key and never touches the queue", () => {
  const arb = createTurnArbiter();
  const key = "last-call:appr-noop";
  submitLastCall(arb, key, T0 + 90_000, "swap text");
  evaluateAt(arb, T0, true);

  arb.releaseFloorPause!("last-call:does-not-exist");

  const d: AnyRec = evaluateAt(arb, T0 + 1_000, false, true);
  assert.strictEqual(
    d.action,
    "drain",
    "releaseFloorPause must be ledger-only: an unknown key is a no-op and a live queued item is " +
      "untouched (unlike remove(), which drops the item itself).",
  );
  assert.strictEqual(d.digest.headline.facts, LAST_CALL_FACTS, "the queued last-call still speaks its own facts");
});

// ── wiring: the terminal sites actually call the seam ───────────────────────────────────────────
//
// The seam is worthless if nothing invokes it, and no unit test drives renderExpired's arbiter branch
// end-to-end. Same source-scan idiom the repo already uses for un-drivable wiring lines
// (tests/test_turn_arbiter_journeys.ts sliceBetween/nonCommentLines).

function nonCommentLines(content: string): string[] {
  return content
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*") && !l.trimStart().startsWith("/*"));
}

/** Slice the enclosing function body so a scan can be pinned PER SITE rather than by raw count. */
function sliceFrom(content: string, startMarker: string, endMarker: string): string {
  const start = content.indexOf(startMarker);
  assert.ok(start >= 0, `source-scan anchor not found: ${JSON.stringify(startMarker)}`);
  const end = content.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `source-scan end anchor not found after ${JSON.stringify(startMarker)}`);
  return content.slice(start, end);
}

test("rz7k(a') — EVERY terminal site releases the credit, each under its OWN key (per-site, not a count)", async () => {
  const { readFileSync } = await import("node:fs");
  const gatingSource = readFileSync(new URL("../src/gating/index.ts", import.meta.url), "utf8");
  const live = nonCommentLines(gatingSource).join("\n");

  // A raw `>= N` count is defeatable: N calls with a typo'd key, or N calls all inside ONE site,
  // would pass while the leak returns. Pin the site AND the key literal, the way the 3tx3 wiring
  // scan does. All three sites are terminal for their record and all three must release.
  const sites: Array<{ what: string; start: string; end: string; key: RegExp }> = [
    {
      what: "renderExpired's expiry/brake collapse (approvals leg)",
      start: "turnArbiter.submit({ facts: expiryFacts",
      end: "} else if (session)",
      key: /releaseFloorPause\?\.\(`last-call:\$\{record\.messageId\}`\)/,
    },
    {
      what: "collapseBrakedActionLastCall (brake action leg)",
      start: "function collapseBrakedActionLastCall",
      end: "\n  }",
      key: /releaseFloorPause\?\.\(`last-call:\$\{a\.id\}`\)/,
    },
    {
      what: "dropExpiredAction, the action leg's own terminal TTL drop (sweepActionItem's reject leg)",
      start: "function dropExpiredAction",
      end: "\n  }",
      key: /releaseFloorPause\?\.\(coalesceKey\)/,
    },
  ];

  for (const site of sites) {
    const block = sliceFrom(live, site.start, site.end);
    assert.match(
      block,
      site.key,
      `rz7k(a'): ${site.what} is a TERMINAL exit for its record and must release the floor-pause credit ` +
        "under its own key. Note the dominant lifecycle drains the last-call while its deadline is " +
        "still LIVE, so the item is gone from the queue by the time it dies — releaseDeadDeadline can " +
        "never see it and nothing else will ever free the entry.",
    );
  }
});

test("rz7k(a) — the D1 cap interrupt also releases the key (the extension is fully consumed)", () => {
  const arb = createTurnArbiter();
  const key = "last-call:appr-cap";
  submitLastCall(arb, key, T0 + 1_000, "the deploy approval expired — I cancelled it");

  assert.strictEqual(evaluateAt(arb, T0, true).action, "hold", "baseline observation, floor held");
  const intr: AnyRec = evaluateAt(arb, T0 + 61_000, true);
  assert.strictEqual(
    intr.action,
    "interrupt-at-phrase-boundary",
    "precondition: cap consumed + the extended deadline reached mid-floor -> D1 delivers the last-call",
  );
  assert.strictEqual(intr.digest.headline.coalesceKey, key, "precondition: the interrupt dequeued THIS item");

  assert.strictEqual(
    arb.floorPausedMs(key),
    0,
    "rz7k(a): the interrupt fires exactly AT the extended boundary and dequeues the item for good, " +
      "and the sweep's reject boundary is that same instant — the credit can buy the item nothing " +
      "more. It must be released here too, not leaked for the life of the process.",
  );
});

test("rz7k(a) guard — a still-LIVE last-call KEEPS its credit after delivery (prune the dead deadline, not the map)", () => {
  const arb = createTurnArbiter();
  const key = "last-call:appr-live";
  submitLastCall(arb, key, T0 + 30_000, "the deploy approval expired — I cancelled it");

  evaluateAt(arb, T0, true);
  evaluateAt(arb, T0 + 20_000, true);
  assert.strictEqual(arb.floorPausedMs(key), 20_000, "precondition: 20s of observed floor is credited");

  const d: AnyRec = evaluateAt(arb, T0 + 21_000, false, true);
  assert.strictEqual(d.action, "drain");
  assert.strictEqual(
    d.digest.headline.facts,
    LAST_CALL_FACTS,
    "precondition: inside the extension the ORIGINAL, still-actionable last-call speaks — not the swap",
  );

  const credit = arb.floorPausedMs(key);
  assert.ok(
    credit >= 20_000 && credit <= TTL_FLOOR_EXTENSION_CAP_MS,
    `a delivered but still-LIVE deadline must KEEP its credit (got ${credit}). The gating sweep is ` +
      "still widening THIS approval's grace by it (sweepApprovalItem), so a blanket prune-on-drain " +
      "would halve the response window the operator was just promised. Only a DEAD deadline prunes.",
  );
});

// ── (b) a blackout gap is not floor time ───────────────────────────────────────────────────────

test("rz7k(b) — a 45s drain-tick blackout is NOT pause-credited: the drain speaks the honest expiry notice", () => {
  // The drain loop is starved for 45s (socket drop + reconnect, or a blocked event loop). When it
  // resumes, the model happens to be mid-turn — the loop evaluates with `floorHeld: !turnClear`, so
  // floorHeld reads true for a moment and then clears. The operator did NOT hold the floor for 45s;
  // the arbiter simply was not looking. Only the observed sliver may count.
  const arb = createTurnArbiter();
  const key = "last-call:appr-blackout";
  const swap = "the deploy approval expired — I cancelled it";
  submitLastCall(arb, key, T0 + 46_000, swap);

  assert.strictEqual(evaluateAt(arb, T0, false).action, "hold", "last look before the blackout: the floor is FREE");
  // ---- 45s blackout: no evaluate() at all ----
  assert.strictEqual(evaluateAt(arb, T0 + 45_000, true).action, "hold", "the loop resumes mid-turn (floor reads held)");
  assert.strictEqual(evaluateAt(arb, T0 + 45_500, false).action, "hold", "half a second later the floor is free again");

  const credited = arb.floorPausedMs(key);
  const d: AnyRec = evaluateAt(arb, T0 + 50_000, false, true);
  assert.strictEqual(d.action, "drain");
  assert.strictEqual(
    d.digest.headline.facts,
    swap,
    "rz7k(b): the deadline (T0+46s) is 4s past and the arbiter observed at most 500ms of floor, so the " +
      "operator must hear the honest expiry notice. Instead the blackout gap was banked as floor-pause " +
      `(${credited}ms of the 45s gap), pushing the effective expiry into the future and speaking a ` +
      "still-actionable last-call for a command the sweep has already dropped — utterance ⇄ state divergence.",
  );
  assert.ok(
    credited <= MAX_UNOBSERVED_CREDIT_MS,
    `rz7k(b): ${credited}ms credited for a 45s span the arbiter never observed the floor across ` +
      "(it only saw a held floor at the resume tick). Credit the OBSERVED floor time — the gating " +
      "sweep widens the staged item's grace by exactly this number, so the fiction extends a dead " +
      "item's life by up to the 60s cap.",
  );
});

test("rz7k(b) — credit follows the OBSERVED floor span, not the resume tick's floor flag", () => {
  // Same elapsed span (30s), same floor flag at the final tick. The ONLY difference is whether the
  // arbiter actually watched the floor across it. That difference must be the whole difference.
  const observed = createTurnArbiter();
  submitLastCall(observed, "last-call:obs", T0 + 500_000, "expired");
  evaluateAt(observed, T0, true);
  evaluateAt(observed, T0 + 30_000, true);
  assert.strictEqual(
    observed.floorPausedMs("last-call:obs"),
    30_000,
    "guard (must stay green): a span observed floor-held at BOTH ends is credited in full — D1's promise",
  );

  const blackout = createTurnArbiter();
  submitLastCall(blackout, "last-call:blk", T0 + 500_000, "expired");
  evaluateAt(blackout, T0, false); // the floor was free when the loop last looked
  evaluateAt(blackout, T0 + 30_000, true); // 30 silent seconds later it resumes mid-turn
  const credited = blackout.floorPausedMs("last-call:blk");
  assert.ok(
    credited <= MAX_UNOBSERVED_CREDIT_MS,
    `rz7k(b): the two arbiters above are indistinguishable to the current code (${credited}ms credited ` +
      "for the unobserved gap vs 30000ms for the genuinely held one) because only the RESUME tick's " +
      "floorHeld is consulted. The floor state when the loop last looked must gate the credit.",
  );
});
