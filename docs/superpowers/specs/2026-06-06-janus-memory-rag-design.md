# Janus Memory / RAG — Design (P0, dedicated effort)

- **Date:** 2026-06-06
- **Status:** Draft for review (proposal — not yet approved for build)
- **Scope owner:** gerso (director)
- **Bead:** `wsm-e2e-pinned-46v.2.7` (RAG / embeddings; deferred — "optional once learn-from-outcomes is the proven need")
- **Predecessors (read first):**
  - `docs/superpowers/specs/2026-06-05-janus-context-management-architecture-design.md` — the pipeline (Janus hears → remembers → retrieves); locked D4/D5/D6; open questions Q1–Q5 answered here.
  - `docs/superpowers/specs/2026-06-05-janus-memory-synthesis-p0b-design.md` — P0b shipped a **warm Python synthesizer** over an **NDJSON stdio seam** with redaction + unconditional fallback. **This RAG design extends that seam; it does not invent a competing one.**
- **Grounding (code that already exists on this branch):**
  - Seam: `src/memory/pythonClient.ts`, `python/synthesizer/{__main__,dispatch,synth}.py`, wire schemas in `src/memory/types.ts`.
  - Ears: `src/paneSignals.ts` (`PaneSignalKind = created|running|quiescing|idle|error|prompt|exited|closed`; `classifyPaneOutput`, `formatPaneSignal`).
  - Redaction: `redactSecrets` in `src/terminal.ts` (already applied at the signal boundary and in `WorldModel`).
  - Durable stores: `src/store/schema.ts` — `events` + `events_fts` (FTS5/bm25), `notes` + `notes_fts`; `src/store/sqliteStore.ts` `getEvents()` / `addNote()` / `search()` (bm25-ranked); `src/store/eventTypes.ts` (`COMMAND_DISPATCHED`, `COMMAND_OUTCOME`, `STATUS_TRANSITION`, …); `src/store/retention.ts` (TTL prune on boot). beads (`bd remember`) holds locked decisions.

---

## BLUF

**Build memory as a second op on the seam P0b already owns, and ship recall *without* vectors first.** The repo already has a bm25-ranked FTS5 index over `events` and `notes` — that is structured + lexical RAG for free, with zero new dependencies. The "event-as-memory" record is just the Phase 1 ears stream redacted and written to the existing `events` table; retrieval is a new `recall` op on the existing stdio NDJSON daemon that the Python side answers by querying SQLite (read-only) and reranking. **Embeddings are deferred** until lexical recall is proven insufficient against real "learn-from-outcomes" usage — and even then they slot in behind the same op, behind a feature flag. The whole subsystem is a **strict upgrade, never a dependency**: with the daemon offline, Janus falls back to the deterministic P0b brief and the in-process World-Model, exactly as today.

The one-line mental model (3B1B): P0b is a **photographer** — it takes the current scene (tiers) and crops it to fit the frame (budget). RAG adds a **librarian** — when the brain asks "have we hit this before?", the librarian walks the shelves (the `events` archive) and hands back the 3–5 most relevant index cards. The photographer runs every pane-switch; the librarian runs only when summoned. Same building (the Python daemon), two desks.

---

## What is already true (do not rebuild)

| Asset | Where | What it gives RAG for free |
|---|---|---|
| Warm Python daemon + NDJSON stdio seam | `pythonClient.ts`, `dispatch.py` | id-correlated request/response, ping handshake, circuit breaker, exponential backoff, UTF-8 hardening, `JANUS_PYTHON` discovery, eager pre-warm |
| Unconditional fallback posture (I1) | `MemoryService.synthesizeAsync` | the floor pattern RAG copies verbatim — any miss ⇒ in-process answer |
| Ears event stream | `src/paneSignals.ts` | the *primary memory input* (D6): `running` (cooking-start), command dispatch, `idle`/`error`/`exited` (outcome) |
| Redaction at the boundary | `redactSecrets` (`src/terminal.ts`) | the **only** sanctioned scrubber; already applied to signal `detail` and `WorldModel` text |
| Append-only `events` + FTS5 | `schema.ts` v1, `events_fts` | **a working lexical search index over every domain event, ranked by bm25** |
| Ranked search method | `sqliteStore.search(query, {source,limit})` | bm25 recall over events + notes, already merged + capped |
| Typed event log | `eventTypes.ts` | `COMMAND_DISPATCHED` / `COMMAND_OUTCOME` / `STATUS_TRANSITION` are literally the cooking/command/outcome triple Q2 asks for |
| Retention | `retention.ts` `pruneOnBoot` | TTL deletion already cascades to `events_fts` via triggers |
| beads | `bd remember` | durable, human-curated decisions/knowledge |

**The thesis of this design:** ~80% of "Janus remembers" is already in the repo as SQLite + FTS5. The dedicated effort is mostly (a) *write* the ears as first-class memory events and (b) add a *retrieval op* to the existing seam — not a greenfield vector store.

---

## Q1 — Seam transport

**Recommendation: extend the existing stdio NDJSON subprocess with a new `recall` op. Do NOT add a second transport.**

P0b already chose and hardened stdio NDJSON (P0b D1/D4). RAG adds **one op**, reusing the same daemon, framing, correlation, handshake, breaker, and discovery. The only delta is that the daemon now needs **read-only access to the SQLite file** (for lexical recall) — which it opens itself by path, not over the wire.

### MECE trade-offs

| Option | Latency | Ops/packaging cost | Concurrency | Failure blast radius | Verdict |
|---|---|---|---|---|---|
| **A. Extend stdio daemon w/ `recall` op (reuse P0b)** | warm, in-proc-adjacent; no connect/TLS | **zero new** — same spawn, same resolver, same breaker | single long-lived child, request-multiplexed by `id` | identical to P0b — daemon down ⇒ fallback | **CHOSEN** |
| B. Local HTTP sidecar | + connect/keepalive; loopback only | new: port mgmt, bind races, firewall prompts on Windows, lifecycle daemon | natural multi-request | a hung port/another process on the port is a *new* failure mode | rejected — reintroduces the lifecycle surface P0b deliberately avoided |
| C. Separate RAG subprocess (2nd daemon) | warm | 2× spawn/health/breaker logic to maintain | isolated | 2 things that can fall over | rejected — duplicates the seam D4 says keep thin |
| D. In-process TS RAG (no Python) | lowest | zero | n/a | none | rejected for the *vector* future (D4 locked Python for embeddings); **but see Q-embeddings — for the lexical v1, TS could query FTS directly. We still route through Python for one seam + a clean graduation path to vectors.** |

### How `recall` rides the existing client

- New op on the wire: `{"op":"recall", ...}` alongside `ping` / `synthesize`. Same `v:1` gate, same `id` correlation, same `ok:true|false` envelope (`dispatch.py` `handle()` already dispatches by `op` — add one branch).
- `pythonClient.ts` gains a sibling `recall(query, opts)` method mirroring `request(...)`: pending-map entry, per-call expiry, `safeParse` of the response, resolve `{ok:false}` on any miss. **No new spawn/health/breaker code** — it shares the daemon the constructor already pre-warms.
- **SQLite access:** the daemon opens the DB **read-only** (`sqlite3.connect("file:...?mode=ro", uri=True)`, stdlib `sqlite3` — no pip dep) using a path passed once at handshake or per-request. Reads only; **all writes stay in TS** (the existing `recordActivity` path) so there is exactly one writer and no lock contention. WAL mode (already used by better-sqlite3) makes concurrent RO readers safe.
- **Windows packaging:** unchanged. `python/synthesizer/` is git-tracked and copied to `dist/python/` by the existing build step; the DB path is resolved in TS and handed to the child (never guessed by Python).

**Why not just query FTS from TS and skip Python for v1?** Tempting (D option) and genuinely simpler for *lexical-only* recall. We still route through the daemon because: (1) it keeps **one** memory seam, not "synth in Python, recall in TS"; (2) the graduation to embeddings (Q-embeddings Phase R3) lands behind the *same* op with *zero* call-site change; (3) reranking/clustering logic wants to live next to the synthesizer's salience code (`synth.py`), reused. This is a deliberate, documented bet — if review prefers TS-lexical-first, it is a clean fallback that costs only the future re-plumb.

---

## Q2 — Memory model: the "event-as-memory" record

**Recommendation: the memory record *is* a redacted `events` row. Reuse the existing table, FTS index, event types, and retention — add a thin typed projection, not a new store.**

### The record (sourced from the Phase 1 ears — D6)

The ears already emit the cooking/command/outcome triple. Each becomes one `events` row, written in TS at the moment the signal fires:

| Ears signal (`PaneSignalKind`) | Event type (`eventTypes.ts`) | Memory meaning |
|---|---|---|
| `running` (the new Phase 1 start edge) | `STATUS_TRANSITION` (`{to:"Running"}`) or a dedicated `cooking_start` | "this pane started cooking" |
| command dispatch | `COMMAND_DISPATCHED` | "we ran X" (command redacted) |
| `idle` / `error` / `exited` | `COMMAND_OUTCOME` / `STATUS_TRANSITION` | "X finished / failed / the pane ended" — **the outcome that makes it learnable** |

**Schema:** no migration required for v1. The existing `events` columns carry it:

```
events(id, ts, type, project_id, pane_id, session_id, summary, payload, handoff_id)
events_fts(summary, payload)   -- FTS5, bm25-ranked, trigger-synced
```

- `summary` = the short, human/model-facing line (what `formatPaneSignal` produces, minus the directive wrapper) — **already redacted**.
- `payload` = JSON sidecar: `{runtimeType, lastCommand?, outcomeKind, durationMs?, exitInfo?}` — **redacted before serialize** (the `NewEvent` contract already says "REDACTED by caller").
- Correlation: `pane_id` + `session_id` + (for command lifecycles) `handoff_id` thread a `dispatched → outcome` pair so the librarian can return "we ran X and it failed with Y."

A **light TS projection** `MemoryEvent` (in `src/memory/`) typed over `StoredEvent` keeps callers honest, but it is a view, not a new table.

### Retention

Reuse `retention.ts` `pruneOnBoot` (TTL via `eventsTtlDays`). Memory events age out with the rest of the audit spine; FTS stays in sync via the existing delete triggers. **Open knob for the director:** memory-relevant events (outcomes) may deserve a *longer* TTL than chatty status churn — a `type`-aware retention tier is a small, additive follow-up, not a v1 blocker.

### Redaction (MUST reuse `redactSecrets` — invariant)

- **Single scrubber.** Every text field of a memory event passes through `redactSecrets` (`src/terminal.ts`) in TS **before** the `events` write. This is the *same* boundary the ears already use for signal `detail` and the *same* P0b invariant I5 (Python never sees raw text).
- **Python never redacts and never sees raw text.** The `recall` op returns rows that were redacted *at write time*; the daemon reads already-scrubbed `summary`/`payload`. No new redaction surface is introduced.
- **Invariant (RAG-I5, mirrors P0b I5):** no un-redacted text crosses the seam, in either direction, in any op.

### Indexing

- v1: the **existing FTS5 index** (`events_fts`) — already there, already bm25-ranked, already trigger-maintained. Zero new index to build or migrate.
- Structured filters (pane, project, type, time window) ride the existing `idx_events_*` indexes via `getEvents`-style WHERE clauses.
- Vectors: **deferred** (Q-embeddings). When added, the vector index is a *parallel* structure keyed by `events.id`, not a replacement.

### MECE trade-offs (record substrate)

| Option | New deps/migrations | Recall quality (v1) | Redaction story | Verdict |
|---|---|---|---|---|
| **Reuse `events` + `events_fts`** | none | bm25 lexical + structured filters | one boundary, already invariant | **CHOSEN** |
| New `memory` table + own FTS | migration; 2 write paths to keep in sync | marginal (same engine) | second boundary to audit | rejected — duplicates the spine for no recall gain |
| External vector DB (chroma/lance/…) | pip dep, venv, file lifecycle | semantic | new boundary | rejected for v1 (no-new-deps ethos; unproven need) |

---

## Q3 — Retrieval contract: push vs pull, token-budget interplay

**Recommendation: PULL by default (a `query_memory` tool the brain calls), with a narrow, automatic PUSH only on the `error`/`outcome` edge. Memory output is a *fourth tier* inside the existing char budget, never additive to it.**

### Push vs pull

- **Pull (primary).** Expose a `query_memory` action in the registry (sibling to the existing notes-recall tool) that the brain calls when it reasons "have we seen this?". This matches the model's existing `list_panes`/notes pattern, is cheap when unused, and keeps the brain in control of *when* recall costs tokens. The action calls `MemoryService.recallAsync(query, opts)` → `pythonClient.recall(...)` → SQLite RO + rerank.
- **Push (narrow, automatic).** On a high-signal **outcome** edge (`error`, or a command `COMMAND_OUTCOME` with failure), the ears path may *proactively* run one recall ("we hit this error before — last time the fix was Z") and fold a single, short hint into the *same* `sendClientContent` note the signal already emits. This is the "learn-from-outcomes" payoff and must be **rate-limited + dedup'd** (one hint per outcome, suppressed if identical to a recent push) so it never floods the session.

### Token-budget interplay (this is the load-bearing constraint)

P0b's brief is **char-budgeted** (`totalBudgetChars` 4800 ≈ 1200 tokens, `MemoryConfig`), raced under 150ms, injected fire-and-forget. Memory must not silently double the brief.

- **Pull path:** the `query_memory` *response* is its own budgeted block (`recallBudgetChars`, default ~1200 chars ≈ 300 tokens) returned to the tool caller — it is a tool result the model already pays for, separate from the switch-brief. The model decides what to keep.
- **Push path:** the hint is carved **out of the existing per-switch budget**, not added to it. Concretely: the synth `cfg` gains an optional `recall` sub-budget; when a push fires, the active-pane tier yields a few hundred chars to a `RECALL:` line so the *total* still respects `totalBudgetChars` (P0b invariant I7 preserved). The Python synthesizer (which already does adaptive reallocation in `synth.py`) is the natural place to blend it.
- **Gemini `contextWindowCompression` (per the context-mgmt spec, `server.ts` Gemini config):** the live SDK already runs a sliding-window compaction on the session transcript. Our briefs/hints are *inputs* to that window; we **graduate toward** owning the right-sizing (the context-mgmt spec's stated direction) but for v1 we **stay strictly under our own char budget** so we never fight the SDK's compressor — we feed it pre-trimmed, salient text and let it manage the long tail. **We do not disable or reconfigure `contextWindowCompression` in this effort.**

### MECE trade-offs

| Dimension | Push-only | **Pull + narrow push (CHOSEN)** | Pull-only |
|---|---|---|---|
| Token cost when irrelevant | always paid | paid only on outcome edge / when asked | zero unless asked |
| Learn-from-outcomes payoff | strong but noisy | strong, rate-limited | weak (brain must think to ask) |
| Brain control | low | high | highest |
| Risk of talking over operator | high (turn-gating needed) | bounded (rides existing turn-gated note) | none |
| Budget safety | hard (additive) | safe (carved from existing budget) | safe |

---

## Q4 — What graduates into RAG vs stays in SQLite ledger / beads

**Recommendation: nothing "graduates out" of SQLite — RAG is a *retrieval lens over* SQLite, plus a future vector sidecar. beads stays the human-curated decision store. Three tiers, clear owners.**

The framing in the open question ("what graduates *into* RAG") is a trap: it implies a migration. The grounded answer is that **the `events`/`notes` tables already *are* the corpus**; RAG is the read path, not a new home.

| Layer | Owner | Holds | Read path | Lifecycle |
|---|---|---|---|---|
| **Live, fast-changing** | World-Model (TS, in-process) | current pane status, in-flight commands | direct memory read (`getTiers`) | ephemeral |
| **Durable episodic corpus** | SQLite `events` + `notes` (+ FTS5) | the ears stream as memory events, command outcomes, operator notes | **RAG `recall` op** (lexical now, +vectors later) | TTL prune (`retention.ts`) |
| **Curated semantic knowledge** | beads (`bd remember`) | locked decisions, architecture rationale, durable "this is how we do X" | `bd` query (human/agent invoked) | human-curated, ~permanent |

**Decision rules (what writes where):**
- **Transient status** (a pane flipped Running) → World-Model only; it becomes a memory event **only** when it carries an outcome worth recalling (don't index every keystroke-level status churn — index starts and outcomes, not the in-between).
- **Episodic "what happened"** (we ran X, it failed with Y, the fix was Z) → `events` (auto, from ears) + `notes` (when the operator or Janus deliberately records a lesson). This is the RAG corpus.
- **Distilled "what we decided/learned"** → beads. RAG **may surface a beads pointer** in a recall result ("see decision wsm-…"), but RAG does not duplicate or replace beads. beads is the high-precision, low-recall store; RAG `events` is high-recall, lower-precision. They compose.

**Why no graduation/migration:** moving data between stores creates a sync invariant and a second writer — exactly the failure surface P0b's single-writer discipline avoids. The corpus already lives in SQLite; RAG just learns to read it well.

### MECE trade-offs

| Option | Sync invariants | Recall coverage | Curation quality | Verdict |
|---|---|---|---|---|
| **Lens over SQLite + beads pointer (CHOSEN)** | none new | high (all events) | high (beads untouched) | **CHOSEN** |
| Copy "important" events into a RAG store | yes (2 writers) | selective | medium | rejected — sync hazard |
| Replace ledger/beads with RAG | massive | high | **loses human curation** | rejected — beads' value is precisely its curation |

---

## Q5 — Failure posture

**Recommendation: copy P0b's posture verbatim — the daemon is a strict upgrade, never a dependency; with memory offline, World-Model + the deterministic P0b brief + (for recall) an in-process FTS or empty result keep Janus fully functional.**

The bar (locked in the context-mgmt spec): *World-Model must function fully with the memory service offline.* P0b already proved the pattern (I1, the resilience ladder). RAG inherits it.

| Condition | Behavior |
|---|---|
| daemon absent / interpreter missing | `synthesize` → P0b deterministic brief; `recall` → **empty result** (`{ok:false}` ⇒ caller treats as "no memory available"); breaker probes on cooldown |
| `recall` round-trip > timeout | that call returns empty; daemon stays up (mirrors the 150ms synth race; recall gets its own, more generous `recallTimeoutMs` — recall is pull, not on the refocus hot path) |
| SQLite RO open fails (locked/missing) | `recall` returns empty; logged once; synth path unaffected |
| daemon crash-loop | existing circuit breaker (3 fails/window → 60s fallback-only) — **shared** with synth, no new breaker |
| invalid/`ok:false` recall response | empty result; → breaker if it recurs |
| **floor** | **World-Model live reads + P0b `assembleBrief`, pure TS, always works; recall degrades to "no memory" (and optionally a TS-side `sqliteStore.search()` call as a same-process last resort)** |

**Two-rung floor for recall (stronger than P0b):** because the lexical corpus is *already queryable in TS* via `sqliteStore.search()`, the recall path can optionally fall back **in-process** (not just to "empty") — TS bm25 over the same FTS index — before giving up. This means even with Python dead, the brain can still get lexical recall. We recommend shipping the empty-result floor first (simplest, matches P0b) and adding the TS-search rung if live use shows recall is valuable enough to want it dead-daemon-resilient.

**Invariant (RAG-I1):** no recall or memory-write failure ever throws into the voice turn, the ears path, or the World-Model. Every miss resolves to a benign value (empty recall / unsynthesized event skipped) and one structured log line.

---

## Embeddings decision

**Recommendation: DEFER vectors. Ship lexical + structured recall first (FTS5 bm25, already in the repo, zero new deps). Add embeddings later — behind the same `recall` op, behind a flag — only if/when lexical recall is measurably insufficient against real learn-from-outcomes usage.**

This honors the repo's hard "no needless new deps" ethos (P0b I8: Python 3.8 stdlib only, no pip, no venv) **and** the bead's own framing (RAG is "optional once learn-from-outcomes is the proven need" — i.e., prove the need before paying the dependency).

### The three honest options

| Option | New deps | Quality | Windows/packaging cost | Offline | Privacy | Verdict |
|---|---|---|---|---|---|---|
| **R1. Lexical/structured only (FTS5 bm25 + filters)** | **none** (already in repo) | good for exact terms, error strings, command names, pane/file names — *which is most of what outcomes key on* | none | yes | yes (local) | **CHOSEN for v1** |
| R2. Small local embedding dep (e.g. a sentence-transformer / `fastembed`-class + a vector index) | pip + venv + model weights (10s–100s MB), breaks stdlib-only | semantic ("crash" ≈ "panic") | **high** — venv on Windows, model download, the venv/pip P0b explicitly deferred | yes | yes | **defer** (R3) — strongest semantic, heaviest cost |
| R3. External embedding API (OpenAI/Voyage/Gemini embeddings) | API key, network, per-call cost, latency | semantic | low runtime, but a network dependency on the hot-ish path | **no** (network) | **sends event text off-box** | **avoid for memory** — violates offline + local-privacy posture (event text, even redacted, leaving the box is a new exposure) |

### Why lexical-first is the right call here (3B1B intuition)

Janus's memory queries are unusually **lexical-friendly**. "Have we hit `ECONNREFUSED` on port 5173 before?" / "did `npm run build` fail in the web pane?" — these key on *exact tokens* (error codes, command names, file paths, pane names), which is precisely where bm25 shines and where embeddings add the least. Embeddings earn their keep on *paraphrase* recall ("the thing where the server wouldn't start"), which is a real but **secondary** need — exactly the kind of thing to validate with usage before paying venv+weights.

### The phased embeddings ramp (if proven needed)

- **R1 (now):** lexical/structured recall. Ship it. Measure: do recalls return useful hits? do operators/the brain act on them?
- **R2 (gated, only if R1 proves thin):** add a **local** embedding path behind `JANUS_MEMORY_VECTORS=1`. This is where venv/pip (deferred by P0b D4) finally lands — scoped to the memory daemon, optional, with the lexical path as the unconditional floor. Stdlib cosine over a small on-disk vector file keyed by `events.id` (no heavyweight vector DB needed at this scale).
- **R3 (only if R2's local model is too weak/slow):** consider an external embedding API for *index-time* embedding only (never query-time-to-model), still behind the flag, with the privacy trade-off surfaced to the director.

**The dependency is the decision** — that is why it is in the director list below, not assumed.

---

## Phased build path

| Phase | Deliverable | Touches | Floor |
|---|---|---|---|
| **R0 — Write ears as memory events** | redact + write the `running`/dispatch/outcome triple to `events` (reuse `redactSecrets`, `recordActivity`, `eventTypes`); add the `MemoryEvent` TS projection | TS only (`src/memory/`, ears emit path) | corpus grows; nothing reads it yet — zero risk |
| **R1 — Lexical recall over the seam** | `recall` op in `dispatch.py` (SQLite RO + bm25 + rerank reusing `synth.py` salience); `pythonClient.recall(...)`; `MemoryService.recallAsync`; `query_memory` registry action (pull) | seam + registry | daemon down ⇒ empty result (or TS `sqliteStore.search()` rung) |
| **R2 — Narrow push on outcomes** | rate-limited, dedup'd recall hint folded into the existing outcome `sendClientContent`; carved from the existing char budget (synth blends it) | ears outcome path + `synth.py` | push suppressed ⇒ identical to today |
| **R3 — (gated) embeddings** | local vector path behind `JANUS_MEMORY_VECTORS`; venv/pip lands here, scoped to the daemon; lexical stays the floor | daemon build wiring | flag off ⇒ R1 lexical, unchanged |

Each phase is independently shippable and independently revertible; R0 is pure additive corpus growth, R1 is the first user-visible value, R3 is the only phase that may add a dependency (and only if proven).

---

## Invariants (checkable by implementation + adversarial review)

- **RAG-I1 — Unconditional floor.** No memory write/recall failure throws into the voice turn, ears path, or World-Model; every miss resolves to a benign value + one log line. (Mirrors P0b I1.)
- **RAG-I2 — One seam.** Memory rides the existing stdio NDJSON daemon (`recall` op); no second transport, no second daemon, no new breaker.
- **RAG-I3 — Single writer.** All `events` writes stay in TS (`recordActivity`); Python opens SQLite **read-only**. No write crosses the seam.
- **RAG-I4 — Redaction boundary.** Every memory-event text field passes `redactSecrets` in TS before persistence; Python never redacts and never sees raw text, in any op. (Mirrors P0b I5.)
- **RAG-I5 — Budget respected.** A pushed recall hint is carved from `totalBudgetChars`, never additive; the per-switch brief still satisfies P0b I7.
- **RAG-I6 — No new runtime deps in v1 (R0/R1/R2).** Python 3.8 stdlib (`sqlite3`, `json`) only; TS adds only already-present `zod`. Any dependency arrives only at the gated R3.
- **RAG-I7 — No graduation/migration.** RAG reads the existing `events`/`notes`; it does not copy data between stores or duplicate beads.

---

## Open decisions for the director

1. **Embeddings: approve lexical-first (R1) and defer vectors (R3) until proven need?** (Recommended yes — honors no-new-deps + the bead's own "prove the need" framing. The alternative is committing to venv/pip now.)
2. **Retrieval contract: approve PULL-default + narrow auto-PUSH on outcome edges?** (vs pull-only, which is safer but weakens the learn-from-outcomes payoff.) Includes accepting the push rate-limit/dedup budget rules.
3. **Recall floor depth: empty-result floor only, or also the in-process TS `sqliteStore.search()` rung** so recall survives a dead daemon? (Recommended: ship empty-floor first, add TS rung if recall proves valuable.)
4. **Type-aware retention:** keep memory events on the uniform `eventsTtlDays`, or give outcomes a longer TTL than status churn? (Small additive follow-up; not a v1 blocker.)
5. **Seam routing for lexical v1:** route lexical recall through the Python daemon (one seam, clean vector graduation — recommended) **or** answer lexical recall in TS directly (simpler now, re-plumb later)? (This is the one place the "extend P0b" thesis costs a little now for a lot later.)
6. **R3 trigger criteria:** what evidence counts as "lexical recall is insufficient" and unlocks the embeddings spend? (Define the metric now so R3 is a decision, not a vibe.)

---

## Non-goals (unchanged from the parent specs)

- Reaching into pane agents' (Claude/Codex) internal memory — Janus observes/orchestrates, never owns their context.
- Replacing the SQLite ledger or beads — RAG is a read lens, not a new home.
- Any LLM call on the synth/recall hot path (deferred; P0b D2 stance preserved).
- Reconfiguring or disabling Gemini's `contextWindowCompression` — we feed it pre-trimmed text and stay under our own budget.
