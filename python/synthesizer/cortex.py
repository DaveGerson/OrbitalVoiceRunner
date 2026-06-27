"""Cortex decision logic — Increment 4, slice 1 (SHADOW).

A pure, deterministic context-curation decision over a state snapshot. v1 is the IDENTITY
baseline: keep every present tier in input order, no drops, no rerank. Real curation rules are
deferred (bead wsm-e2e-pinned-qky). The job of this slice is to prove the seam + the
decision-trace contract; TypeScript runs this fire-and-forget and LOGS the trace, never applying
the decision (parity). No I/O, no Node coupling, no LLM — Gemini is the brain; this is the
deterministic prosthetic. Spec: docs/superpowers/specs/2026-06-27-python-cortex-shadow-design.md
"""
import json

CORTEX_VERSION = "0.1.0"

# Canonical tier order (matches the synthesizer's tier set). Identity preserves this order.
_TIER_KEYS = ("project", "pane", "breadcrumbs", "board", "frame")


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


def decide(tiers, ctx, now):
    """Return {"decision": {...}, "trace": {...}}. Identity baseline; deterministic.

    `tiers`: the MemoryTiers dict. `ctx`: {activePaneId, sessionId?, trigger}. `now`: epoch-ms.
    Total on a dict/None for either arg; the dispatch wrapper guards any other shape (-> CORTEX_FAILED).
    """
    tiers = tiers or {}
    ctx = ctx or {}
    kept = [k for k in _TIER_KEYS if _present(tiers.get(k))]
    tier_chars = {k: _size_probe(tiers.get(k)) for k in kept}
    decision = {"keep": list(kept), "drop": [], "rerank": []}
    trace = {
        "cortexVersion": CORTEX_VERSION,
        "strategy": "baseline-identity",
        "ruleFired": "baseline-identity",
        "inputs": {
            "activePaneId": ctx.get("activePaneId"),
            "sessionId": ctx.get("sessionId"),
            "trigger": ctx.get("trigger"),
            "tierKeys": list(kept),
            "tierChars": tier_chars,
        },
        "output": {"orderedKeep": list(kept), "dropped": []},
        "ts": now,
    }
    return {"decision": decision, "trace": trace}
