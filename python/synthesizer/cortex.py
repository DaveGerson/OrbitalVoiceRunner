"""Cortex decision logic — Increment 4, slice 1 (SHADOW).

A pure, deterministic context-curation decision over a state snapshot. v1 is the IDENTITY
baseline: keep every present tier in input order, no drops, no rerank. Real curation rules are
deferred (bead wsm-e2e-pinned-qky). The job of this slice is to prove the seam + the
decision-trace contract; TypeScript runs this fire-and-forget and LOGS the trace, never applying
the decision (parity). No I/O, no Node coupling, no LLM — Gemini is the brain; this is the
deterministic prosthetic. Spec: docs/superpowers/specs/2026-06-27-python-cortex-shadow-design.md
"""
import json

CORTEX_VERSION = "0.2.1"

# Canonical tier order (matches the synthesizer's tier set). Identity preserves this order.
_TIER_KEYS = ("project", "pane", "breadcrumbs", "board", "frame")

# ── SHADOW renderer port (Inc 4 slice 2, bead wsm-e2e-pinned-5gv) ─────────────────────────────────
# `synthesize_shadow` is an INDEPENDENT copy of synth.synthesize, proven byte-for-byte equal by
# tests/test_cortex_parity.py. SHADOW-only: TS still injects synth.synthesize's brief and applies
# NOTHING here. This is the SHADOW step of a SHADOW→FLIP→RETIRE migration; synth.py stays the live,
# authoritative path (do NOT modify it) until RETIRE. Dual-maintenance during the window is expected.
# Pure + deterministic: output is a function of (tiers, cfg, now) only. Stdlib only. The decomposition
# mirrors synth.py block-for-block so the two stay easy to diff during the dual-maintenance window.
_ELLIPSIS = "…"


def _present(value):
    """A tier counts as present if it is non-None and non-empty (list/dict/str)."""
    if value is None:
        return False
    if isinstance(value, (list, tuple, dict, str)):
        return len(value) > 0
    return True


def _size_probe(value):
    """Deterministic char-size signal for a tier value (NOT the real renderer — a future budget input)."""
    if value is None:
        return 0
    try:
        return len(json.dumps(value, ensure_ascii=False, sort_keys=True))
    except Exception:
        return len(str(value))


def _apply_rules(tiers, kept):
    """Return (keep, drop, rule). v0.2.0 ladder: exited-pane, else identity.
    `kept` is the present-tier list in canonical order (from decide)."""
    pane = (tiers or {}).get("pane")
    if pane and str(pane.get("status", "")).lower() == "exited" and "pane" in kept:
        keep = [k for k in kept if k != "pane"]
        return keep, ["pane"], "exited-pane"
    return list(kept), [], "baseline-identity"


def decide(tiers, ctx, now):
    """Return {"decision": {...}, "trace": {...}}. Deterministic curation ladder.

    `tiers`: the MemoryTiers dict. `ctx`: {activePaneId, sessionId?, trigger}. `now`: epoch-ms.
    Total on a dict/None for either arg; the dispatch wrapper guards any other shape (-> CORTEX_FAILED).
    """
    tiers = tiers or {}
    ctx = ctx or {}
    kept = [k for k in _TIER_KEYS if _present(tiers.get(k))]
    tier_chars = {k: _size_probe(tiers.get(k)) for k in kept}
    keep, drop, rule = _apply_rules(tiers, kept)
    decision = {"keep": keep, "drop": drop, "rerank": []}
    shadow = _shadow_budget(tiers, ctx)
    trace = {
        "cortexVersion": CORTEX_VERSION,
        "strategy": rule,
        "ruleFired": rule,
        "inputs": {
            "activePaneId": ctx.get("activePaneId"),
            "sessionId": ctx.get("sessionId"),
            "trigger": ctx.get("trigger"),
            "tierKeys": list(kept),
            "tierChars": tier_chars,
        },
        "output": {"orderedKeep": keep, "dropped": drop},
        "ts": now,
    }
    if shadow is not None:
        # Lean observability: the cortex's OWN renderer budget allocation + rendered length (NOT the
        # full text — keep logs small). Additive; TS still log-only. None if the shadow render raised
        # (an observation MUST NOT break the identity decision/trace).
        trace["shadowBudget"] = shadow
    if drop:
        # 0.2.1: also render over the post-drop tiers so callers can compute actual savings.
        # Pure observation — a render failure yields None and is silently dropped (telemetry only).
        curated_tiers = {k: tiers.get(k) for k in keep}
        shadow_curated = _shadow_budget(curated_tiers, ctx)
        if shadow_curated is not None:
            trace["shadowBudgetCurated"] = shadow_curated
    return {"decision": decision, "trace": trace}


def _shadow_budget(tiers, ctx):
    """The cortex's own renderer allocation, for the trace. Pure observation; swallow any failure so a
    render hiccup never affects the identity decision (the decision is the contract; this is telemetry).
    `cfg` for the shadow render uses the canonical defaults — observeCortexShadow has no cfg in hand."""
    try:
        brief = synthesize_shadow(tiers or {}, ctx.get("cfg") or {}, ctx.get("ts") or 0)
        return {"perTierChars": brief["perTierChars"], "textLen": len(brief["text"])}
    except Exception:
        return None


# ─────────────────────────────────────────────────────────────────────────────────────────────────
# Renderer port — independent reproduction of synth.synthesize. Helpers mirror synth.py 1:1.
# ─────────────────────────────────────────────────────────────────────────────────────────────────

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


def _base_budgets(cfg):
    """Per-tier char budgets from the config weights (synth.synthesize lines 72-80)."""
    total = int(cfg.get("totalBudgetChars", 4800))
    w = cfg.get("weights", {}) or {}
    return total, {
        "project": int(total * float(w.get("project", 0.40))),
        "pane": int(total * float(w.get("pane", 0.30))),
        "breadcrumbs": int(total * float(w.get("breadcrumbs", 0.15))),
        "board": int(total * float(w.get("board", 0.10))),
        "frame": int(total * float(w.get("frame", 0.05))),
    }


def _reallocate(base, project, pane, crumbs, board):
    """Budget from absent/empty tiers flows to the active pane (70%) + project (30%) — synth 89-103."""
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
    return budgets


def _project_block(project, budget):
    name = project.get("name", "")
    summary = _salient_summary(
        project.get("summary", ""), project.get("keyTerms"),
        max(0, budget - len(name) - 16),
    )
    body = "PROJECT %s: %s" % (name, summary)
    terms = project.get("keyTerms") or []
    if terms:
        body += " | terms: " + ", ".join(terms)
    decisions = project.get("recentDecisions") or []
    if decisions:
        body += " | decisions: " + "; ".join(decisions[:3])
    return _cap(body, budget)


def _pane_block(pane, budget):
    body = "ACTIVE PANE %s (%s, %s)" % (
        pane.get("name", ""), pane.get("status", ""), pane.get("runtimeType", ""))
    if pane.get("lastCommand"):
        body += " last: %s" % pane["lastCommand"]
    recent = pane.get("recent") or []
    if recent:
        body += " | recent: " + "; ".join(recent[:6])
    return _cap(body, budget)


def _frame_block(frame, budget):
    fbody = "FRAME %s | gates: %s" % (frame.get("role", ""), frame.get("gatePosture", ""))
    prefs = frame.get("prefs") or []
    if prefs:
        fbody += " | prefs: " + "; ".join(prefs)
    return _cap(fbody, budget)


def synthesize_shadow(tiers, cfg, now):
    """Independent SHADOW reproduction of synth.synthesize — byte-for-byte equal (test_cortex_parity).

    Returns {"text", "perTierChars", "activePaneId"}. `now` is accepted for contract symmetry; the
    output does not depend on it (breadcrumb decay was already applied upstream). NEVER applied by TS.
    """
    total, base = _base_budgets(cfg)

    project = tiers.get("project")
    pane = tiers.get("pane")
    crumbs = _dedupe_breadcrumbs(tiers.get("breadcrumbs"))
    active_id = pane.get("paneId") if pane else None
    board = _rank_board(tiers.get("board"), active_id)
    frame = tiers.get("frame") or {}

    budgets = _reallocate(base, project, pane, crumbs, board)

    per = {}
    blocks = []

    if project:
        body = _project_block(project, budgets["project"])
        per["project"] = len(body)
        blocks.append(body)

    if pane:
        body = _pane_block(pane, budgets["pane"])
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

    fbody = _frame_block(frame, budgets["frame"])
    per["frame"] = len(fbody)
    blocks.append(fbody)

    text = "\n".join(blocks)
    if len(text) > total:  # hard guarantee I7 (newline joins can add a few chars over the per-tier caps)
        text = text[:total]
    return {"text": text, "perTierChars": per, "activePaneId": active_id}
