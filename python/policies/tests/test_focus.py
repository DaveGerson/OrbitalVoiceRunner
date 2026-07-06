import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import focus  # noqa: E402


def make_candidate(pane_id, name, ordinal, **over):
    base = {
        "paneId": pane_id,
        "paneName": name,
        "projectId": "proj1",
        "projectName": "Alpha Project",
        "presetLabel": "Claude Code",
        "ordinal": ordinal,
        "state": "Idle",
        "isBusy": False,
        "lastActiveAt": 1000,
        "isActive": False,
    }
    base.update(over)
    return base


class ResolveFocusTest(unittest.TestCase):
    def test_empty_candidates_returns_no_match(self):
        r = focus.resolve_focus("the build pane", [])
        self.assertEqual(r, {"paneId": None, "confidence": 0.0, "alternatives": []})

    def test_non_string_reference_returns_no_match(self):
        r = focus.resolve_focus(None, [make_candidate("p1", "build", 1)])
        self.assertIsNone(r["paneId"])
        self.assertEqual(r["confidence"], 0.0)

    def test_blank_reference_returns_no_match(self):
        r = focus.resolve_focus("   ", [make_candidate("p1", "build", 1)])
        self.assertIsNone(r["paneId"])

    def test_exact_name_match_high_confidence(self):
        candidates = [make_candidate("p1", "build", 1), make_candidate("p2", "tests", 2)]
        r = focus.resolve_focus("build", candidates)
        self.assertEqual(r["paneId"], "p1")
        self.assertGreaterEqual(r["confidence"], 0.99)

    def test_substring_match_scores_lower_than_exact(self):
        candidates = [make_candidate("p1", "build", 1)]
        exact = focus.resolve_focus("build", candidates)
        substring = focus.resolve_focus("the build pane", candidates)
        self.assertGreater(exact["confidence"], substring["confidence"])
        self.assertEqual(substring["paneId"], "p1")

    def test_no_overlap_returns_no_match(self):
        candidates = [make_candidate("p1", "build", 1), make_candidate("p2", "tests", 2)]
        r = focus.resolve_focus("xyzxyz nonsense qqq", candidates)
        self.assertIsNone(r["paneId"])
        self.assertEqual(r["confidence"], 0.0)

    # ── ordinal words / digits ──────────────────────────────────────────────────────────────────
    def test_ordinal_word_resolves_by_display_order(self):
        candidates = [make_candidate("p1", "alpha", 1), make_candidate("p2", "bravo", 2)]
        r = focus.resolve_focus("pane two", candidates)
        self.assertEqual(r["paneId"], "p2")
        self.assertGreaterEqual(r["confidence"], 0.99)

    def test_ordinal_digit_resolves_by_display_order(self):
        candidates = [make_candidate("p1", "alpha", 1), make_candidate("p2", "bravo", 2)]
        r = focus.resolve_focus("pane 2", candidates)
        self.assertEqual(r["paneId"], "p2")

    # ── state phrases ────────────────────────────────────────────────────────────────────────────
    def test_stuck_one_matches_error_state(self):
        candidates = [
            make_candidate("p1", "alpha", 1, state="Idle"),
            make_candidate("p2", "bravo", 2, state="Error"),
        ]
        r = focus.resolve_focus("the stuck one", candidates)
        self.assertEqual(r["paneId"], "p2")

    def test_stuck_one_matches_exited_state(self):
        candidates = [
            make_candidate("p1", "alpha", 1, state="Idle"),
            make_candidate("p2", "bravo", 2, state="Exited"),
        ]
        r = focus.resolve_focus("the stuck one", candidates)
        self.assertEqual(r["paneId"], "p2")

    def test_busy_one_matches_isbusy(self):
        candidates = [
            make_candidate("p1", "alpha", 1, isBusy=False),
            make_candidate("p2", "bravo", 2, isBusy=True),
        ]
        r = focus.resolve_focus("the busy one", candidates)
        self.assertEqual(r["paneId"], "p2")

    # ── recency phrases ─────────────────────────────────────────────────────────────────────────
    def test_that_one_prefers_active_pane(self):
        candidates = [
            make_candidate("p1", "alpha", 1, isActive=False, lastActiveAt=5000),
            make_candidate("p2", "bravo", 2, isActive=True, lastActiveAt=1000),
        ]
        r = focus.resolve_focus("that one", candidates)
        self.assertEqual(r["paneId"], "p2", "active pane wins over merely-more-recent")

    def test_it_prefers_most_recent_when_none_active(self):
        candidates = [
            make_candidate("p1", "alpha", 1, isActive=False, lastActiveAt=1000),
            make_candidate("p2", "bravo", 2, isActive=False, lastActiveAt=9000),
        ]
        r = focus.resolve_focus("focus it", candidates)
        self.assertEqual(r["paneId"], "p2")

    # ── determinism + alternatives ordering ─────────────────────────────────────────────────────
    def test_deterministic_repeat_calls_identical(self):
        candidates = [
            make_candidate("p3", "build-worker", 1),
            make_candidate("p1", "build", 2),
            make_candidate("p2", "build-2", 3),
        ]
        first = focus.resolve_focus("build", candidates)
        second = focus.resolve_focus("build", candidates)
        self.assertEqual(first, second)

    def test_alternatives_ordered_by_score_descending(self):
        candidates = [
            make_candidate("p1", "build worker one", 1),
            make_candidate("p2", "build worker two", 2),
            make_candidate("p3", "build", 3),
            make_candidate("p4", "totally unrelated", 4),
        ]
        r = focus.resolve_focus("build worker", candidates)
        scores = [alt["score"] for alt in r["alternatives"]]
        self.assertEqual(scores, sorted(scores, reverse=True), "alternatives must be score-descending")
        # the totally-unrelated candidate never appears (score 0 excluded).
        alt_ids = {alt["paneId"] for alt in r["alternatives"]}
        self.assertNotIn("p4", alt_ids)

    def test_alternatives_capped_at_three(self):
        candidates = [make_candidate(f"p{i}", "build", i) for i in range(1, 6)]
        # Every candidate is named identically "build" -> all tie at the same top score; the winner
        # is the lowest ordinal (deterministic tie-break) and at most 3 alternatives are reported.
        r = focus.resolve_focus("build", candidates)
        self.assertEqual(r["paneId"], "p1")
        self.assertLessEqual(len(r["alternatives"]), 3)

    def test_tie_break_prefers_lower_ordinal_then_pane_id(self):
        candidates = [make_candidate("z9", "same", 5), make_candidate("a1", "same", 2)]
        r = focus.resolve_focus("same", candidates)
        self.assertEqual(r["paneId"], "a1", "lower ordinal wins the tie")

    # ── hostile-input hardening ─────────────────────────────────────────────────────────────────
    def test_malformed_ordinal_does_not_raise(self):
        # A candidate with a non-numeric `ordinal` (or missing entirely) must never crash the sort
        # tie-break (str vs int comparison) — it should just lose ordinal tie-break priority.
        candidates = [
            {"garbage": True},
            {"paneId": None, "ordinal": "x"},
            make_candidate("p1", "build", 1),
        ]
        r = focus.resolve_focus("build", candidates)
        self.assertEqual(r["paneId"], "p1")

    def test_project_name_and_preset_label_contribute_but_score_lower_than_pane_name(self):
        pane_name_hit = [make_candidate("p1", "gamma", 1, projectName="Other", presetLabel="Codex")]
        project_hit = [make_candidate("p2", "delta", 1, projectName="gamma", presetLabel="Codex")]
        r_pane = focus.resolve_focus("gamma", pane_name_hit)
        r_project = focus.resolve_focus("gamma", project_hit)
        self.assertEqual(r_pane["paneId"], "p1")
        self.assertEqual(r_project["paneId"], "p2")
        self.assertGreater(r_pane["confidence"], r_project["confidence"])


if __name__ == "__main__":
    unittest.main()
