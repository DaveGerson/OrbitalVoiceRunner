"""Hysteresis guard for cortex oscillation damping — B-6.

Pure, stateful, no I/O, stdlib only. Callable by future pure-Python cortex callers; the TS side
uses its own inline guard (the stdio round-trip cost would defeat the purpose). NOT wired into
dispatch.py — it is a standalone utility ready for the forthcoming Python agent/LLM layer.
"""


class HysteresisGuard:
    """Suppress duplicate cortex fires within a quiet window.

    Args:
        window_ms:      Minimum milliseconds between two fires with the *same* snapshot hash.
                        A different hash always fires immediately regardless of the window.
        min_char_delta: Reserved for future char-delta gating (v1 ignores it — hash-only).

    State:
        _last_hash:     Hash of the snapshot that last triggered a fire (None = never fired).
        _last_fired_at: Epoch-ms of the last fire (0 = never fired).
    """

    def __init__(self, window_ms: int = 500, min_char_delta: int = 0) -> None:
        self._window_ms = window_ms
        self._min_char_delta = min_char_delta  # reserved for v2 char-delta gating
        self._last_hash: "str | None" = None
        self._last_fired_at: int = 0

    def should_fire(self, snapshot_hash: str, now_ms: int) -> bool:
        """Return True if the cortex should fire for this snapshot at this moment.

        Rules (evaluated in order):
        1. First call ever → True (always fire to prime state).
        2. Different hash from the last fired hash → True (meaningful change).
        3. Same hash AND elapsed < window_ms → False (within quiet window, suppress).
        4. Same hash AND elapsed >= window_ms → True (window expired, re-fire allowed).

        Side-effect: updates _last_hash and _last_fired_at when returning True.
        """
        elapsed = now_ms - self._last_fired_at
        same_hash = self._last_hash == snapshot_hash

        if self._last_hash is not None and same_hash and elapsed < self._window_ms:
            return False

        self._last_hash = snapshot_hash
        self._last_fired_at = now_ms
        return True
