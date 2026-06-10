# UI/UX Gap Audit — 2026-06-10 (Orbital Kitchen + Voice/Eyes-Off)

> Companion to the stability audit (`2026-06-09-core-stability-audit.md`) and fix roadmap
> (`../roadmap/STABILITY-FIX-ROADMAP.md`). This report covers **experience gaps** — places the
> operator is misled, uninformed, blocked, or missing parity — not crash/stability bugs (those are
> filed). Method: two parallel reviews (kitchen UI vs its UX_BRIEF/BLUEPRINT + classic-app parity;
> voice/announcement pipeline for the eyes-off operator), with the highest-severity claims
> re-verified by hand. Already-closed P9/P9.1 items and deliberately-deferred Blueprint placeholders
> (BeadsExplorer, Loading Dock, Boss's Office, Pantry git card) are excluded.

## TL;DR — the three big themes

1. **The kitchen is deaf to the server's awareness channel.** The entire proactive announcement
   pipeline (`proactive_notification` / `proactive_earcon`) — completions, errors, build failures —
   hits the kitchen's `default: break` and is discarded. Full-Auto executions and blocked commands
   are likewise invisible. The brief's #1 anti-pattern ("silent autonomy") is the shipped default.
2. **Several surfaces actively lie.** Mute that doesn't mute, "● LIVE" while the mic is blocked, a
   volume slider that's never applied, approval events narrated as "Pane X exited.", a restart
   toast that says success on a 500, a connection pill hard-coded green, Rulebook copy promising
   per-pane tuning that has no UI.
3. **Eyes-off coverage has holes exactly where it matters.** A pane *crash* is never spoken even
   with the radio on; STOP-ALL engaged from another surface is never narrated; recovery after a
   drop is silent; the resumption digest omits everything except surviving approvals; a last-call
   can be "delivered" without ever being heard and the item then auto-rejects.

---

## A. Silent autonomy — the dropped awareness channel (all verified)

| # | Gap | Where | Sev |
|---|-----|-------|-----|
| A1 | `proactive_notification`/`proactive_earcon` unhandled — completions/errors/build-failures invisible+inaudible off-air (classic handles both, `App.tsx:1260-1279`) | `useOrbitalData.ts:465` (default case) | HIGH |
| A2 | `command_auto_executed` / `command_blocked` → earcon-only (and that earcon is tweak-gated): no toast, no command text, no block reason. Classic shows pane+cmd+reason + desktop notification | `useOrbitalData.ts:412-419` | HIGH |
| A3 | Pane crash/exit is **never spoken even radio-ON** — no `exited` paneSignal is published; the transition goes only to the attention queue + the bus the kitchen ignores (A1) | `observe/index.ts:447-466`, `paneSignals.ts:28` | HIGH |
| A4 | STOP-ALL engaged/killed/released never narrated to the voice channel; freeze and release share one earcon; stage-2 kill has none | `gating/index.ts:443-500`, `useOrbitalData.ts:380-385` | HIGH |
| A5 | No desktop notifications anywhere in the kitchen (classic fires them for approval/action/auto/blocked) — "step away" breaks when the tab is backgrounded | classic `App.tsx:243` | MED |
| A6 | Recovery is silent: no `voice_channel_restored` frame, no all-clear earcon — operator keeps talking into a dead radio, never told it's safe again | `voice/index.ts` (no restored frame), `useOrbitalData.ts:346` | MED-HIGH |
| A7 | Resumption digest covers only surviving approvals/actions — no "while you were away" delta (finished/errored/exited panes, freeze state), though the activity store already records it | `gating/index.ts:510-543` | MED-HIGH |

## B. Surfaces that lie (misinformation, all verified)

| # | Gap | Where | Sev |
|---|-----|-------|-----|
| B1 | **Mute desync**: kitchen's `settings_updated` never propagates `voiceAi.isMicMuted` — voice-commanded mute leaves the mic streaming while the chip says MUTED (classic patches it, with a comment warning exactly this) | `useOrbitalData.ts:373-376` vs `App.tsx:1215-1220` | HIGH |
| B2 | **"● LIVE" before live + silent mic denial**: `voiceLive` flips on click (pre-connect); `getUserMedia` failure is `console.error` only — chip says "I'm listening, Chef" forever while hearing nothing | `useOrbitalData.ts:516, 323-326`, `KitchenRadio.tsx:94,127` | HIGH |
| B3 | **Approval events narrated as "Pane X exited."** — approval-pending/expired enqueue `kind:"exited"` (to borrow severity) but the template has no `{summary}` placeholder, so the rendered text claims a healthy pane died | `paneWrite.ts:185`, `gating/index.ts:639`, `announcementKinds.ts:91` | HIGH |
| B4 | **Volume slider is fake**: saved to settings but `setPlaybackVolume` is never called in the kitchen — Chef's voice always 100% (classic wires it) | `BackOfHouse.tsx:176-178`, `utils/audio.ts:23` | HIGH |
| B5 | **Connection pill hard-coded green**: `streamConnected` is tracked but nothing renders it — socket dead ⇒ "Kitchen open" over a 20s-poll ghost board | `OrbitalApp.tsx:105-108`, `useOrbitalData.ts:119` | HIGH |
| B6 | **Rulebook copy promises per-pane tuning that doesn't exist**; no per-pane gate/posture is visible anywhere on the Line (classic shows a server-truth GateChip per pane) | `BackOfHouse.tsx:148,90-94`, `StationCard.tsx` | HIGH |
| B7 | **Silent/false mutation feedback** beyond the filed approve-toast bug: gate saves are optimistic with `catch {/* silent */}` and no ack; `restartPane` toasts "Re-firing 🔥" without checking `res.ok` (500 ⇒ success ack); same silent-catch in createPane/createProject/editNote | `useOrbitalData.ts:538-605, 647` | HIGH (gates) / MED |
| B8 | EmergencyStop count can lie after a partial kill (`frozenRunning.length \|\| running` fallback) | `OrbitalApp.tsx:296` | LOW |

## C. Eyes-off mechanics (announcement pipeline correctness)

| # | Gap | Where | Sev |
|---|-----|-------|-----|
| C1 | **"Delivered" never means "heard"**: `lastCallAt` is stamped *before* narration and `pushApprovalNarration` swallows send failures — a last-call that was never audible still auto-rejects 60s later, violating the module's own spec. Connectivity is keyed to session existence, not operator presence | `gating/index.ts:679-681,703-704`, `voice/index.ts:65-74` | HIGH |
| C2 | **No `AudioContext.resume()` anywhere**; auto-reconnect constructs the context in a timer (no user gesture) so Chrome starts it suspended — silent radio that claims LIVE | `utils/audio.ts:29-68`, `useOrbitalData.ts:299-343` | HIGH |
| C3 | Debounce drops instead of defers: suppressed announcements lose even their earcon; high-severity items stamp the window so a completion ≤4s after an error is silenced; paneSignalBus stamps its 3s window even with zero observers | `announcementBus.ts:175-191`, `paneSignalBus.ts:24-35` | MED |
| C4 | No voice **defer** verb — "skip"/"stop"/"nevermind" permanently cancel a staged command (claim+delete, unrecoverable); there is no "later/remind me" | `approvalIntent.ts:50` | MED |
| C5 | Barge-in or 10s staleness permanently drops the "pane ready" ack | `voice/index.ts:1108-1152` | LOW |
| C6 | Earcon vocabulary: server emits type `"completion"` which the kitchen's `playEarcon` union doesn't include (latent silent-drop when A1 is fixed); "alert" is overloaded across five different meanings | `announcementKinds.ts:14,60`, `earcon.ts:6` | LOW-MED |

## D. Feature parity lost in the FLIP (classic → kitchen)

| # | Gap | Where | Sev |
|---|-----|-------|-----|
| D1 | `draft_updated` unhandled — the Order Pad never mirrors Janus dictation (core "dictate the order" journey); pad fetches once on open; concurrent edits last-write-win | `TerminalWindow.tsx:65-98` | HIGH |
| D2 | **No pane exit/archive/rename lifecycle** — only Re-fire exists; Exited cards are immortal, no stop/retire/recover/dismiss (classic: exit→archive panel with restore/delete + clear-exited + rename) | `TerminalWindow.tsx:144` vs `App.tsx:634-684,1609,2668` | HIGH |
| D3 | Plans fetched every poll but rendered nowhere — a voice-built plan is invisible and unfireable (classic: Spec Buffer with execute/delete) | `useOrbitalData.ts:193-199` | MED |
| D4 | `history_updated` unhandled + no command-history surface in the burner | classic `App.tsx:340-364` | MED |
| D5 | No reviewable history anywhere: radio transcript in-memory capped 50 + wiped on reload; interaction log JSONL has no endpoint/UI; attention queue rendered nowhere (model-only) | `useOrbitalData.ts:429,508`, `server.ts:61-65` | MED |
| D6 | "Needs Input" pill misses pane-scoped pending *actions* (mode-change confirms) — only staged commands flag a station | `station.ts:84`, `OrbitalApp.tsx:177` | LOW-MED |
| D7 | Call sheet truncates at 6 stations; "open <name>" needs exact lowercase match | `KitchenRadio.tsx:62`, `OrbitalApp.tsx:186-189` | LOW |
| D8 | No in-product affordance to reach `?ui=classic`; nothing ever writes `localStorage['orbital-ui']` so the documented persistent opt-out requires devtools | `main.tsx:12-16` | LOW |

## E. Confirmations & risky actions

| # | Gap | Where | Sev |
|---|-----|-------|-----|
| E1 | One un-confirmed click (or "let 'em cook" voice call) flips the whole kitchen to Full Auto — the riskiest single action has no read-back, and the toast fires after the optimistic flip | `ServiceMode.tsx:13`, `OrbitalApp.tsx:190` | MED |
| E2 | Irreversible deletes with no confirm/undo: Pass ticket "86", burner note delete | `Pass.tsx:62`, `TerminalWindow.tsx:212` | LOW-MED |
| E3 | "kill the burners" voice call only freezes (stage 1) — label over-promises vs dispatch | `OrbitalApp.tsx:193` | LOW |

## F. Accessibility & input

| # | Gap | Where | Sev |
|---|-----|-------|-----|
| F1 | Board keyboard-unreachable: station cards are clickable `<div>`s, no `role`/`tabIndex`/key handler | `StationCard.tsx:29` | HIGH |
| F2 | No modal semantics anywhere: no `role="dialog"`/`aria-modal`, no focus trap, no Escape-to-close, Tab walks the frozen board behind All Hands | `TerminalWindow.tsx:130`, `modals.tsx:14`, `EmergencyStop.tsx:27`, `Pass.tsx:88` | MED |
| F3 | Hold-to-kill is pointer-only — keyboard users have **no path to the emergency stop** (brief §5 says it must always work) | `EmergencyStop.tsx:40` | MED |
| F4 | Toast/transcript lack `aria-live`; acks invisible to assistive tech | `OrbitalApp.tsx:310`, `KitchenRadio.tsx:104` | MED-LOW |
| F5 | Sub-target controls: 13×13px burner close, 26×24 Pass buttons, ~22px gate segments | `TerminalWindow.tsx:136`, `Pass.tsx:70`, `BackOfHouse.tsx:43` | LOW |
| F6 | WalkInKey briefly echoes first chars of a just-typed secret via the optimistic settings echo | `BackOfHouse.tsx:244` | LOW |

## G. Test honesty

- All `orbital_*.spec.ts` run only under `?mock=1`, and `createPane`/`createProject`/the stop-all
  REST trio short-circuit before the wire in mock — so those flows assert client state only and are
  untested end-to-end in CI (`useOrbitalData.ts:560,575,732-746`). The "tuning in flips to live"
  spec passes purely on the optimistic client flip (B2). The live `smoke:kitchen` exists but needs
  a real server. Severity: MED — green e2e ≠ wired feature.

---

## Consolidated top 12 (cross-audit, by operator impact)

1. **A1+A2** Kitchen drops the proactive channel; Full-Auto fires/blocks invisible — silent autonomy as shipped default.
2. **B1** Mute that doesn't mute (privacy-adjacent: mic keeps streaming).
3. **B2+C2** "● LIVE" while mic is blocked or audio context suspended — operator speaks into / listens to a void.
4. **A3** Pane crash never narrated, even radio-ON.
5. **C1** Last-call can be unheard yet the approval still auto-rejects.
6. **B3** Approval events announced as "Pane X exited." — direct misinformation.
7. **B5** Connection pill always green — no offline affordance at all.
8. **D2** No pane exit/archive lifecycle — dead stations accrete forever.
9. **B6** Per-pane autonomy invisible + Rulebook copy promises a UI that doesn't exist (safety surface).
10. **B4+B7** Fake volume slider; silent/false mutation feedback (restart success on 500, silent gate-save failures).
11. **D1** Order Pad never mirrors dictation (`draft_updated` unhandled) — a core journey broken.
12. **F1+F3** Keyboard users can't open a station and can't reach stage-2 emergency stop.

## Suggested insertion into the fix roadmap

- **Joins Wave 0 (quick wins):** B1, B3 (new announcement kinds), B4, B5, B7 (res.ok checks), A2
  (route through showToast), F4 (aria-live), D8 (write the localStorage opt-out).
- **Joins Wave 3 (sessions/safety):** B2+C2 (honest LIVE state + AudioContext resume), A4+A6
  (stop-all + recovery narration), C1 (ack-gated last-call), E1 (Full-Auto confirm).
- **New Wave 5 — "Eyes-off completeness & parity" (~3-4 days):** A1+A3+A5+A7 (full event→announcement
  coverage + away-delta digest), D1-D5 (draft mirror, pane lifecycle, plans, history surfaces),
  B6 (per-pane gate UI), C3/C4 (defer-not-drop debounce, voice "defer" verb), F1-F3 (keyboard
  reachability + modal semantics), G (one live-server e2e lane).
