"""Stdio dispatch logic for the Janus "policies" daemon (voice-UX wave 3).

Protocol: one JSON object per line on stdin -> one JSON object per line on stdout (NDJSON). stdout is
PROTOCOL ONLY; all logs/tracebacks go to stderr. Correlate by `id`. `main()` runs a long-lived warm
daemon, looping until stdin EOF. `handle()` is the pure message dispatcher (importable + unit-testable).

Byte-level mirror of python/synthesizer/dispatch.py's shape (same WIRE_VERSION, same ping/handle/main
structure) — routes to focus.py (resolve_focus) and sitrep.py (rank_sitrep) instead of synth/approval/
cortex.

QUIRK (resolved, do NOT "fix"): the ping response reuses the TS PingResponseSchema
(src/memory/types.ts), which requires the key literally named `synthVersion` (a string). This daemon
reuses that schema rather than forking the handshake, so its pong ALSO carries `synthVersion` — set to
POLICIES_VERSION. Renaming this key to `policiesVersion` breaks the handshake silently (permanent
fallback) — see docs/superpowers/specs/2026-07-02-voice-ux-trio-design.md risk #8.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from focus import resolve_focus  # noqa: E402
from sitrep import rank_sitrep  # noqa: E402

# The NDJSON wire protocol version. MUST stay equal to WIRE_VERSION in src/memory/types.ts — a
# mismatch makes the ping handshake fail and the daemon is treated as unavailable (fallback).
WIRE_VERSION = 1
POLICIES_VERSION = "policies-1"


def handle(msg):
    mid = msg.get("id")
    if msg.get("v") != WIRE_VERSION:
        return {"id": mid, "v": WIRE_VERSION, "ok": False,
                "error": {"code": "BAD_VERSION", "message": "unsupported wire version"}}
    op = msg.get("op")
    if op == "ping":
        # QUIRK (see module docstring): the literal key is `synthVersion`, not `policiesVersion`.
        return {"id": mid, "v": WIRE_VERSION, "ok": True, "pong": True, "synthVersion": POLICIES_VERSION}
    if op == "focus.resolve":
        try:
            resolution = resolve_focus(msg["reference"], msg["candidates"])
            return {"id": mid, "v": WIRE_VERSION, "ok": True, "resolution": resolution}
        except Exception as e:  # never crash the daemon on one bad request
            return {"id": mid, "v": WIRE_VERSION, "ok": False,
                    "error": {"code": "FOCUS_FAILED", "message": str(e)}}
    if op == "sitrep.rank":
        try:
            ranking = rank_sitrep(msg["payload"])
            return {"id": mid, "v": WIRE_VERSION, "ok": True, "ranking": ranking}
        except Exception as e:  # same per-request blast radius as focus.resolve
            return {"id": mid, "v": WIRE_VERSION, "ok": False,
                    "error": {"code": "SITREP_FAILED", "message": str(e)}}
    return {"id": mid, "v": WIRE_VERSION, "ok": False,
            "error": {"code": "BAD_OP", "message": "unknown op: %r" % op}}


def main():
    # Defensive UTF-8 (the launcher also passes -X utf8); harmless if already utf-8.
    try:
        sys.stdin.reconfigure(encoding="utf-8")
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception as e:  # unparseable line: log to stderr, skip (do NOT pollute stdout)
            sys.stderr.write("[policies] skip unparseable line: %s\n" % e)
            sys.stderr.flush()
            continue
        resp = handle(msg)
        sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
        sys.stdout.flush()
