# Phase 5, Step 5.4 — Communication-Pipeline Security Review (decisions of record)

Reviewer: security review with fix authority, 2026-07-10. Scope: the full Voice Communication
Cockpit pipeline (exchange spine, envelopes, resolver, context versions/deliveries, session pool,
result envelope, notifications/narration, recovery actions, fleet projection, replay/metrics/CLI,
benchmark) composed with the pre-existing perimeter (`src/security/perimeter.ts`,
`src/terminal.ts` redaction, `src/gating/`). Regression battery:
`tests/test_communication_security.ts`.

## Decisions of record

### 1. B12 retry fidelity (4.5 finding) — REFUSE, don't hold raw

The durable row's `distilled_instruction` is redacted at rest ("deliver raw, persist redacted"),
so a same-exchange retry redelivers the *stored* copy. When that copy visibly carries a
`[REDACTED:*]` placeholder it is provably not the text the operator sent; silently redelivering
it would hand the agent corrupted instructions while looking like a faithful retry.

**Decision (implemented, `src/exchanges/recoveryActions.ts`):** refuse the automatic
same-exchange redelivery with an explicit "recompose and send fresh" reason. Holding the raw text
for retry was rejected: memory-only raw would silently diverge across restarts (retry targets
routinely predate the process), and any durable raw copy regresses secrets-at-rest. For the
overwhelming majority of instructions (no secret ⇒ redaction is a byte-identical no-op) retry is
unaffected. The interrupted→follow-up-draft leg keeps its pre-fill (the operator reviews a draft
before sending) but the outcome message now flags the scrub explicitly.

### 2. Mute semantics — documented as intended, no behavior change

`mutedProjectIds` mutes the **AnnouncementBus surface only** (earcon + notification stack), keyed
strictly on the *announcing pane's own project* (`server.ts` `isPaneMuted`):

- Muting project A **cannot** suppress project B's announcements, safety-critical or otherwise
  (pinned by `tests/test_announcement_bus.ts`, "unmuted pane on the SAME bus still announces").
- Within the muted project, **all kinds** — including `approval_pending`/`error`/`exited` — are
  suppressed on that one surface (pinned intended, mute precedes the severity branch). Safety
  visibility is preserved through three unmuted channels: the durable attention queue, the
  pull-based SITREP/catch-up, and the live-voice exchange narration (`pushSignal`), which
  deliberately does **not** consult `mutedProjectIds`.
- STOP-ALL/brake narration rides `pushApprovalNarration`, not the bus — never mutable.

Divergence to keep in mind (accepted): "mute" means "stop the earcons/toasts for this project",
not "make this project silent" — a muted project's needs_input/failure can still narrate into the
foreground voice session. That is the safety-preserving direction of the divergence.

### 3. Retention (axis 3) — v12 TTL completion

`agent_exchanges` head rows and `context_deliveries` had no retention. Added
(`src/store/retention.ts`, boot + incremental sweep, default 30d = `ACTION_LOG_TTL_DAYS`):

- `agent_exchanges`: **terminal rows only** (`agent_complete`/`agent_failed`/`cancelled`, aged by
  `updated_at`). In-flight rows and `interrupted` rows are never pruned — interrupted is the
  operator's recovery backlog (spec §4: only the operator disposes of it).
- `context_deliveries`: full-table TTL (hashes + tier-key lists only, no free text).
- Pre-existing gap, out of this program's scope, reported not fixed: `context_injections`
  (schema v10) still has no TTL anywhere. `kv` voice-resumption handles have a read-side
  freshness guard only (bounded by project count; low severity).

### 4. Event wiring (5.3 gap)

- `target_resolved` now lands at exchange creation (`ExchangeService.persistCreate`), payload
  `{paneId, projectId}` per the convention `src/exchanges/metrics.ts` defined. This makes
  `wrongTargetDeliveries` a live tripwire. Side effect (accepted, documented in code):
  `speechToDraftLatency` reads ~0 for live traffic because resolution is synchronous with
  creation by construction — the metric remains meaningful only for fixture/planted data until
  exchange minting moves earlier in the draft flow.
- `clarification_requested` is wired at the **dispatch clarify seam**
  (`src/voice/index.ts` `settleExchangeForDispatch`, cause `dispatch_clarify`, via the new
  append-only `ExchangeService.recordClarificationRequested`). The **target-resolver clarify
  seam** ("which pane did you mean") fires before any exchange exists (`exchange_events.
  exchange_id` is NOT NULL), so it cannot carry this event — deferred to 5.5.

### 5. Model-boundary hardening (found during axis-1 trace)

Two model-bound strings bypassed redaction; both fixed:

- `src/actions/gemini.ts` `voiceResponse` error arm (`Internal error: ${message}` →
  `sendToolResponse`) now scrubs the message.
- `src/voice/index.ts` tool-call catch path (handler-throw message → `sendToolResponse`) now
  scrubs the message.

## Confirmations (no change needed)

- **Untrusted result envelope**: strict zod schema, bounded tail-window scan (8 KiB / 25
  candidates / 8 KiB-per-candidate), redaction+caps at parse; settlement gated on the pane's own
  active-delivery marker; no envelope field ever reaches `dispatchProposal`/`setActivePane`/
  `gateOrDefer`/`writeInput`; repeats/echoes/forgeries absorbed as CAS no-ops. `needs_operator`
  text surfaces as quoted, capped (160), re-redacted **data**.
- **REST actions**: all ride `runAction` (one validation/redaction choke-point) behind the `/api`
  token middleware; `retry_exchange` is genuinely `write_to_pane`-gated through `ctx.gateOrDefer`
  (Off→403, Ask→202, Auto→200, pinned); reads are GET-only with no state mutation; the inline
  `GET /api/fleet/exchange-summary` sits behind the same `/api` auth and returns only
  redacted+160-capped summaries. `cancel_exchange` is an ungated POST by design (de-escalation).
  Cookie is `httpOnly` + `SameSite=strict`; Origin fence and loopback/token cookie-seeding
  unchanged.
- **Cross-project isolation**: fleet projection exposes only redacted/truncated summaries (all
  projects by design); replay is exchange-id-scoped; metrics are aggregates; background narration
  names project/pane + one terse redacted line; mute cannot cross projects (above).
- **Graph memory**: no graphiti/zep/graph-memory hook exists anywhere in `src/`, `server.ts`, or
  `python/` — ingestion remains OFF/absent.
- **Raw-at-rest (pre-existing, reported)**: `.janus_scrollback_*.log` persists raw PTY bytes for
  xterm backfill (never model-bound). Out of this review's mandate to change; flagged for a
  future disk-at-rest pass.
