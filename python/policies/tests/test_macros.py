import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import macros  # noqa: E402
import dispatch  # noqa: E402


def entry(mid, phrase):
    return {"id": mid, "phrase": phrase}


ENTRIES = [
    entry("mac_deploy", "deploy everything"),
    entry("mac_status", "morning status check"),
    entry("mac_clean", "clean the build"),
]


class MatchMacroTest(unittest.TestCase):
    def test_normalized_exact_hit(self):
        r = macros.match_macro("deploy everything", ENTRIES)
        self.assertEqual(r["id"], "mac_deploy")
        self.assertEqual(r["score"], 1.0)

    def test_exact_hit_ignores_case_and_punctuation(self):
        # normalizeUtterance parity: case + trailing punctuation collapse to the same exact match.
        r = macros.match_macro("Deploy, everything!", ENTRIES)
        self.assertEqual(r["id"], "mac_deploy")
        self.assertEqual(r["score"], 1.0)

    def test_unicode_and_apostrophe_normalization(self):
        # Straight/smart apostrophes are stripped; accented/punctuation chars -> space then collapse.
        r = macros.match_macro("clean the build", [entry("mac_x", "clean the build")])
        self.assertEqual(r["id"], "mac_x")
        r2 = macros.match_macro("don't stop", [entry("mac_y", "dont stop")])
        self.assertEqual(r2["id"], "mac_y")

    def test_bounded_fuzzy_hit(self):
        # A small transcription slip clears the conservative fuzzy threshold.
        r = macros.match_macro("deploy everythng", ENTRIES)
        self.assertEqual(r["id"], "mac_deploy")
        self.assertGreaterEqual(r["score"], macros.FUZZY_THRESHOLD)

    def test_near_miss_below_threshold_is_no_match(self):
        # An utterance that overlaps NO phrase closely resolves to a definitive no-match.
        r = macros.match_macro("what is the weather today", ENTRIES)
        self.assertIsNone(r["id"])

    def test_empty_store(self):
        r = macros.match_macro("deploy everything", [])
        self.assertEqual(r, {"id": None, "score": 0.0})

    def test_empty_utterance(self):
        r = macros.match_macro("   ", ENTRIES)
        self.assertEqual(r, {"id": None, "score": 0.0})

    def test_deterministic_tiebreak_lowest_id(self):
        # Two identical phrases -> the lexically-lowest id wins, every time.
        dup = [entry("mac_bbb", "run it all"), entry("mac_aaa", "run it all")]
        for _ in range(5):
            self.assertEqual(macros.match_macro("run it all", dup)["id"], "mac_aaa")

    def test_hostile_entry_missing_id_is_skipped(self):
        r = macros.match_macro("deploy everything", [{"phrase": "deploy everything"}, entry("mac_ok", "deploy everything")])
        self.assertEqual(r["id"], "mac_ok")


class DispatchMacroOpTest(unittest.TestCase):
    def test_macro_match_op_routes_and_wraps(self):
        resp = dispatch.handle({"id": "1", "v": dispatch.WIRE_VERSION, "op": "macro.match",
                                "utterance": "deploy everything", "entries": ENTRIES})
        self.assertTrue(resp["ok"])
        self.assertEqual(resp["match"]["id"], "mac_deploy")

    def test_macro_match_op_bad_payload_fails_closed(self):
        # A missing required field surfaces as ok:False MACRO_FAILED (never crashes the daemon).
        resp = dispatch.handle({"id": "2", "v": dispatch.WIRE_VERSION, "op": "macro.match"})
        self.assertFalse(resp["ok"])
        self.assertEqual(resp["error"]["code"], "MACRO_FAILED")


if __name__ == "__main__":
    unittest.main()
