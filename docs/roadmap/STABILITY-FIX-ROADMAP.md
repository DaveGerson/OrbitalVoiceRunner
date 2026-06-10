# Stability Fix Roadmap — from the 2026-06-09 Core Audit

> Source: [`docs/review/2026-06-09-core-stability-audit.md`](../review/2026-06-09-core-stability-audit.md).
> Ordering principle: **risk retired per hour of work**, then dependency order (the generation-token
> wave unblocks correct behavior that later waves build on). Every item names the code change, how
> to verify it, and what the operator actually feels change.
>
> Effort scale: S = under an hour, M = half-day, L = 1–3 days.

---

## Wave 0 — Quick wins (one sitting; all S; no architectural risk)

These are single-file, low-blast-radius fixes. Each one retires a way the app can die, lie, or
lose data **today**.

### 0.1 Un-wedge pane restart  — CRITICAL
- **Change:** `src/terminal.ts:856` — replace `if (this.status !== "Exited") { this.status = "Running" }`
  with an unconditional reset (the degraded-spawn catch at :810 returns before this line, so the
  guard protects nothing). Update the four test fixtures that copied the buggy guard
  (`tests/test_output_guard.ts:36`, `test_stop_all_two_stage.ts:44`, `test_voice_tools.ts:54`,
  `test_voice_tool_goldens.ts:101`).
- **Verify:** new unit test — same-instance `stop()` → `start()` → assert status returns to
  `Running` and `applyStatusEvent` processes events again.
- **Operator experience:** today, every pane restart (UI button, voice "restart pane", or a
  permissions promotion that restarts the pane) leaves a pane that *looks dead forever* — no idle
  chime, no "done" narration, wrong board status — while the agent is actually running. After the
  fix, a restarted pane simply comes back: status flips to Running, voice announcements resume.

### 0.2 Stop the server-killers  — CRITICAL
- **Change (three small patches):**
  - `.catch(e => log + broadcast failure)` on the fire-and-forget effects at
    `src/applyPaneMode.ts:201-204` and `src/actions/defs/panes_rest.ts:179-184`
    (mirror `src/actionEffects.ts:258-260`, which already does this right).
  - Wrap the body of `sweepExpiredApprovals` (`src/gating/index.ts:672`) in try/catch — it is the
    only unguarded path into better-sqlite3 and it runs on a bare 30s `setInterval`.
  - `server.once("error", reject)` inside the listen promise (`server.ts:1339-1348`) + non-zero
    exit at the entrypoint.
- **Verify:** unit test that a rejecting `term.stop()` on the confirm path resolves to a logged
  failure, not an unhandled rejection; boot test against an occupied port asserts a clean error.
- **Operator experience:** three invisible roulette wheels stop spinning. Confirming a permission
  change or restart can no longer take down the whole server mid-shift; a transient SQLite hiccup
  on a timer tick no longer kills the process with nothing in flight; and starting the server on a
  busy port says "port 3000 in use" instead of sitting alive-but-deaf while logging "recovered".

### 0.3 Error boundary around the kitchen  — CRITICAL (UX)
- **Change:** `src/main.tsx:18-27` — wrap `<OrbitalApp />` in an error boundary whose fallback
  offers reload + a link to `?ui=classic`; give `Suspense` a visible loading fallback instead of
  `null`.
- **Verify:** e2e — force the lazy chunk to 404 and assert the fallback renders.
- **Operator experience:** today one stale cached chunk after a redeploy, or one render-time throw
  anywhere in the kitchen, is a **permanent white page**. After: a branded "kitchen's closed,
  reload / use classic" card. This is the single highest-leverage UX fix in the list.

### 0.4 Resync state on reconnect  — HIGH
- **Change:** `src/orbital/useOrbitalData.ts:346-355` — call the existing `refetchAll()` inside
  `ws.onopen` (it already includes `refetchFrozen` and `refetchSettings`, which the 20s poll
  deliberately omits).
- **Verify:** e2e — kill/restore the socket while toggling STOP-ALL server-side; assert the banner
  reconciles on reconnect.
- **Operator experience:** after a laptop sleep or server restart, the board currently shows
  "Kitchen open · N on the burner" while everything is actually frozen (or keeps showing the
  frozen banner after a missed release) — indefinitely. After: within one reconnect the board
  tells the truth. For a safety UI, this is trust-critical.

### 0.5 Escape only dismisses the top dialog  — HIGH
- **Change:** `src/orbital/OrbitalApp.tsx:278-293` renders every pending approval/action dialog
  simultaneously, and each registers its own window-level Escape handler
  (`src/components/ApprovalDialog.tsx:56-66`, `ActionConfirmDialog.tsx:63-72`). Render one dialog
  at a time (or pass `isTop` and gate the listener).
- **Verify:** unit/e2e — stage 3 approvals, press Escape once, assert exactly one reject POST.
- **Operator experience:** today one Escape press silently rejects the *entire* queue of staged
  agent work — five dialogs, five reject POSTs, one keystroke. After: Escape dismisses the dialog
  you're looking at, nothing else.

### 0.6 Settings save can't open the safety gates  — HIGH
- **Change:** `src/terminal.ts:1308` — deep-merge `advanced.capabilityGates` over
  `DEFAULT_CAPABILITY_GATES` in `updateSettings`, exactly as `loadSettings` (:1264-1267) already
  does; add `clear_history: "Ask"` to the default map in `src/types.ts`.
- **Verify:** unit test — PUT a partial gates map; assert unmentioned capabilities still resolve
  to their defaults, not `"Auto"`.
- **Operator experience:** invisible until it bites — today any partial settings save silently
  flips every unmentioned capability (including `delete_project`) to auto-approve until the next
  restart. After: tightened gates stay tightened. No visible change, which is the point.

### 0.7 Archived panes keep their safety overrides  — MEDIUM
- **Change:** `src/store/sqliteStore.ts:427-433` and `:447-456` — add `capability_gates`, `draft`,
  `model_context`, `human_context` to both the archive and restore INSERT column lists (the v4
  schema columns exist; better-sqlite3 silently ignores the extra named params today).
- **Verify:** unit round-trip — set a pane gate to `Off`, archive, restore, assert the override
  survived.
- **Operator experience:** restoring a pane from the archive currently *silently reverts* its
  per-pane safety overrides (an `Off` becomes the global default) and loses its draft. After:
  what you archived is what you get back.

### 0.8 Honest approval feedback  — MEDIUM
- **Change:** `src/orbital/useOrbitalData.ts:693-701` (and :712-720) — toast "Order up!" and play
  the earcon only after `res.ok`; on failure restore the chip and toast a warning.
- **Verify:** e2e with an intercepted 500 on `/api/commands/approve`.
- **Operator experience:** today an eyes-off operator can *hear a success confirmation for a
  command that never ran* (the chip silently reappears 20 seconds later with no explanation).
  After: success sounds mean success; failures say so immediately.

### 0.9 Two-line hygiene patches  — MEDIUM
- `clientWs.on("error", …)` on both accepted-socket paths (`src/voice/index.ts:332`, `:1251`) and
  `wss.on("error", …)` — routine ECONNRESETs stop routing through the last-resort
  uncaughtException net.
- Fix stale docs that misdescribe blast radius: `src/store/README.md` ("INERT — not wired" → it is
  the **default backend**), CLAUDE.md server.ts size note. Zero user-visible change; large
  agent/developer-trust change.

**Wave 0 exit criteria:** `npm run lint && npm test` green on Windows; new regression tests for
0.1/0.2/0.6/0.7 in the suite; one manual kitchen smoke (restart a pane, approve a command, Escape
with a stacked queue, sleep/wake the laptop).

---

## Wave 1 — Generation tokens (the structural fix; L, ~2–3 days)

One missing concept — "is this callback from the *current* incarnation?" — causes the worst bug
cluster in three different layers. Fix it as one deliberate pattern, three applications.

### 1.1 PTY transport generation  — HIGH
- **Change:** `src/terminal.ts` — stamp each `start()` with `this.transportGen++`; every
  `transport.onData`/`onExit` callback and every timer first checks
  `if (this.transport !== transport) return`. `start()` refuses (or stops) an existing live
  transport. Add a `_restarting` promise latch so overlapping restarts serialize. In
  `src/ptyTransport.ts:160-163`, allow `kill("SIGKILL")` re-entry through the `_killed` latch so
  the 1s SIGTERM→SIGKILL escalation (`terminal.ts:1104`) actually fires. Clear `pendingInput` on
  self-exit so queued commands aren't replayed into a brand-new process.
- **Verify:** the stub-transport tests in `tests/test_async_pane_spawn.ts` extend naturally: old
  transport emits exit after restart → assert new pane unaffected; double-restart → assert exactly
  one live transport; SIGTERM-ignoring fake → assert SIGKILL delivered.
- **Operator experience:** restarts become boring. Today a stubborn agent process can survive as a
  zombie burning CPU while the UI says the pane is gone; an old process dying late can kill the
  *new* pane's status tracking; a double-clicked Restart can leave **two agents typing into one
  pane**, interleaved. After: one pane, one process, always.

### 1.2 Voice session generation  — HIGH
- **Change:** `src/voice/index.ts` — in `connectLiveSession` (:734, :1056-1062), hold the freshly
  connected handle in a local and assign `state.session` only *after* the generation guard passes;
  add `if (myGeneration !== state.connectGeneration) return` at the top of `handleSessionLost`
  (:580-585) so a stale session's death can't detach the live session's staged approvals or
  schedule a redundant reconnect that leaks a duplicate (token-billing) Gemini session.
- **Verify:** unit test with a delayed fake connector — slow stale connect resolves last; assert
  mic routing targets the healthy session and exactly one live session exists.
- **Operator experience:** eliminates the worst voice failure: the mic going *silently dead* while
  everything looks connected, plus phantom "voice channel lost" announcements, plus invisible
  duplicate Gemini sessions quietly consuming quota.

### 1.3 Client fetch sequencing  — MEDIUM
- **Change:** `src/orbital/useOrbitalData.ts:365-369` — patch `pane_status`/`pane_quiescing` into
  state in place (the classic app already does this at `App.tsx:1177-1185`, with a comment
  explaining why; the kitchen regressed it), and add a monotonic token to `refetchTerminals` so a
  stale response can never overwrite a fresher one.
- **Verify:** e2e — rapid status edges on two panes; assert no Running→Idle→Running flap.
- **Operator experience:** station cards stop flickering between states under load, and the
  browser stops re-downloading every pane's full scrollback on every status edge — a visibly
  calmer, faster board.

---

## Wave 2 — Event-loop & persistence health (L, ~3–4 days)

These are the "why does it get slow/laggy/janky over time" fixes. None change features; all change
how the app *feels* under real load.

### 2.1 Stop blocking the loop on every output chunk  — HIGH
- **Change:** `server.ts:283-291` — keep command history in memory and flush asynchronously,
  debounced (~500ms), with atomic write (tmp + rename); never read-modify-write the whole
  `.janus_history.json` per PTY data event.
- **Operator experience:** today a single chatty pane (a build, a test watcher) makes *the voice
  assistant stutter* and every other pane's output lag, because each output chunk synchronously
  rewrites a JSON file on the one serving thread. After: heavy output in one pane is invisible
  everywhere else. This is the biggest perceived-performance win in the roadmap.

### 2.2 Async status probes  — HIGH (Windows-dominant)
- **Change:** `src/statusProbe.ts:349, 370-374` — replace `execSync` with async spawn + callback;
  skip a tick while one is in flight.
- **Operator experience:** on the Windows production host, one open shell pane currently blocks
  the loop up to ~2s *twice a second* (cold PowerShell CIM query). After: idle/busy detection
  costs nothing you can feel. Voice latency stops mysteriously spiking when a shell pane is open.

### 2.3 Stop the database flooding itself  — HIGH
- **Change:** `src/store/sqliteStore.ts:390-411` — emit `pane_created` only on actual first insert
  (check `changes`); add a periodic, batched retention sweep (unref'd interval, `LIMIT 1000`
  loops) instead of boot-only (`server.ts:303-308`); prune claimed `pending_approvals` and add an
  `action_log` TTL in `src/store/retention.ts`.
- **Operator experience:** prevents the slow-rot failure mode: an always-on server whose DB grows
  for weeks (every voice turn currently writes bogus "pane created" audit rows), then stalls for
  ages on the next boot while one giant delete runs. After: restarts stay fast forever, and the
  activity feed shows real events instead of creation spam.

### 2.4 Broadcast projection in one query  — MEDIUM
- **Change:** `src/store/sqliteStore.ts:747-780` — build the `workspaces` payload with JOINs (or
  cache + invalidate on write) instead of getProject × getPanes × getNotes per broadcast
  (`server.ts:629`, 40+ call sites).
- **Operator experience:** every note/pane/handoff mutation currently triggers a synchronous query
  storm in the audio-serving loop. After: adding a note doesn't compete with your conversation.

### 2.5 Corruption gets loud, not silent  — CRITICAL (data safety)
- **Change:** `server.ts:300-340` — on store-init failure, quarantine the bad DB (rename
  `.janus.db` → timestamped `.corrupt`, recreate) or refuse to boot with a clear message; never
  silently fall back to the already-migrated-away legacy JSON. In `src/store/migrate.ts`: throw on
  an unparseable legacy ledger (:90) and set `LEDGER_MIGRATED_KEY` *inside* the import transaction
  (:27-28).
- **Operator experience:** today a corrupt DB makes the app boot looking **empty** — every
  project, pane, and note apparently gone — and anything you save in that state is stranded
  forever even after repair. After: you get an unmissable error naming the quarantined file, and
  nothing you do digs the hole deeper. Nobody should discover corruption by *absence*.

---

## Wave 3 — Safety-surface & session hardening (M–L, ~2–3 days)

### 3.1 The freeze means frozen  — MEDIUM
- **Change:** give the non-brake `ALWAYS_ALLOWED` REST mutators (`clear_history`, `clear_exited`,
  `restore_archived_pane`, `delete_archived_pane`, `update_project`, `stop_pane` — in
  `src/actions/defs/panes_rest.ts`, `archive.ts`, `lifecycle_rest.ts`) real capability rows or at
  minimum an `isFrozen()` check. Keep the brake trio (stop-all/release) exempt — de-escalation
  must never be blockable.
- **Operator experience:** when you slam the emergency stop, *everything* stops. Today the freeze
  banner says "Janus literally cannot act anywhere" while REST can still clear history, delete
  archived panes, and rewrite project metadata.

### 3.2 Validate the settings door  — MEDIUM
- **Change:** zod-validate `PUT /api/settings` (`server.ts:1051-1072`) like the registry routes —
  whitelist `globalPermissionsMode` enum values, gate names, and shapes.
- **Operator experience:** a typo'd or malformed settings write can no longer put the gate matrix
  into an unknown mode *and persist it across restarts*.

### 3.3 Deferred confirms survive restarts  — MEDIUM
- **Change:** spread `ctx.versionStamp` into `applyPaneMode`'s gate params
  (`src/applyPaneMode.ts:207-213`, mirroring `locks.ts:144`) and add an `applyPaneMode`-aware
  rebuild case so boot hydration replays it with live-signal mechanics instead of silently
  quarantining it (`src/gating/index.ts:187-200`).
- **Operator experience:** a pending "promote this pane to Full-Auto?" no longer silently
  *vanishes* if the server restarts before you answer.

### 3.4 Heartbeats and honest disconnects  — MEDIUM
- **Change:** standard ws ping/pong with `terminate()` on missed pong (server side; the existing
  `close` cleanup already does the right thing once it fires); client treats close code 4001 as
  terminal → one reload instead of an endless retry/toast loop
  (`src/orbital/useOrbitalData.ts:299-306` vs `src/voice/index.ts:304-310`).
- **Operator experience:** ghost clients stop pinning "operator connected" state (which today
  keeps approval last-calls *waiting for a listener who left*, and keeps a paid Gemini session
  alive for nobody); after a server restart the UI reloads once cleanly instead of flashing
  "Radio hiccup" toasts forever.

### 3.5 The terminal never lies  — MEDIUM
- **Change:** on observe-socket (re)open and on burner mount, refetch the pane's backfill and
  `term.reset()` + rewrite before resubscribing (`src/components/TerminalView.tsx:75,88-90`,
  `src/terminalStream.ts:18-21`); stop tearing the socket down on `voiceLive` toggles
  (`useOrbitalData.ts:292,484-490`); gate mock-mode mutations (`saveSettings` under `?mock=1`) on
  an explicit e2e flag so a dev opening prod with `?mock=1` can't PUT fixture settings over live
  config.
- **Operator experience:** the terminal you approve work from currently can have *silent holes* —
  output missing between snapshot and subscribe, or dropped whenever you tune the Kitchen Radio.
  After: what's on screen is what happened. For an approval surface, this is non-negotiable.

---

## Wave 4 — Make the view trustworthy (M, ~1–2 days)

The audit's meta-finding: every bug above shipped under green checks.

- **4.1 Fix the 18 Linux-cancelled tests.** Root cause is the `unref()`-everything "force-exit
  hygiene" pattern (`src/actions/gemini.ts:268`, `src/terminal.ts:903,933,1112,1443`): watchdogs
  only fire if something *else* keeps the loop alive. Smallest correct fix: `ref()` the deadline
  timer while a non-ALWAYS_ALLOWED action is actually in flight (a pending action *should* hold
  the loop), and have tests that drive deferred spawns hold a ref'd handle. This is also a latent
  prod hazard during shutdown/drain.
- **4.2 Run the real gates in CI.** Extend `.github/workflows/linux-verify.yml` (or add a job) to
  run `npm run lint && npm test` on every PR — today the full battery exists only on one Windows
  machine, which is how all of this stayed invisible.
- **4.3 Fixture hygiene.** Done partly in 0.1; sweep remaining fixtures for copied production
  logic and extract a shared test helper so a future guard bug can't replicate into the suite.
- **Operator experience:** none directly — this wave is what makes every *future* wave land
  without regressing, and turns "green checks" back into information.

---

## Sequencing at a glance

| Wave | Effort | Risk retired | Headline UX change |
|------|--------|--------------|--------------------|
| 0 | ~1 day total | Process death, data loss, safety fail-open, white page | Restarts work; no white page; board tells the truth after sleep; Escape is safe; success sounds are honest |
| 1 | 2–3 days | The generation-token bug class (3 layers) | Boring restarts; mic never silently dead; no status flapping |
| 2 | 3–4 days | Event-loop blocking, unbounded DB growth, silent corruption | Voice stays smooth under heavy output; app doesn't rot over weeks; corruption is loud |
| 3 | 2–3 days | Freeze bypass, settings injection, lost confirms, ghost clients, terminal holes | STOP-ALL stops all; terminals never lie; reconnects are clean |
| 4 | 1–2 days | Blind quality gates | Future changes can't silently regress any of the above |

Dependencies: 0 has none and every item is independently shippable. 1.1 should land before
deep-testing 0.1 edge cases (they touch the same file; do 0.1 first, it's three lines). 2.3's
periodic sweep assumes 2.5's quarantine semantics for the failure path. 4.2 should land
immediately after 4.1 (CI on a failing suite helps nobody).
