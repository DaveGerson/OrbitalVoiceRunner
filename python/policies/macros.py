"""macro.match op handler (voice macros, 8fz.6). Sole owner: 8fz.6.

match_macro(utterance, entries) matches a routed utterance against the stored macro phrases:
a NORMALIZED EXACT match wins outright; otherwise a BOUNDED fuzzy match (difflib ratio over the
normalized strings) above a conservative threshold. Deterministic: ties break on (score desc, id
asc) so the SAME input always produces the SAME output — the TS facade's FALLBACK CONTRACT depends
on this never being flaky (a rejected/timed-out call degrades to the TS EXACT floor, never wider).

Normalization MIRRORS src/approvalIntent.ts normalizeUtterance BYTE-FOR-BYTE (lowercase, strip every
apostrophe variant, punctuation/unicode -> space, collapse whitespace) so the Python fuzzy layer and
the TS exact floor agree on the exact-match subset — parity the unit + pytest suites both pin.

This module is a pure function of its inputs — no state, no I/O. dispatch.py wraps calls to it in a
try/except (any exception -> {"ok": False, "error": {"code": "MACRO_FAILED", ...}}), so a hostile
entry can never crash the daemon (it just fails that one request, and the TS floor takes over).
"""

import re
from difflib import SequenceMatcher

# Bounded fuzzy floor: conservative on purpose. A macro phrase must never SHADOW a near-miss command,
# so a low-similarity utterance is a definitive NO-MATCH (the caller does not widen past the TS exact
# floor either). Exact matches score 1.0 and always win.
FUZZY_THRESHOLD = 0.86

_APOS = re.compile("[’'`´]")
_NON_ALNUM = re.compile(r"[^a-z0-9\s]")
_WS = re.compile(r"\s+")


def normalize(text):
    """Mirror of src/approvalIntent.ts normalizeUtterance (see module docstring)."""
    if not isinstance(text, str):
        return ""
    s = text.lower()
    s = _APOS.sub("", s)
    s = _NON_ALNUM.sub(" ", s)
    s = _WS.sub(" ", s)
    return s.strip()


def _score(norm_utter, norm_phrase):
    if not norm_phrase:
        return 0.0
    if norm_utter == norm_phrase:
        return 1.0
    return SequenceMatcher(None, norm_utter, norm_phrase).ratio()


def match_macro(utterance, entries):
    """Return {"id": <macro id | None>, "score": <float>} for the best phrase match."""
    entries = entries or []
    norm_utter = normalize(utterance)
    if not norm_utter or not entries:
        return {"id": None, "score": 0.0}

    scored = []
    for e in entries:
        eid = e.get("id")
        if not isinstance(eid, str):
            continue
        scored.append((eid, _score(norm_utter, normalize(e.get("phrase")))))

    if not scored:
        return {"id": None, "score": 0.0}

    # Deterministic: highest score first, then lowest id lexically (stable tie-break).
    scored.sort(key=lambda pair: (-pair[1], pair[0]))
    best_id, best_score = scored[0]

    # Exact match always resolves; a fuzzy match must clear the conservative threshold.
    if best_score >= 1.0 or best_score >= FUZZY_THRESHOLD:
        return {"id": best_id, "score": round(min(best_score, 1.0), 4)}
    return {"id": None, "score": round(best_score, 4)}
