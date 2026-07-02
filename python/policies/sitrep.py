"""sitrep.rank op handler (voice-UX wave 3). Sole owner: hwu1.

rank_sitrep(payload) ranks a SitrepPayload (see src/voice/policyClient.ts) into the SAME fixed
section order the TS fallback (src/voice/sitrep.ts fallbackRanking) uses whenever this daemon is
unavailable: approvals -> busy (+ executing plans) -> attention -> idle. Needs-action first;
urgency within each section; every sort carries a total (id-based) tie-breaker, so the ranking is
100% deterministic and a SITREP reads IDENTICALLY regardless of which side produced it.

  approvals: preserve gather order (already oldest-first -- the TS composer reads the held-
             approval and staged-action stores in their own insertion order; no age/timestamp
             travels in the wire payload to re-derive it from).
  busy:      running panes, longest-elapsed first; tie -> paneId asc. Executing-plan items
             (status running/paused) fold in AFTER the panes, most-progressed first (highest
             currentStepIndex); tie -> plan id asc.
  attention: newest first (smallest ageMs); tie -> paneId asc.
  idle:      non-busy panes, paneId asc (no urgency signal for an idle pane).

A section with no items is OMITTED from the output (rather than emitted with an empty itemIds
list) -- an empty payload therefore ranks to {"sections": []}, matching the daemon-boot stub shape
byte-for-byte (see python/policies/tests/test_dispatch.py's sitrep.rank stub-shape pin). The TS
side (src/voice/sitrep.ts: fallbackRanking/sectionIds) treats a missing key exactly like a present
key with an empty itemIds array, so this omission is invisible to every consumer.
"""


def _busy_pane_ids(panes):
    busy = [p for p in panes if p.get("isBusy")]
    busy.sort(key=lambda p: (-p.get("elapsedMs", 0), p.get("paneId", "")))
    return [p["paneId"] for p in busy]


def _plan_ids(plans):
    ranked = sorted(plans, key=lambda p: (-p.get("currentStepIndex", 0), p.get("id", "")))
    return [p["id"] for p in ranked]


def _attention_ids(attention):
    ranked = sorted(attention, key=lambda a: (a.get("ageMs", 0), a.get("paneId", "")))
    return [a["paneId"] for a in ranked]


def _idle_pane_ids(panes):
    idle = [p for p in panes if not p.get("isBusy")]
    idle.sort(key=lambda p: p.get("paneId", ""))
    return [p["paneId"] for p in idle]


def rank_sitrep(payload):
    panes = payload.get("panes", [])
    approvals = payload.get("approvals", [])
    attention = payload.get("attention", [])
    plans = payload.get("plans", [])

    approval_ids = [a["id"] for a in approvals]
    busy_ids = _busy_pane_ids(panes) + _plan_ids(plans)
    attention_ids = _attention_ids(attention)
    idle_ids = _idle_pane_ids(panes)

    ordered = [
        ("approvals", approval_ids),
        ("busy", busy_ids),
        ("attention", attention_ids),
        ("idle", idle_ids),
    ]
    return {"sections": [{"key": k, "itemIds": ids} for k, ids in ordered if ids]}
