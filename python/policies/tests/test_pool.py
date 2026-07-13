"""pool.plan tests (z5c design D3/D8). Uses the same directory-unique dispatch loader as
test_policies_dispatch.py (bead wsm-e2e-pinned-f2om — pytest collects python/policies/tests
alongside python/synthesizer/tests in one process; both dirs have their own dispatch.py)."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from _policies_dispatch_loader import load_dispatch  # noqa: E402
from pool import plan_pool  # noqa: E402

dispatch = load_dispatch()


def _snapshot(**overrides):
    base = {
        "projects": ["a", "b", "c"],
        "foregroundProjectId": "a",
        "hotSlotBudget": 1,
        "entries": {
            "a": {"state": "hot-foreground", "lastSwitchAtMs": 300, "handleAgeMs": None, "handleTtlMs": None},
            "b": {"state": "handle", "lastSwitchAtMs": 200, "handleAgeMs": 1000, "handleTtlMs": 3_600_000},
            "c": {"state": "handle", "lastSwitchAtMs": 100, "handleAgeMs": 10_000_000, "handleTtlMs": 3_600_000},
        },
    }
    base.update(overrides)
    return base


class PlanPoolPureTest(unittest.TestCase):
    def test_deterministic_for_identical_input(self):
        s = _snapshot()
        r1 = plan_pool(s)
        r2 = plan_pool(s)
        self.assertEqual(r1, r2)

    def test_foreground_always_hot_plus_lru_warm_pick(self):
        r = plan_pool(_snapshot())
        # b switched more recently than c -> b wins the single warm slot.
        self.assertEqual(r["plan"]["foregroundProjectId"], "a")
        self.assertEqual(r["plan"]["hotSlots"], ["a", "b"])

    def test_resume_action_when_fresh_handle_exists(self):
        r = plan_pool(_snapshot())
        actions_by_project = {a["projectId"]: a for a in r["plan"]["actions"]}
        self.assertEqual(actions_by_project["b"]["type"], "resume")

    def test_fresh_action_when_no_usable_handle(self):
        s = _snapshot(hotSlotBudget=2)  # bring c into the hot set too (no fresh handle -> "fresh")
        r = plan_pool(s)
        actions_by_project = {a["projectId"]: a for a in r["plan"]["actions"]}
        self.assertEqual(actions_by_project["c"]["type"], "fresh")

    def test_already_hot_projects_produce_no_promote_action(self):
        r = plan_pool(_snapshot())
        actions_by_project = {a["projectId"]: a for a in r["plan"]["actions"]}
        self.assertNotIn("a", actions_by_project)  # already hot-foreground -> no action needed

    def test_demote_when_a_hot_project_falls_outside_the_lru_window(self):
        s = _snapshot(hotSlotBudget=0)
        s["entries"]["b"]["state"] = "hot-warm"  # b was hot but budget shrank to 0
        r = plan_pool(s)
        self.assertEqual(r["plan"]["hotSlots"], ["a"])
        actions_by_project = {a["projectId"]: a for a in r["plan"]["actions"]}
        self.assertEqual(actions_by_project["b"]["type"], "demote")

    def test_evict_only_fires_for_a_deleted_project(self):
        s = _snapshot(projects=["a", "b"])  # "c" entry stays but its project is gone
        r = plan_pool(s)
        actions_by_project = {a["projectId"]: a for a in r["plan"]["actions"]}
        self.assertEqual(actions_by_project["c"]["type"], "evict")

    def test_zero_hot_slot_budget_means_handle_tier_only(self):
        s = _snapshot(hotSlotBudget=0)
        r = plan_pool(s)
        self.assertEqual(r["plan"]["hotSlots"], ["a"])

    def test_no_foreground_project_is_tolerated(self):
        s = _snapshot(foregroundProjectId=None)
        r = plan_pool(s)
        self.assertIsNone(r["plan"]["foregroundProjectId"])
        self.assertNotIn(None, r["plan"]["hotSlots"])

    def test_trace_is_present_and_over_documents_the_decision(self):
        r = plan_pool(_snapshot())
        self.assertIn("trace", r)
        self.assertEqual(r["trace"]["policy"], "v1-lru")
        self.assertEqual(r["trace"]["hotSlotBudget"], 1)

    def test_ties_break_deterministically_by_project_id(self):
        s = _snapshot(hotSlotBudget=1)
        s["entries"]["b"]["lastSwitchAtMs"] = 100
        s["entries"]["c"]["lastSwitchAtMs"] = 100  # exact tie with b
        r = plan_pool(s)
        self.assertEqual(r["plan"]["hotSlots"], ["a", "b"])  # "b" < "c" lexicographically

    # ── hostile input: never raises out of plan_pool's caller (dispatch.handle) ──────────────
    def test_unknown_extra_fields_are_ignored_not_hostile(self):
        s = _snapshot()
        s["somethingFromANewerClient"] = {"whatever": True}
        s["entries"]["a"]["somethingNew"] = 123
        r = plan_pool(s)  # must not raise
        self.assertEqual(r["plan"]["foregroundProjectId"], "a")

    def test_empty_snapshot_raises(self):
        with self.assertRaises(ValueError):
            plan_pool({})

    def test_missing_required_field_raises(self):
        with self.assertRaises(ValueError):
            plan_pool({"projects": ["a"], "foregroundProjectId": "a"})  # no hotSlotBudget/entries

    def test_malformed_entries_type_raises(self):
        s = _snapshot()
        s["entries"] = "not-a-dict"
        with self.assertRaises(ValueError):
            plan_pool(s)

    def test_malformed_individual_entry_raises(self):
        s = _snapshot()
        s["entries"]["a"] = "not-a-dict-either"
        with self.assertRaises(ValueError):
            plan_pool(s)

    def test_negative_hot_slot_budget_raises(self):
        s = _snapshot(hotSlotBudget=-1)
        with self.assertRaises(ValueError):
            plan_pool(s)

    def test_non_string_project_list_raises(self):
        s = _snapshot(projects=["a", 42])
        with self.assertRaises(ValueError):
            plan_pool(s)


class DispatchPoolPlanTest(unittest.TestCase):
    def test_pool_plan_ok_shape(self):
        r = dispatch.handle({"id": "p1", "v": 1, "op": "pool.plan", "snapshot": _snapshot()})
        self.assertTrue(r["ok"])
        self.assertEqual(r["plan"]["foregroundProjectId"], "a")
        self.assertIn("trace", r)

    def test_pool_plan_hostile_snapshot_never_crashes_the_dispatcher(self):
        r = dispatch.handle({"id": "p2", "v": 1, "op": "pool.plan", "snapshot": {}})
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"]["code"], "POOL_FAILED")

    def test_pool_plan_missing_snapshot_key_never_crashes_the_dispatcher(self):
        r = dispatch.handle({"id": "p3", "v": 1, "op": "pool.plan"})
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"]["code"], "POOL_FAILED")

    def test_daemon_survives_a_pool_failure_and_answers_the_next_op(self):
        bad = dispatch.handle({"id": "p4", "v": 1, "op": "pool.plan", "snapshot": None})
        self.assertFalse(bad["ok"])
        ping = dispatch.handle({"id": "p5", "v": 1, "op": "ping"})
        self.assertTrue(ping["ok"])


if __name__ == "__main__":
    unittest.main()
