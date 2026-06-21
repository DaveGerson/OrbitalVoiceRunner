// tests/test_speakgate_complexity_refactor.ts — characterization pins for the speakGate CC burndown.
//
// Pins the EXACT observable behavior (speak, reason, confidence) of shouldSpeak across EVERY branch
// of the load-bearing rule order, so the verbatim CC<=10 extraction is provably behavior-preserving.
// This is additive to tests/test_speak_gate.ts (kept green) — it asserts reason strings and the
// precise confidence values the production code computes today, not just the speak boolean.
//
// Runner: npx tsx --test --test-force-exit tests/test_speakgate_complexity_refactor.ts

import { test } from "node:test";
import assert from "node:assert";
import { shouldSpeak, type SpeakDecision } from "../src/voice/speakGate";

const ON = { enabled: true };
const OFF = { enabled: false };

function pin(d: SpeakDecision, speak: boolean, reason: string, confidence: number, label: string): void {
  assert.strictEqual(d.speak, speak, `${label}: speak`);
  assert.strictEqual(d.reason, reason, `${label}: reason`);
  assert.strictEqual(d.confidence, confidence, `${label}: confidence`);
}

// Rule 1 — flag OFF hard short-circuit. Reason + confidence fixed regardless of input.
test("rule1: flag OFF => speak gate_disabled conf 1", () => {
  pin(shouldSpeak("hmm so im thinking we restructure the whole thing", OFF), true, "gate_disabled", 1, "off-musing");
  pin(shouldSpeak("Janus, open a pane", OFF), true, "gate_disabled", 1, "off-addressed");
  pin(shouldSpeak("", OFF), true, "gate_disabled", 1, "off-empty");
  pin(shouldSpeak("   ", OFF), true, "gate_disabled", 1, "off-whitespace");
});

// Rule 2 — empty / whitespace-only (after normalization) => speak "empty".
test("rule2: empty/whitespace => speak empty conf 1", () => {
  pin(shouldSpeak("", ON), true, "empty", 1, "empty-string");
  pin(shouldSpeak("   ", ON), true, "empty", 1, "whitespace");
  pin(shouldSpeak("!!! ??? ...", ON), true, "empty", 1, "punctuation-only");
});

// Rule 3a — name token anywhere => addressed_janus_name conf 1.
test("rule3a: janus name anywhere => addressed_janus_name conf 1", () => {
  pin(shouldSpeak("Janus open a pane", ON), true, "addressed_janus_name", 1, "leading-name");
  pin(shouldSpeak("hey janus whats running", ON), true, "addressed_janus_name", 1, "mid-name");
  pin(shouldSpeak("hmm janus, what's the build doing", ON), true, "addressed_janus_name", 1, "musing+name");
});

// Rule 3b — address phrase (leading OR contained). Reason carries the matched phrase, conf 0.9.
test("rule3b: address phrase => addressed_phrase:<p> conf 0.9", () => {
  pin(shouldSpeak("can you check the build", ON), true, "addressed_phrase:can you", 0.9, "leading-phrase");
  pin(shouldSpeak("could you show me the logs", ON), true, "addressed_phrase:could you", 0.9, "could-you");
  pin(shouldSpeak("whats running on pane two", ON), true, "addressed_phrase:whats running", 0.9, "whats-running");
});

// Rule 3c — leading address verb => addressed_verb:<first> conf 0.85.
test("rule3c: leading address verb => addressed_verb:<first> conf 0.85", () => {
  // "please list the panes": no ADDRESS_PHRASE matches; "please" is leading ADDRESS_VERB => verb path.
  pin(shouldSpeak("please list the panes", ON), true, "addressed_verb:please", 0.85, "please-verb");
  // "whats the weather": "whats the" IS an ADDRESS_PHRASE (leading) => phrase path wins before verb.
  pin(shouldSpeak("whats the weather", ON), true, "addressed_phrase:whats the", 0.9, "whats-the-phrase");
});

// Pure leading address-verb path with no phrase collision.
test("rule3c-pure: leading address verb conf 0.85", () => {
  pin(shouldSpeak("could the build be broken", ON), true, "addressed_verb:could", 0.85, "could-verb");
  pin(shouldSpeak("would that work", ON), true, "addressed_verb:would", 0.85, "would-verb");
});

// Rule 4a — leading imperative verb => imperative:<first> conf 0.9.
test("rule4a: leading imperative => imperative:<first> conf 0.9", () => {
  pin(shouldSpeak("run the tests", ON), true, "imperative:run", 0.9, "run");
  pin(shouldSpeak("open the codex pane", ON), true, "imperative:open", 0.9, "open");
  pin(shouldSpeak("ship it", ON), true, "imperative:ship", 0.9, "ship");
});

// Rule 4b — emergency brake anywhere => emergency_brake conf 1.
// NOTE: when the brake word is ALSO the leading token AND an IMPERATIVE_VERB ("stop"), rule 4a
// (leading imperative) fires FIRST -> "imperative:stop". The pure emergency-brake path is reached
// only when the brake word is NOT the first token / not a leading imperative verb.
test("rule4b: emergency brake anywhere => emergency_brake conf 1", () => {
  pin(shouldSpeak("stop everything", ON), true, "imperative:stop", 0.9, "stop-leading-is-imperative");
  // "abort" is a leading imperative? abort is NOT in IMPERATIVE_VERBS, but IS an emergency brake.
  // "we should really abort that" -> no leading/embedded imperative verb -> emergency brake hits.
  pin(shouldSpeak("we should really abort that", ON), true, "emergency_brake", 1, "abort-mid");
  // "actually maybe stop everything": "stop" not first token, but stop IS an IMPERATIVE_VERB so
  // emergency-brake check (rule 4b, tokens.some) runs before embedded-imperative (4c); brake wins.
  pin(shouldSpeak("actually maybe stop everything", ON), true, "emergency_brake", 1, "musing+stop");
});

// Rule 4c — embedded imperative (not first token) => imperative_embedded:<verb> conf 0.8.
test("rule4c: embedded imperative => imperative_embedded:<verb> conf 0.8", () => {
  pin(shouldSpeak("i think we should ship this", ON), true, "imperative_embedded:ship", 0.8, "ship-embedded");
  pin(shouldSpeak("maybe we should look at pane two", ON), true, "imperative_embedded:look", 0.8, "look-embedded");
  pin(shouldSpeak("what if we just deploy", ON), true, "imperative_embedded:deploy", 0.8, "deploy-embedded");
  pin(shouldSpeak("i guess we could merge it", ON), true, "imperative_embedded:merge", 0.8, "merge-embedded");
});

// Rule 5 — thinking-aloud MUTE. Pin confidence math exactly.
test("rule5: thinking-aloud mute with exact confidence", () => {
  // startsWithAny matches the LEADING phrase, and this opens with "hmm" -> leader "hmm" (len 3 =>
  // WEAK base 0.6), not "so im thinking". Deliberation hit: "thinking" => +0.1 = 0.7. tokens>=3 and
  // conf>=0.7 -> MUTE at exactly 0.7.
  pin(
    shouldSpeak("hmm, so what I'm thinking is we restructure the data layer", ON),
    false, "thinking_aloud:hmm", 0.7, "hmm-leader",
  );
  // "wait, no, the other approach was cleaner" -> leader "wait no" (strong, base 0.8),
  // deliberation: "approach" => 1 hit => 0.9. MUTE.
  pin(shouldSpeak("wait, no, the other approach was cleaner", ON), false, "thinking_aloud:wait no", 0.9, "wait-no");
  // "yeah I agree, lets circle back with the team on that" -> leader "yeah i agree" base 0.8;
  // deliberation: "agree","circle","team" => 3 hits => min(1, 0.8+0.3)=1.0. MUTE.
  pin(
    shouldSpeak("yeah I agree, lets circle back with the team on that", ON),
    false, "thinking_aloud:yeah i agree", 1, "yeah-agree",
  );
  // "actually maybe we should reconsider the whole roadmap" -> leader "actually maybe" base 0.8;
  // deliberation: "maybe","reconsider","whole","roadmap" => 4 hits => min(1, 0.8+0.4)=1.0. MUTE.
  pin(
    shouldSpeak("actually maybe we should reconsider the whole roadmap", ON),
    false, "thinking_aloud:actually maybe", 1, "actually-maybe",
  );
});

// Rule 5 — short leader "hmm" alone (len<=3 -> weak, base 0.6) under bar => speak low_conf.
test("rule5: short weak leader under bar => thinking_aloud_low_conf", () => {
  // "hmm ok then" -> leader "hmm" (len 3, weak base 0.6), no deliberation hits, tokens=3.
  // confidence 0.6 < 0.7 -> SPEAK low_conf.
  pin(shouldSpeak("hmm ok then", ON), true, "thinking_aloud_low_conf:hmm", 0.6, "hmm-weak");
});

// Rule 5 — leader present but utterance too short (<3 tokens) => fail open even if conf high.
test("rule5: high-conf leader but <3 tokens => low_conf speak", () => {
  // "so im thinking" alone: leader "so im thinking" (strong base 0.8), tokens=3 actually ->
  // "so","im","thinking": "thinking" is a deliberation word => 0.9, tokens=3 -> would MUTE.
  // Use a genuinely short one: "wait no" -> leader "wait no" strong base 0.8, tokens=2 (<3) => speak.
  pin(shouldSpeak("wait no", ON), true, "thinking_aloud_low_conf:wait no", 0.8, "wait-no-short");
});

// Rule 6 — default fail open (statement, no marker) => default_fail_open conf 0.5.
// Inputs deliberately avoid IMPERATIVE_VERBS ("build","open","test","look",... all force speak via
// rule 4) and EMERGENCY_BRAKES and THINKING_LEADERS, isolating the true default path.
test("rule6: default fail open conf 0.5", () => {
  pin(shouldSpeak("the suite is green", ON), true, "default_fail_open", 0.5, "suite-green");
  pin(shouldSpeak("that looks fine", ON), true, "default_fail_open", 0.5, "looks-fine");
  pin(shouldSpeak("two panes are visible", ON), true, "default_fail_open", 0.5, "two-panes");
  pin(shouldSpeak("interesting", ON), true, "default_fail_open", 0.5, "interesting");
});
