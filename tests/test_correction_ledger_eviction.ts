// tests/test_correction_ledger_eviction.ts — r25i RED: terminal claims are EVICTED, not flagged.
//
// The pre-r25i ledger marked terminal states in place (`superseded` on record(), `corrected` on
// invalidate()) and NOTHING ever deleted — the claims map grew ~0.5-1KB per claim for process
// lifetime. Both marked states are terminal (a superseded claim can never be corrected; a
// corrected claim can never be re-corrected), so absence carries exactly the same information as
// the flag. r25i contract:
//   1. supersede -> EVICT the prior claim (claims map + latestSpokenByPane if it points there);
//   2. correct   -> build facts FIRST, submit to the arbiter, THEN evict the claim;
//   3. result surface: a re-invalidate of an evicted ref returns the unknown-ref result instead of
//      reason "already corrected"/"superseded" — the OUTCOME (corrected:false, no double-speak,
//      no false correction) is identical; storm control moves from flag-check to absence;
//   4. bound: the live set caps at ~(panes x 4 kinds) + never-spoken claims awaiting supersession.
//
// OBSERVABILITY DECISION (deliberate): no size()/debugSize() accessor is added. Eviction is fully
// observable through the existing surface — invalidate()'s `reason` distinguishes "unknown ref"
// (resolveClaim missed BOTH the claims map and the pane index, i.e. the record is GONE) from the
// old terminal-flag reasons (record present, flag set). Pinning "unknown ref" on every old ref
// therefore proves map-membership without widening the module surface with test-only internals.
//
// Runner: npx tsx --test --test-force-exit tests/test_correction_ledger_eviction.ts
import { test } from "node:test";
import assert from "node:assert";
import { createTurnArbiter } from "../src/voice/turnArbiter";
import { createCorrectionLedger } from "../src/voice/correctionLedger";

type AnyRec = Record<string, any>;
const T0 = 1_700_000_000_000;

// ── (a) supersede evicts ───────────────────────────────────────────────────────────────────────

test("supersede EVICTS the prior claim: invalidating the old ref reports unknown ref, not 'superseded'", () => {
  const arb = createTurnArbiter();
  const led: AnyRec = createCorrectionLedger({ arbiter: arb });
  led.record({ claimId: "c1", paneId: "p1", kind: "restart", assertedText: "Restarted pane p1.", assertedAt: T0, spoken: true });
  led.record({ claimId: "c2", paneId: "p1", kind: "restart", assertedText: "Restarted pane p1 again.", assertedAt: T0 + 1_000, spoken: true });

  const res = led.invalidate("c1", "the first restart failed");
  assert.strictEqual(res.corrected, false, "outcome parity: a superseded claim is still never corrected");
  assert.strictEqual(res.reason, "unknown ref",
    "r25i: the prior claim was EVICTED on supersede — the ref resolves to nothing (absence, not a flag)");
  assert.strictEqual(arb.evaluate({ now: T0 + 2_000, floorHeld: false, turnClear: true }).action, "hold",
    "outcome parity: nothing reaches the arbiter for the evicted claim");

  assert.strictEqual(led.invalidate("c2", "the second restart failed too").corrected, true,
    "the live (newest) claim still corrects normally");
});

// ── (b) correct evicts ─────────────────────────────────────────────────────────────────────────

test("correct EVICTS: re-invalidating a corrected ref reports unknown ref, not 'already corrected'", () => {
  const arb = createTurnArbiter();
  const led: AnyRec = createCorrectionLedger({ arbiter: arb });
  led.record({ claimId: "c1", paneId: "p2", kind: "restart", assertedText: "Restarted pane p2.", assertedAt: T0, spoken: true });
  assert.strictEqual(led.invalidate("c1", "the restart actually failed").corrected, true);

  const again = led.invalidate("c1", "the restart failed harder");
  assert.strictEqual(again.corrected, false, "outcome parity: at most ONE correction per claim");
  assert.strictEqual(again.reason, "unknown ref",
    "r25i: the corrected claim was EVICTED after its facts were submitted — dedup is now absence");

  const d: AnyRec = arb.evaluate({ now: T0 + 1_000, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain");
  assert.strictEqual([d.digest.headline, ...d.digest.tail].filter((i: AnyRec) => i.cls === 0).length, 1,
    "exactly one correction item queued — the re-invalidate submitted nothing");
  assert.strictEqual(arb.evaluate({ now: T0 + 2_000, floorHeld: false, turnClear: true }).action, "hold");
});

// ── (c) the index never dangles ────────────────────────────────────────────────────────────────

test("index never dangles: spoken c1 superseded by UNSPOKEN c2 -> latestSpokenClaim is undefined", () => {
  const arb = createTurnArbiter();
  const led: AnyRec = createCorrectionLedger({ arbiter: arb });
  // c1 is the newest SPOKEN claim, so latestSpokenByPane points at it; c2 (unspoken, same
  // pane+kind) evicts c1 without becoming spoken itself — the index must be cleaned, not left
  // dangling at the evicted id and not projecting a stale claim.
  led.record({ claimId: "c1", paneId: "p1", kind: "completion", assertedText: "pane p1 finished", assertedAt: T0, spoken: true });
  led.record({ claimId: "c2", paneId: "p1", kind: "completion", assertedText: "pane p1 finished again", assertedAt: T0 + 500, spoken: false });

  assert.strictEqual(led.latestSpokenClaim("p1"), undefined,
    "the evicted spoken claim must not survive as a stale projection (and must not throw)");
  assert.strictEqual(led.invalidate("p1", "pane p1 errored").reason, "unknown ref",
    "the pane-ref invalidate path agrees: no spoken claim resolves on p1");
});

test("index never dangles: correcting the newest spoken claim clears latestSpokenClaim for the pane", () => {
  const arb = createTurnArbiter();
  const led: AnyRec = createCorrectionLedger({ arbiter: arb });
  led.record({ claimId: "c1", paneId: "p1", kind: "completion", assertedText: "pane p1 finished", assertedAt: T0, spoken: true, assertedSuccess: true });
  assert.strictEqual(led.invalidate("c1", "it did not finish").corrected, true);
  assert.strictEqual(led.latestSpokenClaim("p1"), undefined,
    "post-correction the completion guard elects nothing — strictly less wasted work than re-elect-then-refuse");
});

// ── (d) the bound: live set is O(panes x kinds), not O(claims ever recorded) ───────────────────

test("bound: N sequential corrected claims on one pane leave the live set at O(1) — every old ref is unknown", () => {
  const arb = createTurnArbiter();
  const led: AnyRec = createCorrectionLedger({ arbiter: arb });
  const N = 50;
  for (let i = 0; i < N; i++) {
    led.record({ claimId: `c${i}`, paneId: "p1", kind: "completion", assertedText: `pane p1 finished (${i})`, assertedAt: T0 + i, spoken: true, assertedSuccess: true });
    assert.strictEqual(led.invalidate(`c${i}`, `it did not finish (${i})`).corrected, true, `cycle ${i} corrects`);
  }
  // Every historical ref is gone from the ledger — the map retained none of the N terminal claims.
  for (let i = 0; i < N; i++) {
    assert.strictEqual(led.invalidate(`c${i}`, "again").reason, "unknown ref", `c${i} evicted`);
  }
  assert.strictEqual(led.latestSpokenClaim("p1"), undefined, "no dangling index after N cycles");
});

test("bound: an N-deep supersession chain keeps only the newest claim live", () => {
  const arb = createTurnArbiter();
  const led: AnyRec = createCorrectionLedger({ arbiter: arb });
  const N = 50;
  for (let i = 0; i < N; i++) {
    led.record({ claimId: `c${i}`, paneId: "p1", kind: "restart", assertedText: `Restarted pane p1 (${i}).`, assertedAt: T0 + i, spoken: true });
  }
  for (let i = 0; i < N - 1; i++) {
    assert.strictEqual(led.invalidate(`c${i}`, "stale").reason, "unknown ref", `superseded c${i} evicted`);
  }
  assert.strictEqual(led.invalidate(`c${N - 1}`, "the last restart failed").corrected, true,
    "the sole survivor — the newest claim — still corrects normally");
});

// ── (e) never-drop control: the correction pipeline itself is untouched ────────────────────────

test("never-drop unaffected: record -> invalidate -> drain still yields exactly ONE class-0 retraction with facts intact", () => {
  // Control pin (expected GREEN pre- and post-r25i): facts are built BEFORE eviction — the
  // submitted item must still carry the assertedText and ground truth verbatim.
  const arb = createTurnArbiter();
  const led: AnyRec = createCorrectionLedger({ arbiter: arb });
  const truth = "the restart actually failed — the pane is not up";
  led.record({ claimId: "c1", paneId: "p2", kind: "restart", assertedText: "Restarted pane p2.", assertedAt: T0, spoken: true });
  assert.strictEqual(led.invalidate("c1", truth, { severity: "exception" }).corrected, true);

  const d: AnyRec = arb.evaluate({ now: T0 + 1_000, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain");
  assert.strictEqual(d.digest.headline.cls, 0);
  assert.ok(d.digest.headline.facts.includes(truth), "ground truth survives eviction (facts built first)");
  assert.match(d.digest.headline.facts, /restart/i, "assertedText was read BEFORE the claim was deleted");
  assert.ok(d.digest.headline.facts.includes("p2"), "the pane survives too");
  assert.strictEqual(d.digest.tail.length, 0, "exactly one correction");
  assert.strictEqual(arb.evaluate({ now: T0 + 2_000, floorHeld: false, turnClear: true }).action, "hold");
});
