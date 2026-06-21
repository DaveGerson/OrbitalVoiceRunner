// src/voice/speakGate.ts — BEAD tkd: the voice "should-I-speak" gate (PURE decision core).
//
// THESIS (LlamaPIE / Gemini-Live field data): a cheap code-side gate decides whether Janus's SPOKEN
// reply is emitted, with "the director is thinking aloud / in active human-to-human discussion (not
// addressing Janus)" as the MUTE condition. Prose-only stay-silent rules fail ~67%; only code-side
// gating reaches 0%. The cog prompt sets the INTENT ("proactive in the work, reactive in the talk");
// THIS module enforces it.
//
// SAFETY (a prior incident left hands-free voice DEAD — 5dafe33). The contract, in order:
//   1. Flag OFF  => hard short-circuit to {speak:true}. Byte-for-byte today's behavior. No heuristic
//      ever runs. (Proven by tests/test_speak_gate.ts #1.)
//   2. Flag ON   => FAIL OPEN. Mute (speak:false) ONLY when HIGH-confidence the director is
//      thinking-aloud. A clearly-addressed request, an imperative/command, or ANY ambiguous /
//      low-confidence utterance => SPEAK. Over-muting = dead voice = unacceptable.
//
// This is intentionally a small, isolated, unit-testable unit. It is wired at the SINGLE spoken-output
// choke point in src/voice/index.ts (the one `clientWs.send({type:"audio",...})`), which only ever
// READS the boolean — the decision logic lives ENTIRELY here (mirrors the voiceAckGate seam).
//
// v1 is a conservative heuristic on the input transcript. A smarter classifier can drop in behind the
// same shouldSpeak(transcript, opts) -> SpeakDecision contract without touching index.ts.

import { normalizeUtterance } from "../approvalIntent";

export interface SpeakGateOpts {
  /** The voiceAi.silenceGate flag. When false, shouldSpeak short-circuits to {speak:true}. */
  enabled: boolean;
  /** Injected clock (unused in v1's pure heuristic; reserved so a future time-aware gate stays pure). */
  now?: number;
}

export interface SpeakDecision {
  /** TRUE = emit Janus's spoken audio for this turn. FALSE = mute audio (transcript still renders). */
  speak: boolean;
  /** Why — recorded to the interaction log so a mute is auditable (guards against silent dead-voice). */
  reason: string;
  /** [0,1]. For a MUTE this is the confidence the director was thinking-aloud; muting needs it high. */
  confidence: number;
}

const SPEAK = (reason: string, confidence: number): SpeakDecision => ({ speak: true, reason, confidence });
const MUTE = (reason: string, confidence: number): SpeakDecision => ({ speak: false, reason, confidence });

/**
 * Janus is ADDRESSED: the operator's name, or a second-person request/question aimed at Janus. ANY hit
 * forces SPEAK (we never mute something pointed at Janus). These are matched as whole tokens / leading
 * phrases on the normalized utterance (apostrophes already dropped by normalizeUtterance).
 */
const ADDRESS_NAME = new Set(["janus"]);
// LEADING second-person request/question openers. Deliberately NARROW: openers like "what"/"how"/
// "is"/"do" are EXCLUDED because they collide with musing ("what if we...") and bare statements
// ("is the build green") — they are matched only via the explicit ADDRESS_PHRASES ("what's running")
// or the request-phrase forms below. Over-broad address verbs would wrongly force-speak a musing.
const ADDRESS_VERBS = new Set([
  "can", "could", "would", "will", "please", "show", "tell", "list", "give", "whats", "wheres", "hows",
]);
const ADDRESS_PHRASES = ["can you", "could you", "would you", "will you", "show me", "tell me", "switch to", "let me know", "whats running", "whats the"];

/**
 * IMPERATIVE / command: a first-token action verb, or an emergency-brake word ANYWHERE. Any hit forces
 * SPEAK (never mute a command). This deliberately overlaps approvalIntent's directive spirit, but here
 * it ONLY ever forces SPEAK — so a false positive is harmless (it can only keep the voice ON).
 *
 * q4l widening: the concrete dev-action verbs below (ship/deploy/merge/fix/pull/push/commit/rebase/
 * build/test/look/review/investigate) were added so deliberation-phrased COMMANDS speak. Before this,
 * a command embedded after a musing leader ("i think we should ship this", "what if we just deploy")
 * missed the embedded-imperative check (rule 4) and the musing-leader mute (rule 5) wrongly won.
 * Adding a verb can ONLY force SPEAK (rule 4 only returns SPEAK), so this cannot introduce a new mute
 * nor break the flag-OFF short-circuit. NB: deliberately a concrete-verb set, NOT a generic
 * "we should <X>" => speak construction — that would regress genuine deliberation ("lets circle back").
 */
const IMPERATIVE_VERBS = new Set([
  "open", "close", "run", "stop", "start", "switch", "show", "tell", "list", "approve", "reject",
  "cancel", "restart", "spawn", "kill", "create", "archive", "send", "execute", "go", "proceed",
  "pause", "resume", "check", "read", "focus", "select", "dispatch", "deny", "accept",
  // q4l: dev-action verbs (deliberation-phrased commands like "we should ship" must speak).
  "ship", "deploy", "merge", "fix", "pull", "push", "commit", "rebase", "build", "test", "look",
  "review", "investigate",
]);
// Emergency brakes: if any of these appears ANYWHERE, force SPEAK (safety — never swallow a "stop").
const EMERGENCY_BRAKES = new Set(["stop", "halt", "abort", "freeze", "kill"]);

/**
 * THINKING-ALOUD markers (consulted ONLY after address + imperative both miss). These are trailing-
 * thought / self-directed musing or human-to-human discussion signals. Presence of a STRONG marker at
 * high confidence is the ONLY path to a mute. Kept deliberately narrow — the bar is conservative.
 */
// Strong leading musing phrases (the utterance opens as a self-directed thought).
const THINKING_LEADERS = [
  "hmm", "hm", "uh", "um", "so im thinking", "so i am thinking", "im thinking", "i am thinking",
  "wait no", "wait theres", "actually maybe", "i guess", "i suppose", "what if we", "what if i",
  "maybe we should", "yeah i agree", "yeah lets", "yeah i think", "i think we should", "lets circle back",
];
// Discussion / deliberation words that, combined with a leader, raise confidence.
const DELIBERATION_WORDS = new Set([
  "thinking", "tradeoff", "tradeoffs", "approach", "reconsider", "circle", "team", "versus", "vs",
  "whole", "roadmap", "wondering", "guess", "suppose", "agree", "maybe", "perhaps", "later", "down",
]);

function startsWithAny(s: string, phrases: string[]): string | null {
  for (const p of phrases) {
    if (s === p || s.startsWith(p + " ")) return p;
  }
  return null;
}

function containsPhrase(s: string, phrase: string): boolean {
  return s === phrase || s.startsWith(phrase + " ") || s.includes(" " + phrase + " ") || s.endsWith(" " + phrase);
}

/**
 * Rule 3 — ADDRESSED-TO-JANUS: name anywhere, leading second-person verb, or a request phrase.
 * Returns a SPEAK decision on any hit, or null to fall through. Verbatim from the inline rule.
 */
function addressedDecision(norm: string, tokens: string[], first: string): SpeakDecision | null {
  if (tokens.some((t) => ADDRESS_NAME.has(t))) return SPEAK("addressed_janus_name", 1);
  const phrase = startsWithAny(norm, ADDRESS_PHRASES) ?? ADDRESS_PHRASES.find((p) => containsPhrase(norm, p));
  if (phrase) return SPEAK(`addressed_phrase:${phrase}`, 0.9);
  if (ADDRESS_VERBS.has(first)) return SPEAK(`addressed_verb:${first}`, 0.85);
  return null;
}

/**
 * Rule 4 — IMPERATIVE / emergency-brake: never mute a command. Returns a SPEAK decision on any hit,
 * or null to fall through. Order (leading imperative -> emergency brake anywhere -> embedded
 * imperative) is verbatim from the inline rule and load-bearing.
 */
function imperativeDecision(tokens: string[], first: string): SpeakDecision | null {
  if (IMPERATIVE_VERBS.has(first)) return SPEAK(`imperative:${first}`, 0.9);
  if (tokens.some((t) => EMERGENCY_BRAKES.has(t))) return SPEAK("emergency_brake", 1);
  const embeddedImperative = tokens.find((t) => IMPERATIVE_VERBS.has(t));
  if (embeddedImperative) return SPEAK(`imperative_embedded:${embeddedImperative}`, 0.8);
  return null;
}

/**
 * Rule 5 — THINKING-ALOUD: the ONLY mute path, gated on HIGH confidence. Requires a leading musing
 * marker; deliberation words raise confidence. Returns the MUTE/low-conf-SPEAK decision when a leader
 * is present, or null (no marker) so the caller falls through to the default. Verbatim confidence math.
 */
function thinkingAloudDecision(norm: string, tokens: string[]): SpeakDecision | null {
  const leader = startsWithAny(norm, THINKING_LEADERS);
  if (!leader) return null;
  const deliberationHits = tokens.filter((t) => DELIBERATION_WORDS.has(t)).length;
  // Base confidence from the leader; each deliberation word nudges it up. A bare "hmm" alone
  // (no further signal) stays just under the bar so a terse grunt before a real request never mutes.
  const strongLeader = leader.length > 3; // multi-word leaders ("so im thinking", "wait no") are strong
  let confidence = strongLeader ? 0.8 : 0.6;
  confidence = Math.min(1, confidence + deliberationHits * 0.1);
  // Very short utterances (<= 2 tokens) are too thin to confidently call thinking-aloud — fail open.
  if (tokens.length >= 3 && confidence >= 0.7) {
    return MUTE(`thinking_aloud:${leader}`, confidence);
  }
  // Marker present but not high-confidence -> fail open (speak).
  return SPEAK(`thinking_aloud_low_conf:${leader}`, confidence);
}

/**
 * shouldSpeak — the pure decision. Order is load-bearing (each rule can only ADD a reason to speak;
 * the single mute path is last and gated on HIGH confidence):
 *   1. flag OFF                      => speak (hard short-circuit; no heuristic runs).
 *   2. empty / whitespace            => speak (let existing paths run).
 *   3. ADDRESSED (name/2nd-person)   => speak.
 *   4. IMPERATIVE / emergency-brake  => speak.
 *   5. THINKING-ALOUD @ high conf    => MUTE (the ONLY mute).
 *   6. default                       => speak (fail open).
 */
export function shouldSpeak(transcript: string, opts: SpeakGateOpts): SpeakDecision {
  // 1. Flag OFF — hard short-circuit. Byte-for-byte today's behavior; no heuristic ever runs.
  if (!opts.enabled) return SPEAK("gate_disabled", 1);

  // 2. Empty / whitespace — fail open (the existing transcript paths handle empties).
  const norm = normalizeUtterance(transcript);
  if (norm.length === 0) return SPEAK("empty", 1);

  const tokens = norm.split(" ").filter(Boolean);
  const first = tokens[0] ?? "";

  // 3. ADDRESSED-TO-JANUS — name anywhere, leading second-person verb, or a request phrase. SPEAK.
  const addressed = addressedDecision(norm, tokens, first);
  if (addressed) return addressed;

  // 4. IMPERATIVE / emergency-brake — never mute a command. SPEAK.
  //    A leading action verb is the canonical imperative ("run the tests"). But a command embedded
  //    after a musing leader ("so im thinking, run the tests now") is STILL a command — so any
  //    imperative or emergency-brake ANYWHERE forces SPEAK. This makes the mute path safe by
  //    construction: it can only be reached when NO command token is present (fail-safe toward speak).
  const imperative = imperativeDecision(tokens, first);
  if (imperative) return imperative;

  // 5. THINKING-ALOUD — the ONLY mute path, gated on HIGH confidence. Requires a leading musing
  //    marker; deliberation words raise confidence. Address/imperative already excluded above.
  const thinkingAloud = thinkingAloudDecision(norm, tokens);
  if (thinkingAloud) return thinkingAloud;

  // 6. Default — fail open. Statements with no address, no imperative, no musing marker SPEAK.
  return SPEAK("default_fail_open", 0.5);
}
