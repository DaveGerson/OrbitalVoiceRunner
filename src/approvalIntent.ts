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

export type ApprovalIntent = "approve" | "reject" | "defer" | "clarify" | "none";

/**
 * 4D.3: how many times one pending record may be DEFERRED ("later" / "not now") before the
 * defer verb stops re-arming its TTL window and the normal last-call → grace → expire flow
 * takes over. Shared by gating.applyDeferral (approvals) and resolvePendingActionByVoice
 * (staged actions) so the no-infinite-parking cap is one number.
 */
export const MAX_DEFERRALS = 3;

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
// NOTE: "confirmed" is deliberately NOT here. It lives only in APPROVE_STRONG, whose path
// honors negation (isNegated) — the bare block below does not, so a "confirmed" in BARE_YES
// would make "dont confirmed" wrongly approve. The strong-verb path resolves a lone
// "Confirmed." to approve correctly without that hazard.
const BARE_YES = new Set(["yes", "yep", "yeah", "approved", "ok", "okay", "affirmative"]);
const BARE_NO = new Set(["no", "nope", "nah", "negative"]);

// STRONG verbs live in the approval domain and trigger WITHOUT a nearby object token
// ("approve" / "reject" are unambiguous). WEAK verbs are ambient ("run", "go", "stop") and
// require explicit pairing with an object token so incidental speech does not resolve a vote.
// Past-tense forms (accepted/confirmed/authorized) mirror the reject side's reject/rejected,
// deny/denied pairs — an operator says the tense the UI shows ("Confirm" button -> "Confirmed.").
// Because line 162 spreads APPROVE_STRONG into NON_DIRECTIVE_AFTER_NEGATOR, these are also
// auto-protected from the leading-negator reject directive (so "dont confirmed" stays "none").
const APPROVE_STRONG = new Set(["approve", "approved", "accept", "accepted", "confirm", "confirmed", "authorize", "authorized"]);
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

// ── 4D.3: the DEFER phrase table ────────────────────────────────────────────────────────────────
// "Defer" = "keep it staged, ask me again later" — the non-destructive fourth verb. Before this,
// an eyes-off "skip that for now, ask me later" hit REJECT_WEAK's "skip" and permanently CANCELLED
// the staged command (claim+delete, unrecoverable).
//
// PHRASE TABLE (all matching runs on the normalized token stream; a NEGATOR immediately before a
// matched phrase suppresses it — "dont hold it" is NOT a defer):
//   1. short utterance (≤3 tokens) containing "later"        -> defer   ("later", "maybe later")
//   2. adjacent bigram "<me|again|it|that> later"             -> defer   ("ask me later", "do it later")
//   3. "not now" / "not right now" / "not yet"                -> defer
//   4. "hold on|off|that|it" / "on hold"                      -> defer   ("hold" needs its particle —
//                                                                         bare "hold" stays unresolved)
//   5. "in a minute|moment|bit|second"                        -> defer
//   6. "for now" present AND any of {skip,hold,wait,leave,    -> defer   ("skip that for now",
//      park,pass,not} present                                            "leave it for now")
//
// PRECEDENCE (deliberate, documented): the defer scan runs FIRST — before the bare-yes/no block and
// before the verb scan — so a mixed utterance ("no, later" / "skip that for now, ask me later")
// resolves to the NON-DESTRUCTIVE option. A wrong defer only re-arms a TTL and re-asks; a wrong
// reject destroys the record. Bare "skip"/"skip it" (≤2 tokens, no "for now" rider) is pinned as
// REJECT (see parseApprovalIntent), so the reject lane is unchanged without the rider.
const DEFER_LATER_PRECEDERS = new Set(["me", "again", "it", "that", "them", "you"]);
const DEFER_HOLD_PARTICLES = new Set(["on", "off", "that", "it", "them"]);
const DEFER_IN_A_UNITS = new Set(["minute", "moment", "bit", "second", "sec", "while", "few"]);
const DEFER_FOR_NOW_PAIRS = new Set(["skip", "hold", "wait", "leave", "park", "pass", "not"]);

/** True when tokens[i-1] is a negator ("dont hold it" must not defer). */
function negatorBefore(tokens: string[], i: number): boolean {
  return i > 0 && NEGATORS.has(tokens[i - 1]);
}

// ── isDeferUtterance, decomposed into one predicate per phrase-table clause ──
// Each clause-N predicate tests whether the defer phrase ANCHORS at token index `i`. The clauses
// are EXACTLY those documented on the phrase table above; the dispatcher (isDeferUtterance) runs the
// short-"later" length guard once, then ORs the per-index clauses across the token stream — so the
// observable result is byte-identical to the original linear chain, just hand-verifiable per clause.

/** (2) "<me|again|it|that|them|you> later" — "ask me later", "remind me later", "do it later". */
function isDeferLaterBigram(tokens: string[], i: number): boolean {
  return tokens[i + 1] === "later" && DEFER_LATER_PRECEDERS.has(tokens[i]) && !negatorBefore(tokens, i);
}

/** (3) "not now" / "not yet" / "not right now". */
function isDeferNotNow(tokens: string[], i: number): boolean {
  if (tokens[i] !== "not") return false;
  const next = tokens[i + 1];
  return next === "now" || next === "yet" || (next === "right" && tokens[i + 2] === "now");
}

/** (4) "hold <on|off|that|it|them>" / "on hold". */
function isDeferHold(tokens: string[], i: number): boolean {
  const tok = tokens[i];
  const next = tokens[i + 1];
  if (tok === "hold" && next !== undefined && DEFER_HOLD_PARTICLES.has(next) && !negatorBefore(tokens, i)) return true;
  return tok === "on" && next === "hold";
}

/** (5) "in a <minute|moment|bit|second|sec|while|few>". */
function isDeferInAUnit(tokens: string[], i: number): boolean {
  return tokens[i] === "in" && tokens[i + 1] === "a" && tokens[i + 2] !== undefined && DEFER_IN_A_UNITS.has(tokens[i + 2]);
}

/** (6) "for now" anchored here, paired with a parking verb ANYWHERE in the utterance. */
function isDeferForNow(tokens: string[], i: number): boolean {
  return tokens[i] === "for" && tokens[i + 1] === "now" && tokens.some((t) => DEFER_FOR_NOW_PAIRS.has(t));
}

/** The per-index defer clauses (2)–(6); clause (1) is the length-guarded short-"later" prefix check. */
const DEFER_CLAUSES: ReadonlyArray<(tokens: string[], i: number) => boolean> = [
  isDeferLaterBigram, isDeferNotNow, isDeferHold, isDeferInAUnit, isDeferForNow,
];

function isDeferUtterance(tokens: string[]): boolean {
  // (1) A short, directive utterance built around "later".
  if (tokens.length <= 3 && tokens.includes("later")) return true;
  for (let i = 0; i < tokens.length; i++) {
    for (const clause of DEFER_CLAUSES) {
      if (clause(tokens, i)) return true;
    }
  }
  return false;
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

// Fragment STOP words: tokens that can never be part of a by-name target fragment (verbs,
// negators, object tokens, filler, and the 4D.3 defer-phrase vocabulary so "skip the npm install
// for now" yields "npm install", never "later"/"hold"/… as a bogus by-name target).
const FRAGMENT_STOP = new Set([
  ...APPROVE_VERBS, ...REJECT_VERBS, ...NEGATORS, ...OBJECT_TOKENS,
  "to", "i", "want", "we", "lets", "let", "please", "and", "but", "actually", "now",
  "the", "a", "an", "on", "for", "pane", "in", "do", "make", "sure",
  "later", "hold", "wait", "leave", "park", "pass", "minute", "moment", "bit", "second", "sec",
  "while", "few", "yet", "again", "right", "maybe", "ask", "remind", "me",
]);

/** The first ordinal word in the stream maps to its number ("the second one" -> 2; "last" -> -1). */
function extractOrdinal(tokens: string[]): number | undefined {
  for (const tok of tokens) {
    if (tok in ORDINAL_WORDS) return ORDINAL_WORDS[tok];
  }
  return undefined;
}

/**
 * Fragment: the LONGEST run of non-stopword tokens ("approve the npm install command" -> "npm
 * install"). Stop words and ordinal words break a run; the longest run seen wins.
 */
function extractFragment(tokens: string[]): string | undefined {
  const frag: string[] = [];
  let best: string[] = [];
  for (const tok of tokens) {
    if (FRAGMENT_STOP.has(tok) || tok in ORDINAL_WORDS) {
      if (frag.length > best.length) best = [...frag];
      frag.length = 0;
    } else {
      frag.push(tok);
    }
  }
  if (frag.length > best.length) best = [...frag];
  return best.length ? best.join(" ") : undefined;
}

/** Extract a target hint (ordinal word or a named fragment after "the"). */
function extractTargetHint(tokens: string[]): TargetHint | undefined {
  const hint: TargetHint = {};
  const ordinal = extractOrdinal(tokens);
  if (ordinal !== undefined) hint.ordinal = ordinal;
  const fragment = extractFragment(tokens);
  if (fragment) hint.fragment = fragment;
  return hint.ordinal !== undefined || hint.fragment ? hint : undefined;
}

// Leading-negator directive exclusion set — the approval-domain verbs NEVER become an inferred
// reject directive ("dont approve" / "dont confirm" stay `none`; only ambient action verbs keep the
// reject-directive). Spread of APPROVE_STRONG (+ approve/approved) per the P2 symmetry note below.
const NON_DIRECTIVE_AFTER_NEGATOR = new Set([...APPROVE_STRONG, "approve", "approved"]);

/**
 * 4D.3 (card-pinned): the bare skip family — "skip" / "skip it|that|this" with NO "for now" rider —
 * resolves REJECT. (The defer scan already claimed every "skip … for now" form.) Returns the parsed
 * reject when this anchors, else null to fall through.
 */
function tryBareSkip(tokens: string[]): ParsedApproval | null {
  if (tokens[0] === "skip" && tokens.length <= 2 &&
      (tokens.length === 1 || ["it", "that", "this"].includes(tokens[1]))) {
    return { intent: "reject", targetHint: extractTargetHint(tokens) };
  }
  return null;
}

/**
 * Bare short affirmation/denial ("yes" / "no" / "approved") — the whole utterance (<=2 tokens).
 * Returns approve/reject/clarify when this short-form resolves, else null to fall through.
 */
function tryBareYesNo(tokens: string[]): ParsedApproval | null {
  if (tokens.length > 2) return null;
  const hasYes = tokens.some((t) => BARE_YES.has(t));
  const hasNo = tokens.some((t) => BARE_NO.has(t));
  if (hasYes && !hasNo) return { intent: "approve" };
  if (hasNo && !hasYes) return { intent: "reject" };
  if (hasYes && hasNo) return { intent: "clarify" };
  return null;
}

/**
 * Leading-negator DIRECTIVE: an utterance that STARTS with a CONTRACTED negator immediately followed
 * by an ambient ACTION verb ("dont run", "dont go", "dont execute") is an explicit REJECT directive
 * — the ASR apostrophe-drop case (BUG-008). The fully-spelled "do not run it" is deliberately NOT a
 * directive (design §10 table: -> none).
 *
 * P2 (do-not-approve symmetry): the approval-domain verbs are DELIBERATELY excluded
 * (NON_DIRECTIVE_AFTER_NEGATOR). "Negating approve" is genuinely ambiguous, and "do not approve"
 * already resolves to `none`; so BOTH "do not approve" and "dont approve" yield `none` (never infer
 * a reject from a negated approve). Returns the reject directive when it anchors, else null.
 */
function tryLeadingNegatorDirective(tokens: string[]): ParsedApproval | null {
  if (
    (tokens[0] === "dont" || tokens[0] === "never") &&
    APPROVE_VERBS.has(tokens[1]) &&
    !NON_DIRECTIVE_AFTER_NEGATOR.has(tokens[1])
  ) {
    return { intent: "reject", targetHint: extractTargetHint(tokens) };
  }
  return null;
}

/** Does the verb at index `i` PAIR (resolve a vote)? Strong verbs always; weak verbs only with a
 *  nearby object token AND more than the bare verb+pronoun pair (P0-A). */
function verbPairs(tokens: string[], i: number, tok: string): boolean {
  const isStrong = STRONG_VERBS.has(tok);
  return isStrong || (hasNearbyObject(tokens, i) && tokens.length > 2);
}

/**
 * The main verb scan: walk the tokens, and for each PAIRED, NON-NEGATED approve/reject trigger flag
 * its side. STRONG approval-domain verbs trigger on their own; WEAK ambient verbs require explicit
 * pairing (so "we execute carefully" / bare "execute"/"proceed"/"dispatch" — and the bare
 * verb+pronoun "send it"/"run it"/"go ahead"/"lets go" — never resolve a vote). A negated trigger is
 * conservatively suppressed (no double-negative inference).
 */
function scanVerbVotes(tokens: string[]): { approve: boolean; reject: boolean } {
  let approve = false;
  let reject = false;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const isApproveVerb = APPROVE_VERBS.has(tok);
    const isRejectVerb = REJECT_VERBS.has(tok);
    if (!isApproveVerb && !isRejectVerb) continue;
    if (!verbPairs(tokens, i, tok)) continue;
    if (isNegated(tokens, i)) continue;
    if (isApproveVerb) approve = true;
    if (isRejectVerb) reject = true;
  }
  return { approve, reject };
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

  // 4D.3 DEFER — checked FIRST (see the precedence note on the phrase table above): on mixed
  // signals ("no, later" / "skip that for now, ask me later") the NON-destructive verb wins.
  // A wrong defer merely re-arms a TTL and asks again; a wrong reject claim+deletes forever.
  if (isDeferUtterance(tokens)) {
    return { intent: "defer", targetHint: extractTargetHint(tokens) };
  }

  // The precedence ladder (each guard returns a resolved intent or null to fall through):
  // bare-skip reject -> bare yes/no -> leading-negator reject directive.
  const guarded = tryBareSkip(tokens) ?? tryBareYesNo(tokens) ?? tryLeadingNegatorDirective(tokens);
  if (guarded) return guarded;

  const { approve, reject } = scanVerbVotes(tokens);

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

/**
 * Resolve a 1-based ordinal hint (-1 = last) to a valid index into a length-`len` list, or null when
 * out of range. Shared by both selectors so the in/out-of-range decision is one place.
 */
function ordinalIndex(ordinal: number, len: number): number | null {
  const idx = ordinal === -1 ? len - 1 : ordinal - 1;
  return idx >= 0 && idx < len ? idx : null;
}

/** Tokenize a fragment hint into its non-empty normalized needle tokens (shared matcher input). */
function fragmentNeedle(fragment: string): string[] {
  return normalizeUtterance(fragment).split(" ").filter(Boolean);
}

/** All entries whose haystack (from `hay`) contains EVERY needle token. */
function fragmentMatches<T>(items: T[], needleTokens: string[], hay: (item: T) => string): T[] {
  return items.filter((item) => {
    const h = normalizeUtterance(hay(item));
    return needleTokens.every((t) => h.includes(t));
  });
}

/** True when `lastAnnouncedId` is set AND still present among the pending entries (never blind FIFO). */
function hasLastAnnounced(entries: TargetableEntry[], lastAnnouncedId: string | null): lastAnnouncedId is string {
  return !!lastAnnouncedId && entries.some((e) => e.messageId === lastAnnouncedId);
}

/** The lone-pending case (wsm-e2e-pinned-cqtz): a single entry resolves via:"only" UNLESS the operator
 *  named a fragment that clearly does not match it (e.g. "approve docker build" while only "npm test" is
 *  pending) — then CLARIFY rather than wrongly resolve. A bare vote (no fragment) or a matching fragment
 *  still resolves. Extracted to keep selectApprovalTarget at CC <= 10. */
function resolveLoneApprovalTarget(entry: TargetableEntry, hint: TargetHint | undefined): TargetResult {
  if (hint?.fragment && fragmentMatches([entry], fragmentNeedle(hint.fragment), (e) => `${e.instruction} ${e.terminalId}`).length === 0) {
    return { ambiguous: true };
  }
  return { messageId: entry.messageId, via: "only" };
}

export function selectApprovalTarget(
  entries: TargetableEntry[],
  hint: TargetHint | undefined,
  lastAnnouncedId: string | null
): TargetResult {
  if (entries.length === 0) return {};
  if (entries.length === 1) return resolveLoneApprovalTarget(entries[0], hint);

  // 1. Fragment match against instruction or pane id.
  // A PRESENT fragment is an explicit by-name targeting signal. With >1 pending, if it matches
  // exactly one we take it; if it matches MORE than one OR ZERO, we CLARIFY rather than fall
  // through to the ordinal/lastAnnounced path (P0-B: a fragment that names "docker" but matches
  // nothing must NOT silently approve `lastAnnounced=deploy` — a miss means "I don't know which",
  // which is a clarify, never an over-approve). The single-entry case is handled above.
  if (hint?.fragment) {
    const matches = fragmentMatches(entries, fragmentNeedle(hint.fragment), (e) => `${e.instruction} ${e.terminalId}`);
    if (matches.length === 1) return { messageId: matches[0].messageId, via: "fragment" };
    // 0 matches OR >1 matches, with >1 pending -> the explicit by-name signal is unresolvable.
    return { ambiguous: true };
  }

  // 2. Ordinal ("the second one", "the last one").
  if (hint?.ordinal !== undefined) {
    const idx = ordinalIndex(hint.ordinal, entries.length);
    return idx !== null ? { messageId: entries[idx].messageId, via: "ordinal" } : { ambiguous: true };
  }

  // 3. The most-recently-announced id (never blind FIFO).
  if (hasLastAnnounced(entries, lastAnnouncedId)) {
    return { messageId: lastAnnouncedId, via: "lastAnnounced" };
  }

  // 4. >1 pending and nothing disambiguates -> caller must clarify.
  return { ambiguous: true };
}

/**
 * U1 (bead wsm-e2e-pinned-9fe): pick which staged pendingAction an utterance refers to.
 *
 * Sibling of `selectApprovalTarget`, but typed for PendingAction-like entries (id + summary).
 * It deliberately does NOT reuse `selectApprovalTarget`: actions have no meaningful `terminalId`,
 * so the caller reads back `summary` (never an empty pane id) on a clarify. `actions` are in
 * staged order (oldest first), matching `PendingActionStore.all()`.
 *
 * Resolution order:
 *   exactly-one -> that one (via "only"); ordinal -> actions[ordinal-1] (or last for -1);
 *   fragment -> the UNIQUE summary substring match; otherwise ambiguous (caller clarifies).
 * Returns `{}` for an empty list, `{ id, summary, via }` on a unique hit, or `{ ambiguous: true }`.
 */
export interface PendingActionLike {
  id: string;
  summary: string;
}

export interface ActionTargetResult {
  id?: string;
  summary?: string;
  ambiguous?: boolean;
  via?: "only" | "ordinal" | "fragment";
}

/** Lone-pending-action twin of resolveLoneApprovalTarget (wsm-e2e-pinned-cqtz). Extracted to keep
 *  selectPendingAction at CC <= 10. */
function resolveLonePendingAction(action: PendingActionLike, hint: TargetHint | undefined): ActionTargetResult {
  if (hint?.fragment && fragmentMatches([action], fragmentNeedle(hint.fragment), (a) => a.summary).length === 0) {
    return { ambiguous: true };
  }
  return { id: action.id, summary: action.summary, via: "only" };
}

export function selectPendingAction(
  actions: PendingActionLike[],
  hint: TargetHint | undefined,
): ActionTargetResult {
  if (actions.length === 0) return {};
  if (actions.length === 1) return resolveLonePendingAction(actions[0], hint);

  // Ordinal ("the second one" -> 2; "the last one" -> -1).
  if (hint?.ordinal !== undefined) {
    const idx = ordinalIndex(hint.ordinal, actions.length);
    return idx !== null ? { id: actions[idx].id, summary: actions[idx].summary, via: "ordinal" } : { ambiguous: true };
  }

  // Fragment: a PRESENT by-name signal must match EXACTLY one summary; 0 or >1 -> clarify
  // (never silently resolve the wrong action — same conservative posture as selectApprovalTarget).
  if (hint?.fragment) {
    const matches = fragmentMatches(actions, fragmentNeedle(hint.fragment), (a) => a.summary);
    if (matches.length === 1) return { id: matches[0].id, summary: matches[0].summary, via: "fragment" };
    return { ambiguous: true };
  }

  // >1 pending, no hint -> caller clarifies (reads back the summaries).
  return { ambiguous: true };
}
