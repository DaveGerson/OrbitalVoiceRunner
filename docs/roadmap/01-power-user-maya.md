# Orbital Harness — Assessment by Maya Chen (Solo Founder / Power User)

> ⚠️ **HISTORICAL ASSESSMENT — round one, 2026-05-28. SUPERSEDED — DO NOT READ AS CURRENT FACT.**
> This review's headline blockers (no voice-approval path, dead transcripts, blind approvals,
> orphaned approvals) were RESOLVED on `main` after PR134. The prose below is preserved as a
> historical artifact, not a current assessment. For the current forward wishlist, see
> `docs/roadmap/next-level/`.

## Who I am and what I need

I'm a solo technical founder. On a normal day I have 4–6 AI coding agents (Claude
Code, Codex, a couple of plain shells) running in parallel, and I context-switch
between them constantly. The pitch here — "pace around the room and drive all of
them by voice" — is exactly the tool I keep wishing existed. So I read this
codebase the way I'd evaluate anything I'd put in my daily loop: does the
voice→tool→pane loop actually close, does the ledger stay truthful when I'm not
looking, and can I leave it running for hours without it lying to me or dropping
commands. I'm not grading ambition. I'm grading whether it does the job.

## Methodology — what I read and ran

Read in full: `README.md`, `SETTINGS_SPEC.md`, `server.ts` (916 lines),
`src/terminal.ts`, `src/ledger.ts`, `src/types.ts`, `src/App.tsx` (1561 lines),
all four components (`ApprovalDialog`, `CreateTerminalDialog`, `SettingsDialog`,
`TerminalView`), `src/utils/api.ts`, `src/utils/audio.ts`, `universal_terminal.py`,
and all four test files. Inspected live state in `.janus_ledger.json` and
`.janus_settings.json`.

Ran:
- `npm run lint` (tsc --noEmit): **clean, zero errors.**
- `npm test`: **13/13 pass** across 5 suites (terminal logic, ledger, approvals concurrency).
- A standalone PTY probe to confirm the `script -q -f -c <cmd> /dev/null` spawn
  path actually accepts stdin writes (it does — I got `WRITE_LOOP_OK` back).

So the headline is: it builds, it type-checks, the tests are green, and the core
spawn/write primitive works. That's better than a lot of demos. The problems are
in the wiring between the pieces, and that's where my workflow lives.

---

## 1. Does the tool actually work?

### What genuinely works
- **PTY spawn + write loop.** `UniversalTerminal.start()` (`src/terminal.ts:210-306`)
  spawns via `script` for a real PTY, captures stdout/stderr, strips ANSI, keeps a
  bounded buffer, and `writeInput()` (`:308-312`) writes `cmd + "\n"` to stdin. I
  verified end-to-end that commands written this way reach the shell and produce
  output. The fundamental mechanism is sound.
- **Permission gating logic is correct in isolation.** The effective-mode
  resolution in `propose_command` (`server.ts:631-695`) matches the spec: global
  wins unless `Inherit`, then pane mode, defaulting to Human-in-the-Loop. Full Auto
  writes immediately, Read-Only rejects, HITL parks a pending approval and waits for
  `/api/commands/approve`. The tool response is correctly withheld until the operator
  acts (`:694`).
- **Ledger persistence is atomic.** `flushSave()`/`flushSaveSync()` write to a
  `.tmp` then `rename` (`src/ledger.ts:83-117`), with a dirty/saving guard. That's
  the right pattern and it survives the persistence test.

### Bugs and broken wiring that would bite me

**(A) The approval rationale I'd rely on is collected and then thrown away.**
The backend builds a rich rationale — what it heard me say plus a pane summary —
and ships it to the frontend (`server.ts:681-693`). `ApprovalDialog` is fully built
to render it (`ApprovalDialog.tsx:53-66`). But where App actually mounts the dialog
(`App.tsx:633-641`), it passes `messageId`, `terminalId`, `cmd`, `onApprove`,
`onReject` — and **omits `rationale` entirely**. So every approval prompt I get is a
bare command string with no "here's why / here's what the pane was doing" context.
When I'm approving commands for six agents by voice, that context is the whole point
of human-in-the-loop. Right now I'm rubber-stamping blind.

**(B) Pending approvals leak / hang on disconnect — and the test pretends otherwise.**
The WS `close` handler (`server.ts:864-877`) closes the Gemini session but never
touches `pendingApprovals`. So if I reconnect (which the client does automatically
every 3s, `App.tsx:391-409`), any in-flight approval is now bound to a dead session
object. If I then approve it, `pending.session.sendToolResponse(...)`
(`server.ts:473`) fires at a closed session — it's wrapped in try/catch so it won't
crash, but the command **still writes to the pane** (`:471`) while the model never
learns the outcome. Worse: `test_approvals.ts:44-72` asserts that a close handler
purges session-bound approvals — but that handler **does not exist in
`server.ts`**. The test reimplements an `onCloseCleanup` mock inline and tests the
mock. Green checkmark, zero coverage of real code. That's the kind of thing that
makes me distrust the whole suite.

**(C) Live terminal IDs and ledger pane IDs don't agree.** Startup spawns the
default pane as `"primary-cli"` (`server.ts:117`). But the committed
`.janus_ledger.json` shows the persisted pane as `"pane_1"`. `syncLedger`
(`src/terminal.ts:525-548`) keys panes by the *live* terminal id, while the agent
addresses panes by whatever id is in the ledger briefing. So the model can call
`propose_command(pane_id="pane_1")`, the lookup `manager.terminals["pane_1"]` misses
(`server.ts:639`), and it gets "Node pane_1 not found" even though a pane is right
there. Stale ledger entries from prior runs never get reconciled against live
processes — they just accumulate as ghost panes the agent might target.

**(D) Voice-driven `switch_context` desyncs from the restart path.** The
`switch_context` tool handler (`server.ts:620-626`) calls
`manager.ledger.switchContext()` but — unlike the REST `/api/projects/:id/switch`
endpoint (`:374-383`) — never updates `manager.settings.projects.activeContext` /
`localWorkspacePath`. So if I switch projects by voice and then a pane dies and
restarts, `restart` resolves cwd from `getActiveProject()` (`:265-273`), which may
not be the project I verbally switched to. Restarted agents can come back in the
wrong directory. For multi-project orchestration this is a silent data-integrity hole.

**(E) Command history is keyed by `cwd`, not by pane.** `HistoryManager` files are
`.janus_history.json` in the pane's `cwd` (`server.ts:52-54`). If I run two agents in
the same directory — which I do constantly (Claude Code and Codex on the same repo) —
they **share one history file and clobber each other's stdout capture**
(`appendOutputToLastCommand`, `:104-112`). The per-pane history panel in the UI is
therefore wrong whenever two panes share a directory.

**(F) Output routing to the model is pull-only and shared-buffer fragile.** The
model never receives stdout proactively; it must call `get_pane_summary`
(`server.ts:614-619`) which returns the last N lines of an in-memory buffer capped at
`maxBufferLines` (default 100). A chatty agent blows past 100 lines in seconds, so by
the time Janus looks, the thing it needs to react to has scrolled out of the buffer.
There's no diff/delta tracking despite the tool description claiming "markdown delta"
(`:762`) — it returns the whole tail every time, re-spending tokens on lines the model
already saw.

**(G) Idle/busy detection is a guess.** `updateStatusOnOutput`
(`src/terminal.ts:155-179`) flips a pane to "Idle" 1 second after the last output and
infers prompts via a regex on the last 5 lines. Real agent TUIs (Claude Code, Codex)
render spinners and redraw constantly, so they'll read as perpetually "Running"; a
quiet agent waiting on me reads as "Idle." The `is_busy`/`alive` flags the model uses
for orientation (`listPanes`, `:512-522`) are therefore noisy. The hardcoded 1000ms
also ignores the `idleTimeoutMs` setting that the UI lets me configure.

### Smaller stuff
- `pidusage` is a declared dependency but never imported; `cachedCpu`
  (`src/terminal.ts:76`) is dead. CPU is never actually measured despite UI chrome
  implying live telemetry.
- Audio playback builds 24 kHz buffers (`audio.ts:30`) inside an AudioContext the
  client pins to 16 kHz (`App.tsx:319`). Depending on the browser this resamples or
  plays Janus's voice at the wrong pitch/speed.
- The startup `addTerminal("primary-cli", ...)` runs at module load (`:117`), before
  `manager.onOutput` is wired (`:182`), so the very first pane's earliest output isn't
  broadcast to any client until something else triggers a flush.
- `--dangerously-skip-permissions` is auto-appended for non-Custom presets in Full
  Auto (`src/terminal.ts:94-102`). The agents I run actually use that flag, so the
  intent is fine — but it's silently mutating my launch command based on a dropdown,
  and the resume-flag synthesis (`--resume=${sessionId}` at `:219-224`) invents flag
  syntax that none of Claude Code / Codex / Antigravity actually accept.

---

## 2. Does it support my workflow (hands-free, multi-agent)?

Short version: the demo path works for **one** pane in **one** project. The moment I
scale to my real setup it frays.

- **Multi-pane, same repo:** breaks history (bug E) and any "what's this agent doing"
  read is unreliable (bug F/G). Two Claude Codes on the same checkout is my default,
  and the tool can't keep them straight.
- **Hands-free approval:** the README sells voice-confirm, and the dialog even says
  "Execute with voice 'Confirm'" (`App.tsx:1159`). But there is **no voice-approval
  wiring anywhere** — approvals only resolve via the `Enter`/`Esc` keyboard handler
  (`ApprovalDialog.tsx:21-34`) or a mouse click. So to approve a command I have to
  walk back to the keyboard. That defeats the entire "pace around the room" premise.
  In Human-in-the-Loop (the safe default) this is not hands-free at all.
- **Full Auto to actually be hands-free:** my only path to true hands-free is Full
  Auto, which auto-runs whatever the model proposes with `--dangerously-skip-permissions`
  agents, on my host, on an API with no auth on the LAN binding (`0.0.0.0`,
  `server.ts:910`). I am not leaving that running unattended. So I'm stuck choosing
  between "not hands-free" and "reckless."
- **Trust it unattended:** no. Between the approval-leak-on-reconnect (bug B), the
  pane-id ghosting (bug C), and the switch/restart desync (bug D), the longer it runs
  the more the ledger and the live process set drift apart. The auto-reconnect loop
  silently re-establishes Gemini sessions, and each reconnect is another chance to
  orphan an approval.
- **The model's situational awareness is thin.** Pull-only summaries capped at 100
  lines, no deltas, guessed busy state. For orchestrating six agents the assistant
  needs to reliably know who's blocked on a prompt and who's mid-task; right now it's
  inferring from a regex and a tail buffer.

The settings/config surface, by contrast, is genuinely over-built — three-tab editor,
import/export, per-preset themes and window modes. None of that helps me run agents;
"window mode" and "visual theme" don't appear to do anything in the runtime. It's
polish on a part of the product that wasn't the hard part.

---

## Severity-ranked concerns

| # | Severity | Issue | Evidence |
|---|----------|-------|----------|
| 1 | **Blocker** | "Hands-free" is false — approvals require keyboard/mouse; no voice-confirm exists | `ApprovalDialog.tsx:21-34`; copy at `App.tsx:1159` |
| 2 | **Blocker** | Pending approvals not cleaned on WS close/reconnect → orphaned/hanging tool calls; command still writes against dead session | `server.ts:864-877`, `:471-473` |
| 3 | **Blocker** | Live terminal id (`primary-cli`) ≠ ledger pane id (`pane_1`); agent targets ghost panes / "not found" | `server.ts:117` vs `.janus_ledger.json`; `terminal.ts:525-548` |
| 4 | **High** | Approval rationale collected but never rendered — operator approves blind | `server.ts:681-693` vs `App.tsx:633-641` |
| 5 | **High** | `switch_context` voice path doesn't update settings → restarts land in wrong cwd/project | `server.ts:620-626` vs `:374-383` |
| 6 | **High** | History keyed by cwd, not pane → co-located agents clobber each other | `server.ts:52-54`, `:104-112` |
| 7 | **High** | Tests assert behavior that isn't in the code (mock-only approval cleanup) → false confidence | `tests/test_approvals.ts:44-72` |
| 8 | **Medium** | Pull-only, 100-line, no-delta observation; "delta" is a lie | `server.ts:614-619`, `:762`; `terminal.ts:550-556` |
| 9 | **Medium** | Idle/busy inferred by regex + fixed 1s; ignores `idleTimeoutMs`; wrong for agent TUIs | `terminal.ts:155-179` |
| 10 | **Low** | 16 kHz ctx playing 24 kHz buffers; dead `pidusage`/`cachedCpu`; first-pane output race; fabricated resume flags | `audio.ts:30`/`App.tsx:319`; `terminal.ts:76,219-224`; `server.ts:117,182` |

---

## Bottom line

**Would I use this today? No.**

The skeleton is real — it builds clean, the PTY write loop works, the permission
state machine is logically correct, and ledger writes are atomic. That's a credible
foundation and more than a mockup. But it does not yet do *my* job. The headline
feature, hands-free voice approval, isn't wired (blocker 1). I can't trust it
unattended because approvals orphan on the auto-reconnect it does on its own (blocker
2), and the live process set drifts out of sync with the ledger the agent reasons over
(blockers 3 and 5). The two scenarios that define my day — multiple agents in one repo,
and walking away while they work — are exactly the two it can't currently hold
together (history clobber, ghost panes, blind approvals). And the green test suite
gave me a scare: at least one suite tests a reimplemented mock of behavior the
production code never got (concern 7), so I can't take "13/13 pass" at face value.

It's close enough that I'd want to revisit it, but as it stands it's a strong single-pane,
attended demo wearing the UI of a multi-agent autonomous orchestrator. For someone who
actually runs 4–6 agents and wants to pace the room, it breaks down precisely where the
value is.
