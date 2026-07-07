import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from _synth_dispatch_loader import load_dispatch  # noqa: E402

dispatch = load_dispatch()

CFG = {"totalBudgetChars": 4800,
       "weights": {"project": 0.40, "pane": 0.30, "breadcrumbs": 0.15, "board": 0.10, "frame": 0.05},
       "breadcrumbMax": 12, "breadcrumbMaxAgeMs": 900000}
TIERS = {"project": None, "pane": None, "board": [],
         "frame": {"role": "Janus", "gatePosture": "Auto", "prefs": []}, "breadcrumbs": []}


class DispatchTest(unittest.TestCase):
    def test_ping_pongs_with_version(self):
        r = dispatch.handle({"id": "u1", "v": 1, "op": "ping"})
        self.assertEqual(r["id"], "u1")
        self.assertTrue(r["ok"])
        self.assertTrue(r["pong"])
        self.assertEqual(r["v"], 1)
        self.assertIn("synthVersion", r)

    def test_synthesize_returns_brief(self):
        r = dispatch.handle({"id": "u2", "v": 1, "op": "synthesize", "now": 0, "cfg": CFG, "tiers": TIERS})
        self.assertTrue(r["ok"])
        self.assertIn("text", r["brief"])
        self.assertEqual(r["meta"]["strategy"], "adaptive-extractive")

    def test_bad_version_rejected(self):
        r = dispatch.handle({"id": "u3", "v": 99, "op": "ping"})
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"]["code"], "BAD_VERSION")

    def test_unknown_op_rejected(self):
        r = dispatch.handle({"id": "u4", "v": 1, "op": "frobnicate"})
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"]["code"], "BAD_OP")

    def test_synth_failure_is_caught(self):
        # tiers=None makes synth raise (AttributeError on .get); must surface as SYNTH_FAILED, never crash.
        r = dispatch.handle({"id": "u5", "v": 1, "op": "synthesize", "now": 0, "cfg": CFG, "tiers": None})
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"]["code"], "SYNTH_FAILED")

    def test_approval_parse_returns_parsed(self):
        r = dispatch.handle({"id": "a1", "v": 1, "op": "approval.parse", "transcript": "approve the second one"})
        self.assertEqual(r["id"], "a1")
        self.assertEqual(r["v"], 1)
        self.assertTrue(r["ok"])
        self.assertEqual(r["parsed"], {"intent": "approve", "targetHint": {"ordinal": 2}})

    def test_approval_parse_bare_none(self):
        r = dispatch.handle({"id": "a2", "v": 1, "op": "approval.parse", "transcript": "what does this do"})
        self.assertTrue(r["ok"])
        self.assertEqual(r["parsed"], {"intent": "none"})

    def test_approval_parse_missing_transcript_is_caught(self):
        # No "transcript" key -> KeyError inside the handler; must surface as PARSE_FAILED, never crash.
        r = dispatch.handle({"id": "a3", "v": 1, "op": "approval.parse"})
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"]["code"], "PARSE_FAILED")

    def test_approval_parse_bad_version_rejected(self):
        r = dispatch.handle({"id": "a4", "v": 99, "op": "approval.parse", "transcript": "approve"})
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"]["code"], "BAD_VERSION")


if __name__ == "__main__":
    unittest.main()
