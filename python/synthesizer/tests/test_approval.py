"""Parity test: the Python approval-intent port reproduces every frozen golden vector (task 1.5/1.7).

The vectors are generated from the AUTHORITATIVE TS `parseApprovalIntent`
(`scripts/gen-approval-golden.ts` -> `tests/fixtures/approval_intent_golden.json`). This test loads
that exact file and asserts the Python port returns a byte-equal result for every transcript. A
mismatch means the port drifted from TS (or the vectors were regenerated without re-porting).
"""
import json
import os
import unittest

sys_dir = os.path.dirname(__file__)
sys_path_parent = os.path.join(sys_dir, "..")
import sys  # noqa: E402

sys.path.insert(0, sys_path_parent)
import approval  # noqa: E402

# tests/fixtures/approval_intent_golden.json lives at the repo root: python/synthesizer/tests -> ../../../
_FIXTURE = os.path.normpath(
    os.path.join(sys_dir, "..", "..", "..", "tests", "fixtures", "approval_intent_golden.json")
)


def _load_vectors():
    with open(_FIXTURE, encoding="utf-8") as fh:
        data = json.load(fh)
    return data["vectors"]


class ApprovalParityTest(unittest.TestCase):
    def test_fixture_present_and_dense(self):
        vectors = _load_vectors()
        self.assertGreaterEqual(len(vectors), 100, "golden grid must be dense (boundary-focused)")

    def test_port_reproduces_every_golden_vector(self):
        vectors = _load_vectors()
        mismatches = []
        for v in vectors:
            got = approval.parse_approval_intent(v["transcript"])
            if got != v["expected"]:
                mismatches.append((v["transcript"], v["expected"], got))
        if mismatches:
            lines = "\n".join(
                "  %r\n     expected %s\n     got      %s" % (t, json.dumps(e), json.dumps(g))
                for t, e, g in mismatches
            )
            self.fail("%d/%d vectors diverged from TS:\n%s" % (len(mismatches), len(vectors), lines))


if __name__ == "__main__":
    unittest.main()
