// tests/test_speak_gate.ts — BEAD tkd: voice should-I-speak gate (pure, zero async).
//
// LOCKS the fail-open SAFETY contract the bead forbids violating: with the flag OFF the gate is a
// hard short-circuit to {speak:true} (byte-for-byte today's audio path), and with the flag ON it
// MUTES (speak:false) ONLY when it is HIGH-confidence the director is thinking-aloud / in a
// human-to-human discussion. A clearly-addressed request, an imperative/command, or ANY ambiguous
// utterance => SPEAK. Over-muting = dead voice = unacceptable (the 5dafe33 incident).
//
// shouldSpeak is a PURE function on the input transcript (mirrors src/voiceAckGate.ts +
// src/approvalIntent.ts — the blessed local idiom for a voice gate). v1 is a heuristic; a smarter
// classifier can drop in behind the same {speak,reason,confidence} contract.
//
// Runner: npx tsx --test --test-force-exit tests/test_speak_gate.ts

import { test } from "node:test";
import assert from "node:assert";
import { shouldSpeak } from "../src/voice/speakGate";

const ON = { enabled: true };
const OFF = { enabled: false };

// #1 — FLAG OFF: ALWAYS speak, even for textbook thinking-aloud input. This is the load-bearing
// safety test: with silenceGate:false the gate must be byte-for-byte today's behavior (never mute).
test("flag OFF => ALWAYS speak (byte-for-byte today's behavior)", () => {
  // Textbook thinking-aloud that WOULD mute when enabled — must still speak when disabled.
  assert.strictEqual(shouldSpeak("hmm, so what I'm thinking is we restructure the whole thing", OFF).speak, true);
  assert.strictEqual(shouldSpeak("wait, no, the other approach was better", OFF).speak, true);
  assert.strictEqual(shouldSpeak("yeah I agree, lets circle back with the team", OFF).speak, true);
  // Addressed / imperative / empty — all speak when disabled (no behavior at all).
  assert.strictEqual(shouldSpeak("Janus, open a pane", OFF).speak, true);
  assert.strictEqual(shouldSpeak("run the tests", OFF).speak, true);
  assert.strictEqual(shouldSpeak("", OFF).speak, true);
  assert.strictEqual(shouldSpeak("   ", OFF).speak, true);
});

// #2 — ADDRESSED-TO-JANUS cues => speak (never mute a request aimed at Janus).
test("addressed-to-Janus cues => speak", () => {
  for (const utter of [
    "Janus, open a pane",
    "hey janus what's running",
    "ok janus switch to the codex pane",
    "can you check the build",
    "could you show me the logs",
    "please list the panes",
    "what's running on pane two",
    "switch to the codex pane", // second-person imperative addressed to Janus
    "tell me the status",
  ]) {
    assert.strictEqual(shouldSpeak(utter, ON).speak, true, `addressed must speak: "${utter}"`);
  }
});

// #3 — IMPERATIVE / command => speak (never mute a command; emergency brakes always speak).
test("imperative / command => speak", () => {
  for (const utter of [
    "run the tests",
    "stop everything",
    "approve it",
    "halt the build",
    "abort",
    "freeze the panes",
    "open the codex pane",
    "close that pane",
  ]) {
    assert.strictEqual(shouldSpeak(utter, ON).speak, true, `imperative must speak: "${utter}"`);
  }
});

// #4 — CLEAR thinking-aloud / human-to-human discussion => mute (speak:false) ONLY at high confidence.
test("clear thinking-aloud => mute (high confidence only)", () => {
  for (const utter of [
    "hmm, so what I'm thinking is we restructure the data layer",
    "wait, no, the other approach was cleaner",
    "yeah I agree, lets circle back with the team on that",
    "actually maybe we should reconsider the whole roadmap",
    "i guess the tradeoff is really about latency versus cost",
    "what if we just split it into two services down the line",
  ]) {
    const d = shouldSpeak(utter, ON);
    assert.strictEqual(d.speak, false, `thinking-aloud must mute: "${utter}" (got reason=${d.reason})`);
    // Mute is permitted ONLY at high confidence (the conservative bar guarding against dead voice).
    assert.ok(d.confidence >= 0.7, `mute must be high-confidence: "${utter}" conf=${d.confidence}`);
  }
});

// #5 — AMBIGUOUS / low-confidence => speak (fail open). Empty/whitespace => speak.
test("ambiguous / empty => speak (fail open)", () => {
  for (const utter of [
    "the build is green",            // a statement, no thinking-aloud marker, no address — fail open
    "that looks fine",
    "two panes are open",
    "interesting",
    "",
    "   ",
  ]) {
    assert.strictEqual(shouldSpeak(utter, ON).speak, true, `ambiguous must fail open to speak: "${utter}"`);
  }
});

// #6 — DECISION SHAPE: shouldSpeak returns { speak, reason, confidence } so the wiring + interaction
// log can record WHY a turn was muted (debuggability after the prior dead-voice incident).
test("decision shape { speak, reason, confidence }", () => {
  const d = shouldSpeak("hmm, so what I'm thinking is we should wait", ON);
  assert.strictEqual(typeof d.speak, "boolean");
  assert.strictEqual(typeof d.reason, "string");
  assert.ok(d.reason.length > 0, "reason must be non-empty");
  assert.strictEqual(typeof d.confidence, "number");
  assert.ok(d.confidence >= 0 && d.confidence <= 1, "confidence in [0,1]");

  // And the flag-off short-circuit carries a reason too (auditable).
  const off = shouldSpeak("anything at all", OFF);
  assert.strictEqual(off.speak, true);
  assert.ok(off.reason.length > 0);
});

// #7 — ADDRESS/IMPERATIVE OVERRIDES a thinking-aloud marker: "hmm Janus, what's the build doing?"
// carries a musing marker AND a Janus address — the address must win (speak). Guards the precedence.
test("address/imperative overrides thinking-aloud marker => speak", () => {
  assert.strictEqual(shouldSpeak("hmm janus, what's the build doing", ON).speak, true);
  assert.strictEqual(shouldSpeak("so i'm thinking, run the tests now", ON).speak, true);
  assert.strictEqual(shouldSpeak("actually maybe stop everything", ON).speak, true);
});

// #8 (q4l) — DELIBERATION-PHRASED COMMANDS must SPEAK. A dev-action verb embedded after a musing
// leader ("i think we should ship this") is STILL a command — the embedded-imperative check must hit
// the concrete dev-action verb BEFORE the musing-leader mute fires. These over-muted before the q4l
// IMPERATIVE_VERBS widening (ship/deploy/merge/fix/pull/push/commit/rebase/build/test/look/...).
test("q4l: deliberation-phrased commands speak (over-mute fix)", () => {
  for (const utter of [
    "i think we should ship this",
    "maybe we should look at pane two",
    "actually maybe fix the bug",
    "what if we just deploy",
    "i guess we could merge it",
    "what if we just rebase onto main",
  ]) {
    const d = shouldSpeak(utter, ON);
    assert.strictEqual(d.speak, true, `deliberation-phrased command must speak: "${utter}" (got reason=${d.reason})`);
    // Must speak via an EMBEDDED-IMPERATIVE hit (the safe path), not a new construction.
    assert.ok(
      d.reason.startsWith("imperative"),
      `must speak via embedded imperative, not a broad construction: "${utter}" (reason=${d.reason})`,
    );
  }
});

// #9 (q4l guard) — GENUINE deliberation must STAY muted. Proves the q4l widening did NOT over-broaden
// into a generic "we should <X>" / "lets <X>" => speak rule that would regress legitimate musings.
test("q4l guard: genuine deliberation still mutes", () => {
  assert.strictEqual(
    shouldSpeak("yeah I agree, lets circle back with the team on that", ON).speak,
    false,
    "genuine deliberation 'circle back' must stay muted",
  );
  assert.strictEqual(
    shouldSpeak("actually maybe we should reconsider the whole roadmap", ON).speak,
    false,
    "genuine deliberation 'reconsider the whole roadmap' must stay muted",
  );
});
