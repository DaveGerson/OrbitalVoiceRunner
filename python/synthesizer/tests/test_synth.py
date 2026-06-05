import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from synth import synthesize, SYNTH_VERSION  # noqa: E402

CFG = {
    "totalBudgetChars": 4800,
    "weights": {"project": 0.40, "pane": 0.30, "breadcrumbs": 0.15, "board": 0.10, "frame": 0.05},
    "breadcrumbMax": 12,
    "breadcrumbMaxAgeMs": 900000,
}
FRAME = {"role": "Janus", "gatePosture": "Human-in-the-Loop", "prefs": []}


def tiers(**kw):
    base = {"project": None, "pane": None, "board": [], "frame": FRAME, "breadcrumbs": []}
    base.update(kw)
    return base


class SynthTest(unittest.TestCase):
    def test_version_string(self):
        self.assertRegex(SYNTH_VERSION, r"^\d+\.\d+\.\d+$")

    def test_empty_tiers_render_only_frame(self):
        out = synthesize(tiers(), CFG, 0)
        self.assertIn("FRAME Janus", out["text"])
        self.assertNotIn("PROJECT", out["text"])
        self.assertLessEqual(len(out["text"]), CFG["totalBudgetChars"])
        self.assertIsNone(out["activePaneId"])

    def test_active_pane_id_propagates(self):
        out = synthesize(tiers(pane={"paneId": "p1", "name": "build", "runtimeType": "claude",
                                     "status": "Running", "lastCommand": "npm test", "recent": []}), CFG, 0)
        self.assertEqual(out["activePaneId"], "p1")
        self.assertIn("ACTIVE PANE build", out["text"])

    def test_breadcrumb_dedup(self):
        crumbs = [{"ts": 3, "paneId": "p1", "text": "ran tests"},
                  {"ts": 2, "paneId": "p1", "text": "ran tests"},
                  {"ts": 1, "paneId": "p1", "text": "edited file"}]
        out = synthesize(tiers(breadcrumbs=crumbs), CFG, 0)
        self.assertEqual(out["text"].count("ran tests"), 1)
        self.assertIn("edited file", out["text"])

    def test_board_drops_idle_and_exited_and_ranks_active_first(self):
        board = [{"paneId": "p2", "name": "idleone", "status": "Idle"},
                 {"paneId": "p3", "name": "dead", "status": "Exited"},
                 {"paneId": "p4", "name": "other", "status": "Running"},
                 {"paneId": "p1", "name": "focus", "status": "Running"}]
        out = synthesize(tiers(pane={"paneId": "p1", "name": "focus", "runtimeType": "claude",
                                     "status": "Running", "lastCommand": None, "recent": []},
                               board=board), CFG, 0)
        self.assertNotIn("idleone", out["text"])
        self.assertNotIn("dead", out["text"])
        line = [ln for ln in out["text"].splitlines() if ln.startswith("BOARD:")][0]
        self.assertLess(line.index("focus"), line.index("other"))

    def test_budget_reallocation_gives_pane_more_than_base(self):
        long_recent = ["x" * 400 for _ in range(8)]
        out = synthesize(tiers(pane={"paneId": "p1", "name": "build", "runtimeType": "claude",
                                     "status": "Running", "lastCommand": "go", "recent": long_recent}), CFG, 0)
        base_pane = int(CFG["totalBudgetChars"] * 0.30)
        self.assertGreater(out["perTierChars"]["pane"], base_pane)
        self.assertLessEqual(len(out["text"]), CFG["totalBudgetChars"])

    def test_budget_never_exceeded_under_huge_input(self):
        huge = {"projectId": "x", "name": "P" * 5000, "summary": "S" * 50000,
                "keyTerms": ["term"] * 500, "recentDecisions": ["d" * 1000] * 50}
        out = synthesize(tiers(project=huge,
                               pane={"paneId": "p1", "name": "n" * 5000, "runtimeType": "claude",
                                     "status": "Running", "lastCommand": "c" * 5000,
                                     "recent": ["r" * 5000] * 50}), CFG, 0)
        self.assertLessEqual(len(out["text"]), CFG["totalBudgetChars"])

    def test_deterministic(self):
        t = tiers(project={"projectId": "x", "name": "Janus", "summary": "A voice orchestrator. It runs panes.",
                           "keyTerms": ["pane"], "recentDecisions": []},
                  pane={"paneId": "p1", "name": "build", "runtimeType": "claude",
                        "status": "Running", "lastCommand": "npm test", "recent": ["ok"]})
        a = synthesize(t, CFG, 1733443200000)
        b = synthesize(t, CFG, 1733443200000)
        self.assertEqual(a, b)


if __name__ == "__main__":
    unittest.main()
