import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import dispatch  # noqa: E402


class DispatchTest(unittest.TestCase):
    def test_ping_pongs_with_version(self):
        r = dispatch.handle({"id": "u1", "v": 1, "op": "ping"})
        self.assertEqual(r["id"], "u1")
        self.assertTrue(r["ok"])
        self.assertTrue(r["pong"])
        self.assertEqual(r["v"], 1)
        # QUIRK (dispatch.py docstring): the literal wire key is `synthVersion`, not
        # `policiesVersion` — the daemon reuses the TS PingResponseSchema handshake.
        self.assertIn("synthVersion", r)
        self.assertEqual(r["synthVersion"], dispatch.POLICIES_VERSION)

    def test_bad_version_rejected(self):
        r = dispatch.handle({"id": "u2", "v": 99, "op": "ping"})
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"]["code"], "BAD_VERSION")

    def test_unknown_op_rejected(self):
        r = dispatch.handle({"id": "u3", "v": 1, "op": "frobnicate"})
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"]["code"], "BAD_OP")

    def test_focus_resolve_stub_shape(self):
        r = dispatch.handle({"id": "f1", "v": 1, "op": "focus.resolve", "reference": "the build pane", "candidates": []})
        self.assertTrue(r["ok"])
        self.assertEqual(r["resolution"], {"paneId": None, "confidence": 0.0, "alternatives": []})

    def test_focus_resolve_missing_args_is_caught(self):
        # No "reference"/"candidates" keys -> KeyError inside the handler; must surface as
        # FOCUS_FAILED, never crash the daemon.
        r = dispatch.handle({"id": "f2", "v": 1, "op": "focus.resolve"})
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"]["code"], "FOCUS_FAILED")

    def test_sitrep_rank_stub_shape(self):
        r = dispatch.handle({"id": "s1", "v": 1, "op": "sitrep.rank", "payload": {}})
        self.assertTrue(r["ok"])
        self.assertEqual(r["ranking"], {"sections": []})

    def test_sitrep_rank_missing_payload_is_caught(self):
        r = dispatch.handle({"id": "s2", "v": 1, "op": "sitrep.rank"})
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"]["code"], "SITREP_FAILED")


if __name__ == "__main__":
    unittest.main()
