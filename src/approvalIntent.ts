/**
 * WS-E.2 (BUG-008): a PURE, unit-testable approval-intent parser that replaces the old
 * naive substring `.some(includes)` voice resolver (`server.ts:1186-1189`).
 *
 * The old parser misfired on:
 *   - negation ("I don't want to cancel" -> rejected the build);
 *   - ASR apostrophe drop ("dont run" never matched the literal `don't run`);
 *   - approve/reject collisions (isApprove was checked first, so "approve but reject"
 *     silently approved).
 *
 * This module is intentionally framework-free (no Live session, no terminals) so the
 * negation/apostrophe/collision table can be asserted in isolation.
 */

export type ApprovalIntent = "approve" | "reject" | "clarify" | "none";

export interface TargetHint {
  /** A free-text fragment the operator named ("the npm install one"). */
  fragment?: string;
  /** A 1-based ordinal ("the second one" -> 2; "the last one" -> -1). */
  ordinal?: number;
}

export interface ParsedApproval {
  intent: ApprovalIntent;
  targetHint?: TargetHint;
}

/** Words that, appearing within the negation window BEFORE a trigger verb, negate it. */
const NEGATORS = new Set(["not", "no", "dont", "never", "cant", "cannot", "wont", "nope"]);

/** Standalone short affirmations/denials (the whole utterance is essentially this word). */
const BARE_YES = new Set(["yes", "yep", "yeah", "approved", "ok", "okay", "affirmative"]);
const BARE_NO = new Set(["no", "nope", "nah", "negative"]);

// STRONG verbs live in the approval domain and trigger WITHOUT a nearby object token
// ("approve" / "reject" are unambiguous). WEAK verbs are ambient ("run", "go", "stop") and
// require explicit pairing with an object token so incidental speech does not resolve a vote.
const APPROVE_STRONG = new Set(["approve", "approved", "accept", "confirm", "authorize"]);
const APPROVE_WEAK = new Set(["ok", "okay", "yes", "go", "run", "execute", "proceed", "dispatch", "send"]);
const REJECT_STRONG = new Set(["reject", "rejected", "deny", "denied", "decline", "discard"]);
const REJECT_WEAK = new Set(["cancel", "stop", "abort", "skip", "nevermind"]);

const APPROVE_VERBS = new Set([...APPROVE_STRONG, ...APPROVE_WEAK]);
const REJECT_VERBS = new Set([...REJECT_STRONG, ...REJECT_WEAK]);
const STRONG_VERBS = new Set([...APPROVE_STRONG, ...REJECT_STRONG]);

/** Object tokens that signal the operator is talking about the pending command, not just
 *  uttering an ambient verb. "approve" + one of these (nearby) = an explicit trigger. */
const OBJECT_TOKENS = new Set([
  "command", "commands", "it", "that", "this", "one", "them", "approval", "the", "request",
  "task", "step", "proposal", "first", "second", "third", "last", "previous", "next",
]);

const ORDINAL_WORDS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  last: -1, latest: -1, previous: -1,
};

/** ASR-friendly normalization: drop apostrophes (don't -> dont), lowercase, collapse ws. */
export function normalizeUtterance(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’'`´]/g, "") // strip every apostrophe variant
    .replace(/[^a-z0-9\s]/g, " ") // punctuation -> space (keeps tokens clean)
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(s: string): string[] {
  return normalizeUtterance(s).split(" ").filter(Boolean);
}

/**
 * Returns true if a trigger verb at index `i` is NEGATED by a negator within the
 * preceding `window` tokens (default 3). "do not run it" -> run is negated.
 */
function isNegated(tokens: string[], i: number, window = 3): boolean {
  for (let j = Math.max(0, i - window); j < i; j++) {
    if (NEGATORS.has(tokens[j])) return true;
  }
  return false;
}

/** Does a verb at index `i` have an object token within +/-2 tokens (explicit pairing)? */
function hasNearbyObject(tokens: string[], i: number, window = 2): boolean {
  for (let j = Math.max(0, i - window); j <= Math.min(tokens.length - 1, i + window); j++) {
    if (j === i) continue;
    if (OBJECT_TOKENS.has(tokens[j])) return true;
  }
  return false;
}

/** Extract a target hint (ordinal word or a named fragment after "the"). */
function extractTargetHint(tokens: string[]): TargetHint | undefined {
  const hint: TargetHint = {};

  for (const tok of tokens) {
    if (tok in ORDINAL_WORDS) {
      hint.ordinal = ORDINAL_WORDS[tok];
      break;
    }
  }

  // Fragment: the words sitting between a trigger/"the" and a trailing object token
  // ("approve the npm install command" -> "npm install"). We take the longest run of
  // non-stopword tokens that are not verbs/negators/objects.
  const STOP = new Set([
    ...APPROVE_VERBS, ...REJECT_VERBS, ...NEGATORS, ...OBJECT_TOKENS,
    "to", "i", "want", "we", "lets", "let", "please", "and", "but", "actually", "now",
    "the", "a", "an", "on", "for", "pane", "in", "do", "make", "sure",
  ]);
  const frag: string[] = [];
  let best: string[] = [];
  for (const tok of tokens) {
    if (STOP.has(tok) || tok in ORDINAL_WORDS) {
      if (frag.length > best.length) best = [...frag];
      frag.length = 0;
    } else {
      frag.push(tok);
    }
  }
  if (frag.length > best.length) best = [...frag];
  if (best.length) hint.fragment = best.join(" ");

  return hint.ordinal !== undefined || hint.fragment ? hint : undefined;
}

/**
 * The core parser. Scans for explicit, non-negated approve/reject triggers (a verb paired
 * with a nearby object token), and:
 *   - both present (or genuinely ambiguous) -> "clarify" (NEVER default-approve);
 *   - exactly one -> "approve"/"reject" with an optional target hint;
 *   - none -> "none" (ambient speech does not resolve anything).
 */
export function parseApprovalIntent(transcript: string): ParsedApproval {
  const tokens = tokenize(transcript);
  if (tokens.length === 0) return { intent: "none" };

  // Bare short affirmation/denial ("yes" / "no" / "approved") — the whole utterance.
  if (tokens.length <= 2) {
    const hasYes = tokens.some((t) => BARE_YES.has(t));
    const hasNo = tokens.some((t) => BARE_NO.has(t));
    if (hasYes && !hasNo) return { intent: "approve" };
    if (hasNo && !hasYes) return { intent: "reject" };
    if (hasYes && hasNo) return { intent: "clarify" };
  }

  // Leading-negator DIRECTIVE: an utterance that STARTS with a CONTRACTED negator immediately
  // followed by an approve/run verb ("dont run", "dont approve") is an explicit REJECT
  // directive — this is the ASR apostrophe-drop case (BUG-008: "dont run" must reject). The
  // fully-spelled "do not run it" is deliberately NOT a directive (design §10 table: -> none),
  // and a negated verb mid-sentence ("I dont want to cancel") is likewise suppressed below.
  if ((tokens[0] === "dont" || tokens[0] === "never") && APPROVE_VERBS.has(tokens[1])) {
    return { intent: "reject", targetHint: extractTargetHint(tokens) };
  }

  let approve = false;
  let reject = false;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const isApproveVerb = APPROVE_VERBS.has(tok);
    const isRejectVerb = REJECT_VERBS.has(tok);
    if (!isApproveVerb && !isRejectVerb) continue;

    // STRONG approval-domain verbs trigger on their own; WEAK ambient verbs require explicit
    // pairing with a nearby object token (so "we execute carefully" does not resolve a vote).
    const paired = STRONG_VERBS.has(tok) || hasNearbyObject(tokens, i) || tokens.length <= 2;
    if (!paired) continue;

    // A NEGATED trigger verb is CONSERVATIVELY suppressed (no resolution) — per the design,
    // "do not run it" and "I dont want to cancel" both yield no dispatch. We never infer
    // approval from a double negative.
    if (isNegated(tokens, i)) continue;

    if (isApproveVerb) approve = true;
    if (isRejectVerb) reject = true;
  }

  if (approve && reject) return { intent: "clarify" };
  if (approve) return { intent: "approve", targetHint: extractTargetHint(tokens) };
  if (reject) return { intent: "reject", targetHint: extractTargetHint(tokens) };
  return { intent: "none" };
}

/**
 * WS-E.2 (BUG-007): pick which pending approval an utterance refers to.
 *
 * `entries` are in ANNOUNCED order (oldest first). Resolution order:
 *   fragment match > ordinal > lastAnnouncedId > (only-if-exactly-one) that one.
 * Returns { messageId } on a unique hit, or { ambiguous: true } when 2+ match or none
 * match with >1 pending (the caller then CLARIFIES rather than default-resolving).
 */
export interface TargetableEntry {
  messageId: string;
  instruction: string;
  terminalId: string;
}

export interface TargetResult {
  messageId?: string;
  ambiguous?: boolean;
  /** How the target was chosen (for read-back / logging). */
  via?: "fragment" | "ordinal" | "lastAnnounced" | "only";
}

export function selectApprovalTarget(
  entries: TargetableEntry[],
  hint: TargetHint | undefined,
  lastAnnouncedId: string | null
): TargetResult {
  if (entries.length === 0) return {};
  if (entries.length === 1) return { messageId: entries[0].messageId, via: "only" };

  // 1. Fragment match against instruction or pane id.
  if (hint?.fragment) {
    const needle = normalizeUtterance(hint.fragment);
    const needleTokens = needle.split(" ").filter(Boolean);
    const matches = entries.filter((e) => {
      const hay = normalizeUtterance(`${e.instruction} ${e.terminalId}`);
      return needleTokens.every((t) => hay.includes(t));
    });
    if (matches.length === 1) return { messageId: matches[0].messageId, via: "fragment" };
    if (matches.length > 1) return { ambiguous: true };
  }

  // 2. Ordinal ("the second one", "the last one").
  if (hint?.ordinal !== undefined) {
    const idx = hint.ordinal === -1 ? entries.length - 1 : hint.ordinal - 1;
    if (idx >= 0 && idx < entries.length) {
      return { messageId: entries[idx].messageId, via: "ordinal" };
    }
    return { ambiguous: true };
  }

  // 3. The most-recently-announced id (never blind FIFO).
  if (lastAnnouncedId && entries.some((e) => e.messageId === lastAnnouncedId)) {
    return { messageId: lastAnnouncedId, via: "lastAnnounced" };
  }

  // 4. >1 pending and nothing disambiguates -> caller must clarify.
  return { ambiguous: true };
}
