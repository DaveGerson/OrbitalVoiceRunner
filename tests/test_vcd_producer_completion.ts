// tests/test_vcd_producer_completion.ts — fikj.11 RED, producer 3: vc-C completion claims record at
// the drain sink (spokenness = ground truth) and retract on a contradicting error/exited signal
// within the recency window. Pure helpers + REAL ledger + REAL arbiter composed end to end; the
// production wiring is pinned by source-conformance (the test_turn_arbiter_journeys idiom).
// Runner: npx tsx --test --test-force-exit tests/test_vcd_producer_completion.ts
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTurnArbiter } from "../src/voice/turnArbiter";
import { createCorrectionLedger } from "../src/voice/correctionLedger";
import { completionNarration } from "../src/voice/completionPolicy";
import * as voiceIndexModule from "../src/voice/index";

type AnyRec = Record<string, any>;
const voiceIndex = voiceIndexModule as AnyRec;
const T0 = 1_700_000_000_000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function digestWith(items: AnyRec[]): AnyRec {
  const [headline, ...tail] = items;
  return { headline, tail, tailCount: tail.length, tailGroups: [] };
}

test("recordSpokenCompletionClaims: cls-3 digest items record completion claims; other classes never do", () => {
  const fn = voiceIndex.recordSpokenCompletionClaims;
  assert.strictEqual(typeof fn, "function", "fikj.11 feature absent: recordSpokenCompletionClaims export");
  const records: AnyRec[] = [];
  const ledger = { record: (c: AnyRec) => records.push(c) };
  fn(digestWith([
    { facts: "pane p1 finished", cls: 3, paneId: "p1", forVisualStack: false },
    { facts: "pane p2 finished", cls: 3, paneId: "p2", forVisualStack: true },
    { facts: "approve now", cls: 2, paneId: "p3", forVisualStack: true },
  ]), true, ledger, T0);
  assert.strictEqual(records.length, 2, "headline AND tail cls-3 items record; the cls-2 tail item does not");
  assert.ok(records.every(r => r.kind === "completion" && r.spoken === true && r.assertedAt === T0));
  assert.deepStrictEqual(records.map(r => r.paneId), ["p1", "p2"]);
});

test("recordSpokenCompletionClaims: a passive-context (non-turn) drain records spoken:false", () => {
  const records: AnyRec[] = [];
  voiceIndex.recordSpokenCompletionClaims(
    digestWith([{ facts: "pane p1 finished", cls: 3, paneId: "p1", forVisualStack: false }]),
    false, { record: (c: AnyRec) => records.push(c) }, T0,
  );
  assert.strictEqual(records[0].spoken, false,
    "the D4 dial can make class 3 passive — then the claim never reached the operator's ears");
});

test("completionContradiction: error/exited within the window against a COMPLETION claim -> retraction plan", () => {
  const fn = voiceIndex.completionContradiction;
  assert.strictEqual(typeof fn, "function", "fikj.11 feature absent: completionContradiction export");
  const WINDOW = voiceIndex.COMPLETION_CONTRADICTION_WINDOW_MS;
  assert.strictEqual(typeof WINDOW, "number");
  // assertedSuccess: true — post-fix-2 the guard elects ONLY asserted-success completion claims
  // (the FAILED-claim negative lives in its own test below).
  const claim = { claimId: "c1", kind: "completion", assertedAt: T0, assertedSuccess: true };
  const ledger = { latestSpokenClaim: (_p: string) => claim };
  const hit = fn({ paneId: "p1", kind: "error" }, ledger, T0 + 1_000);
  assert.ok(hit, "a fresh error contradicts the just-spoken completion");
  assert.strictEqual(hit.claimId, "c1");
  assert.ok(hit.groundTruth.includes("p1"), "ground truth names the pane");
  // negative fixtures — every one of these MUST be null (a false correction is worse than a gap):
  assert.strictEqual(fn({ paneId: "p1", kind: "error" }, ledger, T0 + WINDOW + 1), null, "outside the window");
  assert.strictEqual(fn({ paneId: "p1", kind: "idle" }, ledger, T0 + 1_000), null, "idle is not a contradiction");
  assert.strictEqual(fn({ paneId: "p1", kind: "error" }, undefined, T0 + 1_000), null, "no ledger wired");
  const dispatchLedger = { latestSpokenClaim: (_p: string) => ({ claimId: "d1", kind: "dispatch", assertedAt: T0 }) };
  assert.strictEqual(fn({ paneId: "p1", kind: "exited" }, dispatchLedger, T0 + 1_000), null,
    "a pane exiting after a DISPATCH claim is not evidence the dispatch never happened — kind-scoped");
  assert.strictEqual(fn({ paneId: "p1", kind: "error" }, { latestSpokenClaim: () => undefined }, T0 + 1_000), null,
    "no spoken claim on the pane");
});

test("end to end: spoken completion -> error signal -> ONE class-0 retraction through the REAL arbiter", () => {
  const arb = createTurnArbiter();
  const led: AnyRec = createCorrectionLedger({ arbiter: arb });
  voiceIndex.recordSpokenCompletionClaims(
    // completionSuccess: true — the REAL producer (completionPolicy buildItem) stamps the asserted
    // outcome on every cls-3 item post-fix-2; the sink derives the claim's electability from it.
    digestWith([{ facts: "pane p1 finished", cls: 3, paneId: "p1", forVisualStack: false, completionSuccess: true }]), true, led, T0,
  );
  const hit = voiceIndex.completionContradiction({ paneId: "p1", kind: "error" }, led, T0 + 2_000);
  assert.ok(hit);
  assert.strictEqual(led.invalidate(hit.claimId, hit.groundTruth, { severity: "exception" }).corrected, true);
  const d: AnyRec = arb.evaluate({ now: T0 + 3_000, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain");
  assert.strictEqual(d.digest.headline.cls, 0, "the retraction is a class-0 arbiter item (AC2)");
  assert.match(d.digest.headline.facts, /correct|retract/i);
  // storm control (rider: DETERMINISTIC): the spoken index still points at the corrected claim —
  // that IS the designed storm-control path: the guard re-elects, the ledger's already-corrected
  // rule refuses the second retraction. The same contradiction can never fire twice.
  const again = voiceIndex.completionContradiction({ paneId: "p1", kind: "exited" }, led, T0 + 4_000);
  assert.ok(again, "the index still points at the corrected claim — storm control lives in the ledger, not the guard");
  assert.strictEqual(led.invalidate(again.claimId, again.groundTruth).corrected, false, "already corrected -> skip");
});

test("an UNSPOKEN (passive-drained) completion claim never yields a correction (AC3 negative fixture)", () => {
  const arb = createTurnArbiter();
  const led: AnyRec = createCorrectionLedger({ arbiter: arb });
  voiceIndex.recordSpokenCompletionClaims(
    digestWith([{ facts: "pane p1 finished", cls: 3, paneId: "p1", forVisualStack: false }]), false, led, T0,
  );
  assert.strictEqual(voiceIndex.completionContradiction({ paneId: "p1", kind: "error" }, led, T0 + 1_000), null,
    "latestSpokenClaim never surfaces an unspoken claim — nothing to retract");
  assert.strictEqual(arb.evaluate({ now: T0 + 2_000, floorHeld: false, turnClear: true }).action, "hold");
});

// Rider (review pin): the superseded/unspoken interaction. An UNSPOKEN completion recorded after a
// SPOKEN one on the same (pane, kind) marks the spoken claim superseded WITHOUT touching the
// spoken index — so the contradiction guard still elects it, but invalidate refuses with
// "superseded". Net behavior: a silent no-op, never a spoken correction. This means a genuine
// error inside that window goes UNRETRACTED by design — the fail-safe hierarchy (co-design §D):
// a false/confusing correction is worse than a gap, and the operator's operative belief is the
// newer claim anyway. This test documents that trade so a future change can't drift it silently.
test("superseded-unspoken semantics: a later unspoken completion supersedes the spoken one -> silent no-op", () => {
  const arb = createTurnArbiter();
  const led: AnyRec = createCorrectionLedger({ arbiter: arb });
  // c1: spoken completion on p1. The claimId is time+monotonic-seq minted (same-ms collision
  // rider, mirroring restart claims) so capture it instead of pinning the seq literal.
  voiceIndex.recordSpokenCompletionClaims(
    digestWith([{ facts: "pane p1 finished", cls: 3, paneId: "p1", forVisualStack: false }]), true, led, T0,
  );
  const c1 = led.latestSpokenClaim("p1");
  assert.ok(c1, "c1 recorded spoken");
  assert.match(c1.claimId, new RegExp(`^completion:p1:${T0}:\\d+$`),
    "claimId = completion:<pane>:<now>:<monotonic seq> (same-ms collision rider)");
  // c2: UNSPOKEN completion on the same pane (a passive-context drain 500ms later).
  voiceIndex.recordSpokenCompletionClaims(
    digestWith([{ facts: "pane p1 finished again", cls: 3, paneId: "p1", forVisualStack: false }]), false, led, T0 + 500,
  );
  const spoken = led.latestSpokenClaim("p1");
  assert.ok(spoken, "the spoken index still resolves");
  assert.strictEqual(spoken.claimId, c1.claimId,
    "the unspoken record never touches the spoken index — c1 is still the latest SPOKEN claim");
  const res = led.invalidate(spoken.claimId, "pane p1 errored right after", { severity: "exception" });
  assert.strictEqual(res.corrected, false, "the superseded spoken claim is never retracted aloud");
  assert.strictEqual(res.reason, "superseded", "the newer same-(pane,kind) claim superseded it");
  assert.strictEqual(arb.evaluate({ now: T0 + 2_000, floorHeld: false, turnClear: true }).action, "hold",
    "nothing was submitted to the arbiter — the whole scenario is a silent no-op");
});

// ── final-review blocker (fix 2): asserted-outcome gating ──────────────────────────────────────
// recordSpokenCompletionClaims records ALL cls-3 items as kind "completion" — including
// completion_failed digests ("pane X completion FAILED…"). completionContradiction elected on
// kind+recency alone, so a spoken FAILED claim followed within the window by an error/exited
// signal (LIKELY after a failure!) fired a class-0 "retraction" of truthful bad news.

test("a spoken FAILED completion claim never elects a retraction — election is asserted-success gated", () => {
  const arb = createTurnArbiter();
  const led: AnyRec = createCorrectionLedger({ arbiter: arb });
  // The REAL producer chain: a completion_failed idle edge -> arbiter -> drain -> sink.
  const failed: AnyRec = completionNarration({
    sig: { paneId: "p1", kind: "idle" }, outcomeKind: "completion_failed",
    hasExchange: true, policy: "dispatched",
  });
  assert.strictEqual(failed.speak, true, "precondition: a failed settled outcome always speaks");
  arb.submit(failed.item);
  const d: AnyRec = arb.evaluate({ now: T0, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain");
  voiceIndex.recordSpokenCompletionClaims(d.digest, true, led, T0);
  // The error signal lands right after — CONFIRMING the spoken bad news, not contradicting it.
  assert.strictEqual(voiceIndex.completionContradiction({ paneId: "p1", kind: "error" }, led, T0 + 1_000), null,
    "a claim that asserted FAILURE is never 'retracted' by a confirming error signal");
});

test("positive control: a spoken SUCCESS completion claim still elects through the same real chain", () => {
  const arb = createTurnArbiter();
  const led: AnyRec = createCorrectionLedger({ arbiter: arb });
  const ok: AnyRec = completionNarration({
    sig: { paneId: "p1", kind: "idle" }, outcomeKind: "completion",
    hasExchange: true, policy: "dispatched",
  });
  assert.strictEqual(ok.speak, true, "precondition: a dispatched success speaks");
  arb.submit(ok.item);
  const d: AnyRec = arb.evaluate({ now: T0, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain");
  voiceIndex.recordSpokenCompletionClaims(d.digest, true, led, T0);
  const hit = voiceIndex.completionContradiction({ paneId: "p1", kind: "error" }, led, T0 + 1_000);
  assert.ok(hit, "the asserted-success gate must NOT disable the guard's real job (false-done retraction)");
  assert.ok(hit.groundTruth.includes("p1"));
});

// ── final-review blocker (fix 3): never-drop at the send boundary ─────────────────────────────
// buildQueueDrain clears the queue pre-send; a sendClientContent throw in sendArbiterDigest lost
// the digest — including class-0 corrections, whose claims the ledger had already marked
// corrected, so re-invalidate refused: the correction was unrecoverable.

test("never-drop: a failed drain send resubmits the digest — the class-0 correction drains on the next attempt", () => {
  const send = voiceIndex.sendArbiterDigest;
  const resubmit = voiceIndex.resubmitUndeliveredDigest;
  assert.strictEqual(typeof send, "function",
    "fix-3 feature absent: src/voice/index.ts must export sendArbiterDigest (returning `sent`)");
  assert.strictEqual(typeof resubmit, "function",
    "fix-3 feature absent: src/voice/index.ts must export resubmitUndeliveredDigest(arbiter, digest)");
  const arb = createTurnArbiter();
  const led: AnyRec = createCorrectionLedger({ arbiter: arb });
  led.record({ claimId: "c1", paneId: "p1", kind: "completion", assertedText: "pane p1 finished", assertedAt: T0, spoken: true, assertedSuccess: true });
  assert.strictEqual(led.invalidate("c1", "it did not finish", { severity: "exception" }).corrected, true);
  const d1: AnyRec = arb.evaluate({ now: T0 + 1_000, floorHeld: false, turnClear: true });
  assert.strictEqual(d1.action, "drain");
  assert.strictEqual(d1.digest.headline.cls, 0, "precondition: the correction is the drained headline");
  // A session that throws once (socket died mid-send) then succeeds; a store capturing T4 rows.
  const drains: AnyRec[] = [];
  const store = { recordArbiterDrain: (r: AnyRec) => drains.push(r), recordJumpOver: () => {} };
  const contents: AnyRec[] = [];
  let calls = 0;
  const session = { sendClientContent: (c: AnyRec) => { calls += 1; if (calls === 1) throw new Error("socket died"); contents.push(c); } };
  const ack = { lastOperatorSpeechAt: 0, interrupted: false, now: T0 };
  const sent1 = send(session, store, null, ack, d1.digest, d1.mode, led);
  assert.strictEqual(sent1, false, "a throwing send must REPORT failure — the drain tick resubmits on false");
  resubmit(arb, d1.digest);
  const d2: AnyRec = arb.evaluate({ now: T0 + 2_000, floorHeld: false, turnClear: true });
  assert.strictEqual(d2.action, "drain", "the resubmitted correction re-drains on the next tick");
  assert.strictEqual(d2.digest.headline.cls, 0, "the class survives resubmission");
  assert.match(d2.digest.headline.facts, /correct|retract/i, "the retraction facts survive verbatim");
  const sent2 = send(session, store, null, ack, d2.digest, d2.mode, led);
  assert.strictEqual(sent2, true);
  assert.strictEqual(contents.length, 1, "the correction reached the model on the second attempt — never dropped");
  assert.match(String(contents[0]?.turns?.[0]?.parts?.[0]?.text ?? ""), /correct|retract/i);
  assert.strictEqual(drains.length, 2, "T4 telemetry recorded BOTH drain attempts (the failed one included)");
});

test("production wiring conformance: the drain tick consumes the send verdict and resubmits on failure", () => {
  const src = fs.readFileSync(path.resolve(repoRoot, "src/voice/index.ts"), "utf-8");
  const resubmitCalls = (src.match(/resubmitUndeliveredDigest\(/g) ?? []).length;
  assert.ok(resubmitCalls >= 2,
    `resubmitUndeliveredDigest needs a definition AND a drain-tick call site (found ${resubmitCalls})`);
});

test("production wiring conformance: the sink records, the subscriber checks contradictions", () => {
  const src = fs.readFileSync(path.resolve(repoRoot, "src/voice/index.ts"), "utf-8");
  const sinkCalls = (src.match(/recordSpokenCompletionClaims\(/g) ?? []).length;
  assert.ok(sinkCalls >= 2, `recordSpokenCompletionClaims needs a definition AND a call site (found ${sinkCalls})`);
  const guardCalls = (src.match(/completionContradiction\(/g) ?? []).length;
  assert.ok(guardCalls >= 2, `completionContradiction needs a definition AND a call site (found ${guardCalls})`);
  assert.ok(src.includes("correctionLedger?: "), "VoiceDeps must declare the optional correctionLedger seam");
});
