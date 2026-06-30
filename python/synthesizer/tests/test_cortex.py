import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import cortex  # noqa: E402
import dispatch  # noqa: E402

# Resolve the fixture path relative to this file (works from any cwd).
# Layout: python/synthesizer/tests/test_cortex.py  →  ../../.. = repo root
_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
_GOLDEN_FIXTURE = os.path.join(_REPO_ROOT, "tests", "fixtures", "cortex_decide_golden.json")

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

    def test_dispatch_golden_parity(self):
        """Re-run dispatch.handle on every frozen request and assert the response equals the
        frozen golden. This is the real DRIFT ALARM: if cortex.py or dispatch.py changes the
        shape or semantics of cortex.decide, this test goes red before the TS side even boots.

        The fixture lives at tests/fixtures/cortex_decide_golden.json (repo root). It was
        generated by actually running dispatch.handle on each request so the frozen values are
        faithful to the live daemon at generation time. A mismatch here means:
          - Update the fixture (regenerate by running dispatch.handle and copying the output), AND
          - Update the TS CortexTraceSchema / CortexDecideResponseSchema to match, AND
          - Re-run the TS golden test (tests/test_cortex_decide_golden_parity.ts) green.

        The ok:false vector's error.message is skipped in the equality check because Python's
        AttributeError wording is an implementation detail — we only assert code and ok.
        """
        with open(_GOLDEN_FIXTURE, "r", encoding="utf-8") as f:
            vectors = json.load(f)

        mismatches = []
        for v in vectors:
            name = v["name"]
            req = v["request"]
            frozen = v["response"]
            got = dispatch.handle(req)
            if frozen.get("ok") is False:
                # For ok:false, only assert the structural invariants (id, v, ok, error.code).
                # error.message is implementation-detail text we don't freeze.
                if got.get("ok") is not False:
                    mismatches.append("[%s] expected ok:false, got ok:true: %r" % (name, got))
                elif got.get("error", {}).get("code") != frozen.get("error", {}).get("code"):
                    mismatches.append(
                        "[%s] error.code drift: frozen=%r got=%r"
                        % (name, frozen.get("error", {}).get("code"),
                           got.get("error", {}).get("code")))
            else:
                if got != frozen:
                    mismatches.append("[%s] drift:\n  frozen=%s\n  got   =%s"
                                      % (name, json.dumps(frozen), json.dumps(got)))

        self.assertEqual(
            len(mismatches), 0,
            "%d golden vector(s) drifted — regenerate fixture and update both TS + Python schemas:\n%s"
            % (len(mismatches), "\n".join(mismatches)))


    def test_exited_pane_drops_pane_tier(self):
        tiers = dict(TIERS)
        tiers["pane"] = {"paneId": "p1", "name": "main", "runtimeType": "claude",
                         "status": "Exited", "lastCommand": "ls", "recent": ["done"]}
        out = cortex.decide(tiers, CTX, 0)
        self.assertNotIn("pane", out["decision"]["keep"])
        self.assertIn("pane", out["decision"]["drop"])
        self.assertEqual(out["trace"]["ruleFired"], "exited-pane")

    def test_idle_pane_is_kept(self):
        tiers = dict(TIERS)
        tiers["pane"] = {"paneId": "p1", "name": "main", "runtimeType": "claude",
                         "status": "Idle", "lastCommand": "ls", "recent": ["ok"]}
        out = cortex.decide(tiers, CTX, 0)
        self.assertIn("pane", out["decision"]["keep"])      # idle ≈ just-finished ≈ relevant
        self.assertEqual(out["trace"]["ruleFired"], "baseline-identity")

    def test_cortex_version_is_0_2_0(self):
        self.assertEqual(cortex.CORTEX_VERSION, "0.2.0")


if __name__ == "__main__":
    unittest.main()
