"""focus.resolve op handler (voice-UX wave 3). Sole owner: fz1.

resolve_focus(reference, candidates) scores a spoken reference against the live FocusCandidate set
(token-overlap + substring scoring over name/project/preset, ordinal words, state phrases like
"the stuck one" / "the busy one" / "that one"/"it"). Deterministic: ties break on (score desc,
ordinal asc, paneId asc) so the SAME input always produces the SAME output — the TS facade's
FALLBACK CONTRACT (docs/superpowers/specs/2026-07-02-voice-ux-trio-design.md, D2) depends on this
never being flaky, since a rejected/timed-out call degrades to the TS literal floor instead.

This module is a pure function of its inputs — no state, no I/O. dispatch.py wraps calls to it in
a try/except (any exception -> {"ok": False, "error": {"code": "FOCUS_FAILED", ...}}).
"""

import re

_ORDINAL_WORDS = {
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
}

_STUCK_STATES = {"error", "exited"}

_TOKEN_RE = re.compile(r"[^a-z0-9]+")

_ORDINAL_TOKEN = r"(\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten)"
# WHOLE-REFERENCE match only (mirrors src/voice/focusResolver.ts's ordinalFromReference) — never a
# per-token scan. This matters: "the stuck one" / "the busy one" carry the bare word "one" but must
# NOT be treated as ordinal "1"; only an EXACT bare ordinal or a "pane <ordinal>" phrasing counts.
_ORDINAL_PHRASE_RE = re.compile(r"^(?:the\s+)?pane\s+(?:number\s+)?" + _ORDINAL_TOKEN + r"$")
_BARE_ORDINAL_RE = re.compile(r"^" + _ORDINAL_TOKEN + r"$")


def _tokenize(text):
    if not text:
        return []
    return [t for t in _TOKEN_RE.split(str(text).lower()) if t]


def _ordinal_from_reference(ref_lower):
    m = _ORDINAL_PHRASE_RE.match(ref_lower) or _BARE_ORDINAL_RE.match(ref_lower)
    if not m:
        return None
    tok = m.group(1)
    if tok.isdigit():
        n = int(tok)
        return n if n > 0 else None
    n = _ORDINAL_WORDS.get(tok, 0)
    return n if n > 0 else None


def _name_score(ref_lower, ref_tokens, label):
    """Score how well a single label (pane/project/preset name) matches the reference: an exact
    (whole-string) match scores highest, a substring match next, then partial token overlap."""
    if not label:
        return 0.0
    label_lower = str(label).lower()
    if ref_lower == label_lower:
        return 1.0
    if label_lower in ref_lower or ref_lower in label_lower:
        return 0.75
    label_tokens = set(_tokenize(label))
    if not label_tokens:
        return 0.0
    overlap = len(label_tokens & set(ref_tokens))
    if overlap == 0:
        return 0.0
    return 0.5 * (overlap / len(label_tokens))


def _state_score(ref_lower, candidate):
    """Score state-descriptive phrases: 'the stuck one' (Error/Exited), 'the busy one' (isBusy),
    'the idle one'/'the free one' (not busy, not stuck)."""
    state = str(candidate.get("state") or "").lower()
    if "stuck" in ref_lower and state in _STUCK_STATES:
        return 0.9
    if "busy" in ref_lower and candidate.get("isBusy"):
        return 0.9
    if ("idle" in ref_lower or "free" in ref_lower) and not candidate.get("isBusy") and state not in _STUCK_STATES:
        return 0.6
    return 0.0


def _recency_score(ref_lower, candidate, most_recent_id, active_id):
    """Score 'that one'/'it' phrases: prefer the currently-active pane, else the most-recently-
    active one."""
    if "that one" not in ref_lower and re.search(r"\bit\b", ref_lower) is None:
        return 0.0
    pane_id = candidate.get("paneId")
    if active_id is not None and pane_id == active_id:
        return 0.85
    if pane_id == most_recent_id:
        return 0.8
    return 0.0


def _score_candidate(ref_lower, ref_tokens, ordinal, most_recent_id, active_id, candidate):
    scores = [
        _name_score(ref_lower, ref_tokens, candidate.get("paneName")),
        _name_score(ref_lower, ref_tokens, candidate.get("projectName")) * 0.6,
        _name_score(ref_lower, ref_tokens, candidate.get("presetLabel")) * 0.5,
        _state_score(ref_lower, candidate),
        _recency_score(ref_lower, candidate, most_recent_id, active_id),
    ]
    if ordinal is not None and candidate.get("ordinal") == ordinal:
        scores.append(1.0)
    return max(scores)


def _find_active_and_most_recent(candidates):
    active_id = None
    most_recent_id = None
    best_recent = None
    for c in candidates:
        if c.get("isActive"):
            active_id = c.get("paneId")
        ts = c.get("lastActiveAt") or 0
        if best_recent is None or ts > best_recent:
            best_recent = ts
            most_recent_id = c.get("paneId")
    return active_id, most_recent_id


def resolve_focus(reference, candidates):
    candidates = candidates or []
    if not isinstance(reference, str) or not reference.strip() or not candidates:
        return {"paneId": None, "confidence": 0.0, "alternatives": []}

    ref_lower = reference.strip().lower()
    ref_tokens = _tokenize(reference)
    ordinal = _ordinal_from_reference(ref_lower)
    active_id, most_recent_id = _find_active_and_most_recent(candidates)

    scored = [
        (c, _score_candidate(ref_lower, ref_tokens, ordinal, most_recent_id, active_id, c))
        for c in candidates
    ]
    # Deterministic tie-break: highest score first, then lowest ordinal, then paneId lexically.
    # `ordinal` is defensively coerced: a malformed/hostile candidate (missing, non-numeric, or
    # mixed-type `ordinal`) must never compare a str against an int (TypeError) and crash the whole
    # sort — it just loses tie-break priority (falls back to 0) instead of corrupting every response.
    def _ordinal_key(pair):
        ordinal = pair[0].get("ordinal", 0)
        return ordinal if isinstance(ordinal, (int, float)) and not isinstance(ordinal, bool) else 0

    scored.sort(key=lambda pair: (-pair[1], _ordinal_key(pair), str(pair[0].get("paneId", ""))))

    top_candidate, top_score = scored[0]
    alternatives = [
        {"paneId": c.get("paneId"), "score": round(s, 4)}
        for c, s in scored[1:4]
        if s > 0
    ]

    if top_score <= 0:
        return {"paneId": None, "confidence": 0.0, "alternatives": alternatives}

    return {
        "paneId": top_candidate.get("paneId"),
        "confidence": round(min(top_score, 1.0), 4),
        "alternatives": alternatives,
    }
