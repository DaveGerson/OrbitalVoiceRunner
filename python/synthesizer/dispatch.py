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
from approval import parse_approval_intent  # noqa: E402
from cortex import decide as cortex_decide  # noqa: E402

# The NDJSON wire protocol version. MUST stay equal to WIRE_VERSION in src/memory/types.ts — a
# mismatch makes the ping handshake fail and the daemon is treated as unavailable (fallback). The
# cross-language equality is guarded by tests/test_wire_version_parity.ts (no silent drift).
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
    if op == "approval.parse":
        try:
            parsed = parse_approval_intent(msg["transcript"])
            return {"id": mid, "v": WIRE_VERSION, "ok": True, "parsed": parsed}
        except Exception as e:  # same per-request blast radius as synthesize
            return {"id": mid, "v": WIRE_VERSION, "ok": False,
                    "error": {"code": "PARSE_FAILED", "message": str(e)}}
    if op == "cortex.decide":
        try:
            out = cortex_decide(msg.get("tiers"), msg.get("ctx"), msg.get("now"))
            return {"id": mid, "v": WIRE_VERSION, "ok": True,
                    "decision": out["decision"], "trace": out["trace"]}
        except Exception as e:  # SHADOW: any failure is a miss on the TS side; daemon must survive
            return {"id": mid, "v": WIRE_VERSION, "ok": False,
                    "error": {"code": "CORTEX_FAILED", "message": str(e)}}
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
