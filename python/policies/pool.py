"""pool.plan op handler (z5c design, spec 2026-07-07-z5c-session-pool-design.md D3).

Python DECIDES per-project session-pool membership; TypeScript keeps all socket I/O and the
proven reconnect mechanics (decision record 5). This module is a PURE function of its input
snapshot — no state, no I/O, no clock reads of its own (the caller passes `now`). Deterministic:
an identical snapshot always yields an identical plan (D3's "pure" requirement) so the daemon
never needs to be treated as a source of randomness/flakiness by the TS fail-closed floor (D6).

Request shape (dispatch.py's "pool.plan" op):
    { id, v, op: "pool.plan", snapshot, now }
    snapshot = {
        projects: [projectId, ...],           # every project KNOWN to the pool right now
        foregroundProjectId: projectId | None, # the operator's current active project
        hotSlotBudget: int,                    # K — additional hot-warm slots beyond foreground
        entries: {
            projectId: {
                state: "hot-foreground" | "hot-warm" | "handle" | "cold",
                handleAgeMs: number | None,     # ms since the persisted resume handle was stored
                handleTtlMs: number | None,     # the TTL that handle must be compared against
                lastEventAtMs: number | None,
                lastSwitchAtMs: number | None,
            },
            ...
        },
    }

Response (dispatch.py wraps this into the NDJSON envelope):
    { plan: { foregroundProjectId, hotSlots: [projectId, ...],
              actions: [{ type, projectId, reason }, ...] },
      trace: {...} }

v1 policy (deliberately boring per D3 — "the seam and trace are the product"):
  - The foreground project (if any) always holds a hot slot.
  - The K=hotSlotBudget MOST RECENTLY SWITCHED-TO other known projects (LRU over lastSwitchAtMs,
    ties broken by projectId for determinism) also hold hot slots.
  - A project that should be hot but isn't yet: action "resume" (fresh persisted handle, per
    handleAgeMs <= handleTtlMs) or "fresh" (no usable handle).
  - A project that IS hot but falls outside the LRU window: action "demote".
  - A project with an entry that no longer appears in `projects` (project deleted): action
    "evict" — matches D3's "evict handle-tier entries only on project deletion".

Hostile input (empty snapshot, missing/malformed required fields) raises ValueError/TypeError/
KeyError; dispatch.py's try/except turns that into `{"ok": False, "error": {"code":
"POOL_FAILED", ...}}` and the daemon survives to answer the next request (D8). Unknown EXTRA
fields on the snapshot or on an individual entry are ignored (forward-compat, mirrors the
voiceUx settings PUT idiom elsewhere in this codebase) — they are not treated as hostile.
"""

_VALID_STATES = ("hot-foreground", "hot-warm", "handle", "cold")


def _require_list_of_str(value, field_name):
    if not isinstance(value, list) or any(not isinstance(x, str) for x in value):
        raise ValueError("snapshot.%s must be a list of project id strings" % field_name)
    return value


def _require_dict(value, field_name):
    if not isinstance(value, dict):
        raise ValueError("snapshot.%s must be an object" % field_name)
    return value


def _require_number(value, field_name):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("snapshot.%s must be a number" % field_name)
    return value


def _entry_last_switch(entries, project_id):
    entry = entries.get(project_id)
    if not isinstance(entry, dict):
        return -1.0
    v = entry.get("lastSwitchAtMs")
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else -1.0


def _entry_state(entries, project_id):
    entry = entries.get(project_id)
    if not isinstance(entry, dict):
        return "cold"
    state = entry.get("state")
    return state if state in _VALID_STATES else "cold"


def _has_fresh_handle(entries, project_id):
    entry = entries.get(project_id)
    if not isinstance(entry, dict):
        return False
    age = entry.get("handleAgeMs")
    ttl = entry.get("handleTtlMs")
    if not isinstance(age, (int, float)) or isinstance(age, bool):
        return False
    if not isinstance(ttl, (int, float)) or isinstance(ttl, bool):
        return False
    return 0 <= age <= ttl


def _validate_snapshot(snapshot):
    if not isinstance(snapshot, dict) or not snapshot:
        raise ValueError("snapshot must be a non-empty object")
    projects = _require_list_of_str(snapshot.get("projects"), "projects")
    foreground = snapshot.get("foregroundProjectId")
    if foreground is not None and not isinstance(foreground, str):
        raise ValueError("snapshot.foregroundProjectId must be a string or null")
    hot_budget = _require_number(snapshot.get("hotSlotBudget"), "hotSlotBudget")
    if hot_budget < 0:
        raise ValueError("snapshot.hotSlotBudget must be >= 0")
    entries = _require_dict(snapshot.get("entries"), "entries")
    for key, val in entries.items():
        if not isinstance(key, str) or not isinstance(val, dict):
            raise ValueError("snapshot.entries must map project id strings to objects")
    return projects, foreground, int(hot_budget), entries


def plan_pool(snapshot):
    """Compute the deterministic v1 pool plan. Raises on hostile/malformed input (see module
    docstring) — the caller (dispatch.py) is responsible for catching that into POOL_FAILED."""
    projects, foreground, hot_budget, entries = _validate_snapshot(snapshot)
    known = set(projects)

    candidates = [p for p in projects if p != foreground]
    candidates_sorted = sorted(
        candidates,
        key=lambda p: (-_entry_last_switch(entries, p), p),
    )
    warm = candidates_sorted[:hot_budget]
    hot_slots = ([foreground] if foreground else []) + warm
    hot_set = set(hot_slots)

    actions = []
    for project_id in projects:
        state = _entry_state(entries, project_id)
        if project_id in hot_set:
            if state not in ("hot-foreground", "hot-warm"):
                fresh = _has_fresh_handle(entries, project_id)
                actions.append({
                    "type": "resume" if fresh else "fresh",
                    "projectId": project_id,
                    "reason": "fresh persisted handle within TTL" if fresh else "no usable handle — starts a new session",
                })
        else:
            if state in ("hot-foreground", "hot-warm"):
                actions.append({
                    "type": "demote",
                    "projectId": project_id,
                    "reason": "outside the LRU hot-slot budget",
                })

    # D3: evict handle-tier entries only on project deletion — an entry present in `entries` but
    # absent from the current `projects` list means the project itself was deleted.
    for project_id in entries.keys():
        if project_id not in known:
            actions.append({
                "type": "evict",
                "projectId": project_id,
                "reason": "project no longer exists",
            })

    plan = {
        "foregroundProjectId": foreground,
        "hotSlots": hot_slots,
        "actions": actions,
    }
    trace = {
        "policy": "v1-lru",
        "hotSlotBudget": hot_budget,
        "candidatesConsidered": candidates_sorted,
        "warmChosen": warm,
    }
    return {"plan": plan, "trace": trace}
