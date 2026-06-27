"""Python port of the TS approval-intent parser (Python⇄TS seam, plan task 1.5).

A FAITHFUL port of `src/approvalIntent.ts :: parseApprovalIntent` and its helper tables. The
contract is byte-for-byte output parity with the TypeScript original — canonized by the frozen
golden vectors (`tests/fixtures/approval_intent_golden.json`) that both languages assert against.

Posture (matches the ADR + synth.py): stdlib only, pure, deterministic — NEVER reads the clock,
env, or filesystem. String in, plain-dict out:
    parse_approval_intent("approve the second one")
      -> {"intent": "approve", "targetHint": {"ordinal": 2}}

The output dict mirrors the TS `ParsedApproval` JSON exactly: `targetHint` is OMITTED when there is
no hint (TS returns `undefined`, which `JSON.stringify` drops), and within a hint only the set keys
(`ordinal` / `fragment`) appear. Do NOT "improve" the logic here — corrections to the parser are a
separate, deliberate decision that must land on BOTH sides and re-freeze the vectors.
"""
import re

# ── ASR-friendly normalization ───────────────────────────────────────────────────────────────────
_APOS = re.compile(r"[’'`´]")           # every apostrophe variant -> dropped (don't -> dont)
_NON_ALNUM = re.compile(r"[^a-z0-9\s]")  # punctuation -> space (keeps tokens clean)
_WS = re.compile(r"\s+")


def normalize_utterance(s):
    """lowercase, drop apostrophes, punctuation -> space, collapse whitespace (mirrors the TS)."""
    s = (s or "").lower()
    s = _APOS.sub("", s)
    s = _NON_ALNUM.sub(" ", s)
    s = _WS.sub(" ", s)
    return s.strip()


def _tokenize(s):
    return [t for t in normalize_utterance(s).split(" ") if t]


def _at(tokens, j):
    """Bounds-safe token access (mirrors JS `tokens[j]` returning undefined past the ends)."""
    return tokens[j] if 0 <= j < len(tokens) else None


# ── lexical tables (transcribed verbatim from approvalIntent.ts) ──────────────────────────────────
NEGATORS = {"not", "no", "dont", "never", "cant", "cannot", "wont", "nope"}

BARE_YES = {"yes", "yep", "yeah", "approved", "ok", "okay", "affirmative"}
BARE_NO = {"no", "nope", "nah", "negative"}

APPROVE_STRONG = {"approve", "approved", "accept", "accepted", "confirm", "confirmed", "authorize", "authorized"}
APPROVE_WEAK = {"ok", "okay", "yes", "go", "run", "execute", "proceed", "dispatch", "send"}
REJECT_STRONG = {"reject", "rejected", "deny", "denied", "decline", "discard"}
REJECT_WEAK = {"cancel", "stop", "abort", "skip", "nevermind"}

APPROVE_VERBS = APPROVE_STRONG | APPROVE_WEAK
REJECT_VERBS = REJECT_STRONG | REJECT_WEAK
STRONG_VERBS = APPROVE_STRONG | REJECT_STRONG

OBJECT_TOKENS = {
    "command", "commands", "it", "that", "this", "one", "them", "approval", "the", "request",
    "task", "step", "proposal", "first", "second", "third", "last", "previous", "next",
}

ORDINAL_WORDS = {
    "first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5,
    "sixth": 6, "seventh": 7, "eighth": 8, "ninth": 9, "tenth": 10,
    "last": -1, "latest": -1, "previous": -1,
}

# ── defer phrase tables ──────────────────────────────────────────────────────────────────────────
DEFER_LATER_PRECEDERS = {"me", "again", "it", "that", "them", "you"}
DEFER_HOLD_PARTICLES = {"on", "off", "that", "it", "them"}
DEFER_IN_A_UNITS = {"minute", "moment", "bit", "second", "sec", "while", "few"}
DEFER_FOR_NOW_PAIRS = {"skip", "hold", "wait", "leave", "park", "pass", "not"}


def _negator_before(tokens, i):
    """True when tokens[i-1] is a negator ('dont hold it' must not defer)."""
    return i > 0 and tokens[i - 1] in NEGATORS


# Each clause-N predicate tests whether the defer phrase ANCHORS at token index i.
def _is_defer_later_bigram(tokens, i):
    """(2) '<me|again|it|that|them|you> later'."""
    return _at(tokens, i + 1) == "later" and tokens[i] in DEFER_LATER_PRECEDERS and not _negator_before(tokens, i)


def _is_defer_not_now(tokens, i):
    """(3) 'not now' / 'not yet' / 'not right now'."""
    if tokens[i] != "not":
        return False
    nxt = _at(tokens, i + 1)
    return nxt == "now" or nxt == "yet" or (nxt == "right" and _at(tokens, i + 2) == "now")


def _is_defer_hold(tokens, i):
    """(4) 'hold <on|off|that|it|them>' / 'on hold'."""
    tok = tokens[i]
    nxt = _at(tokens, i + 1)
    if tok == "hold" and nxt is not None and nxt in DEFER_HOLD_PARTICLES and not _negator_before(tokens, i):
        return True
    return tok == "on" and nxt == "hold"


def _is_defer_in_a_unit(tokens, i):
    """(5) 'in a <minute|moment|bit|second|sec|while|few>'."""
    return tokens[i] == "in" and _at(tokens, i + 1) == "a" and _at(tokens, i + 2) in DEFER_IN_A_UNITS


def _is_defer_for_now(tokens, i):
    """(6) 'for now' anchored here, paired with a parking verb ANYWHERE in the utterance."""
    return tokens[i] == "for" and _at(tokens, i + 1) == "now" and any(t in DEFER_FOR_NOW_PAIRS for t in tokens)


_DEFER_CLAUSES = (_is_defer_later_bigram, _is_defer_not_now, _is_defer_hold, _is_defer_in_a_unit, _is_defer_for_now)


def _is_defer_utterance(tokens):
    # (1) A short, directive utterance built around "later".
    if len(tokens) <= 3 and "later" in tokens:
        return True
    for i in range(len(tokens)):
        for clause in _DEFER_CLAUSES:
            if clause(tokens, i):
                return True
    return False


def _is_negated(tokens, i, window=3):
    """True if a trigger verb at index i is negated by a negator within the preceding `window`."""
    for j in range(max(0, i - window), i):
        if tokens[j] in NEGATORS:
            return True
    return False


def _has_nearby_object(tokens, i, window=2):
    """Does a verb at index i have an object token within +/- `window` tokens (explicit pairing)?"""
    for j in range(max(0, i - window), min(len(tokens) - 1, i + window) + 1):
        if j == i:
            continue
        if tokens[j] in OBJECT_TOKENS:
            return True
    return False


# Fragment STOP words: tokens that can never be part of a by-name target fragment.
FRAGMENT_STOP = (
    APPROVE_VERBS | REJECT_VERBS | NEGATORS | OBJECT_TOKENS
    | {
        "to", "i", "want", "we", "lets", "let", "please", "and", "but", "actually", "now",
        "the", "a", "an", "on", "for", "pane", "in", "do", "make", "sure",
        "later", "hold", "wait", "leave", "park", "pass", "minute", "moment", "bit", "second", "sec",
        "while", "few", "yet", "again", "right", "maybe", "ask", "remind", "me",
    }
)


def _extract_ordinal(tokens):
    """The first ordinal word in the stream maps to its number ('the second one' -> 2; 'last' -> -1)."""
    for tok in tokens:
        if tok in ORDINAL_WORDS:
            return ORDINAL_WORDS[tok]
    return None


def _extract_fragment(tokens):
    """The LONGEST run of non-stopword tokens. Stop/ordinal words break a run; the longest run wins."""
    frag = []
    best = []
    for tok in tokens:
        if tok in FRAGMENT_STOP or tok in ORDINAL_WORDS:
            if len(frag) > len(best):
                best = list(frag)
            frag = []
        else:
            frag.append(tok)
    if len(frag) > len(best):
        best = list(frag)
    return " ".join(best) if best else None


def _extract_target_hint(tokens):
    """Ordinal word or a named fragment, or None when neither is present (TS returns undefined)."""
    hint = {}
    ordinal = _extract_ordinal(tokens)
    if ordinal is not None:
        hint["ordinal"] = ordinal
    fragment = _extract_fragment(tokens)
    if fragment:
        hint["fragment"] = fragment
    return hint if hint else None


# The approval-domain verbs NEVER become an inferred reject directive ('dont approve' stays none).
NON_DIRECTIVE_AFTER_NEGATOR = APPROVE_STRONG | {"approve", "approved"}


def _with_hint(intent, hint):
    """Build the result dict, including `targetHint` only when a hint exists (TS drops undefined)."""
    out = {"intent": intent}
    if hint is not None:
        out["targetHint"] = hint
    return out


def _try_bare_skip(tokens):
    """Bare 'skip' / 'skip it|that|this' (<=2 tokens, no 'for now' rider) -> reject, else None."""
    if tokens[0] == "skip" and len(tokens) <= 2 and (len(tokens) == 1 or tokens[1] in ("it", "that", "this")):
        return _with_hint("reject", _extract_target_hint(tokens))
    return None


def _try_bare_yes_no(tokens):
    """Bare short affirmation/denial (<=2 tokens) -> approve/reject/clarify, else None. No targetHint."""
    if len(tokens) > 2:
        return None
    has_yes = any(t in BARE_YES for t in tokens)
    has_no = any(t in BARE_NO for t in tokens)
    if has_yes and not has_no:
        return {"intent": "approve"}
    if has_no and not has_yes:
        return {"intent": "reject"}
    if has_yes and has_no:
        return {"intent": "clarify"}
    return None


def _try_leading_negator_directive(tokens):
    """Contracted negator + ambient ACTION verb ('dont run') -> reject directive (ASR drop), else None."""
    if (
        len(tokens) >= 2
        and tokens[0] in ("dont", "never")
        and tokens[1] in APPROVE_VERBS
        and tokens[1] not in NON_DIRECTIVE_AFTER_NEGATOR
    ):
        return _with_hint("reject", _extract_target_hint(tokens))
    return None


def _verb_pairs(tokens, i, tok):
    """Strong verbs always pair; weak verbs only with a nearby object AND more than verb+pronoun."""
    is_strong = tok in STRONG_VERBS
    return is_strong or (_has_nearby_object(tokens, i) and len(tokens) > 2)


def _scan_verb_votes(tokens):
    """Walk tokens; for each PAIRED, NON-NEGATED approve/reject trigger flag its side."""
    approve = False
    reject = False
    for i, tok in enumerate(tokens):
        is_approve = tok in APPROVE_VERBS
        is_reject = tok in REJECT_VERBS
        if not is_approve and not is_reject:
            continue
        if not _verb_pairs(tokens, i, tok):
            continue
        if _is_negated(tokens, i):
            continue
        if is_approve:
            approve = True
        if is_reject:
            reject = True
    return approve, reject


def parse_approval_intent(transcript):
    """The core parser. String in, ParsedApproval-shaped dict out (see module docstring)."""
    tokens = _tokenize(transcript)
    if not tokens:
        return {"intent": "none"}

    # DEFER is checked FIRST: on mixed signals the NON-destructive verb wins.
    if _is_defer_utterance(tokens):
        return _with_hint("defer", _extract_target_hint(tokens))

    # bare-skip reject -> bare yes/no -> leading-negator reject directive.
    guarded = _try_bare_skip(tokens) or _try_bare_yes_no(tokens) or _try_leading_negator_directive(tokens)
    if guarded:
        return guarded

    approve, reject = _scan_verb_votes(tokens)
    if approve and reject:
        return {"intent": "clarify"}
    if approve:
        return _with_hint("approve", _extract_target_hint(tokens))
    if reject:
        return _with_hint("reject", _extract_target_hint(tokens))
    return {"intent": "none"}
