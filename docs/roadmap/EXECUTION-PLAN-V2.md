# Execution Plan v2 — Experience-First Roadmap + Subagent Harness

> Supersedes the wave ordering in `STABILITY-FIX-ROADMAP.md` (the wave content and task IDs remain
> the canonical spec cards; this document reorders them and defines HOW they get executed by
> Opus/Sonnet-class subagents without the usual agent failure modes eating the schedule).
> Sources: `../review/2026-06-09-core-stability-audit.md`, `../review/2026-06-10-ux-gap-audit.md`.

---

# Part 1 — The restructured roadmap (experience-first)

## Reordering principle

The old ordering was *risk-retired-per-hour*. The new ordering is **operator-felt improvement per
day, sustained** — near-term app experience leads; deep structural work follows once the app it
protects is worth protecting. Two amendments keep "experience-first" honest:

1. **Crashes are experience.** A process-death or white-page bug is not "technical debt" — it is
   the worst possible UX. The handful of invisible-but-catastrophic fixes (server-killers, restart
   wedge) stay in Phase 1 because no UX polish survives a dead server.
2. **A red test baseline blocks everything.** Subagents cannot verify work against a suite that
   already fails (they will either ignore failures — including new ones they caused — or "fix"
   them by weakening tests). A short Phase 0 makes the battery green on Linux so every later task
   has a trustworthy gate. This is not long-term infra; it is the precondition for shipping
   Phase 1 safely with agents.

## Phase 0 — Make the gates trustworthy (½–1 day) — *enabler, not infra polish*

| ID | Task | Origin |
|----|------|--------|
| P0.1 | Fix the 18 Linux-cancelled tests: `ref()` action-deadline timers while a non-brake action is in flight; tests driving deferred spawns hold a ref'd handle. Battery must be green in this container. | audit E1 / wave 4.1 |
| P0.2 | Add `npm run lint && npm test` as a PR check (one job in `linux-verify.yml`). Agents get an external gate they cannot quietly skip. | wave 4.2 |
| P0.3 | Write the file-ownership matrix + worktree layout (Part 2) into the repo so parallel agents never collide. | new |

## Phase 1 — "The kitchen tells the truth this week" (2–3 days) — *all operator-visible*

Everything here is a quick win (S effort) with an immediately felt result. Three tracks, disjoint
files, parallelizable.

**Track A — Don't die, don't blank (server + shell):**
| ID | Task | Felt result |
|----|------|------------|
| 1A.1 | Restart wedge: unconditional `Running` reset in `start()` + fixture fixes (`terminal.ts:856`) | Restarted panes come back alive |
| 1A.2 | Server-killers: `.catch` on deferred effects; try/catch sweep; `listen` error handler | The app stops dying mid-shift |
| 1A.3 | ErrorBoundary + visible Suspense fallback around `OrbitalApp` (`main.tsx`) | No more white page |

**Track B — Honest surfaces (kitchen client):**
| ID | Task | Felt result |
|----|------|------------|
| 1B.1 | `refetchAll()` on `ws.onopen`; render `streamConnected` in the top pill | Board truthful after sleep; "Kitchen dark — reconnecting…" |
| 1B.2 | Escape = topmost dialog only | One keypress can't nuke the approval queue |
| 1B.3 | Honest feedback sweep: approve/reject + `restartPane` + gate saves + create* check `res.ok`; failures toast + restore state | Success sounds mean success |
| 1B.4 | Mute desync: propagate `voiceAi.isMicMuted` in `settings_updated` | Mute actually mutes |
| 1B.5 | Honest LIVE: gate chip on `ws.onopen` + mic success; mic-denied → "MIC BLOCKED" toast/chip; `AudioContext.resume()` at top of playback | "LIVE" means live |
| 1B.6 | Wire `setPlaybackVolume` from settings (+ `settings_updated`) | The volume slider works |
| 1B.7 | Handle `proactive_notification`/`proactive_earcon` (toast + earcon incl. `"completion"` type); route `command_auto_executed`/`command_blocked` through `showToast` with pane+cmd+reason | Silent autonomy ends: you hear/see what agents did |

**Track C — Honest narration (server voice path):**
| ID | Task | Felt result |
|----|------|------------|
| 1C.1 | Real `approval-pending`/`approval-expired` announcement kinds (stop overloading `exited`) | No more "Pane X exited." lies |
| 1C.2 | Publish `exited` paneSignal from `detectAndTriggerTransitions` | A crashed pane is *spoken* |
| 1C.3 | Narrate STOP-ALL engage/kill/release to the live session; distinct earcons | The freeze is audible |

**Phase 1 exit:** full battery green; manual kitchen smoke script (Part 4) passes; every item maps
to a sentence an operator would notice ("restart works", "mute mutes", "I heard the crash").

## Phase 2 — "Operator capability + safety truth" (3–4 days)

| ID | Task | Origin |
|----|------|--------|
| 2.1 | Pane lifecycle in the kitchen: exit/stop, archive surface (Pantry), restore/delete, rename, clear-exited | UX D2 |
| 2.2 | Per-pane gate/posture: GateChip on StationCard + burner; pane-scope editing in Rulebook (or fix the copy) | UX B6 |
| 2.3 | `draft_updated` mirror into the Order Pad (focus-guarded) | UX D1 |
| 2.4 | Gate deep-merge in `updateSettings` + zod on `PUT /api/settings`; archive/restore v4 columns | waves 0.6/0.7/3.2 |
| 2.5 | Freeze means frozen: `isFrozen()` on non-brake ALWAYS_ALLOWED mutators | wave 3.1 |
| 2.6 | Full-Auto flip gets a confirm/read-back; "86" gets undo-in-toast | UX E1/E2 |
| 2.7 | Keyboard reachability: focusable station cards, dialog semantics + focus trap, keyboard hold-to-kill | UX F1–F3 |
| 2.8 | Recovery all-clear: `voice_channel_restored` frame + client earcon/toast | UX A6 |
| 2.9 | Desktop notifications for approval/auto/blocked (port from classic) | UX A5 |

## Phase 3 — "Boring restarts, honest terminals" (week 2; structural)

| ID | Task | Origin |
|----|------|--------|
| 3.1 | Transport generation tokens + restart mutex + SIGKILL re-entry + pendingInput clear | wave 1.1 |
| 3.2 | Voice session generation guards (connect + `handleSessionLost`) | wave 1.2 |
| 3.3 | Client fetch sequencing + in-place `pane_status` patch | wave 1.3 |
| 3.4 | WS heartbeat both sides; 4001 terminal-close handling | wave 3.4 |
| 3.5 | Terminal never lies: backfill resync on reopen/mount; socket survives radio toggles; mock-mutation guard | wave 3.5 |
| 3.6 | Last-call ack: stamp `lastCallAt` only after successful narration; repeat once before reject | UX C1 |
| 3.7 | Deferred confirms survive restart (version-stamp `applyPaneMode`) | wave 3.3 |
| 3.8 | DB quarantine on corrupt store; migration marker in txn | wave 2.5 |

## Phase 4 — "Longevity & depth" (week 3)

| ID | Task | Origin |
|----|------|--------|
| 4.1 | Debounced async history writes (kills the per-chunk sync rewrite) | wave 2.1 |
| 4.2 | Async status probes | wave 2.2 |
| 4.3 | `pane_created` only on insert; periodic retention; approvals/action_log pruning | wave 2.3 |
| 4.4 | Broadcast projection in one query | wave 2.4 |
| 4.5 | "While you were away" digest from the activity log | UX A7 |
| 4.6 | Debounce defers (not drops); voice "defer" verb | UX C3/C4 |
| 4.7 | Plans on The Pass; command-history + service-log surfaces | UX D3–D5 |
| 4.8 | One live-server (non-mock) e2e lane for create-pane/stop-all/radio | UX G |

**Why this is the right shape for "near-term over short-sighted":** Phases 1–2 are entirely things
Dave feels within days, each independently shippable. The deep work (generation tokens, heartbeats,
event-loop surgery) lands only after the app it protects is honest and capable — but before the
codebase grows further on top of the broken lifecycle. The old Wave-2 performance work moves last:
it matters at sustained load, not at current scale, and nothing in Phases 1–3 builds on top of it.

---

# Part 2 — The subagent harness

## Why a harness at all

Opus/Sonnet-class agents fail in *known, recurring* ways. This repo has already paid for several
(P9.2's "kill the last 3 fake/silent gaps" was cleanup of agent-shipped fake UX; the 2026-06-01
worktree incident was an agent stashing over human WIP; the test fixtures replicating a production
bug is classic agent copy-paste). The harness exists to make each failure mode *structurally
impossible* rather than relying on prompt exhortations.

## Failure modes → structural countermeasures

| # | Documented Opus/Sonnet failure mode | Countermeasure (structural, not advisory) |
|---|--------------------------------------|--------------------------------------------|
| FM1 | **Premature "done"** — claims completion without running anything | Implementer's final message MUST include verbatim battery output; a separate Verifier re-runs `npm run lint && npm test` itself and trusts only its own run. CI (P0.2) backstops both. |
| FM2 | **Reward hacking** — makes tests pass by weakening assertions/fixtures | Test-Author and Implementer are different agents; Implementer's brief forbids editing `tests/**` (file allowlist); Verifier diffs `tests/**` and fails the task if assertions changed without an approved fixture-fix card (1A.1 is the only one). |
| FM3 | **Context rot** — quality degrades over a long session | One task card = one fresh subagent. No agent carries two cards. The orchestrator (this session) holds all cross-task state; agents get self-contained briefs with file:line anchors and zero reliance on "the conversation so far". |
| FM4 | **Partial-file blindness** — edits from a grep window, breaks the function around it | Briefs mandate: Read the entire enclosing function/component before editing; for the 3 hotspot files (`server.ts`, `terminal.ts`, `useOrbitalData.ts`) grep-first then Read a ±60-line window minimum. Verifier runs the FULL battery, not just the new test. |
| FM5 | **Scope creep / drive-by refactors** | Every card has a file allowlist. Touching any other file = STOP and report back (the orchestrator re-scopes or spawns a new card). Verifier mechanically diffs changed-file list vs allowlist. |
| FM6 | **Hallucinated APIs** (ws internals, node-pty, better-sqlite3 named params, React 19) | Cards embed the verified API facts discovered during the audit (e.g. "better-sqlite3 silently ignores extra named params — that's the bug"). For any API not in the card, the agent must verify with `node -e` or the package's `.d.ts` before using it. |
| FM7 | **Parallel-agent file collisions** | File-ownership matrix (below). Tracks are scheduled so no two concurrent agents share a file. Hotspot files are single-threaded across the whole phase. Each track runs in its own worktree (`isolation: worktree`), merged by the orchestrator only after its Verifier passes. |
| FM8 | **Silent stubs / fake wiring** — handler added but not actually reached; e2e green only in mock | Verifier runs an explicit anti-fake checklist per card: (a) is the new code reachable from the real (non-mock) path? (b) does the e2e assert the *wire* (request sent / frame handled), not just client state? (c) grep for early-returns that bypass it. UX cards additionally require a non-mock verification note (manual run or live-lane e2e). |
| FM9 | **Platform amnesia** — Windows-only or Linux-only idioms | Cards state both targets explicitly. The battery runs on Linux (this container + CI); anything touching PTY/process/paths gets a "Windows behavior" line in the card (e.g. ConPTY teardown, `cmd.exe` legacy transport). No `execSync`-replacement may assume POSIX `ps`. |
| FM10 | **Big-file edit failures** — Edit-tool mismatch loops, duplicated blocks | Hotspot files: small surgical edits only, one Edit per logical change, re-Read the edited region after each Edit. If an Edit fails twice, STOP and report (do not retry blind). |
| FM11 | **Symptom-fixing** — patches the visible effect, not the cause | TDD is mandatory: the Test-Author's failing test must reproduce the *root cause* described in the audit (cards link the audit finding). The Implementer may not modify the repro test (FM2). A fix that makes the test pass by intercepting the symptom gets caught by the Verifier's "does the fix touch the file:line the audit named?" check. |
| FM12 | **UX flattening** — technically correct, feels wrong (silent success, generic copy) | Every Phase 1–2 card carries an *operator-visible acceptance sentence* ("After laptop sleep, the pill reads 'Kitchen dark — reconnecting…' within 5s of socket loss"). The Verifier validates the sentence, not just the diff. Kitchen-voice copy must match the existing register (the kitchen brief's tone), checked against `UX_BRIEF.md`. |
| FM13 | **Forbidden-tool drift** — agents reach for TodoWrite/TaskCreate (prohibited here) or `gh` | Cards restate: task state lives in the card + orchestrator; no todo tools; git only within the agent's own worktree; never `stash`/`reset` (worktree-isolation policy in CLAUDE.md). |
| FM14 | **Baseline blindness** — agent inherits a red suite and can't tell its failures from pre-existing ones | Phase 0 makes the baseline green FIRST. Until then, no implementation card is issued. Verifier compares failure sets against the recorded baseline hash. |

## Roles (the pipeline per task card)

```
ORCHESTRATOR (main session — holds all state, merges, sequences)
  └─ per task card:
     1. TEST-AUTHOR (sonnet, worktree)   — writes the failing test(s) from the card's repro spec.
        Output: red test + verbatim failing output. May NOT touch src/**.
     2. IMPLEMENTER (opus, same worktree) — makes it green. May NOT touch tests/** or files
        outside the allowlist. Output: diff summary + verbatim full-battery output.
     3. VERIFIER (sonnet, fresh agent, same worktree, read+run only) — re-runs lint+battery
        itself; diffs changed files vs allowlist; runs the anti-fake checklist; validates the
        operator-visible sentence (run the app/e2e where the card says so). Output: PASS/FAIL
        + evidence. A FAIL goes back to a FRESH implementer with the verifier's notes (never
        the same conversation — FM3).
     4. ORCHESTRATOR merges the worktree branch, updates the phase checklist, pushes.
```

- UI-heavy cards (Phase 1 Track B, Phase 2) add a **UX-VERIFIER** step: run Playwright non-mock
  where the live lane exists, otherwise drive the dev server and screenshot the states named in
  the acceptance sentence.
- Pure-docs or one-line cards (1B.6) may collapse Test-Author/Implementer into one agent, but the
  independent Verifier is never skipped.
- Model assignment: Opus for multi-file/structural cards (Phase 3), Sonnet for scoped single-file
  cards and all Verifier/Test-Author roles (cheaper, and the role separation matters more than the
  model). Any agent may be re-run with Opus if Sonnet stalls twice.

## File-ownership matrix (Phase 1 — three concurrent tracks)

| Track | Worktree | Owns (exclusive while active) |
|-------|----------|-------------------------------|
| A | `wt/phase1-core` | `src/terminal.ts`, `server.ts`, `src/main.tsx`, `tests/test_terminal_*`, fixture files |
| B | `wt/phase1-kitchen` | `src/orbital/**`, `src/components/ApprovalDialog.tsx`, `src/components/ActionConfirmDialog.tsx`, `src/utils/audio.ts`, `src/utils/earcon.ts`, `e2e/orbital_*` |
| C | `wt/phase1-voice` | `src/announcementKinds.ts`, `src/announcementBus.ts`, `src/observe/index.ts`, `src/dispatch/paneWrite.ts`, `src/gating/index.ts` (narration only) |

Conflicts by construction: none (verified against the audit's file:line lists). `src/voice/index.ts`
is touched by C only in Phase 1; Phase 3 cards that touch it are sequenced after C merges.
Merge order: A → C → B (B's proactive handlers consume C's new announcement kinds; the kitchen
`"completion"` earcon type lands with 1B.7 *after* 1C.1 defines the kinds).

## Task-card template (the unit of work)

```md
CARD <id> — <title>                        Phase <n> / Track <X> / Model: <opus|sonnet>
AUDIT FINDING: <link + file:line from the audit doc — the root cause, verbatim>
FILE ALLOWLIST: <exhaustive>
VERIFIED API FACTS: <anything the audit empirically established>
REPRO SPEC (for Test-Author): <exact failing behavior the test must capture>
IMPLEMENTATION SKETCH: <the audit's one-sentence fix, expanded to ~5 lines max — direction, not dictation>
OPERATOR-VISIBLE ACCEPTANCE: <one sentence an operator could verify>
VERIFICATION COMMANDS: npm run lint && npm test [+ card-specific e2e/smoke]
ANTI-FAKE CHECKS: <card-specific reachability/wire assertions>
PLATFORM NOTES: <Windows/Linux specifics>
STOP CONDITIONS: needs a file outside the allowlist; Edit fails twice; battery has failures
  not in the baseline set; the fix wants to change a test.
```

### Worked example — CARD 1B.4 (mute desync)

```md
CARD 1B.4 — settings_updated must propagate isMicMuted        Phase 1 / Track B / sonnet
AUDIT FINDING: ux-gap B1 — useOrbitalData.ts:373-376 ignores msg.settings.voiceAi.isMicMuted;
  classic handles it at App.tsx:1215-1220 with a comment warning of exactly this desync.
FILE ALLOWLIST: src/orbital/useOrbitalData.ts, e2e/orbital_radio.spec.ts
VERIFIED API FACTS: the settings_updated frame carries the full sanitized settings object;
  micMuted state gates the mic-frame send in startMic's onaudioprocess path.
REPRO SPEC: e2e (mock harness): inject a settings_updated frame with voiceAi.isMicMuted=true
  while voiceLive; assert the mute chip flips AND no further mic frames are sent (spy on ws.send).
IMPLEMENTATION SKETCH: in the settings_updated case, if typeof msg.settings?.voiceAi?.isMicMuted
  === "boolean" and it differs from micMuted, setMicMuted(it). Mirror classic's guard so a
  settings echo of our own optimistic update doesn't bounce.
OPERATOR-VISIBLE ACCEPTANCE: saying "mute the mic" (or any server-side mute) flips the kitchen
  chip to MUTED and the mic genuinely stops streaming within one frame.
VERIFICATION: npm run lint && npm test && npx playwright test e2e/orbital_radio.spec.ts
ANTI-FAKE: the assertion must spy the WIRE (no mic frames sent), not just the chip class.
PLATFORM NOTES: none (pure client).
```

(The remaining cards are generated the same way: every Phase 1–2 row above already names its
audit finding, files, and fix sketch in the two audit docs — the orchestrator stamps them into
this template when dispatching, so each subagent gets a complete, self-contained brief.)

## Scheduling & cadence

- **Batch size:** max 3 concurrent pipelines (one per track). More parallelism than that exceeds
  the orchestrator's ability to review merges carefully — orchestrator review is the last line.
- **Merge discipline:** a track merges only when its Verifier passed and the orchestrator has
  re-run the battery on the merged result. Conflicting late tracks rebase, never force.
- **Checkpoint after every phase:** push, update the phase checklist in this doc, run the manual
  smoke script (Part 4), and record a one-paragraph "what an operator gets" note — that note is
  the deliverable the user judges, per the experience-first principle.
- **Kill criteria:** any pipeline that loops (2 failed verifier rounds) is stopped; the
  orchestrator re-reads the audit finding itself and either re-scopes the card or escalates to
  doing it directly with full context. Never let an agent grind.

# Part 3 — Definition of Done (global)

A card is done when ALL of:
1. The Test-Author's red test is now green, unmodified since red (FM2).
2. `npm run lint && npm test` fully green — run by the Verifier itself (FM1), failure set ⊆ baseline (FM14: baseline = empty after Phase 0).
3. Changed files ⊆ allowlist (FM5).
4. Anti-fake checks pass on the real, non-mock path (FM8).
5. The operator-visible acceptance sentence is demonstrated (FM12).
6. Merged + pushed by the orchestrator with the phase checklist updated.

A phase is done when its cards are done AND the manual smoke script passes end-to-end.

# Part 4 — Manual kitchen smoke script (run at every phase checkpoint)

1. Boot server; open kitchen. Kill the server → pill flips to "Kitchen dark"; restart → recovers + board truthful.
2. Start a pane; restart it from the burner → returns to Running; voice narrates it.
3. Stage an approval by voice; press Escape with two dialogs up → only the top one dismisses.
4. Approve with the network tab throttled to fail → failure toast, chip restored, no success earcon.
5. Mute by voice → chip flips, mic stream stops. Deny mic in a fresh profile → MIC BLOCKED state, not "LIVE".
6. Kill a pane's process externally → spoken "exited" + visible signal.
7. Engage STOP-ALL from a second tab → first tab hears/sees the freeze; release → distinct all-clear.
8. Background the tab; let a command finish → desktop notification (Phase 2+).
9. Keyboard only: open a station, approve a dialog, reach and fire hold-to-kill (Phase 2+).
```
