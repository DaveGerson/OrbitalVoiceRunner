// tests/test_turn_arbiter_severity_ties.ts — RED for bead vwld (J0 conversational coherence):
// `severityRank ?? 0` makes an UNRANKED item sort as if it had declared 'exception' severity.
//
// The defect (src/voice/turnArbiter.ts, buildQueueDrain's comparator):
//     .sort((a, b) => a.cls - b.cls || (a.severityRank ?? 0) - (b.severityRank ?? 0) || a.insertionOrder - ...)
// `?? 0` coerces "this producer declared NO severity" into "this producer declared the MOST severe
// rank there is" (severityRankOf: exception -> 0, info -> 1, absent -> undefined). Consequences:
//   • an unranked item OUTRANKS an earlier declared-`info` item (steals the headline), and
//   • it TIES declared-`exception`,
// both of which contradict the two docs that define the field:
//   • SubmitItem.severityRank (turnArbiter.ts): "Absent -> every item in the class ties, so
//     insertion order (FIFO) stays the sole tiebreaker -- an additive refinement that never changes
//     behavior for a producer that doesn't set it."
//   • severityRankOf (src/voice/correctionLedger.ts): "No severity given -> undefined, so the
//     arbiter's own FIFO default applies."
//   • resubmitUndeliveredDigest (src/voice/index.ts): "DigestItem does not carry severityRank/
//     deadline, so a resubmitted item re-queues at FIFO rank" — today it re-queues at EXCEPTION rank.
//
// CONTRACT DECISION (maintainer, bead vwld): fix the CODE, not the doc. An absent severityRank is a
// FIFO TIE — never rank 0. Two clauses, both pinned below:
//   (C1) An item that declares NO rank keeps its FIFO slot within its class. It is neither promoted
//        (today's bug) nor demoted (so `?? Number.MAX_SAFE_INTEGER` / +Infinity is NOT the fix —
//        that would silently change behavior for producers that never set the field, which the doc
//        explicitly promises it won't).
//   (C2) Items that DO declare a rank still order among themselves by severity regardless of
//        arrival order (the pre-existing co-design §D pin: "an exception correction headlines over
//        an info one EVEN IF invalidated later"), and an UNRANKED BYSTANDER in the same class must
//        not break that ordering. Otherwise the naive `either-side-undefined -> return 0` comparator
//        re-introduces the same defect class from the other end: a rank-less correction wedged
//        between an `info` and an `exception` blocks the severity comparison (non-transitive
//        comparator), and the operator hears the info correction first.
//   An implementation satisfying both: within a class, take the FIFO order, then reorder ONLY the
//   rank-declaring items among the slots they already occupy (rank asc, FIFO within equal rank).
//   Unranked items never move. Must stay class-scoped — severity never crosses a class boundary.
//
// Why this belongs to the J0 layer (JOURNEYS_DESIGN.md §4): the digest headline IS the utterance —
// it is the one item spoken in full, the tail is a counted summary. A mis-ranked headline is the
// utterance ⇄ state divergence of this layer's "lead with the worst" contract: the ledger holds the
// severities, the spoken line ignores them.
//
// Everything under test is REAL: the real createTurnArbiter, the real createCorrectionLedger
// producer (the wild path — "bites when a future invalidator omits severity", bead vwld), and the
// real renderArbiterDigest so at least one assertion is on the actual spoken injection. Time is the
// caller-supplied fake `now` (the arbiter is pure — no clock of its own).
//
// Runner: npx tsx --test --test-force-exit tests/test_turn_arbiter_severity_ties.ts

import { test } from "node:test";
import assert from "node:assert";
import { createTurnArbiter } from "../src/voice/turnArbiter";
import { createCorrectionLedger } from "../src/voice/correctionLedger";
// Namespace import (the tests/test_turn_arbiter_journeys.ts idiom): keeps a missing/renamed export
// a clean per-test assertion instead of a module-link crash across the file.
import * as voiceIndexModule from "../src/voice/index";

type AnyRec = Record<string, any>;

const voiceIndex = voiceIndexModule as AnyRec;

const T0 = 1_700_000_000_000;

/** Headline first, then the counted tail — the drain order the operator actually hears. */
function drainOrder(d: AnyRec): string[] {
  return [d.digest.headline, ...d.digest.tail].map((it: AnyRec) => it.facts);
}

/** Structural shape so the REAL TurnArbiter (typed) can be passed straight through. */
type Drainable = { evaluate(ctx: { now: number; floorHeld: boolean; turnClear: boolean }): unknown };

function drainAt(arb: Drainable, now: number): AnyRec {
  const d = arb.evaluate({ now, floorHeld: false, turnClear: true }) as AnyRec;
  assert.strictEqual(d.action, "drain", "the queue must drain in ONE digest at turn-clear");
  return d;
}

// ── C1 RED: an unranked item must not be promoted to 'exception' rank ──────────────────────────

test("vwld: an unranked correction does NOT steal the headline from an earlier declared-info one (real ledger)", () => {
  const arb = createTurnArbiter();
  const led: AnyRec = createCorrectionLedger({ arbiter: arb });

  const INFO_TRUTH = "pane p1 is actually still running — not finished";
  const NO_SEV_TRUTH = "pane p2's note was never written";
  led.record({ claimId: "c-info", paneId: "p1", kind: "completion", assertedText: "Pane p1 finished.", assertedAt: T0, spoken: true });
  led.record({ claimId: "c-nosev", paneId: "p2", kind: "dispatch", assertedText: "Dispatched on pane p2.", assertedAt: T0 + 10, spoken: true });

  // The declared-`info` correction is elected FIRST (rank 1, insertion order 0)...
  assert.strictEqual(led.invalidate("c-info", INFO_TRUTH, { severity: "info" }).corrected, true);
  // ...then an invalidator that omits severity entirely (rank ABSENT, insertion order 1). Bead vwld:
  // "bites when a future a2tp/qj6s invalidator omits severity".
  assert.strictEqual(led.invalidate("c-nosev", NO_SEV_TRUTH).corrected, true);

  const d = drainAt(arb, T0 + 1_000);
  const order = drainOrder(d);
  assert.strictEqual(order.length, 2, "both corrections ride ONE digest");

  assert.ok(
    d.digest.headline.facts.includes(INFO_TRUTH),
    "absent severityRank must sort as a FIFO TIE, not as rank 0 ('exception'): the EARLIER, "
      + "declared-info correction keeps the headline. Got headline: " + d.digest.headline.facts,
  );
  assert.ok(
    !d.digest.headline.facts.includes(NO_SEV_TRUTH),
    "a correction whose producer declared NO severity must never outrank a declared one — "
      + `it did (headline: ${d.digest.headline.facts})`,
  );
  assert.deepStrictEqual(
    order.map((f: string) => (f.includes(INFO_TRUTH) ? "declared-info" : "no-severity")),
    ["declared-info", "no-severity"],
    "within class 0 the drain order is FIFO when one side declares nothing",
  );

  // The spoken injection must carry the same order (the headline leads the utterance verbatim).
  assert.strictEqual(typeof voiceIndex.renderArbiterDigest, "function",
    "src/voice/index.ts must still export renderArbiterDigest (the drain renderer)");
  const rendered = voiceIndex.renderArbiterDigest(d.digest, d.mode) as { text: string };
  const infoAt = rendered.text.indexOf(INFO_TRUTH);
  const noSevAt = rendered.text.indexOf(NO_SEV_TRUTH);
  assert.ok(infoAt >= 0 && noSevAt >= 0, "both retraction facts ride the injection (told-more floor)");
  assert.ok(
    infoAt < noSevAt,
    "what the operator HEARS first must be the declared-info correction, not the rank-less one "
      + `(spoken text: ${rendered.text})`,
  );
});

test("vwld: an unranked item queued after a ranked one keeps its FIFO slot (generic, class 3)", () => {
  const arb = createTurnArbiter();
  // A ranked clean-success completion (completionPolicy's rank for a non-exception is 1)...
  arb.submit({ facts: "pane p1 finished", cls: 3, paneId: "p1", severityRank: 1 });
  // ...and an item whose producer declares nothing — e.g. resubmitUndeliveredDigest, which drops
  // severityRank on purpose and is documented to "re-queue at FIFO rank".
  arb.submit({ facts: "pane p2 finished", cls: 3, paneId: "p2" });

  const d = drainAt(arb, T0 + 500);
  assert.deepStrictEqual(
    drainOrder(d),
    ["pane p1 finished", "pane p2 finished"],
    "absent severityRank is a FIFO tie: the unranked item must NOT jump the earlier rank-1 item "
      + "(today `?? 0` gives it exception rank and it headlines)",
  );
});

// ── C2 RED: an unranked bystander must not break severity ordering between ranked items ────────

test("vwld: an unranked bystander must not demote a declared exception below a declared info", () => {
  const arb = createTurnArbiter();
  const INFO = "correction: pane p1 — retracting the completion claim; ground truth: still running";
  const NO_SEV = "correction: pane p2 — retracting the dispatch claim; ground truth: never dispatched";
  const EXC = "correction: pane p3 — retracting the restart claim; ground truth: the pane is NOT up";

  arb.submit({ facts: INFO, cls: 0, paneId: "p1", severityRank: 1 });   // declared info,   order 0
  arb.submit({ facts: NO_SEV, cls: 0, paneId: "p2" });                  // declared nothing, order 1
  arb.submit({ facts: EXC, cls: 0, paneId: "p3", severityRank: 0 });    // declared exception, order 2

  const d = drainAt(arb, T0 + 1_500);
  assert.strictEqual(drainOrder(d).length, 3, "all three corrections ride ONE digest (never-drop)");
  assert.strictEqual(
    d.digest.headline.facts, EXC,
    "lead with the worst (co-design §D): the DECLARED exception headlines over the DECLARED info "
      + "regardless of arrival order, and a rank-less bystander in the same class must not change "
      + `that. Got headline: ${d.digest.headline.facts}`,
  );
  const spokenFirst = drainOrder(d)[0];
  assert.notStrictEqual(
    spokenFirst, NO_SEV,
    "the rank-less correction must never be spoken as the headline — declaring nothing is not "
      + "declaring 'exception'",
  );
});

// ── C1 guard (passes today; must KEEP passing): the tie cuts both ways ─────────────────────────

test("vwld: a later declared exception does NOT jump over an EARLIER unranked item (absent is a tie, not last)", () => {
  const arb = createTurnArbiter();
  arb.submit({ facts: "correction: pane p8 — dispatch never landed", cls: 0, paneId: "p8" }); // no rank, order 0
  arb.submit({ facts: "correction: pane p9 — the restart FAILED", cls: 0, paneId: "p9", severityRank: 0 });

  const d = drainAt(arb, T0 + 2_000);
  assert.deepStrictEqual(
    drainOrder(d),
    ["correction: pane p8 — dispatch never landed", "correction: pane p9 — the restart FAILED"],
    "absent severityRank must TIE (FIFO decides), so the fix must not be `?? +Infinity`/MAX_SAFE_INTEGER: "
      + "demoting unranked items would change behavior for producers that never set the field — the "
      + "one thing SubmitItem.severityRank's doc promises it never does",
  );
});

test("vwld: a class where NOBODY declares a rank stays pure FIFO", () => {
  const arb = createTurnArbiter();
  arb.submit({ facts: "correction: first", cls: 0, paneId: "pa" });
  arb.submit({ facts: "correction: second", cls: 0, paneId: "pb" });
  arb.submit({ facts: "correction: third", cls: 0, paneId: "pc" });

  const d = drainAt(arb, T0 + 2_500);
  assert.deepStrictEqual(
    drainOrder(d),
    ["correction: first", "correction: second", "correction: third"],
    "insertion order is the sole tiebreaker when no item declares a severity (Wave-1 pin)",
  );
});

test("vwld: severity never crosses a class boundary — an unranked class-0 item still outranks a rank-0 class-3 one", () => {
  const arb = createTurnArbiter();
  arb.submit({ facts: "pane p4 completion FAILED", cls: 3, paneId: "p4", severityRank: 0 });
  arb.submit({ facts: "correction: pane p5 — the restart claim was wrong", cls: 0, paneId: "p5" });

  const d = drainAt(arb, T0 + 3_000);
  assert.deepStrictEqual(
    drainOrder(d),
    ["correction: pane p5 — the restart claim was wrong", "pane p4 completion FAILED"],
    "class is the PRIMARY key: the severity fix must stay scoped inside a class (a class-3 "
      + "exception never outranks a class-0 correction)",
  );
});
