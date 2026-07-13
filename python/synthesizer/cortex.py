"""Cortex decision logic — Increment 4, Wave 4 (D3 curation profiles + D4 hysteresis).

Replaces the SHADOW slice's `baseline-identity` strategy with a fixed, deterministic,
trigger-aware profile table (D3) plus an externally-fed hysteresis rule (D4). The cortex is the
single logic authority: it owns keep/drop/rerank AND the per-tier char budget; TypeScript is a
renderer. Pure, deterministic, no I/O, no Node coupling, no LLM — Gemini is the brain, this is
the deterministic prosthetic. Every decision is over-documented in the trace. Hostile/malformed
input (empty tiers, unknown trigger, malformed `ctx.history`) NEVER raises — a raise here would
surface as CORTEX_FAILED at the dispatch boundary and the daemon must keep serving other ops.

Spec: docs/superpowers/specs/2026-07-02-cortex-cutover-design.md (D3, D4).
Parent: docs/superpowers/specs/2026-06-27-python-cortex-shadow-design.md (SHADOW scaffold).
"""
import json

CORTEX_VERSION = "0.3.0"

# Canonical tier PRESENCE-CHECK order (matches the synthesizer's tier set). This is NOT the
# render order — each profile below defines its own per-trigger order (D3).
#
# Phase 2 Step 2.1 (docs/superpowers/specs/2026-07-09-agent-exchange-spine.md): "eventFocus" added
# — the background-pane "event focus" block (src/memory/worldModel.ts's getEventFocusTier), only
# ever present when a command-outcome-style trigger names an affected pane. It is APPENDED, not
# inserted, so every existing golden fixture / TIERS_FULL-style test dict that never sets it keeps
# an unaffected `kept0` (the tier is simply never present -> filtered out of every presence check
# below, byte-identical to pre-2.1 behavior).
_TIER_KEYS = ("project", "pane", "breadcrumbs", "board", "frame", "eventFocus")

# Wave 4 D3: the cortex owns the render budget outright (locked 2026-06-25) as a FIXED total,
# not driven by the caller's cfg. Matches DEFAULT_MEMORY_CONFIG.totalBudgetChars in
# src/memory/types.ts.
_TOTAL_BUDGET_CHARS = 4800

# Wave 4 D4 hysteresis constants (docs/superpowers/specs/2026-07-02-cortex-cutover-design.md).
# Named + commented per the "reviewable defaults, not magic numbers" decision.
RESURFACE_FLOOR_DECIDES = 3  # a tier dropped within this many of the most-recent decides stays
                              # suppressed unless a strong trigger (session-start / hash change)
HISTORY_K = 8                # mirrors HISTORY_K in src/memory/types.ts (informational here —
                              # python never enforces ring length, it just reads whatever
                              # ctx.history the TS-owned ring buffer sent)

# Wave 4 D3: fixed, deterministic profile table keyed EXACTLY by the 4 wire triggers
# (CortexWireTrigger in src/memory/types.ts). Each row is (order, caps, dropFirst):
#   order      — render/priority order for this trigger (active-pane-first, outcome-first, ...)
#   caps       — per-tier fraction of _TOTAL_BUDGET_CHARS (each row sums to 1.0)
#   dropFirst  — tiers dropped first on overflow, in the order they are dropped
# A trigger that is not exactly one of these four keys (including non-string/hostile input)
# falls back to the "session-start" row (D3 unknown-trigger fallback) with a trace note — it is
# intentionally never silently treated as some blended/intermediate policy.
#
# Phase 2 Step 2.1: "eventFocus" caps below are ADDITIVE extras on top of the five original
# fractions (which are left completely UNCHANGED — pinned byte-for-byte by
# test_cortex.py::test_*_budget_matches_fixed_fractions_of_4800 and friends). Rows therefore sum
# to MORE than 1.0 when eventFocus is counted, but `_allocate_caps` only ever emits a budget entry
# for tiers actually in `keep` — and eventFocus is only ever "present" (and thus only ever kept)
# when a background-outcome trigger's tiers snapshot actually carries one
# (src/memory/worldModel.ts's getEventFocusTier). Every existing fixture/golden vector never sets
# it, so `keep`/`budget` for those stays byte-identical to pre-2.1 output.
PROFILES = {
    "session-start": {
        "order": ("project", "pane", "eventFocus", "breadcrumbs", "board", "frame"),
        "caps": {"project": 0.40, "pane": 0.30, "breadcrumbs": 0.15, "board": 0.10, "frame": 0.05,
                  "eventFocus": 0.05},
        "dropFirst": (),
    },
    "catch-up": {
        "order": ("project", "pane", "eventFocus", "breadcrumbs", "board", "frame"),
        "caps": {"project": 0.40, "pane": 0.30, "breadcrumbs": 0.15, "board": 0.10, "frame": 0.05,
                  "eventFocus": 0.05},
        "dropFirst": (),
    },
    "pane-switch": {
        "order": ("pane", "project", "breadcrumbs", "board", "eventFocus", "frame"),
        "caps": {"pane": 0.40, "project": 0.25, "breadcrumbs": 0.15, "board": 0.15, "frame": 0.05,
                  "eventFocus": 0.05},
        # eventFocus drops first on a plain pane-switch (the operator explicitly chose a
        # different pane; a stale background event is the least relevant thing here).
        "dropFirst": ("eventFocus", "board", "breadcrumbs"),
    },
    "command-outcome": {
        # eventFocus LEADS: this is the profile a background-outcome trigger actually uses, and
        # the whole reason the block exists is to name the specific pane/event that fired it.
        "order": ("eventFocus", "breadcrumbs", "pane", "board", "project", "frame"),
        "caps": {"breadcrumbs": 0.30, "pane": 0.35, "board": 0.10, "project": 0.20, "frame": 0.05,
                  "eventFocus": 0.25},
        # eventFocus is deliberately absent from dropFirst — never sacrificed first on overflow.
        "dropFirst": ("project", "board"),
    },
}

_ELLIPSIS = "…"


def _present(value):
    """A tier counts as present if it is non-None and non-empty (list/dict/str)."""
    if value is None:
        return False
    if isinstance(value, (list, tuple, dict, str)):
        return len(value) > 0
    return True


def _size_probe(value):
    """Deterministic char-size signal for a tier value (used for overflow detection, not the
    real renderer's byte count)."""
    if value is None:
        return 0
    try:
        return len(json.dumps(value, ensure_ascii=False, sort_keys=True))
    except Exception:
        return len(str(value))


def _apply_exited_pane(tiers, kept):
    """Exited-pane rule (unchanged from v0.2.x): an EXITED active pane is stale, so it is
    dropped BEFORE profile ordering ever sees it — D3: "exited-pane rule stays, applied before
    profile". `kept` is the present-tier list in canonical presence order."""
    pane = (tiers or {}).get("pane")
    if pane and str(pane.get("status", "")).lower() == "exited" and "pane" in kept:
        return [k for k in kept if k != "pane"], ["pane"]
    return list(kept), []


def _profile_for(trigger):
    """Return (profile, label, fellBack) for a wire trigger. Falls back to the session-start
    profile for anything that is not exactly one of the four PROFILES keys, including
    non-string/hostile values (a dict/list trigger is never used as a dict key)."""
    if isinstance(trigger, str) and trigger in PROFILES:
        return PROFILES[trigger], trigger, False
    label = trigger if isinstance(trigger, str) and trigger else "unknown"
    return PROFILES["session-start"], label, True


def _trim_overflow(tiers, keep, profile):
    """If the kept tiers' raw content exceeds the total budget, drop tiers in the profile's
    `dropFirst` order until it fits (or the list is exhausted). When `dropFirst` cannot fit the
    snapshot under budget, no further tiers are dropped — the per-tier caps returned by
    `_allocate_caps` already sum to ~the total budget and bound the actual render regardless
    (D3: "else trim via caps")."""
    keep = list(keep)
    dropped = []
    total = sum(_size_probe(tiers.get(t)) for t in keep)
    for t in profile["dropFirst"]:
        if total <= _TOTAL_BUDGET_CHARS:
            break
        if t in keep:
            keep.remove(t)
            dropped.append(t)
            total -= _size_probe(tiers.get(t))
    return keep, dropped


def _cap_chars(tier, profile):
    """Absolute per-tier char cap: floor(totalBudget * profile fraction)."""
    return int(_TOTAL_BUDGET_CHARS * profile["caps"].get(tier, 0.0))


def _allocate_caps(keep, profile):
    """decision.budget: per-tier char caps for the FINAL kept tiers only (D5 consumes this as
    `plan.caps`)."""
    return {t: _cap_chars(t, profile) for t in keep}


def _collect_suppressed(entry, keep, tier_hashes, suppressed):
    """One `ctx.history` entry's contribution to the hysteresis suppression set. Every shape is
    guarded so a malformed entry is silently ignored, never raised (D3/D4 hostile-input
    contract). A tier is suppressed ONLY when BOTH sides carry a real hash for it and those
    hashes are equal -- if either side has no recorded hash for that tier (a malformed/partial
    entry, or a ctx with no current hash for it), there is no evidence the tier is unchanged, so
    it must NOT be suppressed (`None == None` is not proof of an unchanged hash)."""
    if not isinstance(entry, dict):
        return
    dropped_tiers = entry.get("droppedTiers")
    if not isinstance(dropped_tiers, list):
        return
    entry_hashes = entry.get("tierHashes")
    if not isinstance(entry_hashes, dict):
        entry_hashes = {}
    for t in dropped_tiers:
        if not isinstance(t, str) or t not in keep:
            continue
        prev, cur = entry_hashes.get(t), tier_hashes.get(t)
        # Hash evidence must be a real (non-empty string) hash on BOTH sides -- a missing key,
        # None, "" or any other shape is absence of evidence (None == None is not proof).
        if not (isinstance(prev, str) and prev and isinstance(cur, str) and cur):
            continue
        if cur == prev:
            suppressed.add(t)


def _apply_hysteresis(keep, ctx, session_start_bypass):
    """D4: a tier dropped in the last RESURFACE_FLOOR_DECIDES decides stays dropped unless this
    decide's trigger is session-start (full bypass) or the tier's content hash changed since it
    was dropped (a "strong trigger" override, checked per history entry). `ctx.history` is
    oldest-first (D4 ring buffer); the last RESURFACE_FLOOR_DECIDES entries are the most recent.
    Malformed `ctx.history`/`ctx.tierHashes` are ignored, never raised."""
    if session_start_bypass:
        return list(keep), [], False
    history = ctx.get("history")
    if not isinstance(history, list):
        return list(keep), [], False
    tier_hashes = ctx.get("tierHashes")
    if not isinstance(tier_hashes, dict):
        tier_hashes = {}
    suppressed = set()
    for entry in history[-RESURFACE_FLOOR_DECIDES:]:
        _collect_suppressed(entry, keep, tier_hashes, suppressed)
    if not suppressed:
        return list(keep), [], False
    new_keep = [t for t in keep if t not in suppressed]
    new_drop = [t for t in keep if t in suppressed]
    return new_keep, new_drop, True


def _build_trace(tiers, ctx, now, kept0, tier_chars, keep, drop,
                  exited_drop, overflow_drop, hyst_drop, strategy, hyst_applied, fell_back):
    """Assemble the over-documented decision trace: strategy/ruleFired, raw inputs (unaffected
    by any drop, for observability), and a per-tier `droppedRules` map naming which rule dropped
    each tier — exited-pane, profile overflow trim, or D4 hysteresis."""
    rule_fired = strategy + ("+hysteresis" if hyst_applied else "")
    dropped_rules = {}
    for t in exited_drop:
        dropped_rules[t] = "exited-pane"
    for t in overflow_drop:
        dropped_rules[t] = "overflow-dropfirst"
    for t in hyst_drop:
        dropped_rules[t] = "hysteresis"
    trace = {
        "cortexVersion": CORTEX_VERSION,
        "strategy": strategy,
        "ruleFired": rule_fired,
        "inputs": {
            "activePaneId": ctx.get("activePaneId"),
            "sessionId": ctx.get("sessionId"),
            "trigger": ctx.get("trigger"),
            "tierKeys": list(kept0),
            "tierChars": tier_chars,
        },
        "output": {"orderedKeep": keep, "dropped": drop, "droppedRules": dropped_rules},
        "ts": now,
    }
    # D1: the affected pane a command-outcome trigger is ABOUT. The tiers snapshot has no slot for
    # a non-active pane yet, so the decision cannot act on this beyond the profile table today —
    # but it must not be a silently dead wire (D3: over-document every row). Only added when the
    # caller actually supplied it, so requests that never send it (every existing golden fixture
    # vector) see no new key -- no drift in test_dispatch_golden_parity.
    affected_pane_id = ctx.get("affectedPaneId")
    if affected_pane_id is not None:
        trace["inputs"]["affectedPaneId"] = affected_pane_id
    if fell_back:
        trace["profileFallback"] = "session-start"
    shadow = _shadow_budget(tiers, ctx)
    if shadow is not None:
        trace["shadowBudget"] = shadow
    if drop:
        # Also render over the post-drop tiers so callers can compute actual savings. Pure
        # observation — a render failure yields None and is silently dropped (telemetry only).
        curated_tiers = {k: tiers.get(k) for k in keep}
        shadow_curated = _shadow_budget(curated_tiers, ctx)
        if shadow_curated is not None:
            trace["shadowBudgetCurated"] = shadow_curated
    return trace


def decide(tiers, ctx, now):
    """Return {"decision": {...}, "trace": {...}}. Orchestration only — the actual rules live in
    the helpers above (exited-pane → profile order/overflow → D4 hysteresis).

    `tiers`: the MemoryTiers dict. `ctx`: {activePaneId, sessionId?, trigger, history?,
    tierHashes?, affectedPaneId?}. `now`: epoch-ms. Tolerant of a dict/None for either `tiers`
    or `ctx`; the dispatch wrapper guards any other shape (-> CORTEX_FAILED).
    """
    tiers = tiers or {}
    ctx = ctx or {}
    kept0 = [k for k in _TIER_KEYS if _present(tiers.get(k))]
    tier_chars = {k: _size_probe(tiers.get(k)) for k in kept0}

    exited_keep, exited_drop = _apply_exited_pane(tiers, kept0)

    trigger_raw = ctx.get("trigger")
    profile, trigger_label, fell_back = _profile_for(trigger_raw)

    ordered_keep = [t for t in profile["order"] if t in exited_keep]
    trimmed_keep, overflow_drop = _trim_overflow(tiers, ordered_keep, profile)

    session_start_bypass = trigger_raw == "session-start"
    keep, hyst_drop, hyst_applied = _apply_hysteresis(trimmed_keep, ctx, session_start_bypass)

    drop = exited_drop + overflow_drop + hyst_drop
    decision = {"keep": keep, "drop": drop, "rerank": [], "budget": _allocate_caps(keep, profile)}

    strategy = "profile:%s" % trigger_label
    trace = _build_trace(tiers, ctx, now, kept0, tier_chars, keep, drop,
                          exited_drop, overflow_drop, hyst_drop, strategy, hyst_applied, fell_back)
    return {"decision": decision, "trace": trace}


def _shadow_budget(tiers, ctx):
    """The cortex's own independent renderer allocation, for the trace. Pure observation;
    swallow any failure so a render hiccup never affects the decision (the decision is the
    contract; this is telemetry). Uses canonical default weights — unrelated to the D3 profile
    budget, which is what TS actually applies post-cutover (D5)."""
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
    """Phase 2 Step 2.1: `warnings`/`openTodos` are appended ONLY when present/non-empty (mirrors
    src/memory/assembler.ts's projectBlock) — absent on every pre-2.1 fixture, so this stays
    byte-identical to the un-enriched output for those (test_cortex_parity's oracle)."""
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
    warnings = project.get("warnings") or []
    if warnings:
        body += " | warnings: " + "; ".join(warnings[:3])
    todos = project.get("openTodos") or []
    if todos:
        body += " | todos: " + "; ".join(todos[:3])
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


def _board_entry(e):
    """One BOARD: entry, with the Phase 2 Step 2.1 exchange-state suffix appended only when
    present (mirrors src/memory/assembler.ts's boardBlock)."""
    suffix = ""
    state = e.get("exchangeState")
    if state:
        reason = e.get("waitingReason")
        suffix = "[%s%s]" % (state, (":" + reason) if reason else "")
    return "%s=%s%s" % (e.get("name", ""), e.get("status", ""), suffix)


def _event_focus_block(ef, budget):
    """Phase 2 Step 2.1: the background-pane "event focus" block — mirrors
    src/memory/assembler.ts's eventFocusBlock exactly (same label/format)."""
    state = ef.get("exchangeState")
    reason = ef.get("waitingReason")
    suffix = " (%s%s)" % (state, (": " + reason) if reason else "") if state else ""
    body = "EVENT FOCUS %s%s: %s" % (ef.get("name", ""), suffix, ef.get("eventText", ""))
    return _cap(body, budget)


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

    # Phase 2 Step 2.1: eventFocus is rendered OUTSIDE `_base_budgets`/`_reallocate` on purpose —
    # those two stay untouched 5-tier arithmetic (test_cortex_parity's byte-for-byte oracle
    # depends on it), so eventFocus's budget is a separate, additive fraction of `total` that
    # never perturbs the existing project/pane/breadcrumbs/board/frame allocation. Absent on
    # every pre-2.1 tiers dict, so this whole branch is a no-op for those.
    event_focus = tiers.get("eventFocus")
    if event_focus:
        ef_frac = float(((cfg.get("weights") or {})).get("eventFocus", 0.0))
        body = _event_focus_block(event_focus, int(total * ef_frac))
        per["eventFocus"] = len(body)
        blocks.append(body)

    if crumbs:
        body = _cap("RECENTLY: " + " · ".join(b.get("text", "") for b in crumbs), budgets["breadcrumbs"])
        per["breadcrumbs"] = len(body)
        blocks.append(body)

    if board:
        body = _cap("BOARD: " + ", ".join(_board_entry(e) for e in board), budgets["board"])
        per["board"] = len(body)
        blocks.append(body)

    fbody = _frame_block(frame, budgets["frame"])
    per["frame"] = len(fbody)
    blocks.append(fbody)

    text = "\n".join(blocks)
    if len(text) > total:  # hard guarantee I7 (newline joins can add a few chars over the per-tier caps)
        text = text[:total]
    return {"text": text, "perTierChars": per, "activePaneId": active_id}
