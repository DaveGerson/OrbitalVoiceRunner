# DEBUG NOTES — Janus Voice Runner (feat/local-testing)

> Session scratchpad. **Canonical bug status lives in `BUG_LOG.md`**; the sequenced
> plan lives in `REMEDIATION_PLAN.md`. This file = what *this local-testing session*
> did and decided, so we never lose context.
> Branch: `feat/local-testing` (off `origin/claude/orbital-journey-review-chunked`). 2026-05-30.

---

## North Star
Working live voice loop (Janus ↔ Gemini Live) locally + clean handoffs/drops between
Janus and the terminal panes.

## Branch / safety
- On `feat/local-testing`, based on chunked (= main `80bec8b` + WS-A…WS-E + docs). Upstream unset.
- **All pre-rebase WIP preserved:** stash `WIP-backup-before-chunked-rebase` + durable tag
  **`wip-backup-chunked-rebase`**. Restore a file: `git checkout wip-backup-chunked-rebase -- <path>`.
- The 100+ junk `.janus_scrollback_*` files + `dev-server.log` were swept into that stash (clean tree now).

## What the chunked branch ALREADY fixed (verified against BUG_LOG.md + code)
- ✅ **B01 boot respawn loop** — WS-A: restored panes are inert metadata (`registerInertPane`,
  server.ts:688), no boot auto-spawn. *This was the source of the 12k-line log spam.*
- ✅ **B02 untrue status** — WS-C `statusMachine.ts` / `statusProbe.ts`.
- ✅ **B03 secrets→model** — WS-B `redactSecrets()`.
- ✅ **B06 earcons/notifications** — WS-D `eventBus`/`announcementBus`/`notificationStack`.
- 🟡 **B07 approvals** — WS-E least-authority spoken approvals (`approvalIntent.ts`).

## STILL OPEN (our targets)
- 🟡 **B04 / WS-G wrong Claude launch cmd** — restore used `npx @anthropic-ai/claude`.
  **DONE this session:** changed to bare `claude` (server.ts ~695). Full WS-G (detect binary
  before spawn, validate, actionable error) still pending. NOTE: default preset in
  `terminal.ts`/settings may still carry `npx @anthropic-ai/claude` — verify for NEW panes.
- ⬜ **B05 / WS-F voice round-trip silent** — `audio.ts` unchanged (no `AudioContext.resume()`);
  mic-permission error swallowed; no transcription. Needs a live diagnostic run.
- ⬜ **B08 voice start undiscoverable** — button buried mid-page.
- ⬜ **B09 no transcription** — enable input/outputAudioTranscription for on-screen text.
- ⬜ **B10 / WS-H handoffs ad-hoc** — DESIGN NEEDED (the user's "big thing"). See JOURNEY_AUDIT §Handoffs.

## Done this session
- [x] Branch + backup safety (tag `wip-backup-chunked-rebase`).
- [x] `logs/` dir + `.gitignore` `logs/` (junk already covered by `*.log`).
- [x] B04 quick win: restored Claude panes launch `claude`, not `npx`.
- [ ] B05 [DIAG] instrumentation (decided KEEP) — re-derive on chunked server.ts
      (audio-out ~1477, audio-in ~2215) + add `resume()` in audio.ts/App.tsx. Needs live test.
- [ ] WS-H handoff design.

## NEXT SESSION (copy/paste)
> "On feat/local-testing. Read DEBUG_NOTES.md + BUG_LOG.md. Open items: WS-F (voice round-trip:
>  AudioContext.resume + mic-perm surfacing + transcription), WS-G (binary-detect launch),
>  WS-H (handoff protocol design). Start with WS-F live diagnostic."
