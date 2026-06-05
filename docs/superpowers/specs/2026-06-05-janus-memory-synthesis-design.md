# Janus Memory Synthesis — Design

- **Date:** 2026-06-05
- **Status:** Draft for review (brainstorm output)
- **Scope owner:** gerso (director)
- **Bead:** `wsm-e2e-pinned-46v.2` (P0, child of epic `wsm-e2e-pinned-46v` — Janus Context-Management Layer)
- **Parent / supersedes-in-part:** `docs/superpowers/specs/2026-06-05-janus-context-management-architecture-design.md`.
  This is the dedicated Memory/RAG design effort that parent doc deferred (its D5). It **corrects two
  premises** in the parent (see Problem) and **redefines** the Python submodule from a RAG retrieval
  engine into a **context synthesizer** (per director decision, 2026-06-05).
- **Related:** capability-gate model (`[[janus-capability-gate-model]]`); locked roadmap `docs/roadmap/RECONCILIATION.md` §4.

---

## BLUF

Janus's brain (Gemini Live) reasons from a snapshot taken when the conversation started, and that
snapshot **rots** — most painfully **as the operator switches the active pane**, when Janus keeps
carrying stale context from the pane it just left.

The fix is **not a search engine — it is an autofocus camera.** A Python **Context Synthesizer**
blends five scoped tiers of memory into a right-sized, situationally-aware context for Gemini Live and
**re-focuses on every pane switch**: the new pane snaps into the foreground, the previous pane blurs
into a breadcrumb, the project stays in the mid-ground, the board/system frame stays in the soft
background. The in-process TypeScript **World-Model** holds the always-live raw truth; Python only
*shapes* it. Embeddings / semantic RAG are explicitly **deferred** — v1's mechanism is tier blending
+ token budgeting + recency decay, none of which needs a vector store.

**The v1 success criterion (director-chosen):** *faithful recall with no rotted context at the start
of any interaction, especially across pane switches.*

---

## Problem (grounded in the code)

Janus's only real-time channel into the live model session is the `paneSignalBus` → `sendClientContent`
path. Phase 1 ("ears", shipped — PR #33) added the missing *beginning* edges (`running`/`quiescing`)
so the model now hears panes **start**, not just stop. That closes the "deaf to beginnings" gap. It
does **not** solve context rot: the model still receives a point-in-time briefing and then drifts,
and **switching the active pane does not re-blend its working context.**

**Two premises in the parent arch doc do not hold (verified 2026-06-05):**

1. **There is no `contextWindowCompression` in `server.ts`.** The parent doc claimed we would
   "graduate from" an existing Gemini SDK compressor (cited `server.ts:2914`); a content search finds
   no such configuration. Any compression/budgeting is **net-new**, owned by this design — not a
   migration of existing behavior.
2. **Storage is NOT greenfield.** `src/store/` already persists a substantial memory substrate:
   - `events` — an append-only spine with 13 typed event kinds (`COMMAND_OUTCOME`,
     `STATUS_TRANSITION`, `APPROVAL_DECIDED`, `HANDOFF`, `NOTE_ADDED`, `PLAN_STEP`, …), indexed by
     pane/project/type/time (`src/store/eventTypes.ts`, `src/store/schema.ts`).
   - **`events_fts` — an FTS5 full-text index** over every event's summary+payload, trigger-synced.
     Keyword retrieval over the ears stream already works in-process.
   - `notes` + `notes_fts`, `action_log` (turn-correlated via `interaction_id`),
     `projects.summary`/`projects.key_terms`, `panes.model_context`/`human_context`/`last_command`,
     and **TTL retention** (`src/store/retention.ts`).

**Consequence for scope:** the Python submodule must NOT re-build storage or keyword search — those
exist. Its non-duplicative job is the part TS lacks: **synthesizing** the right blend of
project + pane + system context into Gemini's working context, kept fresh across pane switches.

---

## Scope

**In scope:**
- A formalized in-process **World-Model** (TS): the always-live, never-rotted raw picture the
  synthesizer reads from (panes, statuses, the tier source material).
- A **Context Synthesizer** (Python submodule, the "full home" for context shaping): blends the five
  tiers into a token-budgeted, situationally-aware brief; re-synthesizes on pane switch.
- The **anti-rot freshness contract**: when context is (re)assembled and injected into Gemini Live.
- A **TS fallback assembler** so freshness survives the synthesizer being slow/down.

**Out of scope (deferred):**
- **Embeddings / vector RAG / semantic similarity.** Reserved as an *optional future input* the
  synthesizer may call once "learn from outcomes" (proactive pattern recall) becomes the proven need.
- Reaching into pane agents' (Claude/Codex) own internal memory — Janus observes/orchestrates, never
  owns their heads.
- Replacing the capability-gate safety matrix.

---

## Locked decisions

| # | Decision | Rationale |
|---|----------|-----------|
| M1 | v1 success = **faithful recall, no rotted context at start** | The disease is "boots on a stale snapshot," not "can't search history" |
| M2 | The acute failure is **context rot on pane switch** | Switching the active pane must re-blend the working context |
| M3 | Python submodule = **Context Synthesizer**, NOT a RAG engine | Director redefinition: blend the right amount of project+system+pane context for situational awareness |
| M4 | **Embeddings/RAG deferred** (optional future synthesizer input) | v1 needs tier-blend + budget + recency decay; none requires a vector store — also de-risks the Python greenfield |
| M5 | Memory is **scoped + weighted: Project ▸ Pane ▸ System** | Director's tier weighting; maps onto existing schema |
| M6 | System tier = **Board + Janus frame + decaying Breadcrumbs** | Breadcrumbs = small, lossy, recency-weighted "post-it / bead" trail of Janus's cross-pane work |
| M7 | **TS World-Model holds raw truth; Python only shapes it** | The freshness-critical reflex stays in-process; synthesis is the slower deliberate layer |
| M8 | **Anti-rot must not depend on Python** (TS fallback assembler) | Freshness is guaranteed by World-Model + fallback; Python makes it smaller/prettier, not *present* |
| M9 | Seam transport = **stdio subprocess** | No port/network surface; child dies with parent → no orphaned Python on Windows |
| M10 | Build order: **P0a TS (anti-rot) → P0b Python (synthesis)** | Anti-rot ships before Python exists; synthesis swaps in behind the same contract |
| M11 | v1 synthesis is **primarily extractive** (deterministic, no model call on the pane-switch hot path); LLM summarization is optional/bounded and off the critical path | Keeps re-focus fast; avoids per-switch model latency/cost; makes synthesis testable deterministically |

---

## The five-tier memory model

Modeled on human memory. Project + Pane are the durable tiers; the three System sub-tiers
(Breadcrumbs, Board, Janus frame) together are what the director called "system context."

| Tier | Analogue | Holds | Source (mostly exists) | Budget | Freshness |
|---|---|---|---|---|---|
| **Project** | Long-term semantic | Goal, key terms, decisions, milestones | `projects.summary`/`key_terms` + project-scoped `events`/`notes` | **Largest** | Slow-changing |
| **Pane (active)** | Current focus | Last command, recent ears, pane history/outcomes | `panes.*` + pane-scoped `events`/history | **Next** | Foregrounded on switch |
| **Breadcrumbs** | Short-term working | Decaying 1-line cross-pane action trail ("was on X") | `action_log` + ears, summarized + redacted | Small, **fades** | Recency-decayed |
| **Board** | Perception | All panes' live status at a glance | World-Model (live in-process) | Small | Always live |
| **Janus frame** | Self-model | Role, capability-gate posture, global operator prefs | `settings` + global `notes` | Tiny | Static-ish |

**Breadcrumb decay (the whole v1 mechanism — no embeddings):** each breadcrumb is a short,
secret-redacted, timestamped line derived from a cross-pane action/observation. Salience = a function
of age; the synthesizer includes the top-N most-recent within the breadcrumb budget slice; older ones
fade and drop. This is Janus's short-term memory of *its own* work across panes.

---

## Architecture

**The 3B1B intuition — a camera with depth of field.** Active pane = sharp foreground. Project =
mid-ground (always visible, gives the scene meaning). Board/system = soft background (present for
awareness, never sharp). On pane switch the camera **re-focuses**: new pane sharp, old pane blurs to a
breadcrumb. Python is the autofocus motor.

```
   RAW TRUTH — TS World-Model (in-process · never rots)
   ┌───────────┬──────────────┬───────────────────────────────┐
   │ PROJECT   │ ACTIVE PANE  │ SYSTEM                         │
   │ summary,  │ last cmd,    │ board (all panes) · Janus frame│
   │ key_terms,│ recent ears, │ · decaying breadcrumbs         │
   │ decisions │ pane history │                                │
   └─────┬─────┴──────┬───────┴───────────────┬────────────────┘
         │  raw tiered snapshot + active-pane + deltas (stdio, async)
         ▼            ▼                        ▼
   ┌──────────────────────────────────────────────────────────┐
   │  PYTHON CONTEXT SYNTHESIZER  ("full home")                 │
   │  blend · token-budget · summarize · recency-decay          │
   │  re-focuses on PANE SWITCH / session start / delta         │
   │  (embeddings/RAG = deferred optional input)                │
   └───────────────────────────┬──────────────────────────────┘
         synthesized brief      │   (or TS fallback if Python slow/down)
                                ▼
              Gemini Live working context  (sendClientContent)
                  situationally aware · never rotted
```

**Two-speed memory.** A *fast reflex* (TS World-Model: where is everything right now — instant,
always correct, the source of anti-rot). A *slow deliberate* layer (Python synthesizer: blend the
reflex into a budgeted, situationally-aware brief — may take ~100–300ms, triggered eagerly on switch).
Putting the fast reflex across a process boundary would rebuild the very lag we are killing, so it
stays in TS (M7).

### Components & boundaries

- **`WorldModel` (TS, in-process):** reads live `OrchestratorManager` state + `JanusStore` (events,
  FTS, notes, projects, panes) and exposes pure **tier extractors** — `getProjectTier(projectId)`,
  `getPaneTier(paneId)`, `getBoardTier()`, `getJanusFrameTier()`, `getBreadcrumbs(now)`. No I/O beyond
  the already-in-process store. This is the single source of raw truth.
- **`BreadcrumbRing` (TS):** a bounded, append-on-action ring of redacted 1-line cross-pane notes with
  timestamps; recency-ranked read. Fed from the same edges the ears use (`onRunning`/`onIdle`/
  `command_dispatched`/`approval_decided`) — observation only, no CLI writes.
- **`SynthesizerClient` (TS):** owns the stdio child lifecycle, request/response framing, timeout, and
  **falls back** to `FallbackAssembler` on timeout/error/child-down.
- **`FallbackAssembler` (TS):** deterministic, no-LLM assembly — concatenate tiers in weight order,
  recency-truncate each to its budget slice. Guarantees fresh (if unpolished) context with Python
  absent (M8).
- **`synth/` (Python submodule):** the synthesizer. Transformation over the raw tiered snapshot:
  token-budget allocation across tiers, per-tier selection/truncation, breadcrumb recency selection,
  and assembly. **v1 is primarily extractive** (deterministic, fast — no model call on the hot path,
  M11); an optional, bounded per-tier LLM summarization step (mirroring the redacted Gemini-flash
  `summarizeCommandOutcome` in `src/observe/index.ts`) can enrich a tier under high budget pressure,
  off the critical path. Stateless across requests in v1 (TS owns all state).

---

## Synthesis & budget (the autofocus motor)

- **Fixed token budget `B`** for the assembled brief (configurable; defaults in settings/advanced).
- **Allocation weights** across slices: Project > Pane > (Breadcrumbs + Board + Janus frame),
  normalized to `B`. Exact default split is an implementation-plan tunable.
- **On synthesis:** TS gathers the raw tier material from the World-Model → ships it to Python →
  Python **extractively selects/truncates** each tier to its slice (optionally summarizing only under
  high budget pressure, M11) and returns one situational brief + per-tier token accounting.
- **Re-focus rule (M2):** on pane switch, the *previous* active pane's detail is demoted into a
  breadcrumb ("was working on X: <1-line>"); the new active pane fills the focus slice. The project
  slice is stable across the switch (that continuity is what keeps the scene coherent).
- **Summarization reuse:** input is always secret-redacted (`redactSecrets`) before any model call,
  exactly as the existing outcome summarizer does.

---

## The seam (Node ↔ Python, stdio · async · non-blocking)

- **Transport (M9):** Node spawns the Python synthesizer as a child process; newline-delimited JSON
  (or length-prefixed JSON) over stdin/stdout. No port, no network surface; the child dies with the
  parent (no orphaned Python on Windows). `PYTHONIOENCODING=utf-8` set on spawn (Windows cp1252 trap).
- **TS → Python `SynthesisRequest`:** `{ requestId, activePaneId, budget, tiers: { project, panes[],
  board, breadcrumbs[], janusFrame } }` — all fields already redacted by TS.
- **Python → TS `SynthesisResult`:** `{ requestId, contextText, perTierTokens, version }`.
- **Async, non-blocking:** the TS live loop never blocks on the synthesizer. A request carries a
  **timeout**; on timeout/error the `FallbackAssembler` result is used and the late Python result (if
  any) is dropped or applied to the next turn (implementation choice).
- **Injection:** the synthesized brief reaches Gemini Live via the existing `sendClientContent`
  channel (same path the ears use). The synthesizer never issues CLI/pane writes — observation +
  context only, so it stays outside the capability-gate coupling (mirrors the observe pipeline
  invariant).

---

## Freshness triggers (the anti-rot guarantee)

Re-synthesize on:
1. **Pane switch** — primary; this is the acute rot case (M2). Wire from the active-pane election
   point (`OrchestratorManager` active-id change) / `switch_context`.
2. **Session / WS connection start** — never hand a fresh client a stale brief.
3. **Significant delta** — error / completion / new pane / handoff (the high-salience ears edges).
4. **Optional periodic heartbeat** — bounded refresh for long-idle sessions (settings-gated, off by
   default).

`switch_context` already calls `refreshLedger()` first as of PR #33; this design extends that path to
also request a fresh synthesis rather than serving the snapshot briefing.

---

## Failure posture (graceful degradation)

- **Anti-rot is owned by TS, not Python.** World-Model is always live; `FallbackAssembler` always
  produces a fresh brief. If the Python child is down, slow, crashes, or fails to spawn, Gemini still
  receives **fresh** context — just not summarized/optimally budgeted.
- **Child lifecycle:** spawn on demand / on first need; health via a cheap ping; bounded restart with
  backoff; permanent fallback if restart budget is exhausted (logged, surfaced, non-fatal).
- **No orphans:** child tied to the Node process; killed on shutdown.

---

## Build phasing

- **P0a — TS, anti-rot first (ships value before Python exists):**
  `WorldModel` + tier extractors, `BreadcrumbRing`, `FallbackAssembler`, freshness triggers (pane
  switch / session start / delta), and injection wiring. At the end of P0a, context is **fresh and
  re-focuses on pane switch** using the deterministic fallback assembly.
- **P0b — Python, synthesis behind the same contract:**
  `synth/` submodule + `SynthesizerClient` (stdio) + budget/summarize. Swap the fallback for real
  synthesis; fallback remains the safety net.
- **Deferred — semantic layer:** embeddings/RAG as an optional synthesizer input when proactive
  pattern recall ("last 2 times this command failed…") becomes the proven need.

---

## Testing (TDD per repo conventions)

- **Unit (TS):** tier extractors (shape + redaction), breadcrumb decay/recency selection, budget
  allocation/normalization, `FallbackAssembler` determinism + recency truncation.
- **Contract:** `SynthesizerClient` against a **mock Python** child (fixture process) — request/
  response framing, timeout → fallback, restart/backoff, no-orphan teardown.
- **Integration (the core regression guard):** simulate pane switch and assert the brief
  **re-focuses** — new pane in focus slice, **previous pane's detail dropped** from focus (demoted to
  breadcrumb). This is the direct test of M2 (no rot on switch).
- **Python unit:** budget allocation + extractive per-tier selection/truncation against golden inputs
  (deterministic); the optional LLM summarization step is stubbed.
- Verify with the repo battery: `npm run lint` · `npm test` (`--test-force-exit`) · `npm run build`;
  add Python test invocation to the build/test wiring (set `PYTHONIOENCODING=utf-8`).

---

## Open questions for the implementation plan

1. **Budget split defaults** — concrete token weights per tier and total `B`; where configured
   (settings `advanced`).
2. **Breadcrumb ring size + decay curve** — N, max age, and the salience function.
3. **Python runtime/packaging on Windows** — interpreter discovery (`py -3` vs venv), dependency
   pinning, and the build/test hook integration (`scripts/check-deps`-equivalent for Python).
4. **Late-result policy** — on timeout-then-late-arrival: drop, or apply to the next turn.
5. **Framing detail** — newline-delimited vs length-prefixed JSON; backpressure handling.

---

## Non-goals

- Embeddings / vector RAG / semantic similarity in v1 (deferred optional input).
- Reaching into pane agents' internal memory.
- Replacing the capability-gate matrix.
- Any autonomous CLI/pane write from the memory layer — it is observation + context only.
