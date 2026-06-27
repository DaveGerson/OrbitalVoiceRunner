"""Parity battery: the cortex's independent SHADOW port reproduces `synth.synthesize`
byte-for-byte (Inc 4, slice 2 — bead wsm-e2e-pinned-5gv).

Each fixture asserts `cortex.synthesize_shadow(tiers, cfg, now) == synth.synthesize(tiers, cfg, now)`
over the FULL returned brief dict (text + perTierChars + activePaneId). `synth.synthesize` is the
live, authoritative oracle and MUST NOT be modified. The scenarios mirror test_synth.py so the
oracle is meaningful, plus extra structural cases. SHADOW: nothing here applies the decision.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import synth  # noqa: E402
import cortex  # noqa: E402

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


PANE = {"paneId": "p1", "name": "build", "runtimeType": "claude",
        "status": "Running", "lastCommand": "npm test", "recent": ["ok", "edited file"]}
PROJECT = {"projectId": "x", "name": "Janus", "summary": "A voice orchestrator. It runs panes.",
           "keyTerms": ["pane", "voice"], "recentDecisions": ["use sqlite", "shadow cortex", "flip later", "extra"]}


class CortexParityTest(unittest.TestCase):
    """Each method is one fixture in the battery; assertParity is the byte-for-byte oracle check."""

    def assertParity(self, t, cfg, now, msg=""):
        oracle = synth.synthesize(t, cfg, now)
        port = cortex.synthesize_shadow(t, cfg, now)
        self.assertEqual(port, oracle, msg or "cortex port diverged from synth.synthesize")
        return oracle

    # ── mirror of test_synth.py scenarios ───────────────────────────────────────────────────────
    def test_empty_tiers_frame_only(self):
        out = self.assertParity(tiers(), CFG, 0)
        self.assertIn("FRAME Janus", out["text"])
        self.assertNotIn("PROJECT", out["text"])
        self.assertIsNone(out["activePaneId"])

    def test_full_tiers(self):
        crumbs = [{"ts": 3, "paneId": "p1", "text": "ran tests"},
                  {"ts": 1, "paneId": "p1", "text": "edited file"}]
        board = [{"paneId": "p1", "name": "focus", "status": "Running"},
                 {"paneId": "p4", "name": "other", "status": "Running"}]
        out = self.assertParity(
            tiers(project=PROJECT, pane=PANE, breadcrumbs=crumbs, board=board), CFG, 1733443200000)
        self.assertEqual(out["activePaneId"], "p1")
        self.assertIn("PROJECT Janus", out["text"])
        self.assertIn("ACTIVE PANE build", out["text"])

    def test_active_pane_id_propagates(self):
        out = self.assertParity(tiers(pane=PANE), CFG, 0)
        self.assertEqual(out["activePaneId"], "p1")
        self.assertIn("ACTIVE PANE build", out["text"])

    def test_breadcrumb_dedup(self):
        crumbs = [{"ts": 3, "paneId": "p1", "text": "ran tests"},
                  {"ts": 2, "paneId": "p1", "text": "ran tests"},
                  {"ts": 1, "paneId": "p1", "text": "edited file"}]
        out = self.assertParity(tiers(breadcrumbs=crumbs), CFG, 0)
        self.assertEqual(out["text"].count("ran tests"), 1)
        self.assertIn("edited file", out["text"])

    def test_breadcrumb_dedup_normalization(self):
        # Whitespace/case-insensitive dedup (synth._norm): these collapse to one crumb.
        crumbs = [{"ts": 3, "paneId": "p1", "text": "Ran   Tests"},
                  {"ts": 2, "paneId": "p1", "text": "ran tests"},
                  {"ts": 1, "paneId": "p1", "text": ""}]
        out = self.assertParity(tiers(breadcrumbs=crumbs), CFG, 0)
        self.assertEqual(out["text"].lower().count("ran"), 1)

    def test_board_ranking_drops_idle_exited_active_first(self):
        board = [{"paneId": "p2", "name": "idleone", "status": "Idle"},
                 {"paneId": "p3", "name": "dead", "status": "Exited"},
                 {"paneId": "p4", "name": "other", "status": "Running"},
                 {"paneId": "p1", "name": "focus", "status": "Running"}]
        out = self.assertParity(
            tiers(pane={"paneId": "p1", "name": "focus", "runtimeType": "claude",
                        "status": "Running", "lastCommand": None, "recent": []}, board=board), CFG, 0)
        self.assertNotIn("idleone", out["text"])
        self.assertNotIn("dead", out["text"])
        line = [ln for ln in out["text"].splitlines() if ln.startswith("BOARD:")][0]
        self.assertLess(line.index("focus"), line.index("other"))

    def test_budget_reallocation_when_tiers_absent(self):
        long_recent = ["x" * 400 for _ in range(8)]
        out = self.assertParity(
            tiers(pane={"paneId": "p1", "name": "build", "runtimeType": "claude",
                        "status": "Running", "lastCommand": "go", "recent": long_recent}), CFG, 0)
        base_pane = int(CFG["totalBudgetChars"] * 0.30)
        self.assertGreater(out["perTierChars"]["pane"], base_pane)

    def test_budget_never_exceeded_under_huge_input(self):
        huge = {"projectId": "x", "name": "P" * 5000, "summary": "S" * 50000,
                "keyTerms": ["term"] * 500, "recentDecisions": ["d" * 1000] * 50}
        out = self.assertParity(
            tiers(project=huge,
                  pane={"paneId": "p1", "name": "n" * 5000, "runtimeType": "claude",
                        "status": "Running", "lastCommand": "c" * 5000,
                        "recent": ["r" * 5000] * 50}), CFG, 0)
        self.assertLessEqual(len(out["text"]), CFG["totalBudgetChars"])

    def test_deterministic_two_calls_equal(self):
        t = tiers(project=PROJECT, pane=PANE)
        a = cortex.synthesize_shadow(t, CFG, 1733443200000)
        b = cortex.synthesize_shadow(t, CFG, 1733443200000)
        self.assertEqual(a, b)
        # and equal to the oracle
        self.assertEqual(a, synth.synthesize(t, CFG, 1733443200000))

    # ── extra structural fixtures (exercise branches synth has that test_synth doesn't hit) ───────
    def test_project_salient_summary_with_key_terms(self):
        # multi-sentence summary; _salient_summary keeps first + key-term sentences.
        proj = {"projectId": "x", "name": "Janus",
                "summary": "A voice orchestrator. It runs panes. Unrelated trivia here. Panes are gated.",
                "keyTerms": ["gated"], "recentDecisions": ["d1", "d2", "d3", "d4"]}
        self.assertParity(tiers(project=proj), CFG, 0)

    def test_frame_prefs_render(self):
        fr = {"role": "Janus", "gatePosture": "Auto", "prefs": ["concise", "no-emoji"]}
        self.assertParity(tiers(frame=fr), CFG, 0)

    def test_frame_empty_dict(self):
        # synth does `frame = tiers.get("frame") or {}` — a falsy frame becomes {}.
        self.assertParity(tiers(frame=None), CFG, 0)
        self.assertParity(tiers(frame={}), CFG, 0)

    def test_pane_no_last_command_no_recent(self):
        self.assertParity(
            tiers(pane={"paneId": "p9", "name": "n", "runtimeType": "codex",
                        "status": "Idle", "lastCommand": None, "recent": []}), CFG, 0)

    def test_recent_truncated_to_six(self):
        recent = ["line%d" % i for i in range(10)]
        out = self.assertParity(
            tiers(pane={"paneId": "p1", "name": "b", "runtimeType": "claude",
                        "status": "Running", "lastCommand": "x", "recent": recent}), CFG, 0)
        self.assertIn("line5", out["text"])
        self.assertNotIn("line6", out["text"])

    def test_custom_weights_and_total(self):
        cfg = {"totalBudgetChars": 1000,
               "weights": {"project": 0.5, "pane": 0.2, "breadcrumbs": 0.1, "board": 0.1, "frame": 0.1}}
        self.assertParity(tiers(project=PROJECT, pane=PANE), cfg, 0)

    def test_cfg_defaults_when_keys_missing(self):
        # synth falls back to totalBudgetChars=4800 and per-weight defaults when cfg keys are absent.
        self.assertParity(tiers(project=PROJECT, pane=PANE), {}, 0)
        self.assertParity(tiers(project=PROJECT, pane=PANE), {"weights": {}}, 0)

    def test_board_present_no_active_pane(self):
        # active_id None: board ranks running-first, ties keep input order.
        board = [{"paneId": "p4", "name": "other", "status": "Running"},
                 {"paneId": "p5", "name": "third", "status": "Running"}]
        self.assertParity(tiers(board=board), CFG, 0)

    def test_all_tiers_empty_lists_and_none(self):
        # Only frame present; everything else absent → reallocation path with present={'frame'}.
        self.assertParity(
            {"project": None, "pane": None, "board": [], "frame": FRAME, "breadcrumbs": []}, CFG, 0)


if __name__ == "__main__":
    unittest.main()
