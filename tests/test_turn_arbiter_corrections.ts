// tests/test_turn_arbiter_corrections.ts — Wave 2 RED: vc-D corrections as arbiter class 0.
//
// Spec: docs/superpowers/specs/2026-07-29-turn-arbiter-design.md §3.3 row "vc-D corrections",
// §4-W2; co-design spec §D (docs/superpowers/specs/2026-07-28-voice-coherence-codesign.md, branch
// docs/voice-coherence-codesign) — acceptance criteria 1,3,4,5,6 land here. The correction ledger
// is built INTO the arbiter from day one: the arbiter's queue IS vc-D's drainPending machinery —
// the ledger holds NO private pending-queue of its own; every elected correction is submitted as a
// class-0 item and reaches the operator only through the arbiter's single per-turn-clear drain.
//
// The module under test does NOT exist yet — every test fails "Wave-2 feature absent" until then.
// The Wave-1 arbiter (src/voice/turnArbiter.ts) is REAL here; time is the caller-supplied fake.
//
// ── Pinned API (the implementer builds EXACTLY this surface) ────────────────────────────────────
//   // src/voice/correctionLedger.ts (new, pure; turn-adjacent -> TS per the LOCKED seam rule)
//   export function createCorrectionLedger(deps: { arbiter: { submit(item): void } }): {
//     record(claim: {
//       claimId: string; paneId: string;
//       kind: "dispatch" | "restart" | "completion" | "readiness";
//       assertedText: string; assertedAt: number;
//       spoken: boolean;      // false == the claim never reached the operator (suppressed ack)
//     }): void;
//     invalidate(claimIdOrPaneId: string, groundTruth: string,
//                opts?: { severity?: "exception" | "info" }): { corrected: boolean; reason?: string };
//   };
//
// ── Pinned semantics (co-design §D, revised per D3 "force the turn, steer the words") ──────────
//   • invalidate of a SPOKEN, un-superseded, not-yet-corrected claim submits EXACTLY ONE class-0
//     item into the arbiter and returns { corrected: true }. The item's `facts` are structured
//     retraction FACTS for the digest (NOT a scripted sentence): they carry the paneId, the ground
//     truth, a correction/retraction marker, and a reference to what was asserted (kind or text) —
//     the model phrases the retraction; the arbiter guarantees the turn.
//   • Skip rules (return { corrected: false }, submit NOTHING): claim never spoken; claim already
//     corrected (at most ONE correction per claimId — a correction is never re-corrected); claim
//     superseded by a NEWER spoken claim on the same (paneId, kind); unknown ref.
//     (r25i update: corrected/superseded are terminal, so the ledger now EVICTS those claims —
//     both refusals surface as the unknown-ref result. Every OUTCOME pinned below is unchanged;
//     this suite deliberately asserts `.corrected` only, never those two reason strings.)
//   • invalidate by paneId resolves the latest spoken claim on that pane.
//   • NO time-based downgrade path exists: a pending correction drains spoken however long the
//     turn stays busy (the staleness clock was removed — supersession is the ONLY skip).
//   • Never silent: class 0 refuses passive-context even under a hostile matrix (D4 floor).
//   • Coalescing: >=2 pending corrections on one turn-clear collapse into ONE drain digest
//     (headline + counted tail), never N spoken turns, never silence. Severity orders within the
//     class: an `exception` correction headlines over an `info` one EVEN IF invalidated later —
//     suggested affordance: SubmitItem grows an optional within-class severity rank the arbiter
//     honors inside a class (FIFO stays the default when absent, preserving Wave-1 pins).
//   • (co-design §D AC7 — "corrections fire regardless of completionAnnounce" — is pinned against
//     the vc-C policy knob in Wave 3; the configuration floor is pinned here via the matrix.)
//
// Runner: npx tsx --test --test-force-exit tests/test_turn_arbiter_corrections.ts

import { test } from "node:test";
import assert from "node:assert";
import { createTurnArbiter } from "../src/voice/turnArbiter";

type AnyRec = Record<string, any>;

const T0 = 1_700_000_000_000;

// Computed specifier: tsc must NOT resolve this while the module is unimplemented (lint stays
// green during RED); tsx resolves it at runtime exactly like the static test imports.
const LEDGER_SPEC = ["..", "src", "voice", "correctionLedger"].join("/");

async function loadLedger(): Promise<AnyRec> {
  try {
    return await import(LEDGER_SPEC);
  } catch (e: any) {
    return assert.fail(
      "Wave-2 feature absent: src/voice/correctionLedger.ts is not implemented yet " +
        `(turn-arbiter spec §4-W2, co-design §D) — import failed: ${e?.message ?? e}`,
    );
  }
}

function freshLedger(mod: AnyRec, arbiter: AnyRec): AnyRec {
  assert.strictEqual(typeof mod.createCorrectionLedger, "function", "createCorrectionLedger must be exported");
  return mod.createCorrectionLedger({ arbiter });
}

function drainAll(d: AnyRec): AnyRec[] {
  return [d.digest.headline, ...d.digest.tail];
}

// ── surface ────────────────────────────────────────────────────────────────────────────────────

test("module exports the Wave-2 correction-ledger surface", async () => {
  const mod = await loadLedger();
  const led = freshLedger(mod, createTurnArbiter());
  assert.strictEqual(typeof led.record, "function", "record(claim) must exist");
  assert.strictEqual(typeof led.invalidate, "function", "invalidate(ref, groundTruth) must exist");
});

// ── AC1: spoken claim -> invalidate -> exactly one deterministic class-0 correction ────────────

test("a spoken dispatch claim invalidated drains as ONE class-0 forced turn carrying pane + reality facts", async () => {
  const mod = await loadLedger();
  const arb = createTurnArbiter();
  const led = freshLedger(mod, arb);
  const truth = "the pane was dead — nothing was dispatched";
  led.record({ claimId: "c1", paneId: "p2", kind: "dispatch", assertedText: "Dispatching now on pane p2.", assertedAt: T0, spoken: true });

  const dec = led.invalidate("c1", truth);
  assert.ok(dec && dec.corrected === true, "an invalidated spoken claim yields a correction");

  const d: AnyRec = arb.evaluate({ now: T0 + 1_000, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain", "the correction reaches the operator through the arbiter drain");
  assert.strictEqual(d.digest.headline.cls, 0, "corrections are class 0 — the top of the severity order");
  const facts: string = d.digest.headline.facts;
  assert.ok(facts.includes("p2"), `facts must name the pane, got: ${facts}`);
  assert.ok(facts.includes(truth), `facts must carry the ground truth, got: ${facts}`);
  assert.match(facts, /correct|retract/i, "facts must self-identify as a correction so the model can phrase the retraction (D3)");
  assert.match(facts, /dispatch/i, "facts reference what was asserted (kind/assertedText)");
  assert.strictEqual(d.mode, "forced-turn", "class-0 default delivery mode is forced-turn (D4)");
  assert.strictEqual(arb.evaluate({ now: T0 + 1_001, floorHeld: false, turnClear: true }).action, "hold",
    "exactly one correction per claim — nothing re-fires");
});

// ── AC3: mid-utterance/barge-in -> deferred, NEVER suppressed ──────────────────────────────────

test("a correction under floor-flap (mid-utterance / barge-in) defers and still drains — never suppressed", async () => {
  const mod = await loadLedger();
  const arb = createTurnArbiter();
  const led = freshLedger(mod, arb);
  const truth = "the restart actually failed — the pane is not up";
  led.record({ claimId: "c1", paneId: "p2", kind: "restart", assertedText: "Restarted pane p2.", assertedAt: T0, spoken: true });
  led.invalidate("c1", truth);

  // Rapid hold/release flapping (barge-in-shaped): the correction must survive every step.
  for (let i = 0; i < 20; i++) {
    const d = arb.evaluate({ now: T0 + i * 500, floorHeld: i % 2 === 0, turnClear: false });
    assert.strictEqual(d.action, "hold", `flap step ${i}: deferred, not spoken over the operator`);
  }
  const d: AnyRec = arb.evaluate({ now: T0 + 60_000, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain", "defer means LATER, never NEVER (shouldSpeakCorrection has no suppress arm)");
  assert.strictEqual(d.digest.headline.cls, 0);
  assert.ok(d.digest.headline.facts.includes(truth), "the deferred correction speaks intact");
});

// ── AC4: >=2 pending corrections -> one coalesced drain ────────────────────────────────────────

test(">=2 pending corrections on one turn-clear collapse into ONE drain digest (not N turns, not silence)", async () => {
  const mod = await loadLedger();
  const arb = createTurnArbiter();
  const led = freshLedger(mod, arb);
  led.record({ claimId: "c1", paneId: "p2", kind: "restart", assertedText: "Restarted pane p2.", assertedAt: T0, spoken: true });
  led.record({ claimId: "c2", paneId: "p4", kind: "dispatch", assertedText: "Dispatched on pane p4.", assertedAt: T0 + 100, spoken: true });
  led.invalidate("c1", "pane p2's restart actually failed");
  led.invalidate("c2", "pane p4's dispatch never landed");

  const d: AnyRec = arb.evaluate({ now: T0 + 5_000, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain");
  const items = drainAll(d);
  assert.strictEqual(items.length, 2, "both corrections ride ONE digest");
  assert.ok(items.every((i: AnyRec) => i.cls === 0), "both are class 0");
  assert.strictEqual(d.digest.tailCount, 1, "headline + one counted tail item");
  assert.strictEqual(arb.evaluate({ now: T0 + 5_001, floorHeld: false, turnClear: true }).action, "hold",
    "one spoken turn per turn-clear — never a machine-gun of retractions");
});

test("severity orders within class 0: an exception correction headlines over an info one despite later arrival", async () => {
  const mod = await loadLedger();
  const arb = createTurnArbiter();
  const led = freshLedger(mod, arb);
  led.record({ claimId: "c-ok", paneId: "p1", kind: "completion", assertedText: "Pane p1 finished.", assertedAt: T0, spoken: true });
  led.record({ claimId: "c-bad", paneId: "p2", kind: "restart", assertedText: "Restarted pane p2.", assertedAt: T0, spoken: true });
  // FIFO would headline the info correction — severity must beat arrival order (co-design §D:
  // "ordered severity-first, exceptions before successes").
  led.invalidate("c-ok", "actually still running — not finished", { severity: "info" });
  led.invalidate("c-bad", "the restart actually failed — pane p2 is not up", { severity: "exception" });

  const d: AnyRec = arb.evaluate({ now: T0 + 1_000, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain");
  assert.ok(d.digest.headline.facts.includes("not up"),
    `the exception correction must headline (lead with the worst), got headline: ${d.digest.headline.facts}`);
  assert.strictEqual(d.digest.tail.length, 1);
  assert.ok(d.digest.tail[0].facts.includes("still running"), "the info correction rides the counted tail");
});

// ── AC6: <=1 correction per claim; a correction is never re-corrected ──────────────────────────

test("dedup: a claim corrects at most once, and a delivered correction is never re-corrected", async () => {
  const mod = await loadLedger();
  const arb = createTurnArbiter();
  const led = freshLedger(mod, arb);
  led.record({ claimId: "c1", paneId: "p2", kind: "restart", assertedText: "Restarted pane p2.", assertedAt: T0, spoken: true });

  assert.strictEqual(led.invalidate("c1", "restart failed").corrected, true, "first invalidation corrects");
  // r25i: the refusal mechanism is now ABSENCE (the corrected claim was evicted -> unknown ref),
  // not an already-corrected flag — the pinned INTENT (at most one correction per claim, nothing
  // resubmitted) is mechanism-independent and asserted below unchanged.
  assert.strictEqual(led.invalidate("c1", "restart failed harder").corrected, false, "second invalidation is a no-op");

  const d: AnyRec = arb.evaluate({ now: T0 + 1_000, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain");
  assert.strictEqual(drainAll(d).filter((i: AnyRec) => i.cls === 0).length, 1, "exactly one correction item queued");

  assert.strictEqual(led.invalidate("c1", "a third flip").corrected, false, "a correction is never re-corrected");
  assert.strictEqual(arb.evaluate({ now: T0 + 2_000, floorHeld: false, turnClear: true }).action, "hold",
    "nothing new reaches the queue after the dedup");
});

// ── AC5: never-spoken and superseded claims yield no correction ────────────────────────────────

test("a claim that was never spoken (suppressed ack) is not corrected — nothing reaches the arbiter", async () => {
  const mod = await loadLedger();
  const arb = createTurnArbiter();
  const led = freshLedger(mod, arb);
  led.record({ claimId: "c1", paneId: "p2", kind: "readiness", assertedText: "Pane p2 is ready.", assertedAt: T0, spoken: false });

  const dec = led.invalidate("c1", "the pane never became ready");
  assert.strictEqual(dec.corrected, false, "you cannot retract what was never asserted aloud");
  assert.strictEqual(arb.evaluate({ now: T0 + 1_000, floorHeld: false, turnClear: true }).action, "hold",
    "no class-0 item may be queued for an unspoken claim");
});

test("supersession is the ONLY skip: a claim replaced by a newer spoken claim on the same (pane, kind) is not corrected", async () => {
  const mod = await loadLedger();
  const arb = createTurnArbiter();
  const led = freshLedger(mod, arb);
  led.record({ claimId: "c1", paneId: "p2", kind: "restart", assertedText: "Restarted pane p2.", assertedAt: T0, spoken: true });
  led.record({ claimId: "c2", paneId: "p2", kind: "restart", assertedText: "Restarted pane p2 again.", assertedAt: T0 + 5_000, spoken: true });

  // r25i: supersession now EVICTS c1 (unknown ref) instead of flagging it — same refusal outcome.
  assert.strictEqual(led.invalidate("c1", "the first restart failed").corrected, false,
    "the operator's operative belief is the NEWER claim — correcting the superseded one would confuse, not inform");
  assert.strictEqual(arb.evaluate({ now: T0 + 6_000, floorHeld: false, turnClear: true }).action, "hold");

  assert.strictEqual(led.invalidate("c2", "the second restart failed too").corrected, true,
    "the live claim still corrects normally");
  const d: AnyRec = arb.evaluate({ now: T0 + 7_000, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain");
  assert.strictEqual(drainAll(d).length, 1, "exactly one correction — for the live claim only");
});

test("invalidate by paneId resolves the latest spoken claim on that pane", async () => {
  const mod = await loadLedger();
  const arb = createTurnArbiter();
  const led = freshLedger(mod, arb);
  const truth = "the pane never became ready";
  led.record({ claimId: "c9", paneId: "p7", kind: "readiness", assertedText: "Pane p7 is ready.", assertedAt: T0, spoken: true });

  assert.strictEqual(led.invalidate("p7", truth).corrected, true, "pane-ref invalidation reaches the claim");
  const d: AnyRec = arb.evaluate({ now: T0 + 1_000, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain");
  assert.strictEqual(d.digest.headline.cls, 0);
  assert.ok(d.digest.headline.facts.includes("p7"), "facts name the pane");
  assert.ok(d.digest.headline.facts.includes(truth), "facts carry the ground truth");
});

// ── no time-based downgrade + the never-silent floor ───────────────────────────────────────────

test("no staleness clock: a correction pending for hours still drains spoken, even under a hostile matrix", async () => {
  const mod = await loadLedger();
  // Hostile config tries to silence corrections — the D4 floor clamps it (never passive, never off).
  const arb = createTurnArbiter({ matrix: { 0: "passive-context" } });
  const led = freshLedger(mod, arb);
  const truth = "the restart actually failed — the pane is not up";
  led.record({ claimId: "c1", paneId: "p2", kind: "restart", assertedText: "Restarted pane p2.", assertedAt: T0, spoken: true });
  led.invalidate("c1", truth);

  const SIX_HOURS = 6 * 3600_000;
  assert.strictEqual(arb.evaluate({ now: T0 + SIX_HOURS, floorHeld: false, turnClear: false }).action, "hold",
    "hours of busy turn never decay the correction (the 30s staleness clock is REMOVED)");

  const d: AnyRec = arb.evaluate({ now: T0 + SIX_HOURS + 1_000, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain", "a claim the operator may be acting on does not get less wrong with age");
  assert.strictEqual(d.digest.headline.cls, 0);
  assert.ok(d.digest.headline.facts.includes(truth));
  assert.notStrictEqual(d.mode, "passive-context",
    "told-more floor: NO configuration may reduce a correction to silent context");
});

// ── the arbiter queue IS the correction queue (no private drainPending) ────────────────────────

test("corrections share the arbiter's single drain: one digest with the correction headlining over a deadline item", async () => {
  const mod = await loadLedger();
  const arb = createTurnArbiter();
  const led = freshLedger(mod, arb);
  const truth = "pane p2's restart actually failed";
  led.record({ claimId: "c1", paneId: "p2", kind: "restart", assertedText: "Restarted pane p2.", assertedAt: T0, spoken: true });
  led.invalidate("c1", truth);
  // A gating last-call lands in the SAME queue (Wave-2 re-route) — submitted directly here.
  arb.submit({ facts: "approve the deploy now or I'll drop it", cls: 2, coalesceKey: "last-call:appr-x" });

  const d: AnyRec = arb.evaluate({ now: T0 + 1_000, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain", "ONE cross-producer drain — no private correction queue exists");
  assert.strictEqual(d.digest.headline.cls, 0, "the correction (class 0) outranks the deadline narration (class 2)");
  assert.ok(d.digest.headline.facts.includes(truth));
  assert.deepStrictEqual(d.digest.tail.map((t: AnyRec) => t.facts), ["approve the deploy now or I'll drop it"],
    "the last-call rides the counted tail of the same single spoken turn");
  assert.strictEqual(arb.evaluate({ now: T0 + 1_001, floorHeld: false, turnClear: true }).action, "hold",
    "at most one spoken turn per turn-clear across producers");
});
