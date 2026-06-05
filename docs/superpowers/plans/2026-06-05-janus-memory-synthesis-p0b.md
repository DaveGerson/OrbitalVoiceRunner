# Janus Memory Synthesis — P0b (Python Context Synthesizer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Slot a pre-warmed, optional Python daemon behind `MemoryService.synthesizeAsync` so Gemini Live gets a smarter, budget-reallocated situational brief — while the in-process `assembleBrief` remains an unconditional floor that no setup state can break.

**Architecture:** A warm Python child process speaks line-delimited JSON (NDJSON) over stdio. `synthesizeAsync` owns a 150ms `Promise.race([pythonClient.request(...), timeout])`: Python on a win, `assembleBrief` on any miss. The client handles interpreter discovery, UTF-8-forced spawn (no shell), `id`-correlated framing, a `ping` handshake, respawn-with-backoff, and a circuit breaker. The injector in `src/voice/index.ts` awaits the brief and applies a latest-wins guard so a slow result for a no-longer-active pane is dropped. Python receives only the already-redacted `MemoryTiers`; TS retains authority over `source`.

**Tech Stack:** TypeScript (Node `child_process.spawn`, `zod` — already a dep), Python 3.8+ **stdlib only** (`json`, `sys`, `unittest`), `tsx` for build/test scripts.

**Spec:** `docs/superpowers/specs/2026-06-05-janus-memory-synthesis-p0b-design.md` (decisions D1–D4, invariants I1–I10).
**Bead:** `wsm-e2e-pinned-46v.2.6`.

---

## File Structure

**New files**

| File | Responsibility |
|---|---|
| `python/synthesizer/synth.py` | Pure `synthesize(tiers, cfg, now) -> brief`. Adaptive-extractive logic (D2). No I/O, no clock/env/fs reads (I6). |
| `python/synthesizer/dispatch.py` | Importable stdio dispatch logic: `handle(msg)` (pure message dispatcher) + `main()` (read NDJSON lines → `handle` → write NDJSON; UTF-8 hardened; stdout = protocol only, stderr = logs). |
| `python/synthesizer/__main__.py` | Thin entry the TS client spawns: bootstraps sys.path, calls `dispatch.main()`. |
| `python/synthesizer/tests/test_synth.py` | `unittest` golden tests for `synth.py` (budget reallocation, dedup, ranking, partial/empty, budget cap, determinism). |
| `python/synthesizer/tests/test_dispatch.py` | `unittest` tests for `__main__.handle()` (ping/synthesize/bad-version/bad-op/synth-failure). |
| `src/memory/pythonClient.ts` | The daemon client: interpreter discovery, script-dir resolver, UTF-8 spawn, NDJSON framing + `id` correlation, per-request expiry, `ping` handshake, respawn + circuit breaker, `available()` / `synthesizerState()`. |
| `scripts/copy-python.mjs` | Build step: copy `python/` → `dist/python/` (cross-platform Node fs; excludes `__pycache__` and `tests`). |
| `scripts/run-pytests.ts` | Cross-platform `test:py` runner: reuse `discoverPythonInterpreter`, spawn `unittest`, **exit 0 with a notice when no interpreter exists** (so the JS battery stays green on a Python-less box). |
| `tests/test_memory_python_client.ts` | TS unit tests for `pythonClient.ts` via an injected fake transport (framing, correlation, timeout-cleanup, ping, respawn, breaker). |
| `tests/test_memory_synthesize_async.ts` | TS unit tests for `MemoryService.synthesizeAsync` via a fake client (race → fallback, ok → python, ok:false → fallback, source authority, latest-wins predicate). |
| `tests/test_memory_python_seam.ts` | Cross-seam integration: spawn the **real** daemon → ping → one synthesize round-trip → assert `source:"python"` + budget respected. **Skips** when no interpreter. |

**Modified files**

| File | Change |
|---|---|
| `src/memory/types.ts` | `zod` wire schemas (`PingResponseSchema`, `SynthesizeResponseSchema`), `WIRE_VERSION`, response types. |
| `src/types.ts` | Advanced knobs `memoryPythonEnabled?` (default true), `memorySynthTimeoutMs?` (default 150). |
| `src/memory/index.ts` | `MemoryService.synthesizeAsync` (owns the race + source authority), optional `pythonClient` + `timeoutMs` ctor args, `synthesizerState()`, exported `briefIsForActivePane`; `createMemoryService` wires the optional client. **Sync `synthesize` unchanged.** |
| `src/voice/index.ts` | `injectMemoryBrief` becomes `async`: `await synthesizeAsync`, latest-wins guard, one inject. The three call sites + `orient.ts` are unchanged (fire-and-forget ignores the returned promise). |
| `src/actions/types.ts` | `ActionContext.memorySynthesizerState?: () => "python" \| "fallback"` (mirrors the optional `injectMemoryBrief?` seam). |
| `src/actions/defs/observability.ts` | `get_health` output gains `memory: { synthesizer: ctx.memorySynthesizerState?.() ?? "fallback" }`. |
| `server.ts` | Construct + eagerly pre-warm the optional `PythonSynthClient`, pass it (and `memorySynthTimeoutMs`) into `createMemoryService`; wire `memorySynthesizerState` in `buildRestActionContext`. |
| `package.json` | `build` chains `&& node scripts/copy-python.mjs`; add `"test:py": "tsx scripts/run-pytests.ts"`. |
| `.gitignore` | `python/**/__pycache__/`. |

---

## Task 1: Wire schemas + settings knobs (TS)

**Files:**
- Modify: `src/memory/types.ts`
- Modify: `src/types.ts:287-292`
- Test: `tests/test_memory_wire_schema.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/test_memory_wire_schema.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { WIRE_VERSION, PingResponseSchema, SynthesizeResponseSchema } from "../src/memory/types";

test("WIRE_VERSION is 1", () => {
  assert.equal(WIRE_VERSION, 1);
});

test("PingResponseSchema accepts a valid pong", () => {
  const r = PingResponseSchema.safeParse({ id: "u1", v: 1, ok: true, pong: true, synthVersion: "1.0.0" });
  assert.equal(r.success, true);
});

test("PingResponseSchema rejects a wrong wire version", () => {
  const r = PingResponseSchema.safeParse({ id: "u1", v: 2, ok: true, pong: true, synthVersion: "1.0.0" });
  assert.equal(r.success, false);
});

test("SynthesizeResponseSchema accepts a valid brief", () => {
  const r = SynthesizeResponseSchema.safeParse({
    id: "u2", v: 1, ok: true,
    brief: { text: "PROJECT x", perTierChars: { project: 9 }, activePaneId: "p1" },
    meta: { strategy: "adaptive-extractive", synthVersion: "1.0.0" },
  });
  assert.equal(r.success, true);
});

test("SynthesizeResponseSchema rejects a brief missing text", () => {
  const r = SynthesizeResponseSchema.safeParse({
    id: "u2", v: 1, ok: true, brief: { perTierChars: {}, activePaneId: null },
  });
  assert.equal(r.success, false);
});

test("SynthesizeResponseSchema accepts an error response", () => {
  const r = SynthesizeResponseSchema.safeParse({
    id: "u2", v: 1, ok: false, error: { code: "SYNTH_FAILED", message: "boom" },
  });
  assert.equal(r.success, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test --test-force-exit tests/test_memory_wire_schema.ts`
Expected: FAIL — `WIRE_VERSION` / schemas not exported from `../src/memory/types`.

- [ ] **Step 3: Add schemas to `src/memory/types.ts`**

Append to `src/memory/types.ts` (after the existing `DEFAULT_MEMORY_CONFIG`):

```ts
import { z } from "zod";

/** The NDJSON wire protocol version. A mismatch ⇒ daemon treated as unavailable ⇒ fallback. */
export const WIRE_VERSION = 1;

/** Shape of the brief Python returns (TS stamps `source` authoritatively; Python cannot claim it). */
export const PythonBriefSchema = z.object({
  text: z.string(),
  perTierChars: z.record(z.string(), z.number()),
  activePaneId: z.string().nullable(),
});

export const PingResponseSchema = z.object({
  id: z.string(),
  v: z.literal(WIRE_VERSION),
  ok: z.literal(true),
  pong: z.literal(true),
  synthVersion: z.string(),
});

export const SynthesizeResponseSchema = z.union([
  z.object({
    id: z.string(),
    v: z.literal(WIRE_VERSION),
    ok: z.literal(true),
    brief: PythonBriefSchema,
    meta: z.object({ strategy: z.string(), synthVersion: z.string() }).optional(),
  }),
  z.object({
    id: z.string(),
    v: z.literal(WIRE_VERSION),
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string() }),
  }),
]);

export type PingResponse = z.infer<typeof PingResponseSchema>;
export type SynthesizeResponse = z.infer<typeof SynthesizeResponseSchema>;
```

> Note: `zod` v4 is already a dependency (`package.json`). Import style matches the rest of the repo (`import { z } from "zod"`).

- [ ] **Step 4: Add the advanced settings knobs**

In `src/types.ts`, inside the `advanced` block, immediately after line 292 (`breadcrumbMaxAgeMs?: number;`):

```ts
    // Janus Memory Synthesis P0b (advanced, optional/additive). The Python Context Synthesizer
    // is a STRICT UPGRADE, never a dependency — disabling it (or its absence) silently falls
    // back to the in-process deterministic assembler. See docs/.../p0b-design.md (D1/D3).
    memoryPythonEnabled?: boolean;   // default true — master switch for the Python synthesizer
    memorySynthTimeoutMs?: number;   // default 150 — per-call race deadline before fallback
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx --test --test-force-exit tests/test_memory_wire_schema.ts`
Expected: PASS (6/6).

- [ ] **Step 6: Lint + commit**

```bash
npm run lint
git add src/memory/types.ts src/types.ts tests/test_memory_wire_schema.ts
git commit -m "feat(memory): P0b wire schemas (zod) + python synth settings knobs"
```

---

## Task 2: The pure Python synthesizer + golden tests

**Files:**
- Create: `python/synthesizer/synth.py`
- Test: `python/synthesizer/tests/test_synth.py`

- [ ] **Step 1: Write the failing test**

Create `python/synthesizer/tests/test_synth.py`:

```python
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from synth import synthesize, SYNTH_VERSION  # noqa: E402

CFG = {
    "totalBudgetChars": 4800,
    "weights": {"project": 0.40, "pane": 0.30, "breadcrumbs": 0.15, "board": 0.10, "frame": 0.05},
    "breadcrumbMax": 12,
    "breadcrumbMaxAgeMs": 900000,
}
FRAME = {"role": "Janus", "gatePosture": "Human-in-the-Loop", "prefs": []}


def tiers(**kw):
    base = {"project": None, "pane": None, "board": [], "frame": FRAME, "breadcrumbs": []}
    base.update(kw)
    return base


class SynthTest(unittest.TestCase):
    def test_version_string(self):
        self.assertRegex(SYNTH_VERSION, r"^\d+\.\d+\.\d+$")

    def test_empty_tiers_render_only_frame(self):
        out = synthesize(tiers(), CFG, 0)
        self.assertIn("FRAME Janus", out["text"])
        self.assertNotIn("PROJECT", out["text"])
        self.assertLessEqual(len(out["text"]), CFG["totalBudgetChars"])
        self.assertIsNone(out["activePaneId"])

    def test_active_pane_id_propagates(self):
        out = synthesize(tiers(pane={"paneId": "p1", "name": "build", "runtimeType": "claude",
                                     "status": "Running", "lastCommand": "npm test", "recent": []}), CFG, 0)
        self.assertEqual(out["activePaneId"], "p1")
        self.assertIn("ACTIVE PANE build", out["text"])

    def test_breadcrumb_dedup(self):
        crumbs = [{"ts": 3, "paneId": "p1", "text": "ran tests"},
                  {"ts": 2, "paneId": "p1", "text": "ran tests"},
                  {"ts": 1, "paneId": "p1", "text": "edited file"}]
        out = synthesize(tiers(breadcrumbs=crumbs), CFG, 0)
        self.assertEqual(out["text"].count("ran tests"), 1)
        self.assertIn("edited file", out["text"])

    def test_board_drops_idle_and_exited_and_ranks_active_first(self):
        board = [{"paneId": "p2", "name": "idleone", "status": "Idle"},
                 {"paneId": "p3", "name": "dead", "status": "Exited"},
                 {"paneId": "p4", "name": "other", "status": "Running"},
                 {"paneId": "p1", "name": "focus", "status": "Running"}]
        out = synthesize(tiers(pane={"paneId": "p1", "name": "focus", "runtimeType": "claude",
                                     "status": "Running", "lastCommand": None, "recent": []},
                               board=board), CFG, 0)
        self.assertNotIn("idleone", out["text"])
        self.assertNotIn("dead", out["text"])
        # active pane (focus) ranks before other on the board line
        line = [ln for ln in out["text"].splitlines() if ln.startswith("BOARD:")][0]
        self.assertLess(line.index("focus"), line.index("other"))

    def test_budget_reallocation_gives_pane_more_than_base(self):
        # Only pane present: project/board/breadcrumbs budgets free to the active pane.
        long_recent = ["x" * 400 for _ in range(8)]
        out = synthesize(tiers(pane={"paneId": "p1", "name": "build", "runtimeType": "claude",
                                     "status": "Running", "lastCommand": "go", "recent": long_recent}), CFG, 0)
        base_pane = int(CFG["totalBudgetChars"] * 0.30)
        self.assertGreater(out["perTierChars"]["pane"], base_pane)
        self.assertLessEqual(len(out["text"]), CFG["totalBudgetChars"])

    def test_budget_never_exceeded_under_huge_input(self):
        huge = {"projectId": "x", "name": "P" * 5000, "summary": "S" * 50000,
                "keyTerms": ["term"] * 500, "recentDecisions": ["d" * 1000] * 50}
        out = synthesize(tiers(project=huge,
                               pane={"paneId": "p1", "name": "n" * 5000, "runtimeType": "claude",
                                     "status": "Running", "lastCommand": "c" * 5000,
                                     "recent": ["r" * 5000] * 50}), CFG, 0)
        self.assertLessEqual(len(out["text"]), CFG["totalBudgetChars"])

    def test_deterministic(self):
        t = tiers(project={"projectId": "x", "name": "Janus", "summary": "A voice orchestrator. It runs panes.",
                           "keyTerms": ["pane"], "recentDecisions": []},
                  pane={"paneId": "p1", "name": "build", "runtimeType": "claude",
                        "status": "Running", "lastCommand": "npm test", "recent": ["ok"]})
        a = synthesize(t, CFG, 1733443200000)
        b = synthesize(t, CFG, 1733443200000)
        self.assertEqual(a, b)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run (Windows): `py -3 -m unittest discover -s python/synthesizer/tests -p "test_*.py" -v`
Run (Linux): `python3 -m unittest discover -s python/synthesizer/tests -p "test_*.py" -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'synth'`.

- [ ] **Step 3: Write `python/synthesizer/synth.py`**

```python
"""Pure adaptive-extractive context synthesizer (Janus P0b, decision D2).

Stdlib only. Deterministic: the output is a pure function of (tiers, cfg, now).
NEVER reads the clock, env, or filesystem (invariant I6). `now` is accepted for
contract symmetry but breadcrumb decay was already applied in TypeScript.

`tiers` is the already-redacted MemoryTiers struct (invariant I5) — this module
performs NO redaction and is never handed raw text.
"""

SYNTH_VERSION = "1.0.0"
_ELLIPSIS = "…"


def _cap(s, n):
    if n <= 0:
        return ""
    if len(s) <= n:
        return s
    return s[: max(0, n - 1)] + _ELLIPSIS


def _norm(s):
    return " ".join((s or "").lower().split())


def _salient_summary(summary, key_terms, budget):
    """Keep the first sentence plus any sentence mentioning a key term, in order."""
    if not summary or budget <= 0:
        return ""
    parts = [p.strip() for p in summary.replace("\n", " ").split(". ") if p.strip()]
    if not parts:
        return _cap(summary, budget)
    terms = [t.lower() for t in (key_terms or [])]
    chosen = [parts[0]]
    for p in parts[1:]:
        pl = p.lower()
        if any(t in pl for t in terms):
            chosen.append(p)
    text = ". ".join(chosen)
    if not text.endswith("."):
        text += "."
    return _cap(text, budget)


def _dedupe_breadcrumbs(crumbs):
    seen = set()
    out = []
    for b in crumbs or []:
        key = _norm(b.get("text", ""))
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(b)
    return out


def _rank_board(board, active_id):
    def keep(e):
        return str(e.get("status", "")).lower() not in ("idle", "exited")

    filtered = [e for e in (board or []) if keep(e)]

    def rank(e):
        running = 0 if str(e.get("status", "")).lower() == "running" else 1
        return (0 if e.get("paneId") == active_id else 1, running)

    return sorted(filtered, key=rank)  # stable: ties keep input order ⇒ deterministic


def synthesize(tiers, cfg, now):
    total = int(cfg.get("totalBudgetChars", 4800))
    w = cfg.get("weights", {}) or {}
    base = {
        "project": int(total * float(w.get("project", 0.40))),
        "pane": int(total * float(w.get("pane", 0.30))),
        "breadcrumbs": int(total * float(w.get("breadcrumbs", 0.15))),
        "board": int(total * float(w.get("board", 0.10))),
        "frame": int(total * float(w.get("frame", 0.05))),
    }

    project = tiers.get("project")
    pane = tiers.get("pane")
    crumbs = _dedupe_breadcrumbs(tiers.get("breadcrumbs"))
    active_id = pane.get("paneId") if pane else None
    board = _rank_board(tiers.get("board"), active_id)
    frame = tiers.get("frame") or {}

    # Adaptive reallocation: budget from absent/empty tiers flows to the active pane (70%) + project (30%).
    present = {"frame"}
    if project:
        present.add("project")
    if pane:
        present.add("pane")
    if crumbs:
        present.add("breadcrumbs")
    if board:
        present.add("board")
    freed = sum(base[t] for t in base if t not in present)
    budgets = dict(base)
    add_pane = (freed * 7) // 10
    budgets["pane"] += add_pane
    budgets["project"] += freed - add_pane

    per = {}
    blocks = []

    if project:
        name = project.get("name", "")
        summary = _salient_summary(
            project.get("summary", ""), project.get("keyTerms"),
            max(0, budgets["project"] - len(name) - 16),
        )
        body = "PROJECT %s: %s" % (name, summary)
        terms = project.get("keyTerms") or []
        if terms:
            body += " | terms: " + ", ".join(terms)
        decisions = project.get("recentDecisions") or []
        if decisions:
            body += " | decisions: " + "; ".join(decisions[:3])
        body = _cap(body, budgets["project"])
        per["project"] = len(body)
        blocks.append(body)

    if pane:
        body = "ACTIVE PANE %s (%s, %s)" % (
            pane.get("name", ""), pane.get("status", ""), pane.get("runtimeType", ""))
        if pane.get("lastCommand"):
            body += " last: %s" % pane["lastCommand"]
        recent = pane.get("recent") or []
        if recent:
            body += " | recent: " + "; ".join(recent[:6])
        body = _cap(body, budgets["pane"])
        per["pane"] = len(body)
        blocks.append(body)

    if crumbs:
        body = _cap("RECENTLY: " + " · ".join(b.get("text", "") for b in crumbs), budgets["breadcrumbs"])
        per["breadcrumbs"] = len(body)
        blocks.append(body)

    if board:
        body = _cap(
            "BOARD: " + ", ".join("%s=%s" % (e.get("name", ""), e.get("status", "")) for e in board),
            budgets["board"])
        per["board"] = len(body)
        blocks.append(body)

    fbody = "FRAME %s | gates: %s" % (frame.get("role", ""), frame.get("gatePosture", ""))
    prefs = frame.get("prefs") or []
    if prefs:
        fbody += " | prefs: " + "; ".join(prefs)
    fbody = _cap(fbody, budgets["frame"])
    per["frame"] = len(fbody)
    blocks.append(fbody)

    text = "\n".join(blocks)
    if len(text) > total:  # hard guarantee I7 (newline joins can add a few chars over the per-tier caps)
        text = text[:total]
    return {"text": text, "perTierChars": per, "activePaneId": active_id}
```

- [ ] **Step 4: Run test to verify it passes**

Run (Windows): `py -3 -m unittest discover -s python/synthesizer/tests -p "test_*.py" -v`
Expected: PASS (8 tests OK).

- [ ] **Step 5: Commit**

```bash
git add python/synthesizer/synth.py python/synthesizer/tests/test_synth.py
git commit -m "feat(memory): P0b pure python synthesizer (adaptive-extractive, stdlib) + golden tests"
```

---

## Task 3: The stdio dispatch loop (Python)

**Files:**
- Create: `python/synthesizer/dispatch.py` (importable: `handle()` + `main()` — the testable logic)
- Create: `python/synthesizer/__main__.py` (thin entry; this is the file the TS client spawns)
- Test: `python/synthesizer/tests/test_dispatch.py`

> Why the split: Python reserves the module name `__main__` for the currently-running entry module, so a test cannot `import __main__` to reach `python/synthesizer/__main__.py` — it would import the test runner's own main. Putting `handle()`/`main()` in `dispatch.py` makes them importable; `__main__.py` is a one-line entry that the daemon-spawn launches.

- [ ] **Step 1: Write the failing test**

Create `python/synthesizer/tests/test_dispatch.py`:

```python
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import dispatch  # noqa: E402

CFG = {"totalBudgetChars": 4800,
       "weights": {"project": 0.40, "pane": 0.30, "breadcrumbs": 0.15, "board": 0.10, "frame": 0.05},
       "breadcrumbMax": 12, "breadcrumbMaxAgeMs": 900000}
TIERS = {"project": None, "pane": None, "board": [],
         "frame": {"role": "Janus", "gatePosture": "Auto", "prefs": []}, "breadcrumbs": []}


class DispatchTest(unittest.TestCase):
    def test_ping_pongs_with_version(self):
        r = dispatch.handle({"id": "u1", "v": 1, "op": "ping"})
        self.assertEqual(r["id"], "u1")
        self.assertTrue(r["ok"])
        self.assertTrue(r["pong"])
        self.assertEqual(r["v"], 1)
        self.assertIn("synthVersion", r)

    def test_synthesize_returns_brief(self):
        r = dispatch.handle({"id": "u2", "v": 1, "op": "synthesize", "now": 0, "cfg": CFG, "tiers": TIERS})
        self.assertTrue(r["ok"])
        self.assertIn("text", r["brief"])
        self.assertEqual(r["meta"]["strategy"], "adaptive-extractive")

    def test_bad_version_rejected(self):
        r = dispatch.handle({"id": "u3", "v": 99, "op": "ping"})
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"]["code"], "BAD_VERSION")

    def test_unknown_op_rejected(self):
        r = dispatch.handle({"id": "u4", "v": 1, "op": "frobnicate"})
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"]["code"], "BAD_OP")

    def test_synth_failure_is_caught(self):
        # tiers=None makes synth raise (AttributeError on .get); must surface as SYNTH_FAILED, never crash.
        r = dispatch.handle({"id": "u5", "v": 1, "op": "synthesize", "now": 0, "cfg": CFG, "tiers": None})
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"]["code"], "SYNTH_FAILED")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `py -3 -m unittest discover -s python/synthesizer/tests -p "test_*.py" -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'dispatch'`.

- [ ] **Step 3: Write `python/synthesizer/dispatch.py` (the importable logic)**

```python
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
```

- [ ] **Step 3b: Write `python/synthesizer/__main__.py` (the thin spawn entry)**

```python
"""Entry point the TS client spawns: `python -X utf8 -u <dir>/synthesizer/__main__.py`.
Bootstraps the synthesizer dir onto sys.path so `import dispatch` resolves whether launched
as a file path (sys.path[0] = this dir) or via `-m`, then runs the daemon loop.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dispatch import main  # noqa: E402

if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `py -3 -m unittest discover -s python/synthesizer/tests -p "test_*.py" -v`
Expected: PASS (all synth + dispatch tests OK).

- [ ] **Step 5: Commit**

```bash
git add python/synthesizer/dispatch.py python/synthesizer/__main__.py python/synthesizer/tests/test_dispatch.py
git commit -m "feat(memory): P0b stdio dispatch loop (NDJSON ping/synthesize) + tests"
```

---

## Task 4: The TS daemon client — discovery, spawn, framing, ping, timeout

**Files:**
- Create: `src/memory/pythonClient.ts`
- Test: `tests/test_memory_python_client.ts`

This task delivers the client's full spawn lifecycle — interpreter-candidate iteration (via the ping-timeout, per D4 discovery order), crash-respawn with exponential backoff, NDJSON framing, `id` correlation, and the per-request expiry. The **circuit breaker** (the storm cap) is the only piece deferred to Task 5. The transport is injectable (`spawnImpl`) so the whole lifecycle is unit-testable without a real process.

- [ ] **Step 1: Write the failing test**

Create `tests/test_memory_python_client.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createPythonSynthClient, discoverPythonInterpreter, resolveSynthDir } from "../src/memory/pythonClient";
import { DEFAULT_MEMORY_CONFIG, type MemoryTiers } from "../src/memory/types";

const FRAME = { role: "Janus", gatePosture: "Auto", prefs: [] };
const TIERS: MemoryTiers = { project: null, pane: null, board: [], frame: FRAME, breadcrumbs: [] };

// A fake child process: captures stdin writes, lets the test emit stdout lines + exit.
class FakeChild extends EventEmitter {
  stdin = { write: (s: string) => { this.written.push(s); return true; } };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  written: string[] = [];
  killed = false;
  kill() { this.killed = true; }
  // helper: respond to the most recent request line with a given object (echoes its id)
  reply(obj: Record<string, unknown>) {
    const last = JSON.parse(this.written[this.written.length - 1]);
    this.stdout.emit("data", Buffer.from(JSON.stringify({ id: last.id, ...obj }) + "\n"));
  }
  lastReq() { return JSON.parse(this.written[this.written.length - 1]); }
}

function makeClient(child: FakeChild, over: Record<string, unknown> = {}) {
  return createPythonSynthClient({
    moduleDir: "/repo/src/memory",
    repoRoot: "/repo",
    timeoutMs: 50,
    existsSync: () => true,             // resolver: pretend python dir exists
    spawnImpl: (() => child) as any,    // ignore argv, hand back our fake
    log: () => {},
    ...over,
  });
}

test("discoverPythonInterpreter honors JANUS_PYTHON override first", () => {
  const cands = discoverPythonInterpreter({ JANUS_PYTHON: "/usr/bin/py3" } as any, "linux");
  assert.equal(cands[0].cmd, "/usr/bin/py3");
});

test("discoverPythonInterpreter Windows order is py -3, python, python3", () => {
  const cands = discoverPythonInterpreter({} as any, "win32");
  assert.deepEqual(cands.map((c) => `${c.cmd} ${c.baseArgs.join(" ")}`.trim()), ["py -3", "python", "python3"]);
});

test("discoverPythonInterpreter Linux order is python3, python", () => {
  const cands = discoverPythonInterpreter({} as any, "linux");
  assert.deepEqual(cands.map((c) => c.cmd), ["python3", "python"]);
});

test("resolveSynthDir prefers the override, then moduleDir/python, then repoRoot/python", () => {
  assert.equal(resolveSynthDir({ override: "/X", moduleDir: "/m", repoRoot: "/r" }, () => true), "/X");
  assert.equal(resolveSynthDir({ moduleDir: "/m", repoRoot: "/r" }, (p) => p.startsWith("/r")), "/r/python");
  assert.equal(resolveSynthDir({ moduleDir: "/m", repoRoot: "/r" }, () => false), null);
});

test("ping handshake marks the client available", async () => {
  const child = new FakeChild();
  const client = makeClient(child);
  // client spawns + sends a ping on construction; satisfy it
  await new Promise((r) => setImmediate(r));
  child.reply({ v: 1, ok: true, pong: true, synthVersion: "1.0.0" });
  await new Promise((r) => setImmediate(r));
  assert.equal(client.available(), true);
  client.dispose();
});

test("request correlates a response by id and returns the brief", async () => {
  const child = new FakeChild();
  const client = makeClient(child);
  await new Promise((r) => setImmediate(r));
  child.reply({ v: 1, ok: true, pong: true, synthVersion: "1.0.0" });
  await new Promise((r) => setImmediate(r));
  const p = client.request(TIERS, DEFAULT_MEMORY_CONFIG, 0);
  await new Promise((r) => setImmediate(r));
  assert.equal(child.lastReq().op, "synthesize");
  child.reply({ v: 1, ok: true, brief: { text: "PROJECT x", perTierChars: { project: 9 }, activePaneId: null } });
  const res = await p;
  assert.equal(res.ok, true);
  assert.equal(res.ok && res.brief.text, "PROJECT x");
  client.dispose();
});

test("request resolves ok:false on a daemon error response", async () => {
  const child = new FakeChild();
  const client = makeClient(child);
  await new Promise((r) => setImmediate(r));
  child.reply({ v: 1, ok: true, pong: true, synthVersion: "1.0.0" });
  await new Promise((r) => setImmediate(r));
  const p = client.request(TIERS, DEFAULT_MEMORY_CONFIG, 0);
  await new Promise((r) => setImmediate(r));
  child.reply({ v: 1, ok: false, error: { code: "SYNTH_FAILED", message: "boom" } });
  const res = await p;
  assert.equal(res.ok, false);
  client.dispose();
});

test("request resolves ok:false when the daemon is silent (internal expiry, no leak)", async () => {
  const child = new FakeChild();
  const client = makeClient(child, { requestExpiryMs: 30 });
  await new Promise((r) => setImmediate(r));
  child.reply({ v: 1, ok: true, pong: true, synthVersion: "1.0.0" });
  await new Promise((r) => setImmediate(r));
  const res = await client.request(TIERS, DEFAULT_MEMORY_CONFIG, 0); // never replied
  assert.equal(res.ok, false);
  client.dispose();
});

test("a v-mismatch ping leaves the client unavailable", async () => {
  const child = new FakeChild();
  const client = makeClient(child);
  await new Promise((r) => setImmediate(r));
  child.reply({ v: 2, ok: true, pong: true, synthVersion: "1.0.0" });
  await new Promise((r) => setImmediate(r));
  assert.equal(client.available(), false);
  client.dispose();
});

test("falls through to the next interpreter candidate when the first never pings (D4/I9)", async () => {
  const children: FakeChild[] = [];
  const client = createPythonSynthClient({
    moduleDir: "/m", repoRoot: "/r", existsSync: () => true, log: () => {},
    platform: "win32", pingTimeoutMs: 20, backoffBaseMs: 5, backoffMaxMs: 5,
    spawnImpl: (() => { const c = new FakeChild(); children.push(c); return c; }) as any,
  });
  // first candidate (py -3) spawns but never pings → ping-timeout advances to the next candidate
  await new Promise((r) => setTimeout(r, 45));
  assert.ok(children.length >= 2, "should have spawned a second candidate after the ping-timeout");
  children[children.length - 1].reply({ v: 1, ok: true, pong: true, synthVersion: "1.0.0" });
  await new Promise((r) => setImmediate(r));
  assert.equal(client.available(), true);
  client.dispose();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test --test-force-exit tests/test_memory_python_client.ts`
Expected: FAIL — `../src/memory/pythonClient` does not exist.

- [ ] **Step 3: Write `src/memory/pythonClient.ts`**

```ts
// src/memory/pythonClient.ts — the warm Python synthesizer daemon client (P0b, D3/D4).
// Optional + self-healing: a strict UPGRADE, never a dependency. Mirrors the node-pty
// loader posture in src/ptyTransport.ts (try → degrade to a flag, never throw at the seam).
import { spawn as realSpawn } from "child_process";
import { fileURLToPath } from "url";
import * as nodePath from "path";
import * as fs from "fs";
import {
  WIRE_VERSION,
  PingResponseSchema,
  SynthesizeResponseSchema,
  type MemoryTiers,
  type MemoryConfig,
} from "./types";

export type SynthesizeResult =
  | { ok: true; brief: { text: string; perTierChars: Record<string, number>; activePaneId: string | null } }
  | { ok: false };

export interface PythonSynthClient {
  /** Request a synthesized brief. Resolves ok:false on any miss; NEVER rejects. */
  request(tiers: MemoryTiers, cfg: MemoryConfig, now: number): Promise<SynthesizeResult>;
  /** True only when a daemon has answered a ping and the breaker is closed. */
  available(): boolean;
  /** Observability: which path the next call would take. */
  synthesizerState(): "python" | "fallback";
  /** Tear down the child + timers (idempotent). */
  dispose(): void;
}

interface InterpreterCandidate { cmd: string; baseArgs: string[]; }

export interface PythonSynthClientOpts {
  moduleDir: string;
  repoRoot: string;
  timeoutMs?: number;            // (unused by the client itself; the race lives in synthesizeAsync)
  requestExpiryMs?: number;      // internal pending-entry hard expiry (default 2000) — prevents id leaks
  pingTimeoutMs?: number;        // per-spawn handshake deadline; a miss advances to the next candidate (default 1500)
  interpreterOverride?: string;  // JANUS_PYTHON
  synthDirOverride?: string;     // JANUS_PYTHON_SYNTH_DIR
  platform?: string;
  env?: NodeJS.ProcessEnv;
  spawnImpl?: typeof realSpawn;
  existsSync?: (p: string) => boolean;
  log?: (line: string) => void;
  backoffBaseMs?: number; backoffMaxMs?: number;
  // Task 5 breaker knobs (declared now so the type is stable across tasks):
  breakerThreshold?: number; breakerWindowMs?: number; cooldownMs?: number;
}

/** Ordered interpreter candidates: JANUS_PYTHON wins, else per-platform discovery (D4). */
export function discoverPythonInterpreter(env: NodeJS.ProcessEnv, platform: string): InterpreterCandidate[] {
  const override = env.JANUS_PYTHON && env.JANUS_PYTHON.trim();
  if (override) return [{ cmd: override, baseArgs: [] }];
  if (platform === "win32") {
    return [{ cmd: "py", baseArgs: ["-3"] }, { cmd: "python", baseArgs: [] }, { cmd: "python3", baseArgs: [] }];
  }
  return [{ cmd: "python3", baseArgs: [] }, { cmd: "python", baseArgs: [] }];
}

/** First-exists of [override, moduleDir/python, repoRoot/python] that contains synthesizer/__main__.py. */
export function resolveSynthDir(
  opts: { override?: string; moduleDir: string; repoRoot: string },
  existsSync: (p: string) => boolean,
): string | null {
  const candidates = [
    opts.override,
    nodePath.join(opts.moduleDir, "python"),
    nodePath.join(opts.repoRoot, "python"),
  ].filter(Boolean) as string[];
  for (const dir of candidates) {
    if (existsSync(nodePath.join(dir, "synthesizer", "__main__.py"))) return dir;
    if (opts.override && dir === opts.override && existsSync(dir)) return dir; // override may already be a leaf
  }
  return null;
}

/** Compute this module's directory in both tsx/ESM (dev) and the esbuild CJS bundle (prod). */
export function defaultModuleDir(): string {
  // In the esbuild CJS bundle `__dirname` is defined (so `import.meta.url` is never evaluated);
  // under tsx/ESM `__dirname` is undefined and we fall back to `import.meta.url`. This mirrors the
  // dual-runtime idiom already proven in src/ptyTransport.ts (which builds clean to dist/server.cjs).
  return typeof __dirname !== "undefined" ? __dirname : nodePath.dirname(fileURLToPath(import.meta.url));
}

interface Pending {
  resolve: (r: SynthesizeResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function createPythonSynthClient(opts: PythonSynthClientOpts): PythonSynthClient {
  const spawnImpl = opts.spawnImpl ?? realSpawn;
  const existsSync = opts.existsSync ?? fs.existsSync;
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((l: string) => console.error(l));
  const requestExpiryMs = opts.requestExpiryMs ?? 2000;
  const pingTimeoutMs = opts.pingTimeoutMs ?? 1500;
  const backoffBaseMs = opts.backoffBaseMs ?? 250;
  const backoffMaxMs = opts.backoffMaxMs ?? 2000;

  const synthDir = resolveSynthDir(
    { override: opts.synthDirOverride ?? env.JANUS_PYTHON_SYNTH_DIR, moduleDir: opts.moduleDir, repoRoot: opts.repoRoot },
    existsSync,
  );
  const cands = discoverPythonInterpreter(env, platform);

  let child: any = null;
  let ready = false;             // a ping has ponged with a matching wire version
  let disposed = false;
  let buf = "";
  let seq = 0;
  const pending = new Map<string, Pending>();
  let candIndex = 0;             // which interpreter candidate we're on
  let discovering = true;        // true until one candidate pings OK (then we lock it)
  let attempt = 0;               // backoff exponent
  let pingTimer: ReturnType<typeof setTimeout> | null = null;
  let respawnTimer: ReturnType<typeof setTimeout> | null = null;

  function settleAll(result: SynthesizeResult) {
    for (const [, p] of pending) { clearTimeout(p.timer); p.resolve(result); }
    pending.clear();
  }
  function clearPingTimer() { if (pingTimer) { clearTimeout(pingTimer); pingTimer = null; } }

  function onLine(line: string) {
    line = line.trim();
    if (!line) return;
    let obj: any;
    try { obj = JSON.parse(line); } catch { log(`[synth] skip unparseable stdout line`); return; }
    const id = obj?.id;
    if (id === "__ping__") {
      if (PingResponseSchema.safeParse(obj).success) {
        ready = true; discovering = false; attempt = 0; clearPingTimer();
        log(`[synth] ping ok (synthVersion=${obj?.synthVersion ?? "?"})`);
      } else {
        log(`[synth] ping rejected (v/shape mismatch)`); // the ping-timeout drives the candidate advance
      }
      return;
    }
    const p = pending.get(id);
    if (!p) return; // late/expired — ignore defensively
    pending.delete(id);
    clearTimeout(p.timer);
    const parsed = SynthesizeResponseSchema.safeParse(obj);
    if (parsed.success && parsed.data.ok) p.resolve({ ok: true, brief: parsed.data.brief });
    else p.resolve({ ok: false });
  }

  // Task 5 overrides this to veto a (re)spawn while the breaker is OPEN. Default: always allowed.
  function spawnBlocked(): boolean { return false; }

  function onDown(reason: string) {
    clearPingTimer();
    try { child?.kill(); } catch { /* already dead */ }
    ready = false; child = null;
    settleAll({ ok: false });
    log(`[synth] daemon down (${reason})`);
    if (discovering) candIndex = (candIndex + 1) % Math.max(1, cands.length); // try the next interpreter
    scheduleRespawn();
  }

  function scheduleRespawn() {
    if (disposed || !synthDir || cands.length === 0) return;
    const wait = Math.min(backoffMaxMs, backoffBaseMs * Math.pow(2, attempt++));
    respawnTimer = setTimeout(spawnDaemon, wait);
    if (respawnTimer && typeof (respawnTimer as any).unref === "function") (respawnTimer as any).unref();
  }

  function spawnDaemon() {
    if (disposed || !synthDir || cands.length === 0) return;
    if (spawnBlocked()) return;
    const c = cands[candIndex % cands.length];
    const script = nodePath.join(synthDir, "synthesizer", "__main__.py");
    const args = [...c.baseArgs, "-X", "utf8", "-u", script];
    try {
      child = spawnImpl(c.cmd, args, {
        cwd: synthDir,
        env: { ...env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
        stdio: ["pipe", "pipe", "pipe"],
        // NEVER shell:true — argv array only (invariant I9).
      });
    } catch (e) {
      log(`[synth] spawn failed for "${c.cmd}": ${(e as Error).message}`);
      onDown("spawn-threw");
      return;
    }
    child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString("utf-8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); onLine(line); }
    });
    child.stderr?.on("data", (d: Buffer) => log(`[synth:py] ${d.toString("utf-8").trimEnd()}`));
    child.on("exit", () => onDown("exit"));
    child.on("error", () => onDown("error"));
    // Handshake: ping validates interpreter + script + protocol version in one round-trip.
    // If no valid pong lands within pingTimeoutMs, advance to the next candidate (D4 discovery).
    pingTimer = setTimeout(() => { if (!ready) onDown("ping-timeout"); }, pingTimeoutMs);
    if (pingTimer && typeof (pingTimer as any).unref === "function") (pingTimer as any).unref();
    try { child.stdin?.write(JSON.stringify({ id: "__ping__", v: WIRE_VERSION, op: "ping" }) + "\n"); }
    catch { onDown("stdin-write-failed"); }
  }

  spawnDaemon(); // eager pre-warm

  return {
    available() { return ready && !!child; },
    synthesizerState() { return ready && child ? "python" : "fallback"; },
    request(tiers, cfg, now) {
      if (disposed || !ready || !child) return Promise.resolve({ ok: false });
      const id = `r${++seq}`;
      return new Promise<SynthesizeResult>((resolve) => {
        const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false }); }, requestExpiryMs);
        if (typeof (timer as any).unref === "function") (timer as any).unref();
        pending.set(id, { resolve, timer });
        try {
          child.stdin.write(JSON.stringify({ id, v: WIRE_VERSION, op: "synthesize", now, cfg, tiers }) + "\n");
        } catch {
          pending.delete(id); clearTimeout(timer); resolve({ ok: false });
        }
      });
    },
    dispose() {
      disposed = true; ready = false;
      clearPingTimer();
      if (respawnTimer) { clearTimeout(respawnTimer); respawnTimer = null; }
      settleAll({ ok: false });
      try { child?.kill(); } catch { /* already dead */ }
      child = null;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test --test-force-exit tests/test_memory_python_client.ts`
Expected: PASS (all framing/discovery/resolver/ping/timeout tests).

- [ ] **Step 5: Lint + commit**

```bash
npm run lint
git add src/memory/pythonClient.ts tests/test_memory_python_client.ts
git commit -m "feat(memory): P0b python daemon client (discovery, UTF-8 spawn, NDJSON framing, ping)"
```

---

## Task 5: Respawn with backoff + circuit breaker (TS)

**Files:**
- Modify: `src/memory/pythonClient.ts`
- Test: `tests/test_memory_python_client_breaker.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/test_memory_python_client_breaker.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createPythonSynthClient } from "../src/memory/pythonClient";

class FakeChild extends EventEmitter {
  stdin = { write: (s: string) => { this.written.push(s); return true; } };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  written: string[] = [];
  kill() {}
  ping() { this.stdout.emit("data", Buffer.from(JSON.stringify({ id: "__ping__", v: 1, ok: true, pong: true, synthVersion: "1.0.0" }) + "\n")); }
  crash() { this.emit("exit", { exitCode: 1 }); }
}

function delay(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

test("a crash triggers a backed-off respawn that becomes available again", async () => {
  const spawned: FakeChild[] = [];
  const client = createPythonSynthClient({
    moduleDir: "/m", repoRoot: "/r", existsSync: () => true, log: () => {},
    backoffBaseMs: 10, backoffMaxMs: 20, breakerThreshold: 3, breakerWindowMs: 1000, cooldownMs: 50,
    spawnImpl: (() => { const c = new FakeChild(); spawned.push(c); return c; }) as any,
  });
  await delay(1); spawned[0].ping(); await delay(1);
  assert.equal(client.available(), true);
  spawned[0].crash();
  assert.equal(client.available(), false);
  await delay(30); // wait out the backoff respawn
  assert.equal(spawned.length, 2);
  spawned[1].ping(); await delay(1);
  assert.equal(client.available(), true);
  client.dispose();
});

test("3 crashes within the window trip the breaker → fallback for the cooldown", async () => {
  const spawned: FakeChild[] = [];
  const client = createPythonSynthClient({
    moduleDir: "/m", repoRoot: "/r", existsSync: () => true, log: () => {},
    backoffBaseMs: 5, backoffMaxMs: 5, breakerThreshold: 3, breakerWindowMs: 1000, cooldownMs: 60,
    spawnImpl: (() => { const c = new FakeChild(); spawned.push(c); return c; }) as any,
  });
  await delay(1); spawned[0].ping(); await delay(1);
  spawned[0].crash(); await delay(10);   // respawn 1
  spawned[1].crash(); await delay(10);   // respawn 2
  spawned[2].crash(); await delay(10);   // 3rd failure → breaker OPEN
  assert.equal(client.synthesizerState(), "fallback");
  const countAtTrip = spawned.length;
  await delay(20); // still inside cooldown → no new spawn
  assert.equal(spawned.length, countAtTrip);
  await delay(60); // cooldown elapsed → exactly one probe spawn
  assert.equal(spawned.length, countAtTrip + 1);
  client.dispose();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test --test-force-exit tests/test_memory_python_client_breaker.ts`
Expected: the **respawn-after-crash** test PASSES (Task 4 already respawns + backs off); the **breaker** test FAILS — without the cooldown gate the client keeps respawning through what should be the open-breaker window, so `spawned.length` exceeds `countAtTrip`.

- [ ] **Step 3: Add the circuit breaker on top of Task 4's respawn**

Task 4 already gives `createPythonSynthClient` candidate iteration + crash-respawn with exponential backoff. This step adds **only** the breaker (the storm cap) — it hooks the `spawnBlocked()` stub and wraps `scheduleRespawn`'s backoff with a failure counter.

In `src/memory/pythonClient.ts`, add the breaker constants + state right after the existing `const backoffMaxMs = opts.backoffMaxMs ?? 2000;` line:

```ts
  const breakerThreshold = opts.breakerThreshold ?? 3;
  const breakerWindowMs = opts.breakerWindowMs ?? 10_000;
  const cooldownMs = opts.cooldownMs ?? 60_000;
  let consecutiveFails = 0;
  let firstFailAt = 0;
  let breakerUntil = 0;          // epoch ms; 0 = breaker closed
```

> `Date.now()` is fine in runtime code (it is only forbidden in *workflow scripts*). The breaker uses it for the cooldown window.

Replace the `spawnBlocked` stub with the breaker check:

```ts
  function spawnBlocked(): boolean { return Date.now() < breakerUntil; } // breaker OPEN ⇒ fallback-only
```

Replace the entire `scheduleRespawn` function body with the failure-counting version:

```ts
  function scheduleRespawn() {
    if (disposed || !synthDir || cands.length === 0) return;
    const now = Date.now();
    if (firstFailAt === 0 || now - firstFailAt > breakerWindowMs) { firstFailAt = now; consecutiveFails = 0; }
    consecutiveFails++;
    if (consecutiveFails >= breakerThreshold) {
      breakerUntil = now + cooldownMs;
      consecutiveFails = 0; firstFailAt = 0; attempt = 0;
      log(`[synth] circuit breaker OPEN for ${cooldownMs}ms (fallback-only)`);
      respawnTimer = setTimeout(() => { breakerUntil = 0; log("[synth] breaker probe"); spawnDaemon(); }, cooldownMs);
    } else {
      const wait = Math.min(backoffMaxMs, backoffBaseMs * Math.pow(2, attempt++));
      respawnTimer = setTimeout(spawnDaemon, wait);
    }
    if (respawnTimer && typeof (respawnTimer as any).unref === "function") (respawnTimer as any).unref();
  }
```

In `onLine`, reset the breaker counters on a good ping. Change the ping-OK branch (inside `if (PingResponseSchema.safeParse(obj).success)`) to also clear the failure state:

```ts
        ready = true; discovering = false; attempt = 0; consecutiveFails = 0; firstFailAt = 0; clearPingTimer();
        log(`[synth] ping ok (synthVersion=${obj?.synthVersion ?? "?"})`);
```

- [ ] **Step 4: Run both client suites to verify they pass**

Run: `npx tsx --test --test-force-exit tests/test_memory_python_client.ts tests/test_memory_python_client_breaker.ts`
Expected: PASS (framing suite still green; respawn + breaker green).

- [ ] **Step 5: Lint + commit**

```bash
npm run lint
git add src/memory/pythonClient.ts tests/test_memory_python_client_breaker.ts
git commit -m "feat(memory): P0b daemon respawn (backoff) + circuit breaker + ping-reset"
```

---

## Task 6: `MemoryService.synthesizeAsync` — the race + source authority

**Files:**
- Modify: `src/memory/index.ts`
- Test: `tests/test_memory_synthesize_async.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/test_memory_synthesize_async.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryService, briefIsForActivePane } from "../src/memory";
import { DEFAULT_MEMORY_CONFIG, type MemoryTiers } from "../src/memory/types";
import type { PythonSynthClient, SynthesizeResult } from "../src/memory/pythonClient";

const FRAME = { role: "Janus", gatePosture: "Auto", prefs: [] };
const TIERS: MemoryTiers = {
  project: { projectId: "x", name: "Janus", summary: "Voice orchestrator.", keyTerms: [], recentDecisions: [] },
  pane: { paneId: "p1", name: "build", runtimeType: "claude", status: "Running", lastCommand: "go", recent: [] },
  board: [], frame: FRAME, breadcrumbs: [],
};
// A minimal WorldModel stand-in: getTiers ignores args and returns TIERS.
const wm: any = { getTiers: () => TIERS };

function clientReturning(r: SynthesizeResult | Promise<SynthesizeResult>, avail = true): PythonSynthClient {
  return {
    available: () => avail,
    synthesizerState: () => (avail ? "python" : "fallback"),
    request: () => Promise.resolve(r),
    dispose: () => {},
  };
}

test("no client → fallback", async () => {
  const svc = new MemoryService(wm, DEFAULT_MEMORY_CONFIG);
  const b = await svc.synthesizeAsync("p1", 0);
  assert.equal(b.source, "fallback");
  assert.ok(b.text.includes("PROJECT Janus"));
});

test("unavailable client → fallback (request never called)", async () => {
  let called = false;
  const client: PythonSynthClient = {
    available: () => false, synthesizerState: () => "fallback",
    request: () => { called = true; return Promise.resolve({ ok: false }); }, dispose: () => {},
  };
  const svc = new MemoryService(wm, DEFAULT_MEMORY_CONFIG, client, 50);
  const b = await svc.synthesizeAsync("p1", 0);
  assert.equal(b.source, "fallback");
  assert.equal(called, false);
});

test("client ok → source python", async () => {
  const client = clientReturning({ ok: true, brief: { text: "PY BRIEF", perTierChars: { project: 8 }, activePaneId: "p1" } });
  const svc = new MemoryService(wm, DEFAULT_MEMORY_CONFIG, client, 50);
  const b = await svc.synthesizeAsync("p1", 0);
  assert.equal(b.source, "python");
  assert.equal(b.text, "PY BRIEF");
});

test("client ok:false → fallback", async () => {
  const svc = new MemoryService(wm, DEFAULT_MEMORY_CONFIG, clientReturning({ ok: false }), 50);
  const b = await svc.synthesizeAsync("p1", 0);
  assert.equal(b.source, "fallback");
});

test("client slower than the timeout → fallback", async () => {
  const slow = clientReturning(new Promise<SynthesizeResult>((res) => setTimeout(() => res({ ok: true, brief: { text: "LATE", perTierChars: {}, activePaneId: "p1" } }), 200)));
  const svc = new MemoryService(wm, DEFAULT_MEMORY_CONFIG, slow, 20);
  const b = await svc.synthesizeAsync("p1", 0);
  assert.equal(b.source, "fallback"); // 20ms race beat the 200ms client
});

test("briefIsForActivePane: latest-wins predicate", () => {
  assert.equal(briefIsForActivePane("p1", "p1"), true);
  assert.equal(briefIsForActivePane("p1", "p2"), false);
  assert.equal(briefIsForActivePane(null, null), true);
  assert.equal(briefIsForActivePane("p1", null), false);
  assert.equal(briefIsForActivePane(null, "p1"), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test --test-force-exit tests/test_memory_synthesize_async.ts`
Expected: FAIL — `synthesizeAsync` / `briefIsForActivePane` not exported.

- [ ] **Step 3: Extend `src/memory/index.ts`**

Replace the current `MemoryService` class and `createMemoryService` in `src/memory/index.ts` with:

```ts
import { WorldModel, type WorldModelDeps } from "./worldModel";
import { BreadcrumbRing } from "./breadcrumbs";
import { assembleBrief } from "./assembler";
import { DEFAULT_MEMORY_CONFIG, type MemoryConfig, type SynthesizedBrief, type Breadcrumb } from "./types";
import type { PythonSynthClient } from "./pythonClient";

export { WorldModel } from "./worldModel";
export { BreadcrumbRing } from "./breadcrumbs";
export * from "./types";
export * from "./pythonClient";

/** Latest-wins predicate (invariant I3): a brief is only injectable if its pane is still the focus. */
export function briefIsForActivePane(briefActivePaneId: string | null, currentActivePaneId: string | null): boolean {
  return briefActivePaneId === currentActivePaneId;
}

export class MemoryService {
  constructor(
    private wm: WorldModel,
    private cfg: MemoryConfig = DEFAULT_MEMORY_CONFIG,
    private pythonClient?: PythonSynthClient,
    private timeoutMs: number = 150,
  ) {}

  /** Synchronous deterministic fallback — unchanged P0a path (REST/tests + the race else-branch). */
  synthesize(activePaneId: string | null, now: number): SynthesizedBrief {
    return assembleBrief(this.wm.getTiers(activePaneId, now), this.cfg, now);
  }

  /** P0b: race the Python daemon (≤timeoutMs) against the in-process floor; TS owns `source` (I1/I4). */
  async synthesizeAsync(activePaneId: string | null, now: number): Promise<SynthesizedBrief> {
    const tiers = this.wm.getTiers(activePaneId, now);
    const fallback = (): SynthesizedBrief => assembleBrief(tiers, this.cfg, now);
    const client = this.pythonClient;
    if (!client || !client.available()) return fallback();
    try {
      const timeout = new Promise<null>((res) => { const t = setTimeout(() => res(null), this.timeoutMs); if (typeof (t as any).unref === "function") (t as any).unref(); });
      const raced = await Promise.race([client.request(tiers, this.cfg, now), timeout]);
      if (raced && raced.ok) return { ...raced.brief, source: "python" };
    } catch {
      // never let a client error escape — the floor always answers
    }
    return fallback();
  }

  synthesizerState(): "python" | "fallback" {
    return this.pythonClient?.synthesizerState() ?? "fallback";
  }
}

export interface CreatedMemory {
  service: MemoryService;
  breadcrumbs: BreadcrumbRing;
  addBreadcrumb: (b: Breadcrumb) => void;
}

/** Build the wired memory service. `pythonClient`/`timeoutMs` are optional (P0b); absent ⇒ pure fallback. */
export function createMemoryService(
  deps: Omit<WorldModelDeps, "breadcrumbs">,
  cfg: MemoryConfig = DEFAULT_MEMORY_CONFIG,
  pythonClient?: PythonSynthClient,
  timeoutMs: number = 150,
): CreatedMemory {
  const breadcrumbs = new BreadcrumbRing(cfg);
  const wm = new WorldModel({ ...deps, breadcrumbs });
  return { service: new MemoryService(wm, cfg, pythonClient, timeoutMs), breadcrumbs, addBreadcrumb: (b) => breadcrumbs.add(b) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test --test-force-exit tests/test_memory_synthesize_async.ts`
Expected: PASS (6/6). Also rerun the P0a regression: `npx tsx --test --test-force-exit tests/test_memory_refocus.ts` → still PASS.

- [ ] **Step 5: Lint + commit**

```bash
npm run lint
git add src/memory/index.ts tests/test_memory_synthesize_async.ts
git commit -m "feat(memory): synthesizeAsync (150ms race + TS source authority) + latest-wins predicate"
```

---

## Task 7: Injector awaits + latest-wins guard (voice seam)

**Files:**
- Modify: `src/voice/index.ts:357-370`
- Test: `tests/test_memory_injector_guard.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/test_memory_injector_guard.ts` — this pins the latest-wins behavior of the exact guard the injector uses (the injector is an inline closure; the guard predicate is its testable unit):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { briefIsForActivePane } from "../src/memory";

// Simulate the injector's await→guard→inject sequence with a mutable "current active pane".
async function injectWithGuard(opts: {
  requestedId: string | null;
  synthesizeAsync: (id: string | null) => Promise<{ text: string; activePaneId: string | null; source: string }>;
  currentActiveIdAfterAwait: string | null;
  send: (text: string) => void;
}) {
  const brief = await opts.synthesizeAsync(opts.requestedId);
  if (!briefIsForActivePane(brief.activePaneId, opts.currentActiveIdAfterAwait)) return; // drop stale
  if (brief.text.trim()) opts.send(brief.text);
}

test("a slow brief for a no-longer-active pane is dropped (latest-wins)", async () => {
  const sent: string[] = [];
  await injectWithGuard({
    requestedId: "p2",
    synthesizeAsync: async () => ({ text: "P2 BRIEF", activePaneId: "p2", source: "python" }),
    currentActiveIdAfterAwait: "p1", // user already switched back to p1
    send: (t) => sent.push(t),
  });
  assert.deepEqual(sent, []); // dropped
});

test("a brief for the still-active pane is injected exactly once", async () => {
  const sent: string[] = [];
  await injectWithGuard({
    requestedId: "p1",
    synthesizeAsync: async () => ({ text: "P1 BRIEF", activePaneId: "p1", source: "fallback" }),
    currentActiveIdAfterAwait: "p1",
    send: (t) => sent.push(t),
  });
  assert.deepEqual(sent, ["P1 BRIEF"]);
});
```

- [ ] **Step 2: Run test to verify it fails (then passes — it tests the predicate)**

Run: `npx tsx --test --test-force-exit tests/test_memory_injector_guard.ts`
Expected: PASS once `briefIsForActivePane` exists (Task 6). If Task 6 isn't merged in your working tree yet, it FAILs on the import — run Task 6 first. This test documents and locks the guard contract the injector edit below must honor.

- [ ] **Step 3: Make `injectMemoryBrief` async with the latest-wins guard**

In `src/voice/index.ts`, replace the body (lines 357-370) with:

```ts
    const injectMemoryBrief = async (sess: any, activeId: string | null): Promise<void> => {
      try {
        if (!sess) return;
        // P0b: race the Python synthesizer (≤memorySynthTimeoutMs) against the in-process floor.
        // synthesizeAsync owns the race + `source` authority and NEVER rejects.
        const brief = await memory.service.synthesizeAsync(activeId, Date.now());
        // Latest-wins (invariant I3): if the operator switched panes while we awaited, the active
        // pane moved on — DROP this brief rather than inject stale context for a backgrounded pane.
        if (!briefIsForActivePane(brief.activePaneId, coreState.activePaneId)) return;
        if (brief.text.trim()) {
          sess.sendClientContent({
            turns: [{ role: "user", parts: [{ text: `CONTEXT (situational, do not read aloud):\n${brief.text}` }] }],
            turnComplete: true,
          });
        }
      } catch (e) {
        // The whole body is guarded so the returned promise NEVER rejects — the three fire-and-forget
        // call sites ignore it, and an unhandled rejection must never escape into the live loop.
        console.error("[memory] brief injection failed:", e);
      }
    };
```

Add the import for `briefIsForActivePane`. Find the existing memory import near the top of `src/voice/index.ts` (the `CreatedMemory` type is already imported) and add `briefIsForActivePane`:

```ts
import { briefIsForActivePane } from "../memory";
```

> If `CreatedMemory` is imported from `"../memory"` already, add `briefIsForActivePane` to that same import clause instead of a new line. Verify with: `grep -n "from \"../memory\"" src/voice/index.ts`.

> **Invariant I10:** the three call sites (`:615`, `:963`, `:1133`) and `orient.ts:121` are **unchanged** — they already call `injectMemoryBrief(...)` as a statement and correctly ignore the now-returned promise (fire-and-forget). Do not add `await` or `void` at the call sites.

- [ ] **Step 4: Run tests + lint to verify**

Run: `npx tsx --test --test-force-exit tests/test_memory_injector_guard.ts && npm run lint`
Expected: PASS + clean tsc (a `Promise<void>` returned into a statement position is legal TS; `tsc --noEmit` does not flag floating promises).

- [ ] **Step 5: Commit**

```bash
git add src/voice/index.ts tests/test_memory_injector_guard.ts
git commit -m "feat(memory): injector awaits synthesizeAsync + latest-wins guard (one note/switch)"
```

---

## Task 8: Server wiring + health diagnostics field

**Files:**
- Modify: `server.ts:497-505` (construct + pass the client)
- Modify: `src/actions/types.ts:251` (add the optional getter)
- Modify: `server.ts` `buildRestActionContext` (wire the getter)
- Modify: `src/actions/defs/observability.ts:67-75` (health output field)
- Test: `tests/test_health_synthesizer_field.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/test_health_synthesizer_field.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { OBSERVABILITY_ACTIONS } from "../src/actions/defs/observability";

const getHealth = OBSERVABILITY_ACTIONS.find((a) => a.name === "get_health")!;

function baseCtx(extra: Record<string, unknown> = {}): any {
  return {
    manager: { terminals: {} },
    session: null,
    pendingApprovals: { forSession: () => [] },
    isFrozen: () => false,
    store: null,
    ...extra,
  };
}

test("get_health reports synthesizer=python when the getter says so", () => {
  const res: any = getHealth.handler({}, baseCtx({ memorySynthesizerState: () => "python" }));
  assert.equal(res.kind, "ok");
  assert.equal(res.output.memory.synthesizer, "python");
});

test("get_health defaults synthesizer=fallback when the getter is absent (voice/test path)", () => {
  const res: any = getHealth.handler({}, baseCtx());
  assert.equal(res.output.memory.synthesizer, "fallback");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test --test-force-exit tests/test_health_synthesizer_field.ts`
Expected: FAIL — `res.output.memory` is undefined.

- [ ] **Step 3: Add the optional getter to `ActionContext`**

In `src/actions/types.ts`, immediately after the `injectMemoryBrief?: () => void;` declaration (line 251), add:

```ts
  /** P0b observability: which synthesis path is currently live ("python" when the warm daemon is
   *  available + the breaker is closed, else "fallback"). Wired by the server on the REST surface;
   *  absent on voice/test paths, where get_health reports the safe default "fallback". */
  memorySynthesizerState?: () => "python" | "fallback";
```

- [ ] **Step 4: Add the field to the `get_health` handler**

In `src/actions/defs/observability.ts`, change the handler's returned `output` object (lines 69-74) to add the `memory` field:

```ts
      output: {
        frozen: ctx.isFrozen(),
        panes,
        pending_approvals: pendingApprovals,
        recent: { total: recentTotal, errors: recentErrors, error_rate: recentTotal ? recentErrors / recentTotal : 0 },
        memory: { synthesizer: ctx.memorySynthesizerState?.() ?? "fallback" },
      },
```

- [ ] **Step 5: Construct + pre-warm the client and wire it (server.ts)**

In `server.ts`, replace the `createMemoryService(...)` call (lines 497-505) with:

```ts
  // P0b: the optional warm Python synthesizer. A STRICT UPGRADE — gated by the master switch, eagerly
  // pre-warmed and non-fatal. Absent/broken interpreter ⇒ permanent fallback; Janus stays fully functional.
  const memoryPythonEnabled = manager.settings.advanced?.memoryPythonEnabled !== false; // default true
  const memorySynthTimeoutMs = manager.settings.advanced?.memorySynthTimeoutMs ?? 150;
  let pythonSynthClient: PythonSynthClient | undefined;
  if (memoryPythonEnabled) {
    try {
      pythonSynthClient = createPythonSynthClient({ moduleDir: defaultModuleDir(), repoRoot: process.cwd() });
    } catch (e) {
      console.error("[memory] python synth client init failed (continuing on fallback):", e);
      pythonSynthClient = undefined;
    }
  }
  const memory = createMemoryService(
    { manager: memoryManager, store: memoryStore, redact: redactSecrets },
    {
      totalBudgetChars: manager.settings.advanced?.memoryBudgetChars ?? 4800,
      weights: { project: 0.40, pane: 0.30, breadcrumbs: 0.15, board: 0.10, frame: 0.05 },
      breadcrumbMax: manager.settings.advanced?.breadcrumbMax ?? 12,
      breadcrumbMaxAgeMs: manager.settings.advanced?.breadcrumbMaxAgeMs ?? 900_000,
    },
    pythonSynthClient,
    memorySynthTimeoutMs,
  );
```

Add the imports near the existing `import { createMemoryService } from "./src/memory";` (server.ts:36):

```ts
import { createMemoryService, createPythonSynthClient, defaultModuleDir, type PythonSynthClient } from "./src/memory";
```

> `createPythonSynthClient`, `defaultModuleDir`, and the `PythonSynthClient` type are re-exported from `./src/memory` via `export * from "./pythonClient"` (Task 6, Step 3), so this single import line is sufficient.

In `buildRestActionContext` (server.ts:1281), add the getter to the returned context object (alongside the other `ctx` fields it builds — place it near where other optional seams are set):

```ts
      memorySynthesizerState: () => memory.service.synthesizerState(),
```

- [ ] **Step 6: Run test + lint to verify**

Run: `npx tsx --test --test-force-exit tests/test_health_synthesizer_field.ts && npm run lint`
Expected: PASS (2/2) + clean tsc.

- [ ] **Step 7: Commit**

```bash
git add server.ts src/actions/types.ts src/actions/defs/observability.ts tests/test_health_synthesizer_field.ts
git commit -m "feat(memory): wire + pre-warm optional python client; expose memory.synthesizer on get_health"
```

---

## Task 9: Build delivery (copy python → dist) + test:py + gitignore

**Files:**
- Create: `scripts/copy-python.mjs`
- Create: `scripts/run-pytests.ts`
- Modify: `package.json:9,13`
- Modify: `.gitignore`

- [ ] **Step 1: Write `scripts/copy-python.mjs`**

```js
// Copy python/ → dist/python/ for the production bundle. Cross-platform (Node fs, no shell cp).
// Excludes __pycache__ and tests (the daemon never needs them at runtime).
import { cp, rm, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "python");
const dest = path.join(root, "dist", "python");

if (!existsSync(src)) {
  console.error("[copy-python] no python/ dir — skipping");
  process.exit(0);
}
await rm(dest, { recursive: true, force: true });
await mkdir(path.dirname(dest), { recursive: true });
await cp(src, dest, {
  recursive: true,
  filter: (s) => !s.includes("__pycache__") && !s.split(path.sep).includes("tests"),
});
console.log(`[copy-python] copied ${src} -> ${dest}`);
```

- [ ] **Step 2: Write `scripts/run-pytests.ts`**

```ts
// Cross-platform `test:py` runner. Reuses the D4 interpreter discovery. EXITS 0 with a notice
// when no interpreter exists, so the JS battery stays green on a Python-less dev box.
import { spawnSync } from "node:child_process";
import { discoverPythonInterpreter } from "../src/memory/pythonClient";

const cands = discoverPythonInterpreter(process.env, process.platform);
for (const c of cands) {
  const probe = spawnSync(c.cmd, [...c.baseArgs, "--version"], { stdio: "ignore" });
  if (probe.status === 0) {
    const r = spawnSync(
      c.cmd,
      [...c.baseArgs, "-X", "utf8", "-m", "unittest", "discover", "-s", "python/synthesizer/tests", "-p", "test_*.py", "-v"],
      { stdio: "inherit", env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" } },
    );
    process.exit(r.status ?? 1);
  }
}
console.error("[test:py] no Python interpreter found — skipping python tests (this is OK on a Python-less box)");
process.exit(0);
```

- [ ] **Step 3: Wire `package.json`**

Change the `build` script (line 9) to chain the copy step, and add `test:py` after `test:unit` (line 13):

```json
    "build": "vite build && esbuild server.ts --bundle --platform=node --format=cjs --packages=external --sourcemap --outfile=dist/server.cjs && node scripts/copy-python.mjs",
    "test:py": "tsx scripts/run-pytests.ts",
```

- [ ] **Step 4: Add the gitignore line**

Append to `.gitignore`:

```
python/**/__pycache__/
```

- [ ] **Step 5: Verify build + test:py**

```bash
npm run build
```
Expected: emits `dist/server.cjs` AND `dist/python/synthesizer/__main__.py` exists (verify: `ls dist/python/synthesizer`). `dist/python/synthesizer/tests` must NOT exist (excluded).

```bash
npm run test:py
```
Expected (with Python present): all synth + dispatch tests run green. (Without Python: prints the skip notice, exits 0.)

- [ ] **Step 6: Commit**

```bash
git add scripts/copy-python.mjs scripts/run-pytests.ts package.json .gitignore
git commit -m "build(memory): copy python/ -> dist/python on build; add cross-platform test:py runner"
```

---

## Task 10: Cross-seam integration test (real daemon, skips without Python)

**Files:**
- Test: `tests/test_memory_python_seam.ts`

- [ ] **Step 1: Write the integration test**

Create `tests/test_memory_python_seam.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createPythonSynthClient, discoverPythonInterpreter } from "../src/memory/pythonClient";
import { DEFAULT_MEMORY_CONFIG, type MemoryTiers } from "../src/memory/types";

function haveInterpreter(): boolean {
  for (const c of discoverPythonInterpreter(process.env, process.platform)) {
    if (spawnSync(c.cmd, [...c.baseArgs, "--version"], { stdio: "ignore" }).status === 0) return true;
  }
  return false;
}

const FRAME = { role: "Janus", gatePosture: "Human-in-the-Loop", prefs: ["terse"] };
const TIERS: MemoryTiers = {
  project: { projectId: "x", name: "Janus", summary: "A voice orchestrator. It runs panes.", keyTerms: ["pane"], recentDecisions: [] },
  pane: { paneId: "p1", name: "build", runtimeType: "claude", status: "Running", lastCommand: "npm test", recent: ["ok"] },
  board: [{ paneId: "p1", name: "build", status: "Running" }], frame: FRAME, breadcrumbs: [{ ts: 1, paneId: "p1", text: "ran tests" }],
};

function delay(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

test("real python daemon: ping + one synthesize round-trip → python brief, budget respected", { skip: !haveInterpreter() && "no Python interpreter found" }, async () => {
  const client = createPythonSynthClient({ moduleDir: process.cwd(), repoRoot: process.cwd() });
  // wait for the eager ping handshake to land
  for (let i = 0; i < 50 && !client.available(); i++) await delay(20);
  assert.equal(client.available(), true, "daemon should be available after the ping handshake");

  const res = await client.request(TIERS, DEFAULT_MEMORY_CONFIG, 1733443200000);
  assert.equal(res.ok, true, "synthesize round-trip should succeed");
  if (res.ok) {
    assert.ok(res.brief.text.includes("ACTIVE PANE build"));
    assert.ok(res.brief.text.length <= DEFAULT_MEMORY_CONFIG.totalBudgetChars, "budget respected (I7)");
    assert.equal(res.brief.activePaneId, "p1");
  }
  client.dispose();
});
```

> `moduleDir: process.cwd()` + `repoRoot: process.cwd()` makes the resolver find `<repoRoot>/python/synthesizer/__main__.py` in dev (the suite runs from the repo root). No build needed for this test.

- [ ] **Step 2: Run it**

Run: `npx tsx --test --test-force-exit tests/test_memory_python_seam.ts`
Expected: PASS (with Python). On a Python-less box: the test is reported SKIPPED, suite still green.

- [ ] **Step 3: Commit**

```bash
git add tests/test_memory_python_seam.ts
git commit -m "test(memory): cross-seam integration (real daemon round-trip; skips without python)"
```

---

## Task 11: Full battery + self-review + adversarial review

- [ ] **Step 1: Run the whole battery**

```bash
npm run lint
npm test
npm run build
npm run test:py
```
Expected: tsc clean; full unit suite green (the P0a memory tests + all new P0b suites); build emits `dist/server.cjs` + `dist/python/`; python tests green (or skip-notice on a Python-less box).

- [ ] **Step 2: Self-review against the invariants**

Walk I1–I10 from the spec and point each at the code that enforces it:
- **I1 (floor unconditional):** `synthesizeAsync` `fallback()` on no client / unavailable / timeout / error; injector wraps the await in try/catch.
- **I2 (one note/switch):** injector calls `sendClientContent` at most once per invocation; no background second pass.
- **I3 (latest-wins):** `briefIsForActivePane(brief.activePaneId, coreState.activePaneId)` guard.
- **I4 (source authority):** `source` is stamped by TS; `"python"` only on the `raced.ok` branch (which required `available()` + a resolved client result).
- **I5 (redaction boundary):** `request(tiers, ...)` passes `wm.getTiers(...)` — already redacted in P0a; Python does no redaction.
- **I6 (determinism):** `synth.py` reads no clock/env/fs; `test_deterministic` locks it.
- **I7 (budget):** `synth.py` final `text[:total]` + `test_budget_never_exceeded`; integration asserts `<= totalBudgetChars`.
- **I8 (no new deps):** only stdlib Python + already-present `zod`; verify `git diff package.json` adds no dependency.
- **I9 (cross-platform spawn):** `spawn(... { stdio:['pipe','pipe','pipe'] })`, no `shell:true`, `PYTHONUTF8`/`PYTHONIOENCODING` + `-X utf8 -u`, discovery order per D4.
- **I10 (call-site additivity):** the three voice call sites + `orient.ts` are byte-unchanged; sync `synthesize` still used by REST/tests.

Fix any gap inline, re-run the affected suite.

- [ ] **Step 3: Adversarial review (subagent)**

Dispatch one review subagent: "Adversarially verify the P0b implementation against invariants I1–I10 in `docs/superpowers/specs/2026-06-05-janus-memory-synthesis-p0b-design.md`. Try to find a path where Python being absent/slow/crashing/returning garbage throws into the live loop, blocks a voice turn, double-injects, injects a stale-pane brief, exceeds the char budget, or lets Python claim `source:"python"` without passing zod. Report findings with file:line." Triage findings; fix real ones with a regression test each.

- [ ] **Step 4: Update the bead + open the PR**

```bash
bd update wsm-e2e-pinned-46v.2.6 --status in_review   # or per your bd workflow
```

PR body (save to a temp file, then `gh pr create`): summarize what landed (the warm daemon behind `synthesizeAsync`, the unconditional floor, cross-platform packaging), the verification battery results, the adversarial-review verdict, and the invariants confirmed. **Squash-merge** (you cannot approve your own PR). If `gh pr merge` fails against the worktree's main checkout, confirm merge via `gh pr view --json state` and delete the remote branch manually.

> **Worktree isolation / git policy:** all commits happen on `feat/janus-memory-synthesis-p0b` in this worktree. Do **not** push or merge without the operator's explicit go-ahead.

---

## Notes carried from the spec

- **Pre-warm race (spec risk):** the eager spawn is async + non-fatal; a pane switch within the first ~200ms of boot uses the fallback for that one switch. Acceptable per D1 — do not add blocking-on-boot.
- **Windows-without-Python:** expected and handled (permanent fallback; integration test skips; `test:py` skip-notice). Surfaced only via `get_health.memory.synthesizer` + the structured `[synth]` logs, never to the operator.
- **`synthVersion` vs wire `v`:** if a future synthesizer changes the output *shape*, bump `WIRE_VERSION` (gates compatibility), not just `SYNTH_VERSION` (diagnostics only).
