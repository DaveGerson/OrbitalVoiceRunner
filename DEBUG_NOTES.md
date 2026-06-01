# DEBUG NOTES — Janus Voice Runner (feat/local-testing)

> Session scratchpad. Canonical bug status: `docs/review/BUG_LOG.md`. Plan: `docs/review/IMPLEMENTATION_PLAN.md`.
> Branch: `feat/local-testing` (off `origin/claude/orbital-journey-review-chunked`). Updated 2026-05-30.

## North Star
Working live voice loop (Janus ↔ Gemini Live) locally + clean handoffs. Currently: stabilizing
the terminal/pane lifecycle so a Claude session can actually start without runaway spawning.

## Branch / safety
- On `feat/local-testing`, off chunked (= main `80bec8b` + WS-A…E + docs). Upstream unset.
- Pre-rebase WIP preserved: stash `WIP-backup-before-chunked-rebase` + tag `wip-backup-chunked-rebase`.
- Latest commits: `6c27478` (runaway fix batch), `b502067` (boot launch fix).

## Process-safety rule (IMPORTANT)
- NEVER blanket-kill `claude.exe` — it kills the operator's own Claude Code session.
- To stop the dev server: kill the node `*server.ts*` process TREE (`taskkill /T`), which takes
  its pane children with it. Baseline `claude.exe` count with no panes running = 2 (the CC session).

## DONE this session (committed)
- ✅ **Runaway pane spawn (THE big one)** — boot-restore was auto-spawning every persisted pane;
  now INERT (loads as not-alive metadata; operator starts via POST /api/terminals/:id/restart).
- ✅ **`--resume` bug (P0, BUG-032 A/B/C)** — only resume on a real UUID, `--resume <id>` syntax;
  unified launch cmds to bare `claude`/`codex`/`antigravity` everywhere (constructor, defaults,
  parsePresetsSafe, boot-restore, /restart). No more `npx`/`--session`/`--resume=` junk.
- ✅ **Clear-exited → recoverable ARCHIVE** — ledger ArchivedPane model + endpoints
  (clear-exited / archive / restore / delete) + App.tsx "Clear Exited" button & Archive panel.
- ✅ **Session-resumption log spam (bug E)** — log only on handle change (was 59x/session).
- ✅ **Test-fixture scrollback pollution (bug I)** — test cleanup hooks added.
- ✅ **SQLite scaffold (INERT) + WS-M plan** — `src/store/sqliteStore.ts` + README; schema is a
  DRAFT pending COLLABORATIVE design with maintainer. Nothing wired. better-sqlite3 not installed.
- tsc --noEmit passes. Verified clean inert boot: server up, no transition spam, zero panes spawned.

## OPEN / NEXT
- ⬜ **WS-M SQLite schema — design WITH maintainer** before any build. Top 3 open Qs from scaffold:
  (1) notes as JSON blob vs normalized table? (2) scrollback in DB BLOB vs path ref? (3) archive TTL?
- ⬜ **Verify a pane actually starts** — next live test: click a pane's restart/start, confirm ONE
  `claude` launches, runs, and is controllable (this is now the core unproven path).
- ⬜ **node-pty not installed** → legacy `cmd.exe` transport = visible console windows + unvalidated
  status probe. Installing node-pty would make panes headless + fix status detection. (Decide.)
- ⬜ **WS-F voice round-trip** — AudioContext.resume() + surface mic-permission + transcription.
- ⬜ **Double-spawn (bug D)** — likely scrollback accumulating across boots, not 2 live procs;
  re-confirm now that boot is inert. Low priority.
- ⬜ **WS-H handoffs** (task #4) — deferred.

## NEXT SESSION (copy/paste)
> "On feat/local-testing. Read DEBUG_NOTES.md. Runaway spawn + --resume + archive are fixed &
>  committed (6c27478). Next: live-test that ONE pane starts cleanly via restart, then design the
>  WS-M SQLite schema together (notes/scrollback/archive-TTL open questions). Consider node-pty."
