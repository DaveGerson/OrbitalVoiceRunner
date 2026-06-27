import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import cortex  # noqa: E402
import dispatch  # noqa: E402

TIERS = {"project": {"projectId": "p", "name": "P", "summary": "s", "keyTerms": [], "recentDecisions": []},
         "pane": None, "board": [], "frame": {"role": "Janus", "gatePosture": "Auto", "prefs": []},
         "breadcrumbs": []}
CTX = {"activePaneId": "p1", "sessionId": None, "trigger": "brief-inject"}


class CortexTest(unittest.TestCase):
    def test_identity_keeps_present_tiers_in_order(self):
        out = cortex.decide(TIERS, CTX, 123)
        # pane None, board/breadcrumbs empty -> only project + frame are present, in canonical order.
        self.assertEqual(out["decision"]["keep"], ["project", "frame"])
        self.assertEqual(out["decision"]["drop"], [])
        self.assertEqual(out["decision"]["rerank"], [])

    def test_trace_shape_and_strategy(self):
        tr = cortex.decide(TIERS, CTX, 123)["trace"]
        self.assertEqual(tr["strategy"], "baseline-identity")
        self.assertEqual(tr["ruleFired"], "baseline-identity")
        self.assertEqual(tr["inputs"]["activePaneId"], "p1")
        self.assertEqual(tr["inputs"]["trigger"], "brief-inject")
        self.assertEqual(tr["inputs"]["tierKeys"], ["project", "frame"])
        self.assertEqual(tr["output"]["orderedKeep"], ["project", "frame"])
        self.assertEqual(tr["ts"], 123)
        self.assertIn("cortexVersion", tr)

    def test_deterministic(self):
        self.assertEqual(cortex.decide(TIERS, CTX, 5), cortex.decide(TIERS, CTX, 5))

    def test_trace_carries_shadow_budget(self):
        # Inc 4 slice 2: the trace now reports the cortex's own renderer allocation + rendered length.
        tr = cortex.decide(TIERS, CTX, 123)["trace"]
        self.assertIn("shadowBudget", tr)
        self.assertIn("perTierChars", tr["shadowBudget"])
        self.assertIsInstance(tr["shadowBudget"]["textLen"], int)
        # Lean: the full rendered text is NOT logged, only its length.
        self.assertNotIn("text", tr["shadowBudget"])

    def test_shadow_budget_perTierChars_matches_renderer(self):
        # The trace's shadow allocation equals the independent renderer's perTierChars (same defaults).
        import synth  # the live oracle  # noqa: E402
        tr = cortex.decide(TIERS, CTX, 0)["trace"]
        oracle = synth.synthesize(TIERS, {}, 0)
        self.assertEqual(tr["shadowBudget"]["perTierChars"], oracle["perTierChars"])
        self.assertEqual(tr["shadowBudget"]["textLen"], len(oracle["text"]))

    def test_shadow_render_failure_does_not_break_decision(self):
        # If the shadow render raised, the identity decision + core trace still come back intact;
        # shadowBudget is simply absent (telemetry is best-effort; the decision is the contract).
        out = cortex.decide({"breadcrumbs": [123]}, CTX, 0)  # crumb is an int -> .get raises in renderer
        self.assertEqual(out["decision"]["keep"], ["breadcrumbs"])
        self.assertNotIn("shadowBudget", out["trace"])

    def test_total_on_empty_and_none(self):
        # Must never raise on degenerate (dict/None) shapes.
        self.assertEqual(cortex.decide({}, {}, 0)["decision"]["keep"], [])
        self.assertEqual(cortex.decide(None, None, 0)["decision"]["keep"], [])

    def test_dispatch_routes_cortex_decide(self):
        r = dispatch.handle({"id": "c1", "v": 1, "op": "cortex.decide", "tiers": TIERS, "ctx": CTX, "now": 9})
        self.assertTrue(r["ok"])
        self.assertEqual(r["id"], "c1")
        self.assertEqual(r["v"], 1)
        self.assertEqual(r["decision"]["keep"], ["project", "frame"])
        self.assertEqual(r["trace"]["strategy"], "baseline-identity")

    def test_dispatch_cortex_failure_is_caught(self):
        # A non-dict, truthy tiers makes .get raise inside decide; must surface as CORTEX_FAILED, never crash.
        r = dispatch.handle({"id": "c2", "v": 1, "op": "cortex.decide", "tiers": 123, "ctx": CTX, "now": 0})
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"]["code"], "CORTEX_FAILED")

    def test_dispatch_bad_version_rejected(self):
        r = dispatch.handle({"id": "c3", "v": 99, "op": "cortex.decide", "tiers": TIERS, "ctx": CTX, "now": 0})
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"]["code"], "BAD_VERSION")

    def test_other_ops_still_work_after_cortex(self):
        # Sanity: adding the cortex op did not break the existing router branches.
        self.assertTrue(dispatch.handle({"id": "c4", "v": 1, "op": "ping"})["ok"])
        self.assertTrue(dispatch.handle({"id": "c5", "v": 1, "op": "approval.parse",
                                         "transcript": "approve"})["ok"])


if __name__ == "__main__":
    unittest.main()
