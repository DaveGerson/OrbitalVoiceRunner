"""Pure adaptive-extractive context synthesizer (Janus P0b, decision D2).

Stdlib only. Deterministic: the output is a pure function of (tiers, cfg, now).
NEVER reads the clock, env, or filesystem (invariant I6). `now` is accepted for
contract symmetry but breadcrumb decay was already applied in TypeScript.

`tiers` is the already-redacted MemoryTiers struct (invariant I5) — this module
performs NO redaction and is never handed raw text.
"""

SYNTH_VERSION = "1.0.0"
_ELLIPSIS = "…"


def _cap(s, n):
    if n <= 0:
        return ""
    if len(s) <= n:
        return s
    return s[: max(0, n - 1)] + _ELLIPSIS


def _norm(s):
    return " ".join((s or "").lower().split())


def _salient_summary(summary, key_terms, budget):
    """Keep the first sentence plus any sentence mentioning a key term, in order."""
    if not summary or budget <= 0:
        return ""
    parts = [p.strip() for p in summary.replace("\n", " ").split(". ") if p.strip()]
    if not parts:
        return _cap(summary, budget)
    terms = [t.lower() for t in (key_terms or [])]
    chosen = [parts[0]]
    for p in parts[1:]:
        pl = p.lower()
        if any(t in pl for t in terms):
            chosen.append(p)
    text = ". ".join(chosen)
    if not text.endswith("."):
        text += "."
    return _cap(text, budget)


def _dedupe_breadcrumbs(crumbs):
    seen = set()
    out = []
    for b in crumbs or []:
        key = _norm(b.get("text", ""))
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(b)
    return out


def _rank_board(board, active_id):
    def keep(e):
        return str(e.get("status", "")).lower() not in ("idle", "exited")

    filtered = [e for e in (board or []) if keep(e)]

    def rank(e):
        running = 0 if str(e.get("status", "")).lower() == "running" else 1
        return (0 if e.get("paneId") == active_id else 1, running)

    return sorted(filtered, key=rank)  # stable: ties keep input order ⇒ deterministic


def synthesize(tiers, cfg, now):
    total = int(cfg.get("totalBudgetChars", 4800))
    w = cfg.get("weights", {}) or {}
    base = {
        "project": int(total * float(w.get("project", 0.40))),
        "pane": int(total * float(w.get("pane", 0.30))),
        "breadcrumbs": int(total * float(w.get("breadcrumbs", 0.15))),
        "board": int(total * float(w.get("board", 0.10))),
        "frame": int(total * float(w.get("frame", 0.05))),
    }

    project = tiers.get("project")
    pane = tiers.get("pane")
    crumbs = _dedupe_breadcrumbs(tiers.get("breadcrumbs"))
    active_id = pane.get("paneId") if pane else None
    board = _rank_board(tiers.get("board"), active_id)
    frame = tiers.get("frame") or {}

    # Adaptive reallocation: budget from absent/empty tiers flows to the active pane (70%) + project (30%).
    present = {"frame"}
    if project:
        present.add("project")
    if pane:
        present.add("pane")
    if crumbs:
        present.add("breadcrumbs")
    if board:
        present.add("board")
    freed = sum(base[t] for t in base if t not in present)
    budgets = dict(base)
    add_pane = (freed * 7) // 10
    budgets["pane"] += add_pane
    budgets["project"] += freed - add_pane

    per = {}
    blocks = []

    if project:
        name = project.get("name", "")
        summary = _salient_summary(
            project.get("summary", ""), project.get("keyTerms"),
            max(0, budgets["project"] - len(name) - 16),
        )
        body = "PROJECT %s: %s" % (name, summary)
        terms = project.get("keyTerms") or []
        if terms:
            body += " | terms: " + ", ".join(terms)
        decisions = project.get("recentDecisions") or []
        if decisions:
            body += " | decisions: " + "; ".join(decisions[:3])
        body = _cap(body, budgets["project"])
        per["project"] = len(body)
        blocks.append(body)

    if pane:
        body = "ACTIVE PANE %s (%s, %s)" % (
            pane.get("name", ""), pane.get("status", ""), pane.get("runtimeType", ""))
        if pane.get("lastCommand"):
            body += " last: %s" % pane["lastCommand"]
        recent = pane.get("recent") or []
        if recent:
            body += " | recent: " + "; ".join(recent[:6])
        body = _cap(body, budgets["pane"])
        per["pane"] = len(body)
        blocks.append(body)

    if crumbs:
        body = _cap("RECENTLY: " + " · ".join(b.get("text", "") for b in crumbs), budgets["breadcrumbs"])
        per["breadcrumbs"] = len(body)
        blocks.append(body)

    if board:
        body = _cap(
            "BOARD: " + ", ".join("%s=%s" % (e.get("name", ""), e.get("status", "")) for e in board),
            budgets["board"])
        per["board"] = len(body)
        blocks.append(body)

    fbody = "FRAME %s | gates: %s" % (frame.get("role", ""), frame.get("gatePosture", ""))
    prefs = frame.get("prefs") or []
    if prefs:
        fbody += " | prefs: " + "; ".join(prefs)
    fbody = _cap(fbody, budgets["frame"])
    per["frame"] = len(fbody)
    blocks.append(fbody)

    text = "\n".join(blocks)
    if len(text) > total:  # hard guarantee I7 (newline joins can add a few chars over the per-tier caps)
        text = text[:total]
    return {"text": text, "perTierChars": per, "activePaneId": active_id}
