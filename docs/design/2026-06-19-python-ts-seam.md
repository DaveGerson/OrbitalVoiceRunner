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

## 2026-06-25 — Operator amendment: shadow-first seam migration (supersedes delete-on-cutover)

> This section AMENDS the ADR above; the body above it is unchanged. After an engineering red-team
> and a product-persona review (`handover/python-ts-seam-redteam-review.html`), the operator made
> the final tactical calls below. The full design + plan are the canonical artifacts:
> **spec** `docs/superpowers/specs/2026-06-25-python-ts-seam-migration-design.md` ·
> **plan** `docs/superpowers/plans/2026-06-25-python-ts-seam-migration-plan.md`.

### Supersession

The earlier **"delete-on-cutover"** posture (Python = single source of truth + hard dependency, TS
deleted at cutover; first targets `voiceAckGate` + `recipeApply`; parity harvested-then-deleted
same-PR) is **superseded as of 2026-06-25.** New posture below.

### The reframe + new posture: `SHADOW → FLIP → RETIRE`

Decouple "ship the port" from "take a hard dependency." The first port ships in **shadow** — Python
computes alongside the **authoritative TS** and we log/count diffs. This removes observability,
audible-degradation, Windows-CI, the fail-closed shim, the breaker refactor, and latency-partitioning
from the critical path to the FIRST merge; they return at the **flip**, where they bite.

- **SHADOW** — Python observes; TS authoritative; no dependency; ~zero user risk.
- **FLIP** — Python primary; the **retained TS twin is the fail-closed floor** (it IS the floor —
  no separate shim); degradation is **spoken** (UX Principle 7).
- **RETIRE** — remove the twin only after metrics prove the Python side (fallback-rate ≈ 0).

### The 4 increments

1. **Prove the seam** (ship this week, no dependency) — one multiplexed daemon + typed facade;
   envelope split + single-source `WIRE_VERSION`; port `parseApprovalIntent` **in shadow**; boundary
   golden-master sweep; drop `recipeApply`, keep `voiceAckGate` in TS (+ regression test).
2. **Take the dependency** (after a clean shadow window) — flip to primary (twin = fail-closed
   floor); observability push + **observable** degradation; discovery≠breaker-budget + live Windows CI
   smoke. Merge gate: "twin present + fail-closed verified + degradation observable."
3. **Retire + harden** (deferred, metrics-gated) — retire the twin; then *opportunistically* breaker
   reducer + char tests, full contract test, latency-class partition.
4. **The brain** (brainstorm-gated) — greenfield agent/planning logic born in Python on the proven
   seam (branches off Increment 1, not the flip).

### Per-finding dispositions (compact)

| ID | Disposition | Inc |
|---|---|---|
| `F-TARGET` | Port `parseApprovalIntent` shadow→promote; twin kept | 1→2 |
| `F1` | Drop `recipeApply` — stays TS (the gate) | 1 |
| `F2` | Keep `voiceAckGate` in TS + in-process regression test | 1 |
| `F4` | One multiplexed logic daemon | 1 |
| `F-API` | Typed facade over a generic core | 1 |
| `F6` | Envelope split + single-source version now; contract test deferred | 1 / 3 |
| `F9` | Boundary sweep + shadow-compare; retire twin only when both green | 1→3 |
| `F3` | Floor = retained twin; verify-at-flip gate; no separate shim | 2 |
| `F8` | Observability push + observable degradation (structured log + warm-up-immune fallback-rate in `health.memory.daemon`) | 2 |
| `F7` | Discovery ≠ breaker budget + live Windows CI smoke | 2 |
| `F5` | Breaker reducer + char tests — DEFER (opportunistic) | 3 |
| `F-HOL` | Latency-class partition — DEFER | 3 |

### Pointers

Spec: `docs/superpowers/specs/2026-06-25-python-ts-seam-migration-design.md` · Plan:
`docs/superpowers/plans/2026-06-25-python-ts-seam-migration-plan.md` · Review:
`handover/python-ts-seam-redteam-review.html`.
