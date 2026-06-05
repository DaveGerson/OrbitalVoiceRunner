# Janus Context-Management Architecture — Design

- **Date:** 2026-06-05
- **Status:** Draft for review (brainstorm output)
- **Scope owner:** gerso (director)
- **Related:** locked roadmap `docs/roadmap/RECONCILIATION.md` §4 (P0a → P0b → P1 → P2); capability-gate model (`[[janus-capability-gate-model]]`)

---

## BLUF

Janus's brain (the Gemini Live orchestrator) reasons from a **snapshot taken when the conversation started** and never hears what happens after. It is told when things *stop* (a pane finishes, errors, or needs input) but **never when things start** (a pane begins working, a command starts running). The result the operator hit: *Janus believed every node was idle while they were actively cooking.*

The fix is one coherent pipeline — **Janus hears → Janus remembers → Janus retrieves** — delivered as Path C:

1. **Track 0 (now):** fix the approval-click duplicate-send bug (root-caused, independent).
2. **Phase 1 (now):** give Janus *ears* — a live "started / cooking / command-running" feed that updates both Janus's world-model and the operator's status light in real time, plus an always-fresh catch-up briefing. TypeScript, in-process.
3. **P0 — Janus Memory / RAG (its own design effort):** a Python submodule that ingests the ears' event stream as memory and serves retrieval back to the brain. The "ears" feed is its primary input.
4. **Phase 2 (after Phase 1 proves out):** make status *honest* — distinguish "taking a breath" from "genuinely done," show a quiet `cooking…` state instead of a premature "done."

---

## Problem (grounded in the code)

Janus's only real-time channel into the live model session is `paneSignalBus.subscribe(...) → sendClientContent(...)` (`server.ts:2970`). That bus only ever publishes **endings**:

- idle, on the authoritative Running→Idle edge (`server.ts:498`, via `onIdle`)
- error / prompt, from output classification (`server.ts:846`)

The signal kind enum is capped at `"idle" | "error" | "prompt" | "exited"` (`src/paneSignals.ts:4`) — **there is no `running`/`started`/`busy` kind, and nothing publishes one.** The Running flip itself is silent: `this.status = "Running"` at `src/terminal.ts:566` fires no signal. Contrast the idle edge, which does.

Two compounding leaks make it worse:

- **System prompt is status-free by design** (`server.ts:2903`): it deliberately omits pane status and instructs the model to "ALWAYS call `list_panes`." `list_panes` *is* live (`src/actions/registry.ts:97` → `manager.listPanes()` → reads in-memory `term.status`), but nothing *enforces* the call. If the model relies on memory or skips it, it has zero "running" signal.
- **`switch_context` briefing is stale** (`src/actions/defs/orient.ts:105` → `src/ledger.ts:459` `getProjectBriefing`): it serves `ws.panes` from the ledger snapshot without calling `syncLedger()` first, so even the "catch me up" path can hand back old `is_busy` values.

Net: **Janus hears endings, is deaf to beginnings, and its catch-up can be stale.** That is the full mechanism behind "didn't know Claude was cooking / didn't know commands were running."

> The operator-facing status light has the same root: pane status crosses the wire only via the `GET /api/terminals` snapshot (`server.ts:921`) on a 20s client poll (`src/App.tsx:884`); the Running→Idle flip is never pushed. Phase 1 fixes both viewers from one feed.

---

## Scope

**In scope — Janus's own brain context:**
- The **World-Model**: Janus's always-live picture of the panes (who's running, what's cooking, commands in flight, recent activity).
- The **Shaper + Memory/RAG**: what we feed the brain (summarize, prioritize, fit the token budget) and what Janus remembers across time (the ears as memory + retrieval).

**Out of scope — the pane agents' own memory:**
- Claude / Codex panes manage their *own* context/sessions. Janus **observes** them (the live feed) and **orchestrates** them (instruct / restart / hand off), but does not own their internal memory. This design never reaches into a pane agent's head.

---

## Locked decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Target = **fast AND honest**, phased | Speed felt immediately; honesty (the hard part) isolated |
| D2 | Phase 1 = **ears + fresh catch-up** (the "B" scope) | Smallest change that ends the blindness; world-model's first brick |
| D3 | World-Model lives **in TypeScript, in-process** | It must sit next to the live state (`term.status`, PTY, ledger) or we re-create the very lag we're killing |
| D4 | Shaper + Memory/RAG = **Python submodule, its own arch doc** | Director chose the Python ecosystem (retrieval / embeddings) for Janus's long-term memory, eyes open to the greenfield cost |
| D5 | **Memory/RAG is P0** with its own dedicated design effort | It is the destination the live feed flows into, not a downstream add-on |
| D6 | The **"ears" stream is the memory's primary input** | Janus hears → remembers → retrieves: one pipeline, not two features |

---

## Architecture

```
① LIVE SOURCES  (already in the app · one Node process)
   panes (is it cooking?) · commands in flight · history / ledger
   └─ Phase 1 adds the missing "started / cooking / command-running" signal here
            │  live feed (push)
            ▼
② CONTEXT-MANAGEMENT LAYER
   ┌────────────────────────────┐     ┌──────────────────────────────────────┐
   │ World-Model                │     │ Shaper + Memory / RAG                  │
   │ TS · in-process            │ ──► │ Python submodule (own arch doc)        │
   │ the always-current picture │seam │ summarize · retrieve · budget · remember│
   │ (Phase 1 feeds it)         │ ◄── │ ingests the EARS stream as memory      │
   └────────────────────────────┘     └──────────────────────────────────────┘
            │  fresh, right-sized · push + on-demand
            ▼
③ CONSUMERS
   🤖 Janus's brain (Gemini Live: live nudges + always-fresh briefing)
   🖥️ Operator's board / status light (same live truth, instant)
```

**The seam (Node ↔ Python):** a thin, well-defined interface (stdio or local HTTP) is the only coupling between the in-process World-Model and the Python memory service. The World-Model never blocks on it; memory enrichment/retrieval is async. This boundary is the contract the dedicated memory/RAG design must specify.

**Why the split is non-negotiable:** the World-Model touches live, fast-changing in-process state — putting it across a process boundary would stream all that state out just to track it, re-introducing staleness/latency. The Shaper/Memory is pure transformation + retrieval over an already-captured stream, so it can live in Python without that penalty.

---

## Roadmap / phasing (Path C)

- **Track 0 — Stop the double-send** *(parallel, quick, independent)*
  Approval-click can deliver a pane message twice: the approve path writes via `writeInput` (`server.ts:2167`) but leaves the dictated text in the draft, which a subsequent draft `Send` (`server.ts:1683`) re-emits. Client echo ruled out (verified). Fix: clear the active draft on approve (mirror `server.ts:1685`) and/or a shared per-pane idempotency guard. Short design + failing test, in an isolated worktree.

- **Phase 1 — Give Janus ears** *(near-term, TS in-process)*
  Add a `running`/`started` pane-signal kind; publish it on the Running edge (`src/terminal.ts:566`) and on command dispatch; fan it to (a) the model via the existing `paneSignalBus` channel and (b) the UI via a real-time status push (ending the 20s-poll lag). Make `switch_context` call `syncLedger()` first so catch-up is never stale.

- **P0 — Janus Memory / RAG** *(its own design effort — P0 priority; Phase 1 builds first only because it is the enabling foundation that produces the ears stream, NOT because memory ranks lower)*
  Python submodule. Ingests the ears' event stream as durable memory; serves retrieval into the brain's context. Owns summarization, prioritization, token budgeting (graduating from the Gemini SDK's `contextWindowCompression`, `server.ts:2914`), and long-term recall (today partially served by the SQLite ledger + beads). **Gets its own design doc** — see open questions below.

- **Phase 2 — Make it honest** *(after Phase 1 proves out)*
  Distinguish "just paused" from "genuinely done" for CLI agents (no clean signal exists today — quiet ≠ done; see `src/terminal.ts:344`, 2s silence heuristic). Introduce an intermediate `cooking…` / quiescing state and a humble on-screen label. Voice reserved for genuinely-needs-you moments.

---

## Trade-offs & risks (accepted)

- **Python is greenfield here (chosen cost).** No Python exists in the repo today; a prototype `universal_terminal.py` was deliberately deleted (commit `75a4786`). Standing up the memory submodule means a new Node↔Python IPC seam, a Windows Python runtime/venv, and new build/test wiring. The director accepted this for the Python retrieval/embeddings ecosystem. The dedicated design must keep the seam thin and the World-Model independent of it (degrade gracefully if the memory service is down).
- **Phase 2's "breath vs. done" is genuinely uncertain.** Isolated on purpose; Phase 1's ears already self-correct a premature "done" (the next output republishes "running"), reducing the pain before Phase 2 removes the cause.

---

## Open questions for the dedicated Memory/RAG design effort

1. **Seam transport:** stdio subprocess vs. local HTTP sidecar — lifecycle, restart, Windows packaging.
2. **Memory model:** what's an "event-as-memory" record (cooking starts, command runs, outcome)? retention, redaction (must reuse `redactSecrets`), and indexing.
3. **Retrieval contract:** when does the brain pull memory vs. receive a push? token-budget interplay with Gemini's existing compression.
4. **Relationship to existing stores:** SQLite ledger + beads (`bd remember`) already hold durable state — what graduates into RAG vs. stays.
5. **Failure posture:** World-Model must function fully with the memory service offline.

---

## Non-goals

- Reaching into pane agents' (Claude/Codex) internal memory.
- Replacing the capability-gate safety matrix.
- Phase 2 detection work bundled into Phase 1.
