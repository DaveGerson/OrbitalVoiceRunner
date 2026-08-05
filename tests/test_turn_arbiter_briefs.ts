// tests/test_turn_arbiter_briefs.ts — Wave 3 RED: vc-A turn-gated memory briefs as arbiter class 5.
//
// Spec: docs/superpowers/specs/2026-07-29-turn-arbiter-design.md §3.3 row "Memory briefs", §4-W3;
// co-design spec §A (docs/superpowers/specs/2026-07-28-voice-coherence-codesign.md, branch
// docs/voice-coherence-codesign) — acceptance criteria 1-3 + invariant 5 land here. The brief
// pipeline (InjectGate → shadow → synthesizeAsync → latest-wins → delivery ledger) stays
// byte-for-byte; the ONLY behavior change is the final send's envelope: `turnComplete` becomes
// turn-aware and the class-5 matrix mode decides whether a clear-turn brief may complete a turn.
//
// The exports under test do NOT exist yet — every test fails "Wave-3 feature absent" until then.
// applyBackgroundFraming (fikj.8 Leg B, REAL) and the Wave-1 arbiter matrix (REAL) are exercised
// directly — the envelope must reuse them verbatim, not reimplement them.
//
// ── Pinned API (the implementer builds EXACTLY this surface) ────────────────────────────────────
//   // src/voiceAckGate.ts gains (pure, sibling of shouldSpeakReadyAck):
//   export function briefTurnComplete(s: AckTurnState): boolean
//     // === (shouldSpeakReadyAck(s) === "speak") — co-design §A's turn-aware boolean. A brief is
//     // never SPOKEN (CONTEXT … do not read aloud), so both non-clear arms (defer AND suppress)
//     // collapse to "commit the context, don't invite a turn" — barge-in does NOT drop the brief.
//
//   // src/voice/index.ts gains (pure, exported for unit coverage — same home as
//   // applyBackgroundFraming) and the injectMemoryBrief send site CONSUMES it (the hardcoded
//   // `turnComplete: true` literal at the sendClientContent dies):
//   export function composeBriefEnvelope(input: {
//     briefText: string;   // the composed CONTEXT(...) body, already redacted
//     ack: AckTurnState;   // live ack state at the send instant
//     mode: DeliveryMode;  // the arbiter's class-5 matrix mode (turn-arbiter D4)
//   }): { text: string; turnComplete: boolean }
//
// ── Pinned semantics ───────────────────────────────────────────────────────────────────────────
//   • !briefTurnComplete(ack)  (mid-utterance OR barge-in) → { turnComplete: false,
//     text: applyBackgroundFraming(briefText, false) } REGARDLESS of mode — the brief still lands
//     immediately as passive context (freshness/latest-wins preserved; dropping would starve the
//     model), but it can never invite a response over the director.
//   • briefTurnComplete(ack) && mode === "passive-context" (the DEFAULT class-5 mode) →
//     the same passive framed envelope — the brief path NEVER manufactures a proactive spoken
//     moment by itself (co-design §A invariant 5); completion truth reaches the operator via
//     vc-C's class-3 narration (the load-bearing A↔C coupling).
//   • briefTurnComplete(ack) && mode ∈ {steered-digest, forced-turn} (operator dialed class 5 up)
//     → { turnComplete: true, text: briefText } — unframed (framing is a strict no-op on
//     turn-completing sends, per applyBackgroundFraming's own contract).
//   • NO ack state × mode combination ever loses the brief body (told-more floor).
//
// Runner: npx tsx --test --test-force-exit tests/test_turn_arbiter_briefs.ts

import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Namespace imports (NOT named imports of the not-yet-existing helpers): a static named import of
// a missing binding is a module-link crash taking down the whole file; the namespace object always
// resolves and the missing helper reads back as `undefined`, asserted per-test.
import * as ackGateModule from "../src/voiceAckGate";
import * as voiceIndexModule from "../src/voice/index";
import { shouldSpeakReadyAck, OPERATOR_HOLD_MS } from "../src/voiceAckGate";
import { applyBackgroundFraming } from "../src/voice/index";
import { DEFAULT_DELIVERY_MATRIX } from "../src/voice/turnArbiter";

type AnyRec = Record<string, any>;

const ackGate = ackGateModule as AnyRec;
const voiceIndex = voiceIndexModule as AnyRec;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const T0 = 1_700_000_000_000;
const BRIEF = "CONTEXT (situational, do not read aloud):\npane p2 finished the integration suite.";

// Ack-state builders (AckTurnState shape: lastOperatorSpeechAt / interrupted / now / holdMs?).
const clearTurn = () => ({ lastOperatorSpeechAt: T0 - 10_000, interrupted: false, now: T0 });
const midUtterance = () => ({ lastOperatorSpeechAt: T0 - 500, interrupted: false, now: T0 });
const bargeIn = () => ({ lastOperatorSpeechAt: T0 - 10_000, interrupted: true, now: T0 });

function requireBriefTurnComplete(): (s: AnyRec) => boolean {
  assert.strictEqual(typeof ackGate.briefTurnComplete, "function",
    "Wave-3 feature absent: src/voiceAckGate.ts does not export briefTurnComplete yet (co-design §A)");
  return ackGate.briefTurnComplete;
}

function requireComposeBriefEnvelope(): (input: AnyRec) => AnyRec {
  assert.strictEqual(typeof voiceIndex.composeBriefEnvelope, "function",
    "Wave-3 feature absent: src/voice/index.ts does not export composeBriefEnvelope yet (spec §3.3 row 5)");
  return voiceIndex.composeBriefEnvelope;
}

// ── briefTurnComplete: the pure turn-aware boolean ─────────────────────────────────────────────

test("briefTurnComplete: clear turn -> true; mid-utterance -> false; barge-in -> false", () => {
  const btc = requireBriefTurnComplete();
  assert.strictEqual(btc(clearTurn()), true, "turn clear (>= hold window, not interrupted) -> the brief may complete a turn");
  assert.strictEqual(btc(midUtterance()), false, "operator spoke within the hold window -> never complete a turn over them");
  assert.strictEqual(btc(bargeIn()), false, "explicit barge-in latch -> never complete a turn (the brief still lands)");
  assert.strictEqual(btc({ lastOperatorSpeechAt: T0 - 500, interrupted: true, now: T0 }), false, "both signals -> false");
});

test("briefTurnComplete honors the holdMs override (test seam, co-design §A 'holdMs rides ackState')", () => {
  const btc = requireBriefTurnComplete();
  assert.strictEqual(btc({ lastOperatorSpeechAt: T0 - 1_000, interrupted: false, now: T0 }), false,
    "1s ago is inside the default 1500ms hold");
  assert.strictEqual(btc({ lastOperatorSpeechAt: T0 - 1_000, interrupted: false, now: T0, holdMs: 500 }), true,
    "with holdMs 500 the same instant is a clear turn");
});

test("briefTurnComplete === (shouldSpeakReadyAck === 'speak') across the state grid (one seam, no drift)", () => {
  const btc = requireBriefTurnComplete();
  const offsets = [0, 100, OPERATOR_HOLD_MS - 1, OPERATOR_HOLD_MS, OPERATOR_HOLD_MS + 1, 60_000];
  for (const off of offsets) {
    for (const interrupted of [false, true]) {
      const s = { lastOperatorSpeechAt: T0 - off, interrupted, now: T0 };
      assert.strictEqual(btc(s), shouldSpeakReadyAck(s) === "speak",
        `state {off:${off}, interrupted:${interrupted}}: the boolean must be DERIVED from the ` +
          "existing trichotomy, not a parallel clock that can drift");
    }
  }
});

// ── composeBriefEnvelope: the send-site decision (arbiter class-5 rendering, D3) ───────────────

test("mid-utterance -> passive envelope: turnComplete false + the EXISTING BACKGROUND framing, verbatim", () => {
  const compose = requireComposeBriefEnvelope();
  const env = compose({ briefText: BRIEF, ack: midUtterance(), mode: "passive-context" });
  assert.strictEqual(env.turnComplete, false, "co-design §A AC1: operator spoke within 1500ms -> turnComplete:false");
  assert.strictEqual(env.text, applyBackgroundFraming(BRIEF, false),
    "the passive envelope must reuse fikj.8's applyBackgroundFraming verbatim (Leg B machinery, spec §3.1 D3)");
  assert.ok(env.text.startsWith("BACKGROUND"), "framed passive context leads with the BACKGROUND preamble");
});

test("barge-in -> passive envelope with the brief INTACT (never dropped — dropping would starve the model)", () => {
  const compose = requireComposeBriefEnvelope();
  const env = compose({ briefText: BRIEF, ack: bargeIn(), mode: "passive-context" });
  assert.strictEqual(env.turnComplete, false, "co-design §A AC3: interrupted latch -> turnComplete:false");
  assert.ok(env.text.includes(BRIEF), "unlike a phase-2 ready-ack, barge-in does NOT drop the brief (co-design §A)");
});

test("clear turn under the DEFAULT matrix (class 5 = passive-context) stays passive: no proactive spoken moment", () => {
  const compose = requireComposeBriefEnvelope();
  assert.strictEqual(DEFAULT_DELIVERY_MATRIX[5], "passive-context",
    "precondition (Wave-1, real): class 5 defaults to passive-context");
  const env = compose({ briefText: BRIEF, ack: clearTurn(), mode: DEFAULT_DELIVERY_MATRIX[5] });
  assert.strictEqual(env.turnComplete, false,
    "co-design §A invariant 5: the brief path NEVER manufactures a proactive spoken turn by itself — " +
      "under the default dial a clear-turn brief is still passive context; completion truth arrives " +
      "via vc-C's class-3 narration (the load-bearing A↔C coupling)");
  assert.strictEqual(env.text, applyBackgroundFraming(BRIEF, false), "passive => framed, same Leg-B machinery");
});

test("clear turn with class 5 dialed to steered-digest -> turn-completing, UNFRAMED envelope", () => {
  const compose = requireComposeBriefEnvelope();
  const env = compose({ briefText: BRIEF, ack: clearTurn(), mode: "steered-digest" });
  assert.strictEqual(env.turnComplete, true, "the operator dialed class 5 up: a clear-turn brief may complete a turn");
  assert.strictEqual(env.text, BRIEF,
    "turn-completing sends never carry the BACKGROUND preamble (applyBackgroundFraming's strict no-op contract)");
});

test("clear turn with class 5 dialed to forced-turn -> turn-completing envelope; mid-utterance still passive", () => {
  const compose = requireComposeBriefEnvelope();
  const cleared = compose({ briefText: BRIEF, ack: clearTurn(), mode: "forced-turn" });
  assert.strictEqual(cleared.turnComplete, true);
  assert.strictEqual(cleared.text, BRIEF);
  // Even the loudest dial NEVER speaks over the operator — the ack state outranks the mode.
  const held = compose({ briefText: BRIEF, ack: midUtterance(), mode: "forced-turn" });
  assert.strictEqual(held.turnComplete, false,
    "mid-utterance beats every mode: the dial chooses how loud a CLEAR turn is, never whether to talk over the director");
  assert.ok(held.text.startsWith("BACKGROUND"));
});

test("idempotent framing: an already-framed brief never accumulates a second preamble", () => {
  const compose = requireComposeBriefEnvelope();
  const once = applyBackgroundFraming(BRIEF, false);
  const env = compose({ briefText: once, ack: midUtterance(), mode: "passive-context" });
  assert.strictEqual(env.text, once, "re-injection must not double-frame (applyBackgroundFraming idempotence, reused)");
});

test("told-more floor: NO ack-state × mode combination ever loses the brief body", () => {
  const compose = requireComposeBriefEnvelope();
  const acks = [clearTurn(), midUtterance(), bargeIn(), { lastOperatorSpeechAt: T0 - 500, interrupted: true, now: T0 }];
  const modes = ["passive-context", "steered-digest", "forced-turn"];
  for (const ack of acks) {
    for (const mode of modes) {
      const env = compose({ briefText: BRIEF, ack, mode });
      assert.ok(env.text.includes(BRIEF),
        `envelope for {interrupted:${ack.interrupted}, off:${T0 - ack.lastOperatorSpeechAt}, mode:${mode}} ` +
          "must carry the full brief body — the gate times delivery, it never drops content");
      assert.strictEqual(typeof env.turnComplete, "boolean");
    }
  }
});

// ── wiring: the helper must be CONSUMED at the injectMemoryBrief send site, not just exported ──

test("injectMemoryBrief consumes composeBriefEnvelope (an exported helper nobody calls is a silent no-op)", () => {
  const src = readFileSync(path.join(repoRoot, "src", "voice", "index.ts"), "utf8");
  const lines = src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l));
  const mentions = lines.filter((l) => /\bcomposeBriefEnvelope\b/.test(l)).length;
  assert.ok(mentions >= 2,
    "Wave-3 feature absent: src/voice/index.ts must define composeBriefEnvelope AND call it at the " +
      `injectMemoryBrief sendClientContent site (hardcoded turnComplete:true dies) — found ${mentions} ` +
      "non-comment mention(s), need the definition plus at least one call",
  );
});

// ── the load-bearing A↔C coupling: vc-A must not land without vc-C (same release, LOCKED) ──────

test("coupling: the class-3 completion module exists in the same wave (a passive brief is only safe because vc-C carries the truth)", async () => {
  // Sam's dealbreaker (co-design §A): A alone converts "occasionally-rude interruption" into
  // "silently-missing information". A turn-gated brief the model never voices is acceptable ONLY
  // because the deterministic class-3 completion narration now guarantees the news reaches the
  // operator. This import pins the same-release hard dependency mechanically.
  const spec = ["..", "src", "voice", "completionPolicy"].join("/");
  try {
    const mod: AnyRec = await import(spec);
    assert.strictEqual(typeof mod.completionNarration, "function");
  } catch (e: any) {
    assert.fail(
      "Wave-3 feature absent: vc-A (turn-gated briefs) may not ship without vc-C " +
        `(src/voice/completionPolicy.ts) — the hard same-release dependency is LOCKED: ${e?.message ?? e}`,
    );
  }
});
