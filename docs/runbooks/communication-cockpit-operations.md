# Voice Communication Cockpit — Migration & Operations Guide

- **Date:** 2026-07-10 (Phase 5, Step 5.5 — release documentation)
- **Covers:** the five-phase communication-cockpit program (exchange spine → context/sessions →
  instruction routing → return channel → fleet cockpit), commits `d859f36..f9dc83a` plus the 5.5
  release fixes.
- **Companion docs:** spine spec `docs/superpowers/specs/2026-07-09-agent-exchange-spine.md` ·
  routing spec `docs/superpowers/specs/2026-07-09-instruction-routing.md` · session-pool spec
  `docs/superpowers/specs/2026-07-07-z5c-session-pool-design.md` · security decisions
  `docs/review/2026-07-10-communication-security-review-5.4.md` · release validation + decisions
  of record `docs/review/2026-07-10-release-validation-5.5.md`.

---

## 1. SQLite migration (schema v12)

**What happens on first boot after upgrading:** `applyMigrations` bumps `user_version` 11 → 12 in
one transaction. Purely **additive**: three new tables (`agent_exchanges`, `exchange_events`,
`context_deliveries`) plus nullable `exchange_id` correlation columns on `pending_approvals`,
`action_log`, `attention`, `context_injections`, and `events`. No existing row is rewritten; every
pre-existing explicit-column INSERT/UPSERT is unaffected.

- The migration applies **regardless of any feature flag** (schema is version-forward, the
  established pattern). With every flag off, the new tables simply stay empty.
- **There is no down-migration.** Rollback = flip the flags off; the tables are inert data.
  Reverting the *binary* to a pre-v12 build against a v12 DB is the only unsupported direction
  (older builds refuse a newer `user_version`) — restore from backup for that.
- A corrupt DB at boot still takes the pre-existing quarantine path (`initStoreWithQuarantine`):
  the damaged file is set aside as `.janus.db.corrupt-<ts>` and a fresh store is initialized. A
  **store-init failure is a fatal boot error** — there is no legacy/in-memory fallback (the legacy
  ledger was retired 2026-07-02).
- The one-way JSON→SQLite boot migration for pre-SQLite installs is unchanged and still runs.
- **Retention** (30-day defaults, boot prune + 10-min incremental sweep, `src/store/retention.ts`):
  `exchange_events`, `context_deliveries`, and **terminal** `agent_exchanges` rows
  (`agent_complete`/`agent_failed`/`cancelled`, aged by `updated_at`). In-flight and `interrupted`
  rows are **never** pruned — `interrupted` is the operator's recovery backlog. Step 5.5 also
  closed the pre-existing gap: `context_injections` (v10 telemetry) now has the same 30d TTL.

## 2. The three knobs — states, defaults, escape hatches

> **FLAG COLLAPSE (2026-07).** This section previously documented FOUR knobs across three env
> flags (`JANUS_EXCHANGE_SPINE` · `JANUS_INSTRUCTION_ENVELOPE` · `JANUS_AGENT_RESULT_ENVELOPE`),
> a 27-combination lattice in which most combinations were inert no-ops. They are now **two** env
> flags. `JANUS_INSTRUCTION_ENVELOPE` and `JANUS_AGENT_RESULT_ENVELOPE` are **RETIRED**: if either
> is still set, the server logs a one-line warning at boot and otherwise ignores it — it does not
> crash, and it does not do anything. Remove them from your `.env`.

Both env flags are read **once at boot** (module-load cache); changing one requires a server
restart. The third knob is a settings field read at connection time.

| Flag | Values (default first) | What each state does |
|---|---|---|
| `JANUS_EXCHANGE_SPINE` | **`off`** · `record` · `authoritative` | `off`: no exchange rows written or read — zero behavior delta. `record`: the spine observes the dispatch/approval/observation seams and writes `agent_exchanges`/`exchange_events` rows; illegal transitions are logged, never thrown; **nothing reads exchange state to decide anything**. Also builds/stores instruction envelopes and scans pane output tails for a self-reported result envelope the agent printed on its own initiative (bounded: 8 KiB window / 25 candidates / strict zod / redaction+caps) — both observe-only. `authoritative`: the exchange row is the authoritative "what's in flight" — run-correlated dispatch join, boot-recovery quarantine surfacing, exchange-aware narration/SITREP/fleet; the rendered envelope IS the delivered instruction and resolver decisions govern routing (bind/confirm/clarify); the Workbench draft bridge is live. **Back-compat:** the pre-collapse spellings `shadow` and `primary` are still accepted and map to `record` / `authoritative` respectively. Any unrecognized value fails **closed** to `off`. |
| `JANUS_AGENT_COMPLETION_PROMPT` | **`off`** · `on` | The **only** knob in this subsystem that mutates outgoing agent-facing text — split out into its own clearly-named flag precisely so it cannot be enabled as a side effect of turning something else up. `off`: delivered instructions are byte-identical. `on`: render profiles append the one fixed completion-request line, carrying the live exchange's own id in prose, so an agent that reports back has an id to echo (settlement becomes correlated rather than inferred from the legacy prose heuristic). Requires the spine to be on — **inert, never an error, when `JANUS_EXCHANGE_SPINE=off`**. Validation and settlement paths are identical whether or not the hint was sent. |
| `voiceUx.sessionPoolHotSlots` | **`1`** (clamped 0–3) | Settings surface (`PUT /api/settings`), read at connect time — applies to the *next* voice session, not mid-session. `0` = handle-tier only. Governs the session-pool **decision layer** (`pool.plan` hot-slot budget). NOTE: physical hot-warm sockets are deferred (z5c slice 3 status, §6 of the release-validation doc) — today exactly one physical Gemini socket exists, so values >1 shape planning decisions only. |

**Escape hatches:** every flag rolls back independently by flipping it and restarting; the durable
tables are inert under `off`. `JANUS_CORTEX_PRIMARY=0` (pre-program) independently drops the
Python cortex back to the TS floor without touching the exchange spine.

**Rollout order** (each stage soaks before the next):

1. `JANUS_EXCHANGE_SPINE=record` — collect lifecycle fidelity and populate the metrics/replay
   tables. No existing code path reads exchange state to make a decision in this mode, so behavior
   is unchanged; what you gain is the audit trail (and the evidence needed to justify stage 2).
2. `JANUS_EXCHANGE_SPINE=authoritative` — exchange-aware notifications, recovery, fleet,
   replay/metrics, rendered-envelope delivery and resolver-governed routing. This is where the
   exchange ledger starts governing real behavior; do not skip stage 1's soak.
3. `JANUS_AGENT_COMPLETION_PROMPT=on` — additive settlement precision on top of the always-available
   conservative legacy heuristic. Changes what every agent receives on every dispatch, so soak it
   last and independently.
4. Tune `voiceUx.sessionPoolHotSlots` — independent of the other two.

## 3. Metrics & replay

**REST** (behind the `/api` token middleware; all read-only):

| Route | Returns |
|---|---|
| `GET /api/exchange-metrics` | The communication-quality report (`src/exchanges/metrics.ts`): delivered/settled counts, `wrongTargetDeliveries` (live tripwire — non-zero means a resolver bug), `duplicateDeliveries` (event-adjacency derivation), `clarificationCauses`, speech-to-draft & delivery latency percentiles, context cost, recovery-state counts. Underivable metrics are `null` with `notes[]`, never faked. |
| `GET /api/exchanges/:exchange_id/replay` | One exchange's ordered, redacted timeline: every event, bucketed views (target resolutions, draft revisions, questions, terminal transitions, result summaries), surviving approval rows, context-delivery joins. Instruction content appears **only as a hash**. TTL-pruned history is flagged `degraded: true` with a note — partial honest history, never an error. |
| `GET /api/exchanges/:exchange_id/inspect` | Current durable state + last N events (the recovery drill-down). |
| `GET /api/exchanges/:exchange_id/pane` | The (project, pane) an exchange belongs to (navigation). |
| `GET /api/fleet/exchange-summary` | Per-live-pane latest-exchange projection (redacted, 160-capped) for the fleet board. |

**CLI** (offline, against the DB file directly):

```bash
npx tsx scripts/exchange-metrics-report.ts --db .janus.db                  # all-time report to stdout
npx tsx scripts/exchange-metrics-report.ts --since-ms 3600000              # last hour
npx tsx scripts/exchange-metrics-report.ts --out reports/exchange.json     # also write to file
```

**Voice:** `replay_exchange` / `get_exchange_metrics` exist as registry actions; the exchange
board itself is spoken via `get_status_summary` (SITREP) and `catch_me_up`.

## 4. Troubleshooting

**Recovery actions** (attention items and fleet cards carry the `exchange_id`):

- **`interrupted` exchanges** (boot quarantine or superseded delivery): the operator is the only
  path out. `POST /api/exchanges/:id/retry` mints a **new follow-up draft** pre-filled from the
  original (never an automatic resend; idempotent under double-fire via `follow_up_of` linkage);
  `POST /api/exchanges/:id/cancel` dismisses. The original row never auto-resumes.
- **Same-exchange retry** applies only to a `draft` whose last event is a provable
  `delivery_failed`; anything else is refused with an explanatory message. Retry is **gated**
  (`write_to_pane`: Off→403, Ask→202 pending, Auto→200); cancel is ungated de-escalation.
- **Redacted-retry refusal (by design):** instructions persist redacted. If the stored copy
  visibly carries a `[REDACTED:*]` placeholder, an automatic redelivery is refused ("recompose and
  send fresh") — redelivering provably-corrupted text would look like a faithful retry. For
  instructions without secrets (the overwhelming majority) redaction is a byte-identical no-op and
  retry is unaffected.

**Quarantine semantics (boot):** panes boot inert, so every pre-boot in-flight exchange
(`staged`/`delivered`/`running`/`needs_input`/`terminal_idle`) is quarantined to `interrupted` at
boot — the outcome is unknowable without inventing history, and uncertain deliveries are never
re-sent. `draft`/`awaiting_clarification` rows are kept; an `awaiting_approval` row whose durable
approval vanished reverts to `draft` (a fresh approval must re-fire). Quarantined exchanges
surface once as attention items and in the reconnect resumption digest. A corrupt-DB boot
quarantines the whole file (§1).

**Mute semantics (per the 5.4 decision of record):** `mutedProjectIds` silences the
**AnnouncementBus surface only** (earcons + toast stack) for that project's own panes. It cannot
cross projects, and it does NOT silence: the durable attention queue, pull-based SITREP/catch-up,
live exchange narration (`pushSignal`), or STOP-ALL/brake narration. "Mute" means "stop this
project's earcons/toasts", not "make it silent" — the safety-preserving direction.

**Background projects:** a backgrounded project's *exceptions* (needs_input / failure /
interruption) still narrate into the foreground session, named explicitly ("In project 'X', …"),
never stealing focus. Its *completions* are deliberately silent live (fixed for real in 5.5 — no
more plain-text leak) and surface on that project's own catch-up/SITREP, plus the attention queue.

**Common symptoms:**

| Symptom | Likely cause / check |
|---|---|
| No exchange rows appearing | `JANUS_EXCHANGE_SPINE` unset (default `off`). Flags are boot-time — restart after export. |
| Workbench send returns 400 "over this pane's size limit" | Envelope `primary` refuses over-limit sends rather than silently truncating — shorten the draft. |
| Retry button missing on a failed fleet card | Terminal `agent_failed` is never retryable (5.5 fix — the card no longer offers guaranteed-refused actions). Retry appears for `interrupted` rows. Draft-after-delivery-failure retry is REST-only. |
| A completion narrates once then never again | Intended: exactly-once narration gate + (5.5) windowed SITREP tier-3 (30 min) and mint-once attention for completions. The durable record remains in replay/metrics. |
| `speechToDraftLatency` ≈ 0 in metrics | Known consequence of resolution being synchronous with exchange minting — meaningful for fixture data only until minting moves earlier (documented in `src/exchanges/service.ts`). |
| Replay shows `degraded: true` | Events older than the 30d TTL were pruned — honest partial history. |

## 5. Known limitations (release-honest list)

1. **z5c slice-3 physical hot-warm sockets: deferred.** The session-pool *decision* layer
   (states, LRU, `pool.plan`, hot-slot budget, handle-tier resume + catch-up) is shipped; the
   physical multi-socket execution layer is not — one live Gemini socket exists at a time, and a
   backgrounded project's inject-class events are dropped-not-queued (D6) with `lastEventAtMs`
   bookkeeping for later catch-up. `sessionPoolHotSlots` > 1 shapes plans, not sockets.
2. **Result-envelope correlation is defensive, not yet operative end-to-end.** The delivered
   instruction never carries its own `exchange_id`, so a live agent cannot echo a matching
   envelope; envelope settlement fires only for planted/fixture reports today. Live settlement
   rides the conservative legacy heuristic + ambient signals. Safe by construction (forged or
   stale ids are ignored); making it operative requires minting the exchange before render —
   deliberately deferred (see the 5.5 decisions of record).
3. **terminal_idle-parked exchanges vs. manual commands (4.5-B7): accepted exposure.** A pane
   whose exchange is parked at `terminal_idle` keeps its correlation marker (spec-locked); a
   manual command typed into that pane can, in the narrow worst case, produce output whose final
   line satisfies the (heavily vetoed) legacy done-line heuristic and settle the parked exchange
   with the manual command's summary. Mitigations: the 4.5 eligibility gates (real output, at-rest
   exchange, echo veto, failure-vocabulary veto) and the manual-command log (5.5). Documented, not
   changed — clearing the marker on manual writes would break the pinned "manual writes never
   advance the lifecycle" contract.
4. **Pre-exchange clarifications are not exchange events.** The target resolver's "which pane did
   you mean" fires before any exchange exists (`exchange_events.exchange_id` NOT NULL), so
   `clarificationCauses` counts only post-exchange (dispatch-seam) clarifies. Decision of record
   in `docs/review/2026-07-10-release-validation-5.5.md`.
5. **Envelope draft and exchange keep separate version counters.** Consistency is guaranteed by
   the shared approval record, not by counter equality — each layer CAS-checks its own counter
   against the same approval, so a stale approval can never deliver on either side. Unifying them
   requires mint-at-compose (same root as #2). Details in the 5.5 decisions of record.
6. **Redacted-retry refusal** (§4 above) — a deliberate fidelity/security trade, not a bug.
7. **Raw scrollback at rest** (pre-existing, out of program scope): `.janus_scrollback_*.log`
   holds raw PTY bytes for xterm backfill (never model-bound); flagged for a future
   disk-at-rest pass.
