# WS-F `odb` — Resumption Digest (deferred-execution staging, lifecycle + re-announce)

- **Bead:** `wsm-e2e-pinned-odb` — "WS-F deferred-execution staging" (Locked roadmap §4 P0a)
- **Date:** 2026-06-01
- **Status:** Design — awaiting operator review
- **Blocks:** `wsm-e2e-pinned-8sq` (Matrix surface), `wsm-e2e-pinned-rbh` (Permission truth)

---

## 1. BLUF / human need

> The operator armed a couple of Ask-tier actions, then **went to a meeting**. They come back. Janus
> should hand them their queue: *"Welcome back — here's what you left in progress."*

The value is a **resumption digest across multiple staged items**. Everything in this spec resolves
toward that one human moment. Safety is delivered by **informed re-consent** (re-announce with the
context behind each item, then re-require approval), **never** by a silent clock that kills the very
items the operator stepped away from.

## 2. Premise correction (why this is smaller than the bead implies)

The bead text says *"today an Ask-tier side effect is applied-and-audited immediately."* That describes
the **old `gateCapability` v1**, which has **already been superseded** for the main mutators by
`gateOrDefer` + `PendingActionStore` (server.ts:1387, src/pendingActions.ts) — Ask-tier non-PTY side
effects already **stage** as deferred actions, and pane writes already stage as `pending_approval`.

| Concern | Pane writes (`PendingApprovalStore`) | Non-PTY mutators (`PendingActionStore`) |
|---|---|---|
| Ask-tier staging | ✅ `decideProposal`→`pending_approval` | ✅ `gateOrDefer`→deferred action |
| Survives **process restart** | ✅ durable SQLite (PR #23 / `nzt`) | ❌ holds a live `run()` closure (not serializable) |
| Survives **session disconnect** | ❌ `purgeSession()` **deletes** (server.ts:3089) | ⚠️ in-memory, no session binding (survives in-proc) |
| **Re-announce** on reconnect | ❌ never re-spoken (the `TODO(WS-F)`) | ❌ never re-spoken |

**The untouched gap is lifecycle:** stop discarding survivors on disconnect, and re-surface them on
reconnect. That is the whole of scope here.

## 3. Scope

**In (scope A):**
1. **Disconnect = detach, not purge.** Drop the dead live-session handle; keep the durable record.
2. **Reconnect = resumption digest.** Re-attach survivors to the new session; speak one batched
   summary across all of them, with the maintained context; re-require explicit approval.
3. **Clock pauses while away.** TTL only advances while a session is connected to hear a last-call.
4. **No silent kill.** A connected-and-idle item that crosses TTL gets a spoken **last-call** (context
   + grace), then auto-rejects only if still ignored. Re-announce always precedes reject.
5. **e2e pin** of the disconnect→reconnect→digest→approve round-trip (the bead's `wsm-e2e-pinned-*`).

**Out (YAGNI — separate beads):**
- **Restart-durable deferred actions** — the `PendingActionStore` `run()` closure can't serialize.
  Accepted asymmetry: pane-approvals survive a *process restart*; deferred actions survive only a
  *disconnect*. (Scope **B** — file follow-up bead.)
- **Converting remaining `gateCapability`-only apply-now sites** to staged deferral (Scope **C**).
- **Multi-client fan-out.** Single-operator, last-connection-wins (`activeFrontendWs`).
- **Hard durable cap on abandoned rows.** A never-returning operator leaves rows; pure storage
  hygiene, not safety. Deferred (see §9 follow-ups).

## 4. The model — one primitive, three triggers

Everything reduces to a single mechanism — **context-rich re-announce** — fired at three moments. No
silent kills, no auto-fires.

```
                    ┌─────────────────────────────────────────┐
   stage  ────────► │  STAGED  (un-approved, durable on disk)  │
  (announce         │  command  +  PROVENANCE (rationale+age)  │
   w/ context)      └───────────────┬─────────────────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        │ (1) RECONNECT             │ (2) CONNECTED + IDLE        │ operator
        │  re-attach to new session │  TTL elapsed → LAST-CALL    │ acts
        │  batched digest w/ ctx    │  re-announce w/ context     │  │
        │  re-require approval      │  + grace window             │  ▼
        │  → fresh TTL window       │  still ignored → reject     │ approve → fire once
        └───────────────────────────┴───────────────────────────┘ reject  → drop
                                    │
                          pane died → never writes (dead_pane)
```

### 4.1 The clock rule (forced, not chosen)

"Re-announce **before** rejecting" has a logical consequence: **you cannot re-announce into a session
that isn't there.** Therefore the TTL may reject an item **only while a session is connected** to hear
the last-call. This forces:

- **Disconnected (the meeting):** clock **paused**. The item waits, durably. Away for an hour → still
  there on return. This is what removes the "zombie expiry while away" hazard *without* a guillotine.
- **Connected + idle:** clock runs. At TTL, spoken last-call with context + grace; reject only on
  continued silence. Bounds staleness *during an active session*.
- **Reconnect:** re-attach + batched digest + **fresh** TTL window.

## 5. Data model

The provenance the digest needs **already persists** — no new column for approvals:

- `PendingApproval.rationale = { trigger, summary }` → stored as the `rationale` JSON column
  (`add()` JSON-stringifies; `hydrateApproval()` parses back). `trigger` = raw dictation; `summary` =
  redacted pane snapshot. `timestamp` gives age.
- The **"longer title"** is therefore a **render concern**, not a schema change: a pure
  `renderResumptionLine(record, now)` assembles `capability → targetPane: "<short instruction>"` +
  `"you said: <trigger>"` + `"<age> ago"` from existing fields.
- `PendingAction` already carries a one-line `summary`; the same renderer handles it.

**New transient (in-memory only):** a `lastCallAt?: number` marker on the live record to drive the
last-call→grace→reject transition. It need not persist — if it resets on restart, the item simply
earns a fresh last-call, which is harmless.

**`expires_at` semantics change:** it is rewritten to `now + APPROVAL_TTL_MS` on **re-attach**, and is
only consulted by the sweep for items whose session is currently connected (see §6.3). The durable
column stays; its meaning narrows to "deadline *while connected*."

## 6. Server wiring deltas

### 6.1 Disconnect — `detachSession` replaces `purgeSession` (server.ts:3089)

`PendingApprovalStore.detachSession(session)`: for every record bound to `session`, null its live
handle in the `sessions` side-map and clear `lastAnnounced` for it, **but keep** the record, the
`order` entry, and the durable row. (The store already models "record with no live handle" — the
restart-hydrate path sets `session === undefined`.) `purgeSession` is retained only if some caller
still needs hard-purge semantics; the disconnect handler switches to `detachSession`.

`PendingActionStore` needs nothing on disconnect — it is not session-bound and already survives
in-process.

### 6.2 Reconnect — `reannounceSurvivors(session)` (after `session` is live, ~server.ts:1713)

1. **Re-attach:** bind every orphan record (`session === undefined`) to the new live `session`; reset
   each `expires_at = now + APPROVAL_TTL_MS`; clear any `lastCallAt`.
2. **Digest:** collect all survivors (approvals + pending actions). If none, **silent**. Otherwise push
   **one** system-event: a count lead-in + `renderResumptionLine` for up to **3** most-recent items,
   then `"+N more — all queued"`. UI receives a broadcast so chips repopulate for the full list.
3. **Re-require approval:** survivors are still in the un-approved `STAGED` state (there is no
   approved-but-undelivered gap in the current flow), so no flag is needed — the digest simply
   re-surfaces them for a conscious yes. Approving runs the existing `applyResolution`/`confirm` path
   unchanged.

### 6.3 Sweep — last-call-then-grace replaces silent auto-reject (`sweepExpiredApprovals`)

For each store, the sweep now:
- **Skips** any item whose session is **not currently connected** (clock-pause while away).
- For a connected item past `expires_at` with no `lastCallAt`: set `lastCallAt = now`, push the
  last-call narration (single-item `renderResumptionLine` + "approve now or I'll drop it"), broadcast.
  **Do not reject yet.**
- For a connected item with `lastCallAt` and `now - lastCallAt > GRACE_MS`: route through the existing
  `applyResolution(id, "expire")` / `pendingActions.expire(id)` → reject (no write/effect), broadcast.

New constant `APPROVAL_GRACE_MS` (default 60 s). `APPROVAL_TTL_MS` (5 min) and `APPROVAL_SWEEP_MS`
(30 s) unchanged.

## 7. Spoken digest format

- **0 items:** silent.
- **1 item:** `"Welcome back — one action still waiting, armed <age> ago: <renderResumptionLine>. Approve, or has this moved on?"`
- **2–3 items:** `"Welcome back — <N> actions waiting from before: <line1>; <line2>; <line3>. Which first?"`
- **>3 items:** name the 3 most-recent as above, then `"…and <N-3> more, all in your queue."`
- UI chips always show the **full** list regardless of the spoken cap.

## 8. Testing strategy (TDD)

**Unit (`tsx --test`, `--test-force-exit`):**
- `detachSession` keeps record + `order` + durable row, nulls the live handle; survivor is then an
  orphan re-attachable by a fresh handle.
- `renderResumptionLine` — composition, redaction (`redactSecrets`), age formatting, missing-rationale
  fallback.
- Sweep: connected+idle past TTL → last-call (no reject); +grace → reject. Disconnected past TTL →
  **no** last-call, **no** reject (clock paused).
- Re-attach resets `expires_at` and clears `lastCallAt`.
- `PendingActionStore` survivor included in digest collection; not restart-durable (documented).

**e2e (Playwright, `?mock=1`) — the bead's pin:**
- Stage ≥2 items (a pane approval + a deferred action) → assert chips + spoken announce.
- Drop the WS (simulate disconnect) → assert items **not** purged (chips persist across reconnect,
  durable row present).
- Reconnect → assert **one** batched digest is re-announced with context, and chips repopulate.
- Approve one from the digest → assert it writes/executes exactly once via the existing claim gate;
  reject another → assert no write.

**Battery before "done":** `npm run lint` · `npm test` · `npm run build` · `py -3 -m unittest
tests.test_universal_terminal` · `npm run test:e2e`.

## 9. Edge cases, accepted limitations, follow-ups

- **Process restart vs. disconnect asymmetry** (deferred actions lost on restart) — accepted; **follow-up
  bead** (scope B): persist action *intent* + rebuild `run()`.
- **Truly-abandoned rows** (operator never returns) accumulate in SQLite — accepted; **follow-up bead**:
  long janitorial retention sweep (hygiene, still re-announce-before-reject).
- **Multi-tab:** orphans re-attach to whichever session connects; a second concurrent tab with no
  remaining orphans announces nothing. Acceptable at single-operator scale.
- **Dangling Gemini `callId`:** the original functionCall was already answered once with
  `pending_approval`; re-announce uses a fresh system-event push (not a call resume), and
  `resolveDecision` never reads `callId`, so writes still land correctly.
- **HIGH COLLISION** (per bead): the sweep behavior change touches a tested mechanism
  (`sweepExpiredApprovals` + ~100 claim/dead-pane/exactly-once tests). Keep the claim gate and
  `resolveDecision`/`confirm` terminal semantics **byte-for-byte**; only the *trigger* (last-call vs.
  silent reject) and the *connected-gate* change.
- **Legacy backend** (`JANUS_LEDGER_BACKEND=legacy`, `store === null`): approvals are in-memory only,
  so there is nothing durable to re-attach after a restart, but disconnect-detach + reconnect-digest
  still function within a process. No behavioral regression on the legacy path.

## 10. Success criteria

1. Disconnect no longer discards staged items; they persist (durably for approvals).
2. On reconnect, a single spoken digest re-surfaces all survivors with their maintained context, and
   UI chips repopulate.
3. An item left during a disconnect is **not** expired by the clock; it is actionable on return.
4. A connected-and-idle item is never silently dropped — a spoken last-call always precedes any reject.
5. Approving/rejecting a re-surfaced item goes through the unchanged claim gate (exactly-once, dead-pane
   safe).
6. Full battery green; e2e pins the round-trip.
