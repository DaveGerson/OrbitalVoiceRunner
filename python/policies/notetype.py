"""note.classify op handler (typed-note capture, hwu.3). Sole owner: hwu.3.

classify_note(text) maps a note's text to ONE NoteType the ledger stores. It may emit ONLY the
four-value SUBSET decision|todo|warning|note (src/store/types.ts NoteType is
decision|todo|warning|note|handoff) — it must NEVER emit "handoff" or any value outside the set, which
would corrupt the typed-note taxonomy hwu.4 (promotion) and hwu.5 (typed-note filter) build on.

Pure + DETERMINISTIC: a fixed keyword precedence over the normalized text, no state, no I/O, no
randomness — the SAME input always yields the SAME type. That determinism is load-bearing: the TS
facade's FALLBACK CONTRACT degrades to a fixed default ('note') on any daemon miss, so a flaky
classifier would silently drift the taxonomy.

PRECEDENCE (highest signal first): warning > decision > todo > note. Hazards surface first (a note
that both flags a risk AND proposes an action is filed as a warning); an explicit decision beats a
to-do; anything with no cue is a plain note.

Normalization MIRRORS macros.normalize / src/approvalIntent.ts normalizeUtterance (lowercase, strip
apostrophes, non-alnum -> space, collapse whitespace) so cue matching is punctuation-insensitive.

dispatch.py wraps calls in try/except (any exception -> {"ok": False, "error": {"code":
"NOTETYPE_FAILED", ...}}), so a hostile payload can never crash the daemon — it fails that one request
and the TS client falls open to 'note'.
"""

import re

_APOS = re.compile("[’'`´]")
_NON_ALNUM = re.compile(r"[^a-z0-9\s]")
_WS = re.compile(r"\s+")

# Hazards / cautions — highest precedence (surface risks first). Deliberately unambiguous words.
_WARNING = re.compile(
    r"\b(warning|warn|careful|caution|risk|risky|danger|dangerous|broken|breaks|break|"
    r"fail|fails|failing|failed|error|bug|beware|regress|regression|heads up|watch out|hazard)\b"
)
# An explicit choice / conclusion.
_DECISION = re.compile(
    r"\b(decided|decision|decide|agreed|agree|go with|going with|lets go with|lets use|"
    r"well use|chose|choose|chosen|settled on|the plan is)\b"
)
# An action item / reminder.
_TODO = re.compile(
    r"\b(todo|to do|need to|needs to|remember to|follow up|action item|next step|make sure|"
    r"dont forget|must|should|have to|task|gotta)\b"
)


def normalize(text):
    """Mirror of macros.normalize (see module docstring)."""
    if not isinstance(text, str):
        return ""
    s = text.lower()
    s = _APOS.sub("", s)
    s = _NON_ALNUM.sub(" ", s)
    s = _WS.sub(" ", s)
    return s.strip()


def classify_note(text):
    """Return one of "decision" | "todo" | "warning" | "note" for the note text."""
    norm = normalize(text)
    if not norm:
        return "note"
    if _WARNING.search(norm):
        return "warning"
    if _DECISION.search(norm):
        return "decision"
    if _TODO.search(norm):
        return "todo"
    return "note"
