# Core-Features Stability Audit — 2026-06-09

> Scope: server hub (`server.ts`), pane lifecycle/PTY (`src/terminal.ts`, `src/ptyTransport.ts`,
> status machine/probe), persistence (`src/store/`, `src/ledger.ts`), capability-gate/approval/voice
> pipeline (`src/gating/`, `src/pendingApprovals.ts`, `src/voice/`), client (`src/orbital/` kitchen +
> shared components), and the quality gates themselves (unit suite, CI).
>
> Method: five parallel subsystem reviews + independent verification of the highest-severity claims
> and a fresh run of the full quality-gate battery on Linux/Node 22.22. Findings below are
> code-verified (file:line); the most severe ones were re-read and confirmed by hand. **Audit only —
> no fixes applied in this commit.**

## TL;DR

Yes — there are real instability sources the current view (tests, CI, docs) does not surface.
The five most consequential:

1. **Same-instance pane restart permanently wedges the status machine at "Exited"** (critical,
   verified line-by-line; the test fixtures replicate the buggy guard so no test can catch it).
2. **Two server-killing crash vectors**: unobserved rejections in fire-and-forget restart/mode-change
   effects, and the unguarded 30s approval sweep that goes straight into better-sqlite3.
3. **A corrupt/locked `.janus.db` silently boots an empty-looking app** and strands every write made
   in that state (the legacy JSON was already renamed `.bak` and the migration never retries).
4. **Event-loop blocking on the hot path**: a full synchronous read/parse/rewrite of
   `.janus_history.json` on *every PTY output chunk*, `execSync` process probes every 500ms per
   shell pane, and an N+1 synchronous SQLite storm on every `broadcastLedgerUpdate`.
5. **The unit suite does not pass in a clean Linux environment** (18 tests cancelled,
   deterministically — the same "unref'd watchdog" pattern that is also a latent prod hazard), and
   CI never runs the full suite, so none of the above is visible from the green checks.

A single cross-cutting theme explains the worst cluster: **the system lacks a generation/identity
concept at every layer** — PTY transports (stale `onExit` tears down the new spawn), voice sessions
(stale connect overwrites the live session), and client fetches (stale `/api/terminals` response
overwrites a fresher one). One design fix (a generation token checked in callbacks) resolves
findings in three different subsystems.

---

## A. Verified critical findings (read these first)

### A1. Pane restart wedge — status machine dead after every same-instance restart  — CRITICAL
- `src/actions/defs/panes_rest.ts:179-184` restarts via `await term.stop(); term.start()` on the
  **same** `UniversalTerminal` instance (so does `applyPaneMode`'s restart-resume leg).
- During `stop()`, the transport's `onExit` (`src/terminal.ts:886`) stamps `status = "Exited"`.
- `start()` then refuses to reset it: `if (this.status !== "Exited") { this.status = "Running" }`
  (`src/terminal.ts:856`) — the guard is exactly inverted for this path.
- The only other path to `Running` is `applyStatusEvent`, which early-returns on Exited
  (`src/terminal.ts:579`). Grep confirms no other `this.status =` assignment can recover.
- Result: a live agent process behind a pane the status machine, ledger sync, onIdle/onRunning
  edges, and voice narration all believe is dead — unrecoverably, until the pane object is rebuilt.
- **Untestable as-is:** the test fixtures copy the same guard verbatim
  (`tests/test_output_guard.ts:36`, `test_stop_all_two_stage.ts:44`, `test_voice_tools.ts:54`, …).
- Fix: unconditionally set `Running` in `start()` (the degraded-spawn catch returns before this
  line, so the guard protects nothing), and fix the fixtures.

### A2. Stale transport callbacks — no generation guard  — HIGH
- `transport.onExit` / `onData` handlers (`src/terminal.ts:862-898`) close over `this` with no
  `if (this.transport !== transport) return` check. A SIGTERM-resistant child that outlives the 1s
  kill window fires the **old** transport's exit after `start()` — marking the new pane Exited and
  clearing the new pane's probe/idle/ready timers (which also strands queued `pendingInput`).
- Compounding: `NodePtyTransport.kill()`'s `_killed` latch (`src/ptyTransport.ts:160-163`) makes
  the SIGTERM→SIGKILL escalation (`src/terminal.ts:1104-1107`) a silent no-op — SIGKILL is never
  delivered, so stubborn children become permanent zombies while `stop()` reports success.
- And: no per-pane restart mutex — two overlapping restarts both await the same `_stopping`
  promise (`src/terminal.ts:1052-1054`) then both `start()`, leaking a second live PTY whose
  `onData` stays wired into the same pane.
- Fix (one change covers all three): transport-generation token checked in every callback +
  `start()` refuses/kills an existing live transport + allow `kill("SIGKILL")` re-entry.

### A3. Server-fatal crash vectors  — HIGH
1. **Unobserved rejections on confirm paths.** `applyPaneMode`'s gated run closure
   (`src/applyPaneMode.ts:201-204`) and `respawn_pane`'s IIFE
   (`src/actions/defs/panes_rest.ts:179-184`) never attach `.catch` — on the Ask→confirm path
   nobody awaits them, and `term.stop()` rejects in practice (that's why QW4 exists in
   `src/gating/index.ts:473-484`). One rejected deferred confirm = uncaught rejection = process
   death (modulo the global net, which then leaves unknown state — see A4).
2. **Unguarded SQLite on a timer.** `sweepExpiredApprovals` (`src/gating/index.ts:672-723`) and
   `PendingApprovalStore.expired()` (`src/pendingApprovals.ts:801-820`) hit better-sqlite3 with no
   try/catch inside a bare `setInterval`. A transient SQLITE_BUSY/disk-full on a tick is an
   uncaughtException with nothing in flight.
3. **`server.listen` has no error handler** (`server.ts:1339-1348`): on EADDRINUSE the `'error'`
   event is swallowed by the global net, the await never settles, and the process sits alive but
   not listening, logging "recovered".
4. The global `uncaughtException`/`unhandledRejection` net (`server.ts:362-377`) recovers
   *unconditionally forever*, converting unknown-state crashes into silent corrupt-state
   continuation; it currently masks (3) entirely. Escalate after N hits per window.

### A4. Persistence: corrupt DB ⇒ silent empty world; stranded writes  — CRITICAL (data loss)
- On any store-init failure the server silently falls back to legacy JSON (`server.ts:300-340`) —
  but the one-shot migration already renamed `.janus_ledger.json` → `.bak`
  (`src/store/migrate.ts:101-103`), so the fallback boots **empty**: all projects/panes/notes/gate
  overrides appear gone. Writes made in that state land in a fresh JSON file that the migration
  will never re-import (`LEDGER_MIGRATED_KEY` check, `migrate.ts:24-30`).
- Related: a momentarily locked/corrupt legacy file during migration is swallowed
  (`migrate.ts:90`), archived, and marked done — workspace history silently never arrives.
- Fix: quarantine a bad DB (rename + recreate) or refuse to boot; throw on unparseable legacy
  ledger; set the migration marker inside the import transaction.

### A5. Event-loop blocking on the hot path  — HIGH
- **Per-chunk history rewrite**: `appendOutputToLastCommand` (`server.ts:283-291`, called from
  `src/observe/index.ts:494`) synchronously reads, JSON-parses, pretty-stringifies, and rewrites
  the entire multi-pane `.janus_history.json` on **every PTY data event**. A chatty pane turns this
  into continuous O(file-size) blocking I/O on the one loop serving voice WS audio, all panes, and
  HTTP. Non-atomic write, too (crash ⇒ history loss).
- **Sync probes**: `execSync` process-tree probes (`src/statusProbe.ts:349,370-374`) run on a
  500ms `setInterval` per shell pane — on Windows (the production host) a cold
  `powershell Get-CimInstance` tick is 0.5–2s of blocked loop, near-continuously.
- **N+1 broadcast storm**: `manager.ledger.workspaces` (`server.ts:629-634` →
  `src/store/sqliteStore.ts:747-780`) is getProject × getPanes × getNotes, all synchronous, on
  every `broadcastLedgerUpdate` (40+ call sites).
- **Write amplification**: every `listPanes()` → `syncLedger()` → `savePane()` emits a bogus
  `pane_created` audit event + FTS insert (`sqliteStore.ts:390-411`) — and `listPanes` runs on
  every voice turn. Combined with retention running **only at boot** (`server.ts:303-308`), an
  always-on server grows the DB unboundedly, then pays one giant blocking prune at next startup.

---

## B. Safety-surface findings (gate matrix / approvals)

- **Partial settings PUT fails open** — `updateSettings` shallow-merges `advanced`
  (`src/terminal.ts:1308`), so a PUT carrying a partial `capabilityGates` map replaces the whole
  matrix; every capability missing from the PUT resolves to the permissive `"Auto"` fallback
  (`src/pendingApprovals.ts:207-216`) until restart. `PUT /api/settings` is also entirely
  unvalidated (`server.ts:1051-1072`), including `globalPermissionsMode`. Deep-merge over
  `DEFAULT_CAPABILITY_GATES` + zod-validate the route.
- **ALWAYS_ALLOWED mutators bypass the matrix AND the STOP-ALL freeze** — `clear_history`,
  `clear_exited`, `restore_archived_pane`, `delete_archived_pane`, `update_project`, `stop_pane`
  never call `gateOrDefer`, and the frozen short-circuit lives inside the gate resolver
  (`src/gating/index.ts:257`). While "Janus literally cannot act anywhere", all of these still
  execute via REST. Keep the brake trio exempt; give the rest real capability rows or an
  `isFrozen()` check.
- **Archive→restore silently drops per-pane `capability_gates`** (plus draft/contexts):
  `archivePane`/`restorePane` INSERTs list only v1 columns; better-sqlite3 silently ignores the
  extra named params (`src/store/sqliteStore.ts:427-456`). This is the exact data-loss path
  migration v4 was written to close. An operator's `Off` override silently reverts on restore.
- **Escape bulk-rejects the whole HiTL queue** — every stacked `ApprovalDialog`/
  `ActionConfirmDialog` registers its own window-level Escape handler
  (`src/components/ApprovalDialog.tsx:56-66`; rendered all-at-once at
  `src/orbital/OrbitalApp.tsx:278-293`). One keypress = N reject/cancel POSTs.
- **Deferred mode-changes don't survive restart** — `applyPaneMode` stages its Ask intent without
  the version stamp (`src/applyPaneMode.ts:207-213`), so boot hydration quarantines it silently
  (`src/gating/index.ts:187-200`); the operator's pending confirm simply vanishes.
- Leaks: claimed `pending_approvals` rows are never pruned (the v5 fix covered only
  `pending_actions`, `src/store/retention.ts:35`); `action_log` has no retention at all.

## C. Voice/session findings

- **Stale-connect overwrite** — `connectLiveSession` assigns `state.session` *before* the
  generation guard (`src/voice/index.ts:734,1056-1062`); an overlapping slow connect resolving
  last wires the mic to a session it immediately closes. The closed session's `handleSessionLost`
  (`voice/index.ts:580-585`) has no generation guard: it detaches the *live* session's staged
  approvals and schedules a reconnect that hoists a third session over the healthy second one
  without closing it (token-burning leak). Fix: hold the new handle in a local until the guard
  passes; bail out of `handleSessionLost` on generation mismatch.
- **No WS heartbeat anywhere** (server or client): half-open sockets buffer broadcasts unboundedly,
  pin `activePaneId`/"operator connected" gating to a ghost, and keep a paid Gemini Live session
  alive. Standard ping/pong + `terminate()` fixes all three via the existing close cleanup.
- Missing `ws.on("error")` on both accepted-socket paths (`src/voice/index.ts:332,1251`) — routine
  ECONNRESETs are handled only by the last-resort global net.

## D. Client (orbital kitchen — the new default) findings

- **No error boundary + `Suspense fallback={null}`** around the lazy default app
  (`src/main.tsx:10,18-27`). A post-deploy chunk 404 or any render throw = permanent white page.
  The classic app wrapped itself in an ErrorBoundary; the FLIP shipped the new default without one.
- **No resync on WS reconnect** (`src/orbital/useOrbitalData.ts:346-355`), and the safety-net poll
  omits `refetchFrozen`/`refetchSettings` — a STOP-ALL (or its release) missed while disconnected
  is wrong on the board indefinitely. `refetchAll()` already exists; call it in `onopen`.
- **Terminal output silently lost** across socket gaps / radio toggles (the WS effect tears down on
  `voiceLive` change, `useOrbitalData.ts:292,484-490`) and on burner open (stale snapshot backfill,
  `src/components/TerminalView.tsx:75,88-90`; `publishChunk` drops unsubscribed chunks,
  `src/terminalStream.ts:18-21`). The terminal operators approve work from can have invisible holes.
- **`pane_status` → full `/api/terminals` refetch with no stale-response guard**
  (`useOrbitalData.ts:365-369`) — fetch storm + out-of-order overwrite (status flapping). The
  classic app deliberately patched in place (`App.tsx:1177-1185`); the kitchen regressed it.
- Unauthorized close code 4001 is ignored → endless reconnect/toast loop after a server restart
  rotates the auth token (`useOrbitalData.ts:299-306` vs `src/voice/index.ts:304-310`).
- `?mock=1` against a real deployed server can PUT the entire mock settings fixture over live
  config (`useOrbitalData.ts:252-254,538-551`).
- Optimistic approve toasts "Order up!" before the POST and never checks `res.ok`
  (`useOrbitalData.ts:693-701`) — the one action the code itself says "must never be silent" can be
  *wrongly affirmative* out loud.

## E. The view itself is broken: test/CI/docs gaps

This is the direct answer to "is there anything missing from your view":

1. **The full unit suite fails in a clean Linux container** (this remote env): 18 tests cancelled
   across `test_action_timeout.ts`, `test_async_pane_spawn.ts`, `test_memory_python_client.ts`,
   `test_server.ts` — all with `'Promise resolution is still pending but the event loop has already
   resolved'`, deterministic in isolation (not the known Windows ConPTY teardown flake that
   `scripts/run-unit.mjs` retries for). Root cause: the codebase's "force-exit hygiene" pattern —
   watchdog/deferred-start/kill-fallback timers are all `unref()`'d (`src/actions/gemini.ts:268`,
   `src/terminal.ts:903,933,1112,1443`) — means core async machinery only runs if *something else*
   keeps the loop alive. The HTTP server provides that in prod; bare tests/scripts don't. This is
   also a latent prod hazard during shutdown/drain sequences.
2. **CI never runs the full suite** — `.github/workflows/linux-verify.yml` runs only the memory-seam
   subset. The complete battery runs only on the author's Windows box via `predev`. Every finding
   in this report shipped under green checks.
3. **Fixtures replicate production bugs** — the restart-wedge guard (A1) is copied verbatim into at
   least four test fixtures, making the bug structurally untestable.
4. **Stale docs that misdescribe blast radius** — `src/store/README.md` says the store is
   "INERT — not wired into the app" while it is the **default backend**; `DEBUG_NOTES.md` is a
   scratchpad from a different branch; CLAUDE.md says `server.ts` is ~3,200 lines (it's 1,372).
5. Typecheck and build pass clean on Linux (verified); the gates that *do* run are green — which is
   exactly why the failing ones are invisible.

## Cross-cutting themes

1. **No generation/identity tokens** — same bug class in three layers: PTY transports (A2), voice
   sessions (C), client fetches (D). One pattern fixes ~6 findings.
2. **Fire-and-forget async without `.catch`** — restart/mode-change effects, timer sweeps.
3. **Synchronous I/O on the single serving loop** — history file, probes, N+1 SQLite, boot prune.
4. **Fail-open asymmetries on the safety surface** — partial-PUT gate merge, freeze bypass,
   archive/restore gate drop, missing-entry `"Auto"` fallback.
5. **`unref()`-everything force-exit hygiene** — correct goal, but it silently disables watchdogs
   whenever the loop is otherwise idle, and it's why the test suite can't see half of this.

## Suggested priority order

| # | Fix | Findings closed |
|---|-----|-----------------|
| 1 | Transport generation token + unconditional `Running` reset in `start()` + SIGKILL re-entry + restart mutex | A1, A2 (restart wedge, stale teardown, zombies, double-spawn) |
| 2 | `.catch` on deferred effects; try/catch the sweep; `server.listen` error handler; escalating error net | A3 (all process-death vectors) |
| 3 | Quarantine bad DB instead of silent legacy fallback; marker inside txn | A4 (data loss) |
| 4 | Debounced async history writes; async probes; cached/JOINed broadcast projection; `pane_created` only on real insert; periodic retention sweep | A5 (loop blocking, DB growth) |
| 5 | ErrorBoundary + visible Suspense fallback around OrbitalApp; `refetchAll()` on `ws.onopen`; topmost-only Escape | D1, D2, B-Escape |
| 6 | Deep-merge `capabilityGates` in `updateSettings` + zod on `PUT /api/settings`; freeze-check the non-brake ALWAYS_ALLOWED mutators; add v4 columns to archive/restore INSERTs | B (safety surface) |
| 7 | Generation guards in voice connect/`handleSessionLost`; WS heartbeat both sides; `ws.on("error")` | C |
| 8 | Make the full unit suite pass on Linux (ref the watchdog while a wedged action is pending, or keep a ref'd handle during tests); run `npm run lint && npm test` in CI; fix fixtures | E |

## What held up well

Not everything is fragile — several deliberate mechanisms were checked and are sound: the single
resolve choke-point with atomic claim (`resolveDecision`) closes REST+voice double-dispatch races;
`decideProposal` composes gate AND mode most-restrictive-first; the frozen short-circuit is applied
at exactly one point; `loadSettings` deep-merges gate defaults so a corrupt settings *file* fails
closed; the voice reconnect machinery is bounded, flap-resistant, and self-healing on poisoned
resume handles; `PaneSignalBus` isolates throwing observers; xterm disposal in `TerminalView` is
correct; scrollback/backfill/output buffers are all capped; and the store's test discipline
(`:memory:`, pinned `JANUS_DB`) prevents cross-test DB pollution.
