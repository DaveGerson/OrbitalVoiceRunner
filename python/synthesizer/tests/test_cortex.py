import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import cortex  # noqa: E402
from _synth_dispatch_loader import load_dispatch  # noqa: E402

dispatch = load_dispatch()

# Resolve the fixture path relative to this file (works from any cwd).
# Layout: python/synthesizer/tests/test_cortex.py  →  ../../.. = repo root
_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
_GOLDEN_FIXTURE = os.path.join(_REPO_ROOT, "tests", "fixtures", "cortex_decide_golden.json")

TIERS = {"project": {"projectId": "p", "name": "P", "summary": "s", "keyTerms": [], "recentDecisions": []},
         "pane": None, "board": [], "frame": {"role": "Janus", "gatePosture": "Auto", "prefs": []},
         "breadcrumbs": []}
CTX = {"activePaneId": "p1", "sessionId": None, "trigger": "session-start"}

TIERS_FULL = {
    "project": {"projectId": "p", "name": "P", "summary": "s", "keyTerms": [], "recentDecisions": []},
    "pane": {"paneId": "p1", "name": "main", "runtimeType": "claude", "status": "Running",
             "lastCommand": "ls", "recent": ["ok"]},
    "breadcrumbs": [{"ts": 1, "paneId": "p1", "text": "did a thing"}],
    "board": [{"paneId": "p1", "name": "main", "status": "Running"}],
    "frame": {"role": "Janus", "gatePosture": "Auto", "prefs": []},
}


def _big_board(n):
    return [{"paneId": "p%d" % i, "name": "pane-name-%d" % i, "status": "Running"} for i in range(n)]


def _big_breadcrumbs(n):
    return [{"ts": i, "paneId": "p1", "text": "did something quite descriptive number %d" % i}
            for i in range(n)]


class ProfileTest(unittest.TestCase):
    """D3: fixed, deterministic trigger -> profile table (order + budget + dropFirst)."""

    def test_session_start_profile_keeps_present_tiers_in_canonical_order(self):
        out = cortex.decide(TIERS, CTX, 123)
        # pane None, board/breadcrumbs empty -> only project + frame are present.
        self.assertEqual(out["decision"]["keep"], ["project", "frame"])
        self.assertEqual(out["decision"]["drop"], [])
        self.assertEqual(out["decision"]["rerank"], [])

    def test_trace_shape_and_strategy(self):
        tr = cortex.decide(TIERS, CTX, 123)["trace"]
        self.assertEqual(tr["strategy"], "profile:session-start")
        self.assertEqual(tr["ruleFired"], "profile:session-start")
        self.assertNotIn("profileFallback", tr)
        self.assertEqual(tr["inputs"]["activePaneId"], "p1")
        self.assertEqual(tr["inputs"]["trigger"], "session-start")
        self.assertEqual(tr["inputs"]["tierKeys"], ["project", "frame"])
        self.assertEqual(tr["output"]["orderedKeep"], ["project", "frame"])
        self.assertEqual(tr["ts"], 123)
        self.assertIn("cortexVersion", tr)

    def test_deterministic(self):
        self.assertEqual(cortex.decide(TIERS, CTX, 5), cortex.decide(TIERS, CTX, 5))
        self.assertEqual(cortex.decide(TIERS_FULL, CTX, 5), cortex.decide(TIERS_FULL, CTX, 5))

    def test_total_on_empty_and_none(self):
        # Must never raise on degenerate (dict/None) shapes.
        self.assertEqual(cortex.decide({}, {}, 0)["decision"]["keep"], [])
        self.assertEqual(cortex.decide(None, None, 0)["decision"]["keep"], [])

    def test_session_start_budget_matches_fixed_fractions_of_4800(self):
        ctx = {"activePaneId": "p1", "sessionId": None, "trigger": "session-start"}
        out = cortex.decide(TIERS_FULL, ctx, 0)
        self.assertEqual(out["decision"]["keep"],
                          ["project", "pane", "breadcrumbs", "board", "frame"])
        self.assertEqual(out["decision"]["budget"],
                          {"project": 1920, "pane": 1440, "breadcrumbs": 720, "board": 480, "frame": 240})

    def test_catch_up_matches_session_start_order_and_budget(self):
        ctx = {"activePaneId": "p1", "sessionId": None, "trigger": "catch-up"}
        out = cortex.decide(TIERS_FULL, ctx, 0)
        self.assertEqual(out["decision"]["keep"],
                          ["project", "pane", "breadcrumbs", "board", "frame"])
        self.assertEqual(out["decision"]["budget"],
                          {"project": 1920, "pane": 1440, "breadcrumbs": 720, "board": 480, "frame": 240})
        self.assertEqual(out["trace"]["strategy"], "profile:catch-up")

    def test_pane_switch_leads_with_active_pane(self):
        ctx = {"activePaneId": "p1", "sessionId": None, "trigger": "pane-switch"}
        out = cortex.decide(TIERS_FULL, ctx, 0)
        self.assertEqual(out["decision"]["keep"],
                          ["pane", "project", "breadcrumbs", "board", "frame"])
        self.assertEqual(out["decision"]["budget"],
                          {"pane": 1920, "project": 1200, "breadcrumbs": 720, "board": 720, "frame": 240})
        self.assertEqual(out["trace"]["strategy"], "profile:pane-switch")

    def test_command_outcome_leads_with_breadcrumbs(self):
        ctx = {"activePaneId": "p1", "sessionId": None, "trigger": "command-outcome"}
        out = cortex.decide(TIERS_FULL, ctx, 0)
        self.assertEqual(out["decision"]["keep"],
                          ["breadcrumbs", "pane", "board", "project", "frame"])
        self.assertEqual(out["decision"]["budget"],
                          {"breadcrumbs": 1440, "pane": 1680, "board": 480, "project": 960, "frame": 240})
        self.assertEqual(out["trace"]["strategy"], "profile:command-outcome")

    def test_affected_pane_id_surfaces_in_trace_inputs_when_supplied(self):
        # Fixer review (Wave 4 cortex cutover): D1 threads ctx.affectedPaneId through so a
        # command-outcome profile can lead with it; the tiers shape has no separate slot for a
        # non-active pane yet (only the single active "pane" tier), so the decision itself cannot
        # act on it -- but it must not be entirely invisible either (D3: "over-document every
        # row"). Surface it in trace.inputs whenever the caller actually supplied it.
        ctx = {"activePaneId": "p1", "sessionId": None, "trigger": "command-outcome", "affectedPaneId": "p2"}
        out = cortex.decide(TIERS_FULL, ctx, 0)
        self.assertEqual(out["trace"]["inputs"]["affectedPaneId"], "p2")

    def test_affected_pane_id_absent_from_trace_inputs_when_not_supplied(self):
        # No golden-fixture drift: requests that never send affectedPaneId (every existing
        # fixture vector) must not gain a new trace.inputs key.
        ctx = {"activePaneId": "p1", "sessionId": None, "trigger": "command-outcome"}
        out = cortex.decide(TIERS_FULL, ctx, 0)
        self.assertNotIn("affectedPaneId", out["trace"]["inputs"])

    def test_unknown_trigger_falls_back_to_session_start_with_trace_note(self):
        ctx = {"activePaneId": "p1", "sessionId": None, "trigger": "reconnect-weirdo"}
        out = cortex.decide(TIERS_FULL, ctx, 0)
        self.assertEqual(out["decision"]["keep"],
                          ["project", "pane", "breadcrumbs", "board", "frame"])
        self.assertEqual(out["trace"]["strategy"], "profile:reconnect-weirdo")
        self.assertEqual(out["trace"]["profileFallback"], "session-start")

    def test_non_string_trigger_falls_back_gracefully(self):
        for bad_trigger in (None, 123, ["pane-switch"], {"x": 1}):
            ctx = {"activePaneId": "p1", "sessionId": None, "trigger": bad_trigger}
            out = cortex.decide(TIERS_FULL, ctx, 0)  # must never raise
            self.assertEqual(out["decision"]["keep"],
                              ["project", "pane", "breadcrumbs", "board", "frame"])
            self.assertEqual(out["trace"]["strategy"], "profile:unknown")
            self.assertEqual(out["trace"]["profileFallback"], "session-start")

    def test_pane_switch_overflow_drops_board_then_breadcrumbs(self):
        tiers = dict(TIERS_FULL)
        tiers["breadcrumbs"] = _big_breadcrumbs(200)
        tiers["board"] = _big_board(200)
        ctx = {"activePaneId": "p1", "sessionId": None, "trigger": "pane-switch"}
        out = cortex.decide(tiers, ctx, 0)
        # Sanity: this snapshot really does overflow the budget.
        raw_total = sum(cortex._size_probe(tiers[t]) for t in cortex._TIER_KEYS)
        self.assertGreater(raw_total, cortex._TOTAL_BUDGET_CHARS)
        self.assertIn("board", out["decision"]["drop"])
        self.assertIn("breadcrumbs", out["decision"]["drop"])
        self.assertLess(out["decision"]["drop"].index("board"),
                         out["decision"]["drop"].index("breadcrumbs"))
        self.assertEqual(out["trace"]["output"]["droppedRules"]["board"], "overflow-dropfirst")
        self.assertEqual(out["trace"]["output"]["droppedRules"]["breadcrumbs"], "overflow-dropfirst")
        # pane/project/frame are never in pane-switch's dropFirst list -> never overflow-dropped.
        self.assertIn("pane", out["decision"]["keep"])
        self.assertIn("project", out["decision"]["keep"])
        self.assertIn("frame", out["decision"]["keep"])

    def test_command_outcome_overflow_drops_project_then_board(self):
        tiers = dict(TIERS_FULL)
        tiers["project"] = dict(TIERS_FULL["project"], summary="x" * 3000)
        tiers["board"] = _big_board(200)
        ctx = {"activePaneId": "p1", "sessionId": None, "trigger": "command-outcome"}
        out = cortex.decide(tiers, ctx, 0)
        self.assertIn("project", out["decision"]["drop"])
        self.assertIn("board", out["decision"]["drop"])
        self.assertLess(out["decision"]["drop"].index("project"),
                         out["decision"]["drop"].index("board"))
        # breadcrumbs/pane/frame are not in command-outcome's dropFirst -> stay kept regardless.
        self.assertIn("breadcrumbs", out["decision"]["keep"])
        self.assertIn("pane", out["decision"]["keep"])
        self.assertIn("frame", out["decision"]["keep"])

    def test_session_start_never_overflow_drops(self):
        # session-start/catch-up have an empty dropFirst list -> overflow never drops a tier here;
        # the (already-computed) per-tier caps are what bound the actual render (D3 "trim via caps").
        tiers = dict(TIERS_FULL)
        tiers["board"] = _big_board(200)
        tiers["breadcrumbs"] = _big_breadcrumbs(200)
        ctx = {"activePaneId": "p1", "sessionId": None, "trigger": "session-start"}
        out = cortex.decide(tiers, ctx, 0)
        self.assertEqual(out["decision"]["drop"], [])
        self.assertEqual(out["decision"]["keep"],
                          ["project", "pane", "breadcrumbs", "board", "frame"])


class ExitedPaneTest(unittest.TestCase):
    """The pre-existing exited-pane rule; now applied before the profile (D3)."""

    def test_exited_pane_drops_pane_tier(self):
        tiers = dict(TIERS)
        tiers["pane"] = {"paneId": "p1", "name": "main", "runtimeType": "claude",
                         "status": "Exited", "lastCommand": "ls", "recent": ["done"]}
        out = cortex.decide(tiers, CTX, 0)
        self.assertNotIn("pane", out["decision"]["keep"])
        self.assertIn("pane", out["decision"]["drop"])
        self.assertEqual(out["trace"]["strategy"], "profile:session-start")
        self.assertEqual(out["trace"]["output"]["droppedRules"]["pane"], "exited-pane")

    def test_idle_pane_is_kept(self):
        tiers = dict(TIERS)
        tiers["pane"] = {"paneId": "p1", "name": "main", "runtimeType": "claude",
                         "status": "Idle", "lastCommand": "ls", "recent": ["ok"]}
        out = cortex.decide(tiers, CTX, 0)
        self.assertIn("pane", out["decision"]["keep"])      # idle ≈ just-finished ≈ relevant
        self.assertEqual(out["decision"]["drop"], [])
        self.assertEqual(out["trace"]["ruleFired"], "profile:session-start")


class HysteresisTest(unittest.TestCase):
    """D4: a tier dropped in the last RESURFACE_FLOOR_DECIDES decides stays suppressed unless a
    strong trigger (session-start, or the tier's content hash changed) overrides it."""

    def _history(self, dropped_tiers, tier_hashes, trigger="pane-switch", ts=100):
        return [{"droppedTiers": dropped_tiers, "tierHashes": tier_hashes, "trigger": trigger, "ts": ts}]

    def test_recently_dropped_tier_stays_suppressed(self):
        ctx = {
            "activePaneId": "p1", "sessionId": None, "trigger": "pane-switch",
            "history": self._history(["board"], {"board": "h1"}),
            "tierHashes": {"board": "h1"},  # unchanged since the drop
        }
        out = cortex.decide(TIERS_FULL, ctx, 0)
        self.assertNotIn("board", out["decision"]["keep"])
        self.assertIn("board", out["decision"]["drop"])
        self.assertEqual(out["trace"]["output"]["droppedRules"]["board"], "hysteresis")
        self.assertTrue(out["trace"]["ruleFired"].endswith("+hysteresis"))

    def test_strong_trigger_hash_change_resurfaces(self):
        ctx = {
            "activePaneId": "p1", "sessionId": None, "trigger": "pane-switch",
            "history": self._history(["board"], {"board": "h1"}),
            "tierHashes": {"board": "h2"},  # content changed since the drop -> resurface
        }
        out = cortex.decide(TIERS_FULL, ctx, 0)
        self.assertIn("board", out["decision"]["keep"])
        self.assertNotIn("board", out["decision"]["drop"])
        self.assertFalse(out["trace"]["ruleFired"].endswith("+hysteresis"))

    def test_session_start_bypasses_hysteresis_entirely(self):
        ctx = {
            "activePaneId": "p1", "sessionId": None, "trigger": "session-start",
            "history": self._history(["pane"], {"pane": "h1"}),
            "tierHashes": {},  # no hash info at all -- session-start must not care
        }
        out = cortex.decide(TIERS_FULL, ctx, 0)
        self.assertIn("pane", out["decision"]["keep"])
        self.assertFalse(out["trace"]["ruleFired"].endswith("+hysteresis"))

    def test_only_last_three_history_entries_considered(self):
        # RESURFACE_FLOOR_DECIDES == 3: a drop recorded 4 decides ago must NOT suppress today.
        old_entry = {"droppedTiers": ["frame"], "tierHashes": {"frame": "h1"}, "trigger": "x", "ts": 1}
        recent = [{"droppedTiers": [], "tierHashes": {}, "trigger": "pane-switch", "ts": t}
                  for t in (2, 3, 4)]
        ctx = {
            "activePaneId": "p1", "sessionId": None, "trigger": "pane-switch",
            "history": [old_entry] + recent,  # oldest-first, 4 entries total
            "tierHashes": {"frame": "h1"},
        }
        out = cortex.decide(TIERS_FULL, ctx, 0)
        self.assertIn("frame", out["decision"]["keep"])

    def test_hostile_history_is_ignored_never_raises(self):
        for bad_history in ("not-a-list", 5, {"x": 1}, [1, 2, "junk"], [{"droppedTiers": "nope"}]):
            ctx = {"activePaneId": "p1", "sessionId": None, "trigger": "pane-switch",
                   "history": bad_history, "tierHashes": "also-junk"}
            out = cortex.decide(TIERS_FULL, ctx, 0)  # must never raise
            self.assertEqual(out["decision"]["keep"],
                              ["pane", "project", "breadcrumbs", "board", "frame"])

    def test_malformed_entry_missing_tierhashes_on_both_sides_does_not_suppress(self):
        # Fixer review (Wave 4 cortex cutover): a history entry with NO "tierHashes" field at all,
        # compared against a ctx with no hash evidence for that tier either, used to compare
        # None == None (both .get() calls miss) and read that as "hash unchanged" -> suppressed the
        # tier forever. Spec D7 says a malformed history entry must be IGNORED, not treated as
        # positive evidence of an unchanged hash -- with no real evidence on either side the tier
        # must resurface, not stay suppressed.
        ctx = {
            "activePaneId": "p1", "sessionId": None, "trigger": "pane-switch",
            "history": [{"droppedTiers": ["board"], "trigger": "x", "ts": 1}],  # no tierHashes field
            "tierHashes": {},  # no evidence for "board" on the current side either
        }
        out = cortex.decide(TIERS_FULL, ctx, 0)
        self.assertIn("board", out["decision"]["keep"], "no real hash evidence -> must not suppress")
        self.assertNotIn("board", out["decision"]["drop"])
        self.assertFalse(out["trace"]["ruleFired"].endswith("+hysteresis"))

    def test_explicit_none_or_empty_hash_values_on_both_sides_do_not_suppress(self):
        # Re-verify residual (Wave 4): the key-presence guard alone still let {"board": None} on
        # BOTH sides through to None == None (and "" == ""). Hash evidence must be a non-empty
        # string on both sides -- anything else is absence of evidence, and the tier resurfaces.
        for bogus in (None, "", 0, [], {}):
            ctx = {
                "activePaneId": "p1", "sessionId": None, "trigger": "pane-switch",
                "history": self._history(["board"], {"board": bogus}),
                "tierHashes": {"board": bogus},
            }
            out = cortex.decide(TIERS_FULL, ctx, 0)
            self.assertIn("board", out["decision"]["keep"],
                          f"bogus hash value {bogus!r} on both sides must not suppress")
            self.assertFalse(out["trace"]["ruleFired"].endswith("+hysteresis"))


class DispatchRobustnessTest(unittest.TestCase):
    def test_dispatch_routes_cortex_decide(self):
        r = dispatch.handle({"id": "c1", "v": 1, "op": "cortex.decide", "tiers": TIERS, "ctx": CTX, "now": 9})
        self.assertTrue(r["ok"])
        self.assertEqual(r["id"], "c1")
        self.assertEqual(r["v"], 1)
        self.assertEqual(r["decision"]["keep"], ["project", "frame"])
        self.assertEqual(r["trace"]["strategy"], "profile:session-start")

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

    def test_dispatch_survives_malformed_ctx_history_then_other_ops_still_work(self):
        # D7: hostile ctx.history must NOT surface as CORTEX_FAILED -- decide() itself ignores it.
        r = dispatch.handle({"id": "c6", "v": 1, "op": "cortex.decide", "tiers": TIERS_FULL,
                             "ctx": {"activePaneId": "p1", "trigger": "pane-switch",
                                     "history": "garbage", "tierHashes": 5}, "now": 0})
        self.assertTrue(r["ok"])
        self.assertTrue(dispatch.handle({"id": "c7", "v": 1, "op": "ping"})["ok"])

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


class VersionTest(unittest.TestCase):
    def test_cortex_version_is_0_3_0(self):
        self.assertEqual(cortex.CORTEX_VERSION, "0.3.0")

    def test_cortex_version_in_trace_is_0_3_0(self):
        tr = cortex.decide(TIERS, CTX, 0)["trace"]
        self.assertEqual(tr["cortexVersion"], "0.3.0")


class ShadowBudgetTest(unittest.TestCase):
    """Unchanged from the SHADOW slice: the trace also carries the cortex's OWN independent
    renderer allocation (unrelated to the D3 profile budget) for lean observability."""

    def test_trace_carries_shadow_budget(self):
        tr = cortex.decide(TIERS, CTX, 123)["trace"]
        self.assertIn("shadowBudget", tr)
        self.assertIn("perTierChars", tr["shadowBudget"])
        self.assertIsInstance(tr["shadowBudget"]["textLen"], int)
        self.assertNotIn("text", tr["shadowBudget"])

    def test_shadow_budget_perTierChars_matches_renderer(self):
        import synth  # the live oracle  # noqa: E402
        tr = cortex.decide(TIERS, CTX, 0)["trace"]
        oracle = synth.synthesize(TIERS, {}, 0)
        self.assertEqual(tr["shadowBudget"]["perTierChars"], oracle["perTierChars"])
        self.assertEqual(tr["shadowBudget"]["textLen"], len(oracle["text"]))

    def test_shadow_render_failure_does_not_break_decision(self):
        # If the shadow render raised, the decision + core trace still come back intact;
        # shadowBudget is simply absent (telemetry is best-effort; the decision is the contract).
        out = cortex.decide({"breadcrumbs": [123]}, CTX, 0)  # crumb is an int -> .get raises in renderer
        self.assertEqual(out["decision"]["keep"], ["breadcrumbs"])
        self.assertNotIn("shadowBudget", out["trace"])

    def test_exited_pane_has_both_shadow_budgets(self):
        """exited-pane drop: trace must have both shadowBudget (full) and shadowBudgetCurated (post-drop)."""
        tiers = {
            "project": {"projectId": "p1", "name": "P", "summary": "s", "keyTerms": [], "recentDecisions": []},
            "pane": {"paneId": "p1", "name": "main", "runtimeType": "claude",
                     "status": "Exited", "lastCommand": "ls", "recent": ["done"]},
            "breadcrumbs": [],
            "board": [],
            "frame": {"role": "Janus", "gatePosture": "Auto", "prefs": []},
        }
        out = cortex.decide(tiers, CTX, 42)
        self.assertEqual(out["decision"]["drop"], ["pane"])
        tr = out["trace"]
        self.assertIn("shadowBudget", tr, "shadowBudget (full-tier render) must still be present")
        self.assertIn("shadowBudgetCurated", tr, "shadowBudgetCurated must be present when drop is non-empty")
        self.assertLess(
            tr["shadowBudgetCurated"]["textLen"],
            tr["shadowBudget"]["textLen"],
            "curated render must be shorter than full render because pane was dropped",
        )
        self.assertIn("perTierChars", tr["shadowBudgetCurated"])
        self.assertIsInstance(tr["shadowBudgetCurated"]["textLen"], int)
        self.assertNotIn("text", tr["shadowBudgetCurated"])

    def test_non_drop_input_has_no_shadow_budget_curated(self):
        """When drop is empty, shadowBudgetCurated must NOT appear in the trace."""
        out = cortex.decide(TIERS, CTX, 123)
        self.assertEqual(out["decision"]["drop"], [])
        self.assertNotIn("shadowBudgetCurated", out["trace"])


if __name__ == "__main__":
    unittest.main()
