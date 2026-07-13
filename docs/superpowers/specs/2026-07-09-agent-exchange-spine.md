# AgentExchange Spine — the communication-only exchange lifecycle (Phase 1, Step 1.1)

- **Date:** 2026-07-09
- **Status:** Design contract (architect step 1.1). RED-first suites land with this doc:
  `tests/test_exchange_lifecycle.ts`, `tests/test_exchange_correlation.ts` — both import
  `src/exchanges/lifecycle` / `src/exchanges/service`, which do **not exist yet**; step 1.3
  implements them against these tests.
- **Related:** z5c session pool `docs/superpowers/specs/2026-07-07-z5c-session-pool-design.md`
  (voice_session_id semantics, D5) · z5c slice 1 delivery classes
  `docs/superpowers/plans/2026-07-07-z5c-slice1-delivery-classes.md` (spoken vs inject lanes) ·
  handoffs prior art `src/store/types.ts:58-83` (schema v2) · Python/TS seam ADR
  `docs/design/2026-06-19-python-ts-seam.md`.

## BLUF

One durable record — the **AgentExchange** — tracks a single operator communication from
utterance to reported outcome: *draft → target resolution → approval → delivery → terminal
observation → needs-input/result → interruption/cancellation*. It is a **communication
lifecycle, not a work engine**: Orbital listens, understands, drafts, routes, correlates, and
reports; the terminal coding agents do the engineering. The spine is additive (schema v12, new
tables + nullable columns), flag-gated (`JANUS_EXCHANGE_SPINE: off|shadow|primary`), and reuses
the codebase's proven exactly-once idioms (atomic `claimed` CAS, two-phase durable intent,
quarantine-not-guess recovery).

---

## 1. The lifecycle

### 1.1 States (12)

`draft` · `awaiting_clarification` · `awaiting_approval` · `staged` · `delivered` · `running` ·
`needs_input` · `terminal_idle` · `agent_complete` · `agent_failed` · `interrupted` · `cancelled`

- **Terminal (no outgoing edges):** `agent_complete`, `agent_failed`, `cancelled`.
- **Semi-terminal:** `interrupted` — settled-but-uncertain; its only outgoing edge is
  `→ cancelled` (operator dismisses). An interrupted exchange is **never auto-resumed**; a
  follow-up is a NEW exchange.
- **Cancellable (9):** every non-terminal state: `draft`, `awaiting_clarification`,
  `awaiting_approval`, `staged`, `delivered`, `running`, `needs_input`, `terminal_idle`,
  `interrupted`.

### 1.2 Diagram

```mermaid
stateDiagram-v2
    [*] --> draft: exchange_created
    draft --> awaiting_clarification: clarification_requested
    awaiting_clarification --> draft: draft_revised (version++)
    draft --> awaiting_approval: approval_requested\n(binds approval_id @ draft_version)
    awaiting_approval --> draft: draft_revised (version++,\napproval invalidated)
    awaiting_approval --> staged: approval_confirmed\n(CAS on exact draft_version)
    draft --> staged: auto-execute gate\n(Full Auto / spotlight)
    staged --> delivered: delivery_succeeded\n(pane write accepted by live PTY)
    staged --> draft: delivery_failed\n(nothing landed; re-arm)
    delivered --> running: terminal_running
    delivered --> terminal_idle: terminal_idle (fast command)
    delivered --> needs_input: needs_input_detected
    delivered --> agent_failed: agent_failure_reported
    running --> needs_input: needs_input_detected
    needs_input --> running: input supplied (gated write)
    running --> terminal_idle: terminal_idle
    needs_input --> terminal_idle: terminal_idle
    running --> agent_failed: agent_failure_reported
    needs_input --> agent_failed: agent_failure_reported
    terminal_idle --> agent_complete: agent_completion_reported
    terminal_idle --> agent_failed: agent_failure_reported
    terminal_idle --> running: pane resumed (idle premature)
    interrupted --> cancelled: operator dismisses
    agent_complete --> [*]
    agent_failed --> [*]
    cancelled --> [*]
```

(Plus: every cancellable state `→ cancelled` (exchange_cancelled), and every in-flight state —
`staged`, `delivered`, `running`, `needs_input`, `terminal_idle` — `→ interrupted`
(exchange_recovered quarantine / superseded delivery). Omitted above to keep the diagram legible.)

### 1.3 Legal transition table (normative)

| From \ To | draft | awaiting_clarification | awaiting_approval | staged | delivered | running | needs_input | terminal_idle | agent_complete | agent_failed | interrupted | cancelled |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **draft** | – | ✔ | ✔ | ✔ᵃ | | | | | | | | ✔ |
| **awaiting_clarification** | ✔ | – | | | | | | | | | | ✔ |
| **awaiting_approval** | ✔ᵇ | | – | ✔ᶜ | | | | | | | | ✔ᵈ |
| **staged** | ✔ᵉ | | | – | ✔ᶠ | | | | | | ✔ | ✔ |
| **delivered** | | | | | – | ✔ | ✔ | ✔ᵍ | | ✔ | ✔ | ✔ |
| **running** | | | | | | – | ✔ | ✔ | | ✔ | ✔ | ✔ |
| **needs_input** | | | | | | ✔ | – | ✔ | | ✔ | ✔ | ✔ |
| **terminal_idle** | | | | | | ✔ʰ | | – | ✔ | ✔ | ✔ | ✔ |
| **agent_complete** | | | | | | | | | – | | | |
| **agent_failed** | | | | | | | | | | – | | |
| **interrupted** | | | | | | | | | | | – | ✔ |
| **cancelled** | | | | | | | | | | | | – |

Notes: ᵃ Full-Auto/spotlight gate resolved `auto_execute` — no approval leg (the gate decision
comes from the existing choke-point, `decideProposal`, `src/pendingApprovals.ts:327`).
ᵇ `draft_revised` while an approval is unresolved — the approval binding is invalidated (§3).
ᶜ `approval_confirmed`, CAS on the exact bound `draft_version` (§2/§3). ᵈ approval rejected or
TTL-expired (payload carries `reason: rejected|expired`) — an exchange whose approval dies is
cancelled, mirroring today's terminal reject/expire in `resolveDecision`
(`src/pendingApprovals.ts:391`). ᵉ `delivery_failed` with **certainty that nothing landed**
(pane missing / `status === "Exited"` — the two pre-write guards in `applyAutoExecute`,
`src/dispatch/paneWrite.ts:198-215`); the approval binding is cleared, a re-send needs a fresh
approval. A delivery whose outcome is *uncertain* is NEVER retried — it quarantines to
`interrupted` (§4). ᶠ `delivery_succeeded` = the write was accepted by a **live, non-Exited
PTY**. There is no stronger receipt available: `src/ptyTransport.ts` writes to a dead process
silently discard (documented at `src/dispatch/paneWrite.ts:207-215`), so "delivered" means
*write accepted*, and the `running` edge is the behavioral confirmation. ᵍ fast commands: the
status machine can reach Idle without the correlator ever seeing a distinct Running edge
(exactly the z5c 1d6w fast-command case — `docs/superpowers/specs/2026-07-07-z5c-session-pool-design.md`
D1). ʰ idle was premature; the pane resumed output before a completion report was composed.

Illegal-by-construction (called out because they are the tempting bugs):
- `delivered|running|needs_input|terminal_idle → staged|awaiting_approval|draft` — a landed
  write can never be "un-delivered"; a follow-up instruction is a NEW exchange.
- `interrupted → running|delivered` — no auto-resume, ever.
- Any edge out of `agent_complete` / `agent_failed` / `cancelled`.
- `draft → delivered` — delivery only ever passes through `staged` (the committed-for-delivery
  gate outcome), so every delivery has a durable pre-write intent row (§2).

### 1.4 Event types → transitions

Every state change appends exactly one `exchange_events` row (append-only; the exchange row is
the mutable head, events are the audit spine — the same split the codebase already uses for
`handoffs` + `events.handoff_id`, schema v2, `src/store/schema.ts:154-183`).

| event_type | transition it records | source |
|---|---|---|
| `exchange_created` | `[*] → draft` | voice / rest |
| `target_resolved` | (no state change; stamps `pane_id`, may accompany draft) | voice / cortex |
| `clarification_requested` | `draft → awaiting_clarification` | system |
| `draft_revised` | `awaiting_clarification|awaiting_approval → draft`, or in-place `draft` version bump | voice / rest |
| `approval_requested` | `draft → awaiting_approval` | system |
| `approval_confirmed` | `awaiting_approval → staged` | voice / rest / ws |
| `delivery_attempted` | (no state change; durable pre-write intent, `delivery_attempt`++) | system |
| `delivery_succeeded` | `staged → delivered` | system |
| `delivery_failed` | `staged → draft` (certain-failure only) | system |
| `terminal_running` | `delivered|needs_input → running` | terminal |
| `terminal_quiescing` | (no state change; advisory breadcrumb — mirrors the humble `quiescing` signal, `src/observe/index.ts:380`) | terminal |
| `terminal_idle` | `delivered|running|needs_input → terminal_idle` | terminal |
| `needs_input_detected` | `delivered|running → needs_input` | terminal |
| `agent_completion_reported` | `terminal_idle → agent_complete` | system (report composed from the agent's own output — see §6) |
| `agent_failure_reported` | `delivered|running|needs_input|terminal_idle → agent_failed` | terminal |
| `exchange_cancelled` | any cancellable state `→ cancelled` | voice / rest / system (TTL) |
| `exchange_recovered` | in-flight `→ interrupted` (boot quarantine / supersession), or a kept state re-hydrated (payload `disposition: kept|interrupted`) | system |
| `context_version_delivered` | (no exchange state change; stamps `context_version`, joins `context_deliveries`) | cortex |

---

## 2. Idempotency & exactly-once

The spine copies the two proven idioms already in this store, verbatim in spirit:

**(a) Atomic single-winner CAS (the `claimed` idiom).** Approval exactly-once is *already*
enforced by `claimApproval` — `UPDATE pending_approvals SET claimed=1 WHERE id=? AND claimed=0`
(`src/store/sqliteStore.ts:305`), with sticky-claimed upsert protection
(`src/store/sqliteStore.ts:293-303`) and the mandatory in-process gate inside `resolveDecision`
(`src/pendingApprovals.ts:391-426`). The spine does **not** re-implement that; it adds a second,
exchange-level CAS on top:

```sql
UPDATE agent_exchanges
   SET state='staged', updated_at=@now
 WHERE exchange_id=@id
   AND state='awaiting_approval'
   AND approval_id=@approvalId
   AND approval_draft_version=@draftVersion   -- §3 binding
```

`changes === 1` ⇒ this caller applied the approval to the exchange; `changes === 0` ⇒ stale
(already applied, superseded draft, or a lost race) — recorded as a no-op event, never a second
delivery. Every state transition in the machine is such a guarded `UPDATE … WHERE state=<from>`;
repeated application of any event is a structural no-op.

**(b) Two-phase durable intent for delivery (the pending_actions idiom, schema v5).** The pane
write (`term.writeInput`, fired at `src/dispatch/paneWrite.ts:217` on the auto arm and
`src/gating/index.ts:1041` on the approved arm) is **not transactional with SQLite**, so
delivery is recorded in two phases:

1. `delivery_attempted` event appended + `delivery_attempt` incremented **before** the write
   (durable intent; idempotency key = `(exchange_id, draft_version, delivery_attempt)`);
2. the write fires against a live PTY;
3. CAS `staged → delivered` + `delivery_succeeded` event + `delivered_at` stamp.

A crash between (1) and (3) leaves `delivery_attempted` without `delivery_succeeded` — that is
the **uncertain delivery** signature, and recovery quarantines it to `interrupted` (§4). It is
never re-sent: double-typing an instruction into a live Claude/Codex pane is destructive, and
`writeInput` gives no receipt.

**(c) Upstream replay guards stay authoritative.** A Gemini functionCall re-delivered on a
resumed session is already suppressed by `hasSucceededIdempotencyKey`
(`src/store/sqliteStore.ts:399`, checked in `isReplayShortCircuit`,
`src/voice/index.ts:1581-1589`), and duplicate voice proposals by the 5s proposal-dedup window
(`src/voice/index.ts:1560-1573`). The exchange service sits **behind** those guards; its own
CAS idempotency is defense-in-depth, not a replacement.

**ID minting.** `exchange_id = exch_<epoch36>_<seq36>`, the established mint idiom
(`dispatch_…` in `src/dispatch/joinTracker.ts:48`, `ixn_…` in `src/interactionLog.ts:69-71`,
`inj-…` in `src/voice/index.ts:86-88`, `ctxevt-…` in `src/memory/contextTelemetry.ts:83`).
`delivery_id` for `context_deliveries` mirrors `ctxevt` minting.

---

## 3. Draft-version binding

Today **no draft-version concept exists anywhere**: a pending approval stores the raw
instruction verbatim and replays it on approve (`command` column comment, "RAW — the approved
write replays verbatim", `src/pendingApprovals.ts:650`); the pane Workbench "draft" (schema v3
`panes.draft`) is a different subsystem with no approval linkage. The binding below is new
behavior:

- `draft_version` starts at **1** on `exchange_created`; every `draft_revised` increments it.
- `approval_requested` stamps the exchange with `approval_id` **and** `approval_draft_version =
  draft_version` (one column beyond the canonical model — see §9 deviations — so the binding is
  CAS-able in SQL, not JSON-parsed).
- **Editing invalidates:** `draft_revised` while `awaiting_approval` transitions the exchange
  back to `draft`, bumps `draft_version`, clears `approval_id`/`approval_draft_version`, and
  resolves the outstanding pending-approval row via the existing single choke-point
  `applyResolution(messageId, "reject")` (`src/gating/index.ts:1066`) with a
  `superseded_by_revision` payload on the exchange event. The old approval can never fire: even
  if a racing confirm wins the *approval* claim, the exchange-level CAS in §2(a) fails on
  `approval_draft_version` mismatch and no delivery occurs.
- **Approval binds the exact version:** `approval_confirmed` carries
  `(approval_id, draft_version)`; a mismatch on either is a recorded stale no-op.
- The pending-approval row's `command` continues to be the raw instruction **at the bound
  version** — what the operator heard read back is byte-for-byte what can land.

---

## 4. Restart behavior: durable state, recovery, quarantine

Ground truth constraints (all verified in code):

- Panes boot **INERT** (CLAUDE.md; no auto-spawn) — after a restart every previously-running
  PTY is gone and no observation continuity exists.
- Approval survivors are already durable and re-hydrated unclaimed on boot
  (`hydrateFromStore`, `src/pendingApprovals.ts:598-611`), detach/reattach across disconnects
  (`detachSession` :789, `reattachSession` :845).
- Store boot already has a quarantine idiom for a corrupt DB
  (`initStoreWithQuarantine`, `src/store/migrate.ts:193-232`).
- Live session ids are **ephemeral**: sids are minted per live handle
  (`sess_${seq}_${Date.now()}`, `src/pendingApprovals.ts:617-629`) and rewritten on re-attach;
  z5c makes them per-project pool entries (design D5). So `voice_session_id` is nullable,
  re-bindable, and **never a recovery correlation key**.

**Boot recovery (`recoverOnBoot`), by state — the pure rule `recoveryDisposition(state)`:**

| State at boot | Disposition | Why |
|---|---|---|
| `draft`, `awaiting_clarification` | **keep** | Pure durable text; no live handle required. |
| `awaiting_approval` | **keep** | The approval row re-hydrates via the existing path; if the durable `pending_approvals` row is *gone* (claimed+deleted mid-crash, or TTL-swept), the service reverts the exchange to `draft` with an `exchange_recovered` event — a fresh `approval_requested` must re-fire. It never assumes the missing approval was confirmed. |
| `staged` | **interrupt (quarantine)** | Ambiguous: `delivery_attempted` may or may not have flushed before `writeInput` fired. **Never auto-resend.** |
| `delivered`, `running`, `needs_input` | **interrupt (quarantine)** | The observed PTY no longer exists (inert boot); outcome unknowable without inventing history. |
| `terminal_idle` | **interrupt (quarantine)** | The terminal outcome was seen but no completion report was composed; composing one post-hoc from stale scrollback would be invented correlation. `terminal_state` is preserved on the row for the operator. |
| `agent_complete`, `agent_failed`, `cancelled`, `interrupted` | **keep** | Already settled. |

**Hard rules:**
- **Never invent historical correlation.** Recovery must not scan `events`, history JSON, or
  scrollback to guess what happened to an in-flight exchange. Post-boot pane signals never
  settle a pre-boot exchange (the correlator's active-exchange binding, §5, is cleared on boot;
  the correlation test suite pins this).
- **Never auto-resend uncertain deliveries.** The only path out of `interrupted` is the
  operator: dismiss (`→ cancelled`) or dictate a follow-up (a NEW exchange, optionally
  pre-filled from the interrupted one's `distilled_instruction` — a *draft* convenience, never
  an automatic send).
- Quarantined exchanges surface once as an attention item (the existing in-memory queue +
  `attention_updated` broadcast pattern, `src/observe/index.ts:572-598`) carrying the
  `exchange_id`, and in the reconnect resumption digest alongside approval survivors
  (`renderResumptionLine` precedent, `src/pendingApprovals.ts:529`).

---

## 5. Correlation map — existing IDs → exchange fields, with the code seams

One exchange = **one instruction to one pane**. Correlation is *explicit at write time*, never
inferred after the fact.

| Existing ID / subsystem | Exchange field | Seam (verified file:line) |
|---|---|---|
| `interaction_id` (`ixn_…`, one per operator turn) | `agent_exchanges.interaction_id`, `exchange_events.interaction_id` | Minted at `InteractionLogger.mint` (`src/interactionLog.ts:69`); stamped per dispatch as `state.currentInteractionId` → `interactionIdForCall` (`src/voice/index.ts:1151`) and onto `action_log.interaction_id` in the audit seam (`src/voice/index.ts:1216-1233`; column: schema v7, `src/store/schema.ts:259-263`). The exchange service captures the same value at `exchange_created`. |
| Pending-approval id (`PendingApproval.messageId` == pendingId; synthetic for plan/dispatch fan-out) | `agent_exchanges.approval_id` (+ `approval_draft_version`); reverse: new nullable `pending_approvals.exchange_id` | Record built + staged in `applyPendingApproval` (`src/dispatch/paneWrite.ts:249-255`, `pendingApprovals.add` → durable insert `src/store/sqliteStore.ts:293`); resolved exclusively through `applyResolution` (`src/gating/index.ts:1066-1105`), whose `renderApproved` is the single approved-write path (`addCommand` :1040, `writeInput` :1041). In `primary` mode the exchange transitions (`approval_confirmed`→`staged`, delivery phases) hook exactly there and in `applyAutoExecute` (`src/dispatch/paneWrite.ts:198-220`). |
| Dispatch group / member (`dispatch_…` id, in-memory ring) | `instruction_envelope_json.dispatch_group_id` + one exchange **per member**; step 1.4 replaces the in-memory join with exchange correlation | Group minted at `DispatchJoinTracker.create` (`src/dispatch/joinTracker.ts:46-58`, module singleton :144, `MAX_GROUPS=50` ring :40 — **in-memory only** today); fan-out staging in `stageDispatchGroup` (`src/actions/defs/dispatch_group.ts:155-186`), synthetic per-member pendingId `` `${base}__${group.id}__${t.key}` `` (:172, `forceStage: true` :178); settle feeds: `noteRunning` from observe `onRunning` (`src/observe/index.ts:361`), `noteTransition` from `settleDispatchJoin` (`src/observe/index.ts:203-227`, called from `onIdle` :315 and `detectAndTriggerTransitions` :634). |
| Pane signals (`PaneSignalKind`: running/quiescing/idle/prompt/error/exited…) | drive `terminal_running` / `terminal_quiescing` / `terminal_idle` / `needs_input_detected` / `agent_failure_reported` events + `terminal_state` | The correlator taps the SAME observe call sites that feed the join tracker today — `onIdle` (`src/observe/index.ts:309-335`), `onRunning` (:344-370), `onQuiescing` (:380-390), `emitHighSeverityTransition`/exited (:572-598), `onExit` (:727-733) — NOT a `PaneSignalBus` subscription: the bus lanes (`spoken`/`inject`, `src/paneSignalBus.ts:10,61,98`) debounce/dedupe for their consumers (z5c D1), and a debounced-away edge must still settle an exchange. Exchange settlement is a third concern with its own (trivial) dedup: the state CAS. |
| Command-history entry | optional `exchange_id` field on the JSON `HistoryEntry` (file-backed — see §9 discovery 2) | `HistoryManager.addCommand` (`server.ts:469`), invoked from the two write paths only: `applyAutoExecute` via `deps.addCommand` (`src/dispatch/paneWrite.ts:216`) and `renderApproved` (`src/gating/index.ts:1040`), plus the raw WS input path (`server.ts:1043`). Only exchange-driven writes stamp the field; the raw path never does. Legacy/manual entries stay `exchange_id`-less forever — **never adopted**. |
| Context injection telemetry (`inject_id`, `ctxevt` rows) | `context_deliveries` (new table) + `agent_exchanges.context_version`; reverse: new nullable `context_injections.exchange_id` | `mintInjectId` (`src/voice/index.ts:86-88`); rows written by `recordContextInjection` (`src/store/sqliteStore.ts:1388`), shape `ContextInjectionEvent` (`src/memory/contextTelemetry.ts:55-74`); hashes reuse `hashText`/`hashSnapshot` (`src/memory/contextTelemetry.ts:90-99`) so `snapshot_hash`/`brief_hash` join the existing v10 columns byte-compatibly. `context_version` = a monotonic per-session counter stamped on each `context_version_delivered`; an exchange created after delivery N carries `context_version = N` ("what did the brain know when it drafted this"). |
| `voice_session_id` | `agent_exchanges.voice_session_id` (nullable, re-bindable) | Durable sid mint `sidFor` (`src/pendingApprovals.ts:617-629`); z5c pool entry identity (`ctx.sessionId`, design D5). Ephemeral by construction — informational, never a recovery key (§4). |
| Events audit spine | new nullable `events.exchange_id` (mirrors the `handoff_id` precedent) | `appendEventInTxn` (`src/store/sqliteStore.ts:130-144`); precedent ALTER at schema v2 (`src/store/schema.ts:180-181`). |
| Attention rows | new nullable `attention.exchange_id` column + optional `exchangeId` in the in-memory `AttentionItem.details` | Live queue is in-memory `manager.attentionQueue` (`src/terminal.ts:1304`; pushes at `src/observe/index.ts:212,403,453,500,577`); the durable `attention` table + `upsertAttention` (`src/store/sqliteStore.ts:422`) exists but has no live-path caller today — the column is future-proofing, the `details` field is the working correlation channel. |
| Handoffs (prior art, NOT extended) | none — see §7 | `StoredHandoff`/`HandoffState` (`src/store/types.ts:58-83`), flip-on-resolve leg `flipHandoffOnResolve` (`src/gating/index.ts:1004-1010`). |

---

## 6. SQLite migration plan — schema v12 (additive)

Follows the repo's exact migration idiom: one new entry appended to the `MIGRATIONS` array in
`src/store/schema.ts` (index+1 == target `user_version`; `SCHEMA_VERSION` bumps 11 → 12;
`applyMigrations` runs it once in a txn — `src/store/schema.ts:4,7,366-376`). Purely additive:
new tables + nullable `ALTER TABLE … ADD COLUMN`s, so every existing explicit-column
INSERT/UPSERT is unaffected (the v3/v4/v7 precedent).

```sql
-- v12 (exchange spine, spec 2026-07-09): the communication-only AgentExchange lifecycle.
CREATE TABLE agent_exchanges (
  exchange_id            TEXT PRIMARY KEY NOT NULL,
  project_id             TEXT NOT NULL,
  pane_id                TEXT NOT NULL,
  voice_session_id       TEXT,               -- ephemeral, re-bindable; never a recovery key
  interaction_id         TEXT,
  operator_utterance     TEXT NOT NULL DEFAULT '',   -- redacted at the boundary
  distilled_instruction  TEXT NOT NULL DEFAULT '',   -- RAW (replays verbatim, the pending_approvals.command rule)
  instruction_envelope_json TEXT NOT NULL DEFAULT '{}', -- redacted JSON (dispatch_group_id, template refs, …)
  draft_version          INTEGER NOT NULL DEFAULT 1,
  context_version        TEXT,
  state                  TEXT NOT NULL DEFAULT 'draft',
  approval_id            TEXT,
  approval_draft_version INTEGER,            -- §3 binding (deviation §9: +1 column vs canonical model)
  delivery_attempt       INTEGER NOT NULL DEFAULT 0,
  terminal_state         TEXT,
  result_summary         TEXT,               -- redacted; the agent's REPORT, not a verification
  result_envelope_json   TEXT,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  delivered_at           INTEGER,
  completed_at           INTEGER
);
CREATE INDEX idx_agent_exchanges_state         ON agent_exchanges(state);
CREATE INDEX idx_agent_exchanges_pane_state    ON agent_exchanges(pane_id, state);
CREATE INDEX idx_agent_exchanges_project_created ON agent_exchanges(project_id, created_at);
CREATE INDEX idx_agent_exchanges_approval      ON agent_exchanges(approval_id);

CREATE TABLE exchange_events (
  event_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  exchange_id   TEXT NOT NULL,
  project_id    TEXT,
  pane_id       TEXT,
  event_type    TEXT NOT NULL,
  payload_redacted_json TEXT NOT NULL DEFAULT '{}',
  source        TEXT NOT NULL DEFAULT 'system',  -- voice|rest|ws|terminal|cortex|system
  interaction_id TEXT,
  ts            INTEGER NOT NULL
);
CREATE INDEX idx_exchange_events_exchange_ts ON exchange_events(exchange_id, ts);
CREATE INDEX idx_exchange_events_type_ts     ON exchange_events(event_type, ts);

CREATE TABLE context_deliveries (
  delivery_id      TEXT PRIMARY KEY NOT NULL,
  project_id       TEXT,
  voice_session_id TEXT,
  context_version  TEXT NOT NULL,
  trigger          TEXT NOT NULL,             -- ContextInjectionTrigger vocabulary (contextTelemetry.ts:14)
  snapshot_hash    TEXT,                      -- hashSnapshot(), joins context_injections.source_snapshot_hash
  brief_hash       TEXT,                      -- hashText(), joins context_injections.brief_hash
  included_sources_json TEXT NOT NULL DEFAULT '[]',
  dropped_sources_json  TEXT NOT NULL DEFAULT '[]',
  acknowledged_at  INTEGER,
  ts               INTEGER NOT NULL
);
CREATE INDEX idx_context_deliveries_session_ts ON context_deliveries(voice_session_id, ts);
CREATE INDEX idx_context_deliveries_version    ON context_deliveries(context_version);

-- Nullable correlation columns (the v2 handoff_id / v7 interaction_id precedent):
ALTER TABLE pending_approvals   ADD COLUMN exchange_id TEXT;
ALTER TABLE action_log          ADD COLUMN exchange_id TEXT;
CREATE INDEX idx_action_log_exchange_id ON action_log(exchange_id);
ALTER TABLE attention           ADD COLUMN exchange_id TEXT;
ALTER TABLE context_injections  ADD COLUMN exchange_id TEXT;
ALTER TABLE events              ADD COLUMN exchange_id TEXT;
CREATE INDEX idx_events_exchange ON events(exchange_id);
```

**Where a column can't land:** terminal command history is **not in SQLite** — it is the
file-backed `HistoryManager` (`server.ts:378-500`, `.janus_history.json`, atomic tmp+rename,
redact-on-save). Its `HistoryEntry` is plain JSON, so the correlation is an additive optional
`exchange_id?: string` field written only by the exchange delivery path (§5), no DDL. The
SQLite `events` `command_outcome` rows (the migrated legacy history) additionally get the
`events.exchange_id` column above.

Store API additions follow the `recordAction`/`getActionLog` style (`src/store/sqliteStore.ts:366,410`):
`insertExchange`, `casExchangeState` (guarded UPDATE, returns won:boolean), `appendExchangeEvent`
(inside `recordActivity`-style txns where paired with a state CAS, `src/store/sqliteStore.ts:120-126`),
`getExchange`, `getOpenExchanges(paneId?)`, `recordContextDelivery`.

---

## 7. Relationship to the existing `handoffs` lifecycle (prior art, not extension)

Schema v2 already ships an exchange-shaped lifecycle: `handoffs`
(`composing|revising|staged|delivered|consumed|rejected|expired|blocked_read_only`,
`gate_approval_id`, `revision_count`, `events.handoff_id` — `src/store/types.ts:58-83`,
`src/store/schema.ts:154-183`), flipped in the same resolver choke-point the spine will hook
(`flipHandoffOnResolve`, `src/gating/index.ts:1004`). The spine does **not** extend it:

- handoffs are a pane→pane **artifact** (composed prompt + source context refs) with no
  operator-utterance provenance, no draft-version⇄approval binding (`revision_count` counts but
  binds nothing), and no terminal-observation/result leg;
- `agent_exchanges` is the operator-communication record with exactly those things.

Plan: handoffs continue unchanged; in `primary` mode a `deliver_handoff` delivery ALSO creates
an exchange (kind stamped in `instruction_envelope_json.handoff_id`), so the handoff artifact
and the communication record correlate without either owning the other. Folding `handoffs` into
the spine is explicitly deferred (a candidate for a later phase, not 1.x).

---

## 8. Feature flag — `JANUS_EXCHANGE_SPINE: off | shadow | primary`

Read once at boot (the `JANUS_SHELL_ALLOWLIST` / `VOICE_TRACE` env idiom,
`src/pendingApprovals.ts:120`, `src/observe/index.ts:170`).

- **`off` (default):** migration applies (schema is version-forward like every prior wave), but
  no exchange rows are written and no code path consults them. Zero behavior delta.
- **`shadow`:** the `ExchangeService` observes the seams in §5 and writes
  `agent_exchanges`/`exchange_events`/`context_deliveries` rows; the legal-transition guard
  **logs** violations (never throws — the QW5 "observation never breaks the pipeline" rule,
  `src/observe/index.ts:645-667`); nothing reads exchange state to make a decision; delivery,
  approvals, join-tracking, and announcements all run on today's paths. This is the B-3/cortex
  SHADOW pattern (`applied=0`, `src/store/schema.ts:277-310`) applied to the lifecycle: we
  measure fidelity before we steer.
- **`primary`:** the exchange row becomes the authoritative lifecycle head: voice/REST surfaces
  read it for "what's in flight", the resumption digest includes quarantined exchanges, and
  step 1.4 replaces the in-memory `dispatchJoinTracker` join with exchange/member correlation.
  The capability-gate choke-point, `resolveDecision`'s claim, and `applyResolution`'s rendering
  remain untouched and authoritative for *permission* — the spine records and correlates; it
  never gates.

Rollback = flip the env var; the tables are inert data.

---

## 9. Non-goals / the boundary (normative)

OrbitalVoiceRunner **listens, understands, drafts, routes, correlates, and reports**. The
terminal agents do the engineering. Concretely, the spine must never grow:

1. **No mission DAG / dependencies.** An exchange never references another exchange as a
   prerequisite, parent, or child. Fan-out (`dispatch_to_panes`, macros) is N *sibling*
   exchanges sharing a `dispatch_group_id` label in their envelope — a correlation tag for
   reporting, carrying **no state semantics** (a group "completes" only in the sense that a
   report can say all members settled; nothing is triggered by it).
2. **No project decomposition / planning.** The spine never splits an utterance into steps.
   Plans were already demoted to operator-approved outlines (`src/observe/index.ts:441-444`);
   the spine does not re-grow an execution engine under a new name.
3. **No engineering verification.** `agent_complete` records the agent's **report**
   (`result_summary` composed the way `computeIdleSummary` summarizes today,
   `src/observe/index.ts:288-307` — from the agent's own output, redacted). Orbital never runs
   tests, lints, builds, or diffs to "verify" an exchange. `agent_failed` likewise records the
   *observed* failure edge, not a judgment.
4. **No retry policy / scheduling.** No automatic re-delivery, no backoff, no queues of pending
   exchanges per pane, no timers that advance state except the existing approval TTL sweep
   (which cancels, never advances). Every re-send is a new operator-driven exchange.
5. **No autonomous follow-ups.** `needs_input` surfaces attention + narration; the *answer* is
   an ordinary gated pane write initiated by the operator. The spine never composes and sends
   an answer on its own.
6. **No gate authority.** The capability-gate matrix (`decideProposal` +
   `effectiveCapabilityGateFor` + `applyDispatchDecision`) remains the sole permission
   choke-point. The spine is downstream bookkeeping; a spine outage (store fault) must never
   block or loosen a write decision (best-effort writes, the `audit:` seam's never-throw rule,
   `src/voice/index.ts:1216-1233`).
7. **One instruction, one pane.** The exchange grain is fixed. Anything that wants to be
   "a task tracked across panes/sessions/days" is `bd` (beads) territory, not the spine's.

**Canonical-model deviations (explicit):**
1. Added column `approval_draft_version` on `agent_exchanges` (not in the canonical model) so
   §3's binding is enforceable as a SQL CAS predicate instead of JSON parsing inside a
   transaction.
2. Added nullable `events.exchange_id` beyond the listed correlation targets, mirroring the
   existing `handoff_id` audit-spine precedent (schema v2) — the `events` table is where
   `command_outcome` rows (imported legacy history) live.
3. "Terminal command history" correlation is a JSON-field addition, not a SQLite column (the
   history store is file-backed — discovery, §6).

---

## 10. Test plan (RED-first, landing with this doc)

- `tests/test_exchange_lifecycle.ts` — imports `../src/exchanges/lifecycle` (does not exist;
  suite is RED until step 1.3): full legal-transition matrix + illegal-complement rejection,
  draft-revision version bump + approval invalidation, exact-version approval binding,
  delivery-after-write-only ordering, idempotent repeated approval/delivery, cancellation from
  every cancellable state (and refusal from terminal states), boot quarantine dispositions.
- `tests/test_exchange_correlation.ts` — imports `../src/exchanges/service` (does not exist):
  unrelated-pane signals never settle; pre-delivery signals never advance; two exchanges on one
  pane stay independent (supersession marks the earlier in-flight one `interrupted`, settled
  ones untouched); legacy/manual commands are never adopted; post-boot signals never settle
  pre-boot exchanges; unknown-pane signals are a no-op.

Idiom matched to the existing suite: `node:test` `describe/it` + `assert` from `node:assert`
(`tests/test_approvals_wse.ts:1-2`), run by `node scripts/run-unit.mjs` (`tsx --test
--test-force-exit`).
