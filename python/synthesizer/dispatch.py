"""Stdio dispatch logic for the Janus context synthesizer (P0b).

Protocol: one JSON object per line on stdin → one JSON object per line on stdout
(NDJSON). stdout is PROTOCOL ONLY; all logs/tracebacks go to stderr. Correlate by `id`.
`main()` runs a long-lived warm daemon, looping until stdin EOF. `handle()` is the pure
message dispatcher (importable + unit-testable).
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from synth import synthesize, SYNTH_VERSION  # noqa: E402

WIRE_VERSION = 1


def handle(msg):
    mid = msg.get("id")
    if msg.get("v") != WIRE_VERSION:
        return {"id": mid, "v": WIRE_VERSION, "ok": False,
                "error": {"code": "BAD_VERSION", "message": "unsupported wire version"}}
    op = msg.get("op")
    if op == "ping":
        return {"id": mid, "v": WIRE_VERSION, "ok": True, "pong": True, "synthVersion": SYNTH_VERSION}
    if op == "synthesize":
        try:
            brief = synthesize(msg["tiers"], msg["cfg"], msg["now"])
            return {"id": mid, "v": WIRE_VERSION, "ok": True, "brief": brief,
                    "meta": {"strategy": "adaptive-extractive", "synthVersion": SYNTH_VERSION}}
        except Exception as e:  # never crash the daemon on one bad request
            return {"id": mid, "v": WIRE_VERSION, "ok": False,
                    "error": {"code": "SYNTH_FAILED", "message": str(e)}}
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
            sys.stderr.write("[synth] skip unparseable line: %s\n" % e)
            sys.stderr.flush()
            continue
        resp = handle(msg)
        sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
        sys.stdout.flush()
