# Janus Memory Synthesis — P0b Design: Python Context Synthesizer

> **Status:** Approved design (2026-06-05). Successor to the P0a TS anti-rot slice
> (`2026-06-05-janus-memory-synthesis-design.md`, shipped on `main` as PR #35).
> **Next step:** implementation plan via `superpowers:writing-plans`.
> **Bead:** `wsm-e2e-pinned-46v.2.6` (P0b). RAG/embeddings remain `wsm-e2e-pinned-46v.2.7`.

## BLUF

A **pre-warmed Python daemon** sits behind `MemoryService.synthesizeAsync`, speaking
**line-delimited JSON (NDJSON) over stdio**. It receives the *already-redacted* `MemoryTiers`
and returns a smarter, budget-reallocated brief. **Any** miss — timeout, crash, absent
interpreter, invalid response — silently resolves to the existing deterministic
`assembleBrief` (P0a). The operator never perceives Python's presence or absence; only the
*quality* of the brief moves. There is **no setup state that can break Janus.**

## Context — what P0a already gives us

P0a shipped the in-process anti-rot layer (`src/memory/`):

- `WorldModel.getTiers(activePaneId, now)` → a fully-redacted, serializable `MemoryTiers`
  (`{project, pane, board, frame, breadcrumbs}`). Every text field is redacted at this
  boundary (spec invariant). **This struct is the P0b request payload, unchanged.**
- `assembleBrief(tiers, cfg, now)` → deterministic, char-budgeted `SynthesizedBrief`. **This
  is the P0b fallback, unchanged.** `SynthesizedBrief.source` already enumerates
  `"fallback" | "python"`.
- `MemoryService.synthesize(activePaneId, now)` is **synchronous** and called **fire-and-forget**
  from `src/voice/index.ts:355` (`injectMemoryBrief`, invoked non-blocking at `:613/:956/:1124`)
  and `src/actions/defs/orient.ts:118`. Nothing awaits its return to gate a voice turn — the
  brief is a side effect pushed into Gemini via `sendClientContent`.

Because the consumption is already fire-and-forget, introducing an **async** Python path is
additive, not a refactor of the call sites.

## Locked decisions

### D1 — Timing model: "refocus in a blink" (async-first, single brief)
`synthesize` gains an async sibling `synthesizeAsync(activePaneId, now): Promise<SynthesizedBrief>`.
**`synthesizeAsync` owns the race** — `Promise.race([pythonClient.request(...), timeout(150ms)])` —
and always resolves to a valid brief (python on a win, `assembleBrief` on any miss; it never
rejects). The injector simply `await`s it, applies a **latest-wins guard** (re-check the active
pane id, drop a result whose pane is no longer focused), then injects **one** brief.

- **Rationale (UX):** the ≤150ms refocus window is below the floor of human reaction time
  (~300–500ms to speak after a pane switch) plus Gemini's own listen-then-reply lag, so the
  theoretical rot window is invisible in the chair. One Gemini note per switch keeps the
  model's context clean. The deterministic fallback *is* the anti-rot guarantee.
- **Rejected:** "instant + background refine" (two notes/switch, ordering + dedup complexity);
  "sync blocking" (Node has no clean synchronous read from a long-lived child's stdout →
  forces `execFileSync` → cold ~150–300ms Python boot every switch, killing the warm-daemon
  premise — *dominated*).

### D2 — v1 intelligence: adaptive synthesizer, deterministic, stdlib-only
Python's v1 job is **adaptive budgeting and salience over the same redacted tiers** — *not*
retrieval (RAG is `.7`) and *not* a model call:

- dynamic budget reallocation (unused project/board budget flows to the active pane),
- breadcrumb dedup / clustering,
- board filtered to non-idle panes and ranked against the active pane,
- salience extraction from the project summary (sentence-level).

Constraints: **deterministic** given `(tiers, cfg, now)`; **Python 3.8+ stdlib only**; **no pip
deps, no venv, no model on the hot path**. Even the Python tests use `unittest` (stdlib) so
nothing ever needs installing. The synthesizer logic lives in a **pure, I/O-free function** so
it is unit-testable in isolation.

### D3 — Failure posture: silent, pre-warmed, self-healing
Python is a **strict upgrade, never a dependency** — mirrors the `src/ptyTransport.ts`
node-pty loader (`try require → catch legacy`, with an availability flag).

- **Spawn:** eager and **non-fatal** at server boot; pre-warmed so the first pane switch is
  already warm.
- **Health:** a `ping` handshake on every spawn validates interpreter + script + protocol
  version in one round-trip.
- **Restart:** crash ⇒ respawn with exponential backoff (250ms → 2s). After **3 consecutive
  failures within a window** the **circuit breaker** trips ⇒ fallback-only for a 60s cooldown,
  then a single probe. Prevents spawn storms.
- **Optional always:** missing/broken interpreter ⇒ permanent fallback; Janus stays fully
  functional. **Observable** via a `memory.synthesizer: "python" | "fallback"` diagnostics
  field + one structured log line per state transition. Silent to the operator.

### D4 — Cross-platform packaging (Windows primary, Linux first-class)
- **Interpreter discovery:** `JANUS_PYTHON` env override always wins. Else **Windows:**
  `py -3` → `python` → `python3`; **Linux:** `python3` → `python`. Validated by the `ping`
  handshake, not by parsing `--version`.
- **UTF-8, hard:** child env `PYTHONUTF8=1` + `PYTHONIOENCODING=utf-8`, launched `-X utf8 -u`
  (UTF-8 mode, unbuffered) — neutralizes the Windows cp1252 trap. Plain pipes
  (`spawn`, `stdio:['pipe','pipe','pipe']`, **argv array, never `shell:true`**). stdout is
  protocol-only; stderr carries logs/tracebacks → dev log only.
- **Delivery & resolution (most failure-resistant):** git-tracked `.py` under
  `python/synthesizer/`; `npm run build` copies `python/` → `dist/python/`. The client resolves
  the script dir as **first-exists of** `[JANUS_PYTHON_SYNTH_DIR, <module-dir>/python,
  <repoRoot>/python]`. Works in dev (tsx from repo root) and prod (bundle) on both OSes.
- **Floor:** Python **3.8+** (Ubuntu 20.04 ships 3.8). Linux relies on the **system
  `python3`** (stdlib-only makes that near-universal); document the one-liner
  `apt-get install -y python3`. venv/pip deferred to `.7`.
- **Hygiene:** add `python/**/__pycache__/` to `.gitignore`.

## Architecture & file map

```
voice/index.ts injectMemoryBrief (fire-and-forget, :355)
  └─ await MemoryService.synthesizeAsync(activeId, now)        [NEW]
       └─ pythonClient.request(tiers, cfg, now)  ── race(150ms) ──┐
            ├─ ok + zod-valid  → SynthesizedBrief{source:"python"}│
            └─ miss            → assembleBrief(…){source:"fallback"}
  └─ latest-wins: re-check coreState.activePaneId → DROP if moved
  └─ session.sendClientContent(brief)                          [one note/switch]
```

**New files**
- `src/memory/pythonClient.ts` — daemon client: interpreter discovery, spawn (UTF-8 env),
  NDJSON framing + `id` correlation, per-request 150ms timeout, ping handshake, respawn +
  circuit breaker, availability state.
- `python/synthesizer/__main__.py` — stdio read/dispatch/write loop (pure I/O shell;
  dispatches `ping` / `synthesize`).
- `python/synthesizer/synth.py` — pure `synthesize(tiers, cfg, now) -> brief` (no I/O;
  the adaptive-extractive logic of D2).
- `python/synthesizer/tests/test_synth.py` — `unittest` golden tests for `synth.py`.

**Modified files**
- `src/memory/index.ts` — add `MemoryService.synthesizeAsync`; `createMemoryService` wires an
  optional `pythonClient`. **Keep sync `synthesize` as the pure fallback** (REST/tests + race
  else-branch).
- `src/memory/types.ts` — zod schemas for the wire messages (`PingResponse`,
  `SynthesizeResponse`, error form) + the request builder type.
- `src/voice/index.ts:355` — `injectMemoryBrief` awaits `synthesizeAsync` (race already inside
  the client) and applies the latest-wins guard. The three call sites are otherwise unchanged.
- `src/types.ts` — advanced knobs: `memoryPythonEnabled` (default true), `memorySynthTimeoutMs`
  (default 150). (`JANUS_PYTHON`, `JANUS_PYTHON_SYNTH_DIR` are env, not settings.)
- Build config (vite/esbuild or a `scripts/` copy step) — copy `python/` → `dist/python/`.
- Diagnostics/health surface — expose `memory.synthesizer`.
- `.gitignore` — `python/**/__pycache__/`.
- `package.json` — `test:py` → `python -m unittest discover python/synthesizer/tests`.

## The wire contract (NDJSON)

One JSON object per line, `\n`-terminated. **stdout = protocol only**, **stderr = logs**.
Correlate by `id`. Client buffers stdout, splits on `\n`, parses each complete line; partial
lines buffered; an unparseable stdout line is logged + skipped defensively.

**Handshake**
```jsonc
→ {"id":"u1","v":1,"op":"ping"}
← {"id":"u1","v":1,"ok":true,"pong":true,"synthVersion":"1.0.0"}
```
**Synthesize**
```jsonc
→ {"id":"u2","v":1,"op":"synthesize","now":1733443200000,
   "cfg":{"totalBudgetChars":4800,"weights":{…},"breadcrumbMax":12,"breadcrumbMaxAgeMs":900000},
   "tiers":{ "project":…, "pane":…, "board":[…], "frame":…, "breadcrumbs":[…] }}
← {"id":"u2","v":1,"ok":true,
   "brief":{"text":"PROJECT …\nACTIVE PANE …","perTierChars":{…},"activePaneId":"p1"},
   "meta":{"strategy":"adaptive-extractive","synthVersion":"1.0.0"}}
← {"id":"u2","v":1,"ok":false,"error":{"code":"SYNTH_FAILED","message":"…"}}
```

**Contract rules**
- `v` is the **wire protocol version** (current `1`); a mismatch ⇒ daemon treated as unavailable
  ⇒ fallback. `synthVersion` is the synthesizer logic semver (diagnostics only).
- `now` is **passed in** — Python must never read its own clock; breadcrumb decay is already
  applied in TS by `breadcrumbs.recent(now)`.
- **`source` is set authoritatively by TS** based on which path produced the brief. Python's
  output is only used if it passes zod validation; Python cannot "claim" `python`.
- `tiers` is exactly `MemoryTiers` with every text field already redacted in TS. **Python
  performs no redaction and is never given un-redacted text.**

## Error handling / resilience ladder

| Condition | Behavior |
|---|---|
| interpreter absent / won't spawn | permanent fallback; probe each cooldown |
| ping fails / `v` mismatch | unavailable; fallback; scheduled retry |
| round-trip > `memorySynthTimeoutMs` (150ms) | that call falls back; daemon stays up |
| invalid response / `ok:false` | that call falls back; → breaker if it recurs |
| daemon crash / exit | in-flight requests reject→fallback; respawn w/ backoff |
| crash-looping (3 fails/window) | breaker OPEN → fallback-only 60s → one probe |
| **floor** | **`assembleBrief` — pure TS, in-process, always works** |

Operator UX is identical across every rung; only brief *polish* changes.

## Configuration & environment

- **Settings (advanced):** `memoryPythonEnabled` (bool, default true) — master switch;
  `memorySynthTimeoutMs` (number, default 150).
- **Env:** `JANUS_PYTHON` (interpreter path/command override); `JANUS_PYTHON_SYNTH_DIR`
  (script dir override, first in the resolver chain).

## Testing strategy

**TS — always-on (no Python required; these guard the seam):**
- mock transport asserts: request shape + `id` correlation; 150ms timeout → fallback;
  `ok:false` → fallback; invalid JSON / zod miss → fallback; `v` mismatch → fallback.
- **latest-wins**: switch p2 then p1; a slow p2 response must NOT inject after p1 is active.
- circuit breaker: 3 failures → fallback-only for the cooldown, then a probe.
- source authority: TS sets `source` regardless of Python's claim.

**Python — where an interpreter exists (`unittest`, zero install):**
- `synth.py` golden tests: budget reallocation, breadcrumb dedup/cluster, board ranking,
  empty/partial tiers, budget never exceeded.

**Cross-seam integration — where an interpreter exists:**
- spawn the real daemon → `ping` → one `synthesize` round-trip → assert `source:"python"` +
  total budget respected. **Skips gracefully** when no interpreter is found, so a
  Windows-without-Python dev box still runs the full suite green.

## Invariants (checkable by the implementation + adversarial review)

- **I1 — Floor is unconditional.** With Python disabled/absent/broken, `synthesizeAsync`
  returns a valid `assembleBrief` brief; no throw escapes the injector.
- **I2 — One note per switch.** Exactly one `sendClientContent` per pane switch (timing model
  D1); no double-injection.
- **I3 — Latest-wins.** A late Python result for a no-longer-active pane is dropped, never
  injected.
- **I4 — Source authority in TS.** `source==="python"` only when Python's response passed zod
  validation and won the race; otherwise `"fallback"`.
- **I5 — Redaction boundary unchanged.** Python receives only the already-redacted
  `MemoryTiers`; it performs no redaction and never sees raw text.
- **I6 — Determinism.** `synth.py` output is a pure function of `(tiers, cfg, now)`; it reads
  no clock, env, or filesystem state for synthesis.
- **I7 — Budget respected.** The Python brief's total length ≤ `cfg.totalBudgetChars` (same
  contract as `assembleBrief`).
- **I8 — No new runtime deps.** No pip packages; Python 3.8 stdlib only; TS adds only the
  already-present `zod`.
- **I9 — Cross-platform spawn.** No `shell:true`; UTF-8 env forced; interpreter resolved via
  the D4 discovery order with the `JANUS_PYTHON` override.
- **I10 — Call-site additivity.** The three existing fire-and-forget injection call sites and
  `orient.ts` are unchanged except for the await; REST/test paths that call sync `synthesize`
  still work.

## Out of scope (deferred to `wsm-e2e-pinned-46v.2.7`)

Embeddings / semantic retrieval / RAG; any model (LLM) call in the synthesis path; venv & pip
dependencies; cross-session persistent long-term memory beyond the existing store tiers.

## Risks & open questions

- **First-switch warmth vs. boot race.** Eager spawn is async/non-fatal; if a user switches
  panes within the first ~200ms of boot, that one switch uses the fallback (acceptable — D1).
- **Windows interpreter absent on dev boxes.** Expected and handled (permanent fallback); the
  cross-seam test skips. Surfaced only in diagnostics, never to the operator.
- **`synthVersion` drift.** Wire `v` gates compatibility; `synthVersion` is informational. If a
  future synthesizer changes output *shape*, bump `v`, not just `synthVersion`.
