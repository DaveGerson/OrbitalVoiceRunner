# Design: The Python Cortex — Increment 4, Slice 1 (SHADOW scaffold)

- **Date:** 2026-06-27
- **Status:** Approved for the SHADOW slice (operator, brainstorm 2026-06-27). Curation policy, triggers, and flip are deferred to beads.
- **Related:** ADR `docs/design/2026-06-19-python-ts-seam.md` · plan `docs/superpowers/plans/2026-06-25-python-ts-seam-migration-plan.md` (Inc 4) · seam `src/memory/pythonClient.ts` · `python/synthesizer/`

## BLUF

Increment 4 is **"the cortex"** — a deterministic Python support layer that makes the live voice model (Gemini Live) more effective despite its limits (weak working memory, imprecise state tracking). **Gemini stays the brain/driver; the cortex is the deterministic executive prosthetic; TypeScript stays the resilient I/O shell and the fail-closed floor.**

This slice ships the **SHADOW scaffold only**: the seam, the op, the decision-trace contract, and fire-and-forget observation wiring. The cortex *observes and logs what it would decide*; TypeScript injects exactly today's brief. **Behavior is byte-identical to today, enforced by tests.** Every judgment-laden rule is deferred to a bead.

## Locked decisions (the brainstorm)

| # | Decision | Resolution |
|---|---|---|
| Gate posture | How the cortex relates to the capability gate | **A — cortex proposes, TS gate disposes.** The cortex never enforces; it never sits on the synchronous, fail-closed enforcement path. (Not exercised in this slice — read/feed only.) |
| Role | What the cortex *is* | A **deterministic logic layer** supporting Gemini. Gemini reasons; the cortex does the precise, reliable bookkeeping. |
| Beachhead | First pillars | **Context/state curation** + a **minimal session abstraction** (one session today, multi-session-ready interface). Read/feed only — no action driving. |
| Shape | How much vision now | **Minimal now, multi-session-ready interface.** |
| Curator↔budgeter (D) | Two deciders touching context | **The cortex is the single logic authority and owns the char-budget.** The synthesizer becomes an in-process **renderer**. Output is an **ordered list**. **Over-document every decision** via a structured trace. |
| Loop memory (B) | Damping oscillation | **Pure-reactive core** (function of the current snapshot). Decision-memory/hysteresis is an **externalized callable owned by the memory/context module**, not baked in. |
| Feed model (C) | How world info reaches the cortex | **Pull per-event over the existing request/response seam.** Risk stays in the resilient TS backend; the cortex is a stateless consulted transform. No second transport. |
| Triggers | What is a "frame" | Today's 3 points **+ command-outcomes** (the live/streaming feel). *In this slice only today's 3 points are wired; outcome-triggers + the inject-gate are a bead.* |

## The mental model — an OODA control loop, not a pipeline

```
   OBSERVE                ORIENT / DECIDE                 ACT
 ┌────────────┐    (2)   ┌──────────────────┐     (3)   ┌──────────────────┐
 │   state    │ ───────▶ │ CORTEX (determ.) │ ────────▶ │ TS executor      │
 │  snapshot  │  consult │   +              │ apply-if- │ inject / connect │
 │ epoch-stamp│          │ GEMINI (brain)   │  fresh    │ dispatch → GATE  │
 └─────▲──────┘          └──────────────────┘           └────────┬─────────┘
       │                                                          │
       │ (1) events                                  (4) actions  │
       │  pane switch · outcome · health · proposal     mutate    │
       └───────────────────────── THE WORLD ◀──────────────────────┘
```

The cortex is the **deterministic half of the "decide" node** in a loop that closes through the world. In SHADOW it is wired only to the **context-curation** arc, and its output is observed, never applied.

## The parity boundary (this slice)

**Built now (additive, zero behavior change):**
1. **`cortex.decide` op** on the existing multiplexed daemon (`python/synthesizer/dispatch.py` router; logic in `python/synthesizer/cortex.py`). Pure, deterministic, per-request blast radius (never crashes the daemon).
2. **`createPythonCortexClient(core)`** — a fail-closed TS facade reusing the generic `createPythonModuleClient` core, mirroring `approvalClient.ts`. Returns `null`/unavailable on any miss.
3. **The decision-trace contract** — every call emits a structured, versioned trace (the over-document principle).
4. **`MemoryService.observeCortexShadow(activePaneId, now)`** — a **non-blocking, never-throws** observer that builds the same tiers, fires `cortex.decide` fire-and-forget, and logs the returned trace. It does **not** touch `synthesizeAsync` or the injected brief.
5. **One call site** — `injectMemoryBrief` (`src/voice/index.ts:545`) fires `void memory.service.observeCortexShadow(activeId, Date.now())` after the existing inject. Not awaited.

**v1 decision logic = identity baseline.** `decide(tiers, ctx, now)` returns the tiers in input order (`keep = all`, `drop = []`, `rerank = []`) plus a full trace with `strategy: "baseline-identity"`. No real curation. The point of this slice is the **seam + contract + observability**, not the intelligence.

**Explicitly NOT built (parity / beads):** real curation rules · outcome-triggers + inject-gate · the flip (apply cortex output) · shadow trust-gate · decision-memory/hysteresis · session/connection-management logic.

## Contracts

### Op: `cortex.decide` (wire v1, request/response NDJSON)

Request:
```json
{ "id": "r1", "v": 1, "op": "cortex.decide",
  "tiers": { "...": "same MemoryTiers struct as synthesize" },
  "ctx": { "activePaneId": "p1", "sessionId": "s1|null", "trigger": "session-start|pane-switch|catch-up" },
  "now": 1234567890 }
```

Response (success):
```json
{ "id": "r1", "v": 1, "ok": true,
  "decision": { "keep": ["project","pane","breadcrumbs","board","frame"], "drop": [], "rerank": [] },
  "trace": {
    "cortexVersion": "0.1.0",
    "strategy": "baseline-identity",
    "ruleFired": "baseline-identity",
    "inputs": { "activePaneId": "p1", "trigger": "session-start", "tierKeys": ["..."], "tierChars": { "...": 0 } },
    "output": { "orderedKeep": ["..."], "dropped": [] },
    "ts": 1234567890 } }
```

Failure: `{ id, v:1, ok:false, error:{ code:"CORTEX_FAILED", message } }` (daemon survives; TS treats as unavailable).

### TS facade (`src/memory/cortexClient.ts`)

```ts
export interface PythonCortexClient {
  available(): boolean;
  decide(tiers: MemoryTiers, ctx: CortexCtx, now: number): Promise<CortexResult>; // {ok:true, decision, trace} | {ok:false}
}
export function createPythonCortexClient(core: PythonModuleClient): PythonCortexClient;
```

## Parity invariants (the test targets)

- **I-P1:** `synthesizeAsync` output and the injected brief are byte-identical whether the cortex is present, absent, slow, or erroring. (`synthesizeAsync` is untouched.)
- **I-P2:** `observeCortexShadow` is non-blocking (caller never awaits) and **never throws** — an unhandled rejection must never reach the live loop.
- **I-P3:** cortex unavailable / timeout / error / off-schema ⇒ zero effect on injection (logged-and-ignored, or an "unavailable" trace).
- **I-P4:** `cortex.decide` is pure/deterministic — identical inputs yield an identical decision + trace (modulo `ts`).
- **I-P5:** a malformed `cortex.decide` request yields `ok:false` and the daemon keeps serving (`synthesize`/`approval.parse` still work).

## Test plan (TDD)

- **Python `tests/test_cortex.py`:** identity decision + trace shape; determinism; robustness to weird/empty tiers (returns, never raises).
- **Python dispatch:** `cortex.decide` routed; bad input → `CORTEX_FAILED`; daemon survives (other ops still answer).
- **TS `tests/test_cortex_client.ts`:** facade fail-closed (no daemon → `available()===false`, `decide` resolves `{ok:false}`); parses a healthy response.
- **TS `tests/test_cortex_shadow_parity.ts`:** with a fake cortex client returning a decision / throwing / unavailable, the brief from `synthesizeAsync` and the `sendClientContent` payload are identical to the no-cortex baseline (I-P1/I-P2/I-P3).
- Existing `tests/test_wire_version_parity.ts` continues to pass (cortex op uses `WIRE_VERSION`).

## Deferred decisions → beads (tomorrow)

1. **Cortex curation policy** — the real keep/drop/rerank rules + budget allocation (replaces identity baseline).
2. **Outcome-triggers + inject-gate** — add command-outcome frames; the diff-gated / debounce / significance policy for *when* an outcome warrants re-injection (operator paused here — needs a decision).
3. **The flip + shadow trust-gate** — apply cortex output as primary (env-gated, TS twin = floor); define the signal that earns the flip when curation has no single "correct" answer.
4. **Decision-memory / hysteresis** — the externalized callable in the memory/context module for oscillation damping.
5. **Session/connection-management logic** — hot/hot uptime, per-project warm agents (interface is shaped now; logic deferred).

## Why this is safe

`synthesizeAsync` (the brief authority) is not modified. The cortex is reached only through a separate, non-blocking, never-throws observer whose output is logged. If the entire Python side vanishes, the user-visible system is exactly today's. Risk lives in the resilient TS backend; the cortex carries none.
