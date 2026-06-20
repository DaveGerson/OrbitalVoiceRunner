# ADR: The Python ⇄ TypeScript seam — Python owns logic, TS owns the frontend + I/O shell

- **Date:** 2026-06-19
- **Status:** Accepted (operator direction)
- **Context owners:** operator
- **Related:** `src/memory/pythonClient.ts`, `python/synthesizer/`, the capability-gate matrix (`src/gating/`), CLAUDE.md → "Python ⇄ TS boundary"

## Decision

**Python owns decision/domain logic; TypeScript owns the frontend and the I/O shell.** New
decision-logic is authored in Python from the start. Existing pure-logic in TypeScript migrates to
Python **opportunistically** — only when a file is already being changed for another reason — never
as a standalone rewrite.

## Why

- **Toward a Python AI/agent layer.** The forthcoming agent/LLM/planning work will live in Python;
  the system's "brain" belongs in the same runtime as that layer.
- **Team / language fit.** Python is the stronger language here for business/domain logic.
- **Separation of concerns.** A clean split — UI/transport in TS, decisions in Python — keeps each
  side small and single-purpose.

## What this is NOT

- **Not a rewrite.** The working, tested TS server stays. We do not port the runtime substrate
  (PTY, WS, streaming) or replace the Node server with a Python server. Migration is opportunistic.
- **Not "everything to Python."** Only *logic* moves. Runtime substrate and the frontend stay TS.

## The boundary

| Goes to **Python** (the brain) | Stays in **TypeScript** (frontend + shell) |
|---|---|
| Agent/LLM/planning logic (the new layer) | React/Vite **frontend — exclusively TS** |
| Memory/RAG scoring, context synthesis (already in `python/synthesizer/`) | WS/REST transport, `node-pty`/ConPTY pane lifecycle |
| Policy *evaluation*, classification, non-hot validation/normalization | Capability-gate **enforcement** choke-point (synchronous, fail-closed) |
| Pure, deterministic, no Node-object coupling, not on a hot path | Real-time audio/streaming, per-keystroke/-frame/-spawn hot paths, SQLite I/O |

### Litmus test for a new piece of "logic"
A unit belongs in **Python** if ALL hold: (1) it's a pure function of its inputs (no `this`, no PTY/WS/DB
handle), (2) it's a *decision/transformation*, not transport, (3) it's not on a hot path
(per-keystroke / per-audio-frame / per-spawn), (4) a stdio round-trip's latency is acceptable.
Otherwise it stays **TS**.

## The bridge (one mechanism, already proven)

TS drives Python over a **stdio-JSON daemon**: `src/memory/pythonClient.ts` spawns
`python/<module>/__main__.py` and exchanges **one JSON object per line** (the synthesizer's protocol,
`python/synthesizer/dispatch.py`). New Python logic modules follow this exact shape. Do not invent a
second transport (no HTTP server, no second IPC scheme) without revisiting this ADR.

Contract requirements for any seam crossing:
- **Stable, versioned JSON protocol** per module (one object per line, explicit schema).
- **TS fails closed** if the Python side errors, times out, or is unavailable — never fail open,
  especially for anything gate- or safety-adjacent.
- **Deterministic Python** where possible (pure function of inputs), so it's testable in isolation
  (`npm run test:py` / module unit tests) without the Node host.

## Consequences

- **+** New agent logic lands in the target runtime immediately; TS surface shrinks over time.
- **+** Pure logic becomes independently testable in Python.
- **−** A second runtime and a serialization boundary add system complexity — accepted here for the
  agent-layer goal, but it raises the bar for protocol discipline (above).
- **−** Latency: anything crossing the seam pays a stdio round-trip; hot paths must stay TS.

## Notable deferral — the capability gate

The gate's *decision* (capability + global/per-pane state → Auto/Ask/Off) is a pure function and is
portable **in principle**. But it is a **synchronous, fail-closed security choke-point** on every
pane-mutating action. Do NOT move it across the seam casually: it would add per-action latency and a
failure mode an action could slip through. Revisit only after the Python seam is battle-tested on
lower-stakes logic, and only with a fail-closed, low-latency contract.

## Applying it to current work (illustrative)

- Burndown targets `App.tsx` / `useOrbitalData.ts` / `SettingsDialog.tsx` / `OrbitalApp.tsx` →
  **frontend, stay TS** (refactor in place).
- `sqliteStore.ts` → persistence I/O, **stays TS**. Preset normalization → hot + substrate-adjacent,
  **stays TS**.
- `gating/index.ts` decision core → portable in principle, **deferred** (see above).
- So the current complexity burndown is unaffected; the seam's payoff is **forward-looking** (the
  new agent layer + opportunistic ports when a pure-logic file is already being touched).
