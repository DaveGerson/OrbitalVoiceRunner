import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import sitrep  # noqa: E402


def pane(pane_id, is_busy, elapsed_ms=0):
    return {
        "paneId": pane_id,
        "projectId": "p1",
        "name": pane_id,
        "state": "Running" if is_busy else "Idle",
        "isBusy": is_busy,
        "elapsedMs": elapsed_ms,
        "lastCommand": None,
    }


def approval(id_, kind="agent_instruction", pane_id="a", summary="do it"):
    return {"id": id_, "kind": kind, "paneId": pane_id, "summary": summary}


def attention(pane_id, age_ms, type_="error", message="oops"):
    return {"paneId": pane_id, "type": type_, "message": message, "ageMs": age_ms}


def plan(id_, current_step_index, total_steps=5, status="running"):
    return {
        "id": id_,
        "name": id_,
        "status": status,
        "currentStepIndex": current_step_index,
        "totalSteps": total_steps,
    }


class RankSitrepTest(unittest.TestCase):
    def test_empty_payload_yields_no_sections(self):
        # Empty sections are OMITTED (not emitted with an empty itemIds list) -- this exact shape
        # is pinned by python/policies/tests/test_dispatch.py's sitrep.rank stub-shape assertion,
        # which this real implementation must keep matching for an empty payload.
        r = sitrep.rank_sitrep({"now": 0, "panes": [], "approvals": [], "attention": [], "plans": []})
        self.assertEqual(r, {"sections": []})

    def test_partial_payload_only_emits_nonempty_sections_in_fixed_order(self):
        payload = {
            "now": 0,
            "panes": [pane("p-idle", False)],
            "approvals": [],
            "attention": [attention("p-idle", age_ms=10)],
            "plans": [],
        }
        r = sitrep.rank_sitrep(payload)
        keys = [s["key"] for s in r["sections"]]
        # relative order among the sections that ARE present still follows the fixed priority.
        self.assertEqual(keys, ["attention", "idle"])

    def test_approvals_preserve_gather_order(self):
        payload = {
            "now": 0,
            "panes": [],
            "approvals": [approval("a1"), approval("a2"), approval("a3")],
            "attention": [],
            "plans": [],
        }
        r = sitrep.rank_sitrep(payload)
        approvals_section = next(s for s in r["sections"] if s["key"] == "approvals")
        self.assertEqual(approvals_section["itemIds"], ["a1", "a2", "a3"])

    def test_busy_panes_ranked_longest_elapsed_first_with_id_tiebreak(self):
        payload = {
            "now": 0,
            "panes": [
                pane("p-mid", True, elapsed_ms=30000),
                pane("p-long", True, elapsed_ms=90000),
                pane("p-idle", False, elapsed_ms=5000),
                pane("p-tie-b", True, elapsed_ms=1000),
                pane("p-tie-a", True, elapsed_ms=1000),
            ],
            "approvals": [],
            "attention": [],
            "plans": [],
        }
        r = sitrep.rank_sitrep(payload)
        busy = next(s for s in r["sections"] if s["key"] == "busy")
        # longest elapsed first; the two 1000ms-tied panes break by paneId ascending.
        self.assertEqual(busy["itemIds"], ["p-long", "p-mid", "p-tie-a", "p-tie-b"])

    def test_executing_plans_fold_into_busy_after_panes_most_progressed_first(self):
        # rank_sitrep does not itself filter by status -- the TS composer only ever includes
        # running/paused plans in the payload it builds, so only such plans appear here.
        payload = {
            "now": 0,
            "panes": [pane("p1", True, elapsed_ms=500)],
            "approvals": [],
            "attention": [],
            "plans": [plan("plan-behind", current_step_index=1), plan("plan-ahead", current_step_index=4)],
        }
        r = sitrep.rank_sitrep(payload)
        busy = next(s for s in r["sections"] if s["key"] == "busy")
        self.assertEqual(busy["itemIds"], ["p1", "plan-ahead", "plan-behind"])

    def test_attention_ranked_newest_first_smallest_age_with_id_tiebreak(self):
        payload = {
            "now": 0,
            "panes": [],
            "approvals": [],
            "attention": [
                attention("p-old", age_ms=60000),
                attention("p-new", age_ms=1000),
                attention("p-tie-b", age_ms=5000),
                attention("p-tie-a", age_ms=5000),
            ],
            "plans": [],
        }
        r = sitrep.rank_sitrep(payload)
        att = next(s for s in r["sections"] if s["key"] == "attention")
        self.assertEqual(att["itemIds"], ["p-new", "p-tie-a", "p-tie-b", "p-old"])

    def test_idle_panes_ranked_by_pane_id_ascending(self):
        payload = {
            "now": 0,
            "panes": [pane("p-z", False), pane("p-a", False), pane("p-busy", True, 10)],
            "approvals": [],
            "attention": [],
            "plans": [],
        }
        r = sitrep.rank_sitrep(payload)
        idle = next(s for s in r["sections"] if s["key"] == "idle")
        self.assertEqual(idle["itemIds"], ["p-a", "p-z"])

    def test_deterministic_across_repeated_calls(self):
        payload = {
            "now": 0,
            "panes": [pane("p1", True, 100), pane("p2", False)],
            "approvals": [approval("a1")],
            "attention": [attention("p1", 10)],
            "plans": [plan("pl1", 2)],
        }
        first = sitrep.rank_sitrep(payload)
        second = sitrep.rank_sitrep(payload)
        self.assertEqual(first, second)


if __name__ == "__main__":
    unittest.main()
