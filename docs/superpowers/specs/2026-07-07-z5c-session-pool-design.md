# z5c Design: The Per-Project Session Pool — session/connection management

Operator-approved design (2026-07-07 brainstorm) for `wsm-e2e-pinned-z5c`
(cortex session/connection management), folding in and closing
`wsm-e2e-pinned-1d6w` (inject-leg delivery class vs the L1 cooldown).

- **Date:** 2026-07-07
- **Status:** Approved (operator, brainstorm 2026-07-07; spec review waived by operator).
  **Implementation status as of 2026-07-10 (Phase 5.5 release review — honest accounting):**
  Slice 1 (delivery classes, 1d6w) and Slice 2 (handle tier: per-project KV handles,
  resume-and-catch-up switching, legacy handle migration) are SHIPPED. Slice 3 is **partially
  shipped**: the DECISION layer landed (`src/voice/sessionPool.ts` — D2 entry state machine,
  D4 switch plans, D6 `pool.plan` + TS fail-closed floor, D7 `sessionPoolHotSlots` config,
  `python/policies` pool op), but the PHYSICAL hot-warm socket execution (multiple concurrent
  live Gemini sockets, background feeding) is **deferred** — the runtime remains
  single-physical-socket; `hot-warm` is a planned state the executor does not yet realize, and
  a backgrounded project's inject-class events are dropped-not-queued (D6) with `lastEventAtMs`
  bookkeeping for catch-up. `sessionPoolHotSlots` > 1 therefore shapes plans, not sockets.
  See `docs/runbooks/communication-cockpit-operations.md` §5 (known limitations).
- **Related:** parent spec `docs/superpowers/specs/2026-06-27-python-cortex-shadow-design.md`
  (deferred item 5) · cutover spec `docs/superpowers/specs/2026-07-02-cortex-cutover-design.md`
  (D8 deferral) · seam ADR `docs/design/2026-06-19-python-ts-seam.md` ·
  resumption resilience `src/voiceResumption.ts` · bus `src/paneSignalBus.ts`
- **In-wave sweeps:** `wsm-e2e-pinned-f2om` (pytest duplicate-basename — pre-work),
  `wsm-e2e-pinned-ud10` (dead-pane detection feeds the health snapshot).

## BLUF

Replace the single global Gemini Live session with a **per-project session pool**: each
project gets its own server-side Gemini conversation (its own brain), managed as a
**hybrid LRU** — the foreground project plus K hot sockets (K=1 default), with a
resumption-**handle tier** below (no socket, ~1–2s resume + cortex catch-up on switch).
**Python decides pool membership** (`pool.plan`, a new op on the existing daemon);
**TypeScript keeps all socket I/O and the proven reconnect mechanics.** The folded-in
1d6w fix gives command-outcome injections their **own bus delivery class** so fast-command
outcomes actually reach the brain(s). Every piece fails closed to today's single-session
behavior.

## Why (the re-derivation)

The bead's original 2026-06-27 sketch said "hot/hot redundant connections for uptime."
Re-derived 2026-07-07 against the shipped cortex-primary product: a Gemini Live session's
conversational state lives **server-side inside Google's session** — a second socket is a
fresh brain, not a mirror, so literal hot/hot replication is physically unavailable. The
operator chose the real prize instead: **per-project warm agents** — killing the
cross-project context contamination of one global brain and making `switch_context` land
on a session that already knows the project. Uptime work is deliberately NOT this wave
(see Non-goals).

## Operator decision record (binding, 2026-07-07)

1. **Prize = instant project switch / per-project brains.** Not zero-gap failover, not a
   recovery-policy port. Rejected: warm-standby failover (cost without continuity — a
   standby is a fresh brain), policy-only port (doesn't move the product).
2. **Warm = hybrid LRU.** Foreground + K hot sockets (K=1 default); all other known
   projects hold a resumption handle only. Python's `pool.plan` owns slot assignment and
   eviction. Rejected: hot-pool-only (quota + idle billing scale with project count),
   handle-only (gives up instant switch-back, the common flow).
3. **1d6w = own delivery class** (this closes the bead). `PaneSignalBus` deliveries are
   tagged by concern: `spoken` keeps the L1 cross-kind cooldown (`crossKindCooldownMs`,
   5000ms — voice pacing unchanged); `inject` bypasses L1 and relies on the D2 inject gate
   (hash-diff + 3s debounce, per session) as its sole anti-spam. Rationale: the L1 cooldown
   is speech pacing; the inject leg already has purpose-built spam protection downstream —
   suppressing it only produced the measured fast-command under-injection. Rejected:
   keep-as-is (streaming feel stays broken for the common case), raw pre-cooldown tap
   (second delivery semantics around the bus instead of a first-class one).
4. **Pool scope = the browser WS connection.** Hot sockets live inside the existing
   per-WS-connection voice scope and die with it; **handles persist in KV**, so a browser
   refresh costs one ~1–2s resume, never a cold brain. Rejected: server-global pool
   (orphan lifecycle, idle eviction, audio rebinding across connections — a subsystem for
   a rare event).
5. **Python decides membership; TS keeps mechanics.** `pool.plan` returns the slot plan;
   the existing per-socket reconnect machinery (`connectLiveSession` generation counters,
   PLM4 never-throw, 1007/1008 triage, poison-handle self-heal) stays TS and is
   generalized per pool entry, not moved or rewritten.
6. **No event queue for the handle tier.** A backgrounded handle-tier project's brain is
   frozen; on promotion the cortex fires a **catch-up profile** brief (Wave 6 catch-up
   synthesis already composes current state on demand). Rejected: per-project event replay
   queue (a second stateful mechanism duplicating what catch-up synthesis already does).
7. **Fail-closed floor = today's product.** Any `pool.plan` miss (timeout / error /
   off-schema / daemon dead) degrades that call to single-session behavior. The daemon
   dying mid-session leaves exactly today's app.

## Design

### D1. Bus delivery classes (the 1d6w fix — ships first)

`src/paneSignalBus.ts` gains a per-delivery **concern class**: `spoken` | `inject`.

- `spoken` deliveries: today's semantics, including the L1 cross-kind cooldown — voice
  announcement pacing is unchanged by this wave.
- `inject` deliveries: **not** suppressed by the L1 cross-kind cooldown. Per-kind dedupe
  and ordering guarantees of the bus still apply; the D2 inject gate (per session — see
  D5) is the anti-spam authority for this class.
- The D1 command-outcome trigger (cutover spec) subscribes as `inject` class. A fast
  command completing within 5s of its own `running` edge now produces an injection
  candidate; the D2 gate decides.
- The Journey 4 comment (`tests/test_cortex_cutover_journeys.ts`, "bead: inject-leg vs L1
  cooldown") becomes a positive regression test: fast-command outcome **does** inject.

### D2. `SessionPool` (TS, `src/voice/`)

A `SessionPool` owns `Map<projectId, PoolEntry>` inside the existing per-WS-connection
voice scope (`VoiceSessionState`).

- Entry states: `hot-foreground` (socket + mic/audio attached) · `hot-warm` (socket open,
  no audio, receives `inject`-class feeds) · `handle` (no socket; persisted resumption
  handle) · `cold` (nothing yet).
- The single-session connect/reconnect machinery generalizes to per-entry: each hot entry
  runs its own `connectLiveSession`-equivalent with its own generation counter, bounded
  reconnect budget, and 1007/1008 triage. **This is the riskiest refactor of the wave**;
  it must preserve the PLM4 never-throw contract per entry and stay within the CC ≤ 10 /
  cognitive ≤ 15 gates (extract per-entry helpers; do not grow `connectLiveSession`).
- Audio routing: exactly one entry holds the mic (`hot-foreground`). `switch_context`
  re-points audio on a hot target; on a handle target it connects (resume handle) then
  attaches audio, and the cortex fires a `catch-up` brief.
- Background hot entries keep receiving `inject`-class briefs so their brains stay
  current (that is what the K hot slots buy).

### D3. `pool.plan` (Python, `python/` — new module on the existing daemon)

New op on the multiplexed dispatch router, same request/response NDJSON shape and
versioning as `cortex.decide`:

Request: `{ id, v, op: "pool.plan", snapshot, now }` where `snapshot` is the TS-composed
health snapshot: `{ projects: [...], foregroundProjectId, hotSlotBudget, entries:
{ [projectId]: { state, handleAgeMs, lastEventAtMs, lastSwitchAtMs, recentCloseCodes,
paneHealth } } }`. `paneHealth` carries the dead-pane signal (ud10 sweep).

Response: `{ ok: true, plan: { foregroundProjectId, hotSlots: [projectId],
actions: [{ type: "promote"|"demote"|"resume"|"fresh"|"evict", projectId, reason }] },
trace }` — deterministic, pure (identical snapshot ⇒ identical plan), full decision trace
per the over-document principle. Failure: `{ ok: false, error: { code: "POOL_FAILED" } }`;
the daemon survives, other ops keep answering.

- Called per pool-relevant event (project switch, entry close, entry connect, periodic
  is NOT added — event-driven pull only, per the locked feed model).
- Raced at 300ms via the `policyClient` idiom. Miss ⇒ D6 floor.
- v1 policy: LRU over `lastSwitchAtMs` for the K hot slots; `resume` when a fresh handle
  exists (TTL per `voiceResumption.ts` constants passed in the snapshot), else `fresh`;
  `evict` handle-tier entries only on project deletion. Deliberately boring — the seam
  and trace are the product; policy can grow later without touching TS.

### D4. Switching flows

- **Hot target**: re-point audio; zero connects; brain already current. Instant.
- **Handle target**: `connect(resume handle)` (~1–2s) → attach audio → cortex `catch-up`
  brief. Handle poisoned (1008) ⇒ existing self-heal clears it, fresh session + catch-up.
- **Failover (unchanged)**: a dropped socket recovers via today's bounded per-entry
  reconnect. Pool membership means backgrounded projects fail independently of the
  foreground; a background entry that exhausts its budget demotes to `handle`.

### D5. State & persistence

- **Per-project resumption handles in KV**, keyed by project; the existing single-handle
  KV slot migrates to the foreground project's entry on first boot (one-way, trivially —
  a stale handle is self-healing by design). TTL + 1008 self-heal apply per entry
  unchanged.
- **Per-session cortex state**: the D2 inject-gate state (`_lastSnapshotHash`, last-inject
  timestamp) and the D4 hysteresis ring buffer become per-entry. `ctx.sessionId` in
  `cortex.decide` carries the entry's real session identity (the multi-session-ready
  interface from the shadow slice, finally exercised).
- Hot sockets die with the WS connection (locked decision 4); handles persist across
  refresh and restart.

### D6. Fail-closed floor

`pool.plan` miss/timeout/error/off-schema ⇒ that call behaves single-session: foreground
only, no hot-warm slots; handle-tier resume still works from TS defaults (resume if fresh
handle else fresh session — the `voiceResumption.ts` logic, which never left TS). Daemon
dead ⇒ today's app, indefinitely. Disposition recorded to telemetry (`pool-miss`,
mirroring `cortex-miss`).

### D7. Config

One number joins the settings surface with the `voiceUx`/`contextInjectDebounceMs` PUT
idiom: `sessionPoolHotSlots` (default **1**, min 0 = handle-tier only, capped at 3 —
quota guard: foreground + K must stay well inside Gemini Live concurrent-session limits).
Everything else (LRU policy, TTLs) is code, not config — YAGNI.

### D8. Testing (the trust gate)

- **Python pytest**: `pool.plan` determinism against fixture snapshots; LRU/promote/
  demote/resume-vs-fresh decisions; hostile snapshots (empty, unknown fields, malformed
  entries) return `POOL_FAILED`, never raise; dispatch survives (other ops answer).
  Pre-work: fix `f2om` so the combined pytest run collects cleanly.
- **TS unit**: pool state machine transitions (all edges above); per-entry inject-gate
  isolation (project A's inject doesn't consume project B's debounce); delivery-class
  cooldown matrix (spoken suppressed at <5s cross-kind, inject not suppressed, D2 gate
  still dedupes); handle KV migration; floor behavior on `pool.plan` miss.
- **Journeys** (mockLive, in-proc): fast-command outcome injects (1d6w regression, the
  Journey 4 root cause); hot switch is instant + no re-prime; handle switch resumes and
  fires catch-up; daemon killed mid-session ⇒ floor, loop uninterrupted; browser
  reconnect resumes foreground from handle; redaction invariant holds on every injected
  string in every session.
- **Live smoke**: `npm run smoke:claude` + live e2e green before merge, per the standing
  done-pipeline.

### D9. Slicing (ship order)

1. **Slice 1 — delivery classes (1d6w)** + per-session gate-state groundwork. Smallest,
   closes 1d6w, fixes the fast-command under-injection.
2. **Slice 2 — handle tier**: per-project handles in KV + resume-and-catch-up switching.
   The product win; zero idle cost; no new Python op yet (TS defaults = D6 floor logic).
3. **Slice 3 — hot slots + `pool.plan`**: hot-warm entries, background feeding, the
   Python policy module + snapshot. The instant-switch polish.

Each slice lands green through the full battery independently; the pool interface from
slice 2 is shaped so slice 3 adds states, not rewrites.

### D10. Non-goals (this wave)

Zero-gap/standby failover (the original "hot/hot" — re-derived away, see Why); moving
reconnect mechanics to Python; server-global pool; event-queue replay for the handle
tier; runtime toggling of `sessionPoolHotSlots` mid-session (read at connect, PUT applies
next session); any capability-gate/approval semantic change (locked posture: cortex
proposes, TS gate disposes); multi-operator anything.

## Hard constraints (standing project rules)

Panes boot inert; no live API keys in tests; redaction invariants preserved (every
injected string through the redaction pass regardless of session); complexity gates
(CC ≤ 10 / cognitive ≤ 15, zero suppressions) are hard errors; TDD for behavioral
changes; beads claimed on start, closed with provenance on land.
