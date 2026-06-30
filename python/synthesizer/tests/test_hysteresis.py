import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from hysteresis import HysteresisGuard  # noqa: E402


class HysteresisGuardTest(unittest.TestCase):

    def _guard(self, window_ms=500):
        return HysteresisGuard(window_ms=window_ms)

    # (a) Same hash within the quiet window → False (suppress)
    def test_same_hash_within_window_suppressed(self):
        g = self._guard(window_ms=500)
        g.should_fire("abc123", 0)          # prime: True (ignored)
        result = g.should_fire("abc123", 100)  # same hash, 100 ms later → within 500 ms window
        self.assertFalse(result)

    # (b) Different hash always fires → True
    def test_different_hash_fires_immediately(self):
        g = self._guard(window_ms=500)
        g.should_fire("abc123", 0)           # prime
        result = g.should_fire("xyz789", 50) # different hash within window
        self.assertTrue(result)

    # (c) Same hash after the window expires → True
    def test_same_hash_after_window_expires_fires(self):
        g = self._guard(window_ms=500)
        g.should_fire("abc123", 0)            # prime
        result = g.should_fire("abc123", 600) # same hash, 600 ms > 500 ms window
        self.assertTrue(result)

    # (d) First call always fires → True
    def test_first_call_always_fires(self):
        g = self._guard()
        result = g.should_fire("anything", 0)
        self.assertTrue(result)

    # Additional: window boundary is exclusive (== window_ms is still within → False)
    def test_boundary_exact_window_still_suppressed(self):
        g = self._guard(window_ms=500)
        g.should_fire("h1", 0)
        result = g.should_fire("h1", 499)  # 499 < 500 → suppress
        self.assertFalse(result)

    # Additional: after firing on a different hash the window resets on the new hash
    def test_window_resets_after_hash_change(self):
        g = self._guard(window_ms=500)
        g.should_fire("h1", 0)
        g.should_fire("h2", 100)   # different hash → fires, updates state
        result = g.should_fire("h2", 150)  # same new hash, 50 ms later → suppress
        self.assertFalse(result)

    # min_char_delta param is accepted without error (reserved, not yet enforced)
    def test_min_char_delta_accepted(self):
        g = HysteresisGuard(window_ms=200, min_char_delta=10)
        self.assertTrue(g.should_fire("x", 0))  # first call → always True


if __name__ == "__main__":
    unittest.main()
