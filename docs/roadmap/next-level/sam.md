# Next-Level Voice-First Capabilities — Orbital Harness / Janus

**Persona:** Sam Rivera, voice-first developer. Voice is my PRIMARY and usually ONLY modality.
I steer multi-agent coding sessions by speech, away from the keyboard (RSI). Round one asked
"does voice work today" (answer: no — see `assessments/03-voice-first-sam.md`). This document
assumes those P0/P1 bugs are fixed — voice approval exists, playback is correct, transcripts
populate, errors are surfaced — and asks the harder question: **what net-new capabilities does
Janus need so I can run a genuinely complex hands-free multi-agent session start to finish
without ever touching the keyboard?**

Everything below is grounded in the code I read (`server.ts`, `src/App.tsx`,
`src/utils/audio.ts`, the components). I cite `file:line` wherever a feature builds on or
replaces existing code.

Priority key: **P0-aspirational** = the spine of a real hands-free workflow, build first;
**P1** = removes a recurring forced-to-screen moment; **P2** = polish / power-user.
Effort: **S** ≈ <1 day, **M** ≈ 2–4 days, **L** ≈ a week+.

---

## Next-Level Features

### NL-1. Proactive spoken event push (the "tap on the shoulder" channel) — P0-aspirational, L

**Problem.** Today Janus only learns pane state when *it* chooses to call `get_pane_summary`
("Pull, not push", `server.ts:761-762`). Pane stdout streams to the UI as `stdout_chunk`
(`server.ts:199-204`, consumed at `src/App.tsx:381-382`) and is **never** pushed to the model or
spoken. So when a build fails, a test breaks, or an agent goes idle waiting on me, I hear
*nothing*. In a multi-agent session that is fatal: agent B finishes while I'm talking to agent A
and I never find out. A hands-free operator needs the system to interrupt *me*, not the reverse.

**Sketch.** Add a server-side **event detector** over each pane's stdout buffer (extend the
`stdout_chunk` path at `server.ts:199-204`): cheap heuristics/regex for state transitions —
`build failed`, `error:`, `Tests: N failed`, prompt-idle (no output for N seconds while
`is_busy` was true), and the existing approval-pending signal. On a transition, inject a
**system turn** into the live session (`session.sendRealtimeInput` / a synthetic tool-result the
model is told to read aloud) so Janus speaks a one-liner: *"Build agent failed — 3 type errors
in api.ts. Want the details?"* Make it rate-limited and debounced so it doesn't talk over
itself, and gate verbosity by a spoken setting (NL-7). This is the single biggest lever: it
turns Janus from a thing I poll into a copilot that watches my panes for me.

---

### NL-2. Spoken read-back and on-demand summarization of pane output — P0-aspirational, M

**Problem.** Even reactively, I can't *get* pane content into my ears in a usable form. The model
can call `get_pane_summary` (`server.ts:614-619`, `server.ts:760-769`) but the result is markdown
meant for the model's context, not a spoken digest, and there's no command for "read me the last
error" or "summarize what the test agent just did." For a sighted user the xterm panel
(`TerminalView.tsx`) covers this; for me the pane is invisible.

**Sketch.** Two new tools the model can call in response to my speech:
`read_pane_tail(pane_id, lines)` — returns the literal last N lines for verbatim read-back of an
error/stack trace; and `summarize_pane(pane_id, focus)` — returns a tight natural-language
summary ("focus" = errors | diff | last-command-result). Both reuse the redaction/delta logic
already behind `getPaneSummary` (`server.ts:614-619`). Tune the system instruction
(`server.ts:730`) so Janus prefers *spoken-friendly* phrasing (read error lines slowly, spell out
filenames). This makes "Janus, what went wrong in the build pane?" actually answerable by ear.

---

### NL-3. Voice-driven pane / project creation & full settings control — P0-aspirational, L

**Problem.** The model's toolset can list, summarize, switch, note, rename, and propose commands
(`server.ts:738-832`) — but it **cannot create a pane, create/delete a project, change a pane's
permission mode, mute the mic, or reconnect.** Every one of those is screen-only today:
`CreateTerminalDialog`, the per-pane permission `<select>` (`src/App.tsx:1199-1207`), the global
permission `<select>` (`src/App.tsx:680-689`), the mute/disconnect buttons
(`src/App.tsx:704-715`), `SettingsDialog`. Starting a *fresh* multi-agent session — the most
common complex workflow — currently *requires* the keyboard before voice can do anything.

**Sketch.** Add tools mirroring the existing REST/dialog actions:
`create_pane(name, tool_preset, cwd, permissions_mode)`, `create_project`, `delete_project`
(guarded, see NL-4), `set_pane_permissions(pane_id, mode)`, `set_global_permissions(mode)`,
`set_mic_muted(bool)`. Wire them into the `onmessage` tool dispatch
(`server.ts:604-721`) next to the existing handlers, reusing the same manager/ledger methods the
HTTP routes already call. Now "Janus, spin up a Claude Code agent in the api repo, human-in-loop"
works with zero clicks. This is the gating dependency for true hands-free *session setup*.

---

### NL-4. Confirmable spoken read-back before destructive / high-blast-radius actions — P0-aspirational, M

**Problem.** The screen UI protects destructive actions by forcing me to *type* "SURE" to delete
a project (round-one finding, `src/App.tsx:488-501`). That guard is exactly backwards for me — it
*mandates* the keyboard. But I still need protection: voice mis-recognition ("delete the *bin*
folder" heard as "delete the project") on a destructive op is catastrophic. The current
approval modal (`ApprovalDialog.tsx`) is also mouse/Enter only.

**Sketch.** A unified **spoken confirm protocol** for any destructive or auto-fire action
(delete project/pane, `rm`/`git reset`/force-push commands, switching a pane to Full Auto). Janus
*reads the action back verbatim* and waits for an explicit confirm phrase before executing:
*"You asked me to delete project Orbital and its 3 panes. Say 'confirm delete' to proceed."*
Require a **distinct, hard-to-misfire phrase** (not bare "yes"), with a short timeout that
auto-cancels. Implement as a server-side `pendingConfirmations` map paralleling `pendingApprovals`
(`server.ts:684`), plus a `confirm_action`/`cancel_action` intent the model resolves. This
replaces the typed-"SURE" gate (`src/App.tsx:488-501`) with a safe spoken equivalent and gives me
the "safe hands-free middle" that round one found missing entirely.

---

### NL-5. Spoken navigation + conversational focus context across panes — P1, M

**Problem.** I think in terms of *agents*, not IDs. The model has `switch_context` for projects
(`server.ts:620-626`) but no notion of a *currently-focused pane* for conversation, and no way for
me to say "go to the build agent" / "the second one" / "the Codex pane." Every reference forces
me (or the model) to disambiguate by pane_id. Across 4–5 agents that's exhausting by voice.

**Sketch.** Server-side **conversational focus state**: a `focusedPaneId` per session, set by a
`focus_pane(reference)` tool that resolves fuzzy spoken references ("build agent", "the Claude
one", ordinals) against `listPanes()` (`server.ts:609-610`) names/presets. Once focused,
bare commands ("re-run the tests", "what's it doing?") implicitly target it — Janus fills
`pane_id` from focus instead of asking. Surface the focused pane visually too (see UI-2). This is
what makes a *multi*-agent session navigable by voice instead of a list-recital exercise.

---

### NL-6. Audio earcons for state changes — P1, S

**Problem.** Sound is my status bar. Today there are zero non-speech audio cues; state lives in
colored dots and pulsing borders (`src/App.tsx:667-671`, `src/App.tsx:1128-1138`,
`isAlertActive`). I can't watch those. When an approval is pending, a build fails, or the socket
is reconnecting (`isReconnecting`, `src/App.tsx:391-409`), I get nothing audible — and I won't
always want a full spoken sentence interrupting me.

**Sketch.** A small earcon library in `src/utils/audio.ts` (alongside `playAudioChunk`,
`src/utils/audio.ts:20`): short distinct tones for *approval-pending*, *build-failed*,
*agent-idle/your-turn*, *connection-lost*, *reconnected*. Trigger from the WS `onmessage` cases
that already exist — `approval_pending` (`src/App.tsx:355`), `command_blocked`
(`src/App.tsx:378`), `onclose`/reconnect (`src/App.tsx:391`) — plus the new NL-1 events. Play them
on a **separate gain node** so they duck rather than collide with Janus's voice. Cheap, huge
quality-of-life: I learn the sound vocabulary and stop needing the screen for state.

---

### NL-7. Spoken status digest — "what needs me right now?" — P1, M

**Problem.** In a busy multi-agent session I lose the thread: which agents are blocked, which
finished, what's waiting on my approval. The data exists (pending approvals
`server.ts:684`, per-pane `is_busy`/`alive`/state from `listPanes` `server.ts:609-610`, the
amber alert set in the UI `src/App.tsx:1152`) but is only *visual*. There's no way to ask "where
do things stand?" and get a triage answer.

**Sketch.** A `get_attention_digest()` tool that aggregates across all panes: pending approvals
(read back the commands), failed/blocked agents, idle-waiting agents, and recently-finished work,
returned as a ranked spoken summary. Drive it from `listPanes()` + `pendingApprovals` +
the NL-1 event log. Bind to phrases like "what needs me?" / "status." Pairs with UI-3 (visual
attention queue). This is my standup-with-myself — the thing that lets me step away and come back
without reconstructing five panes by ear.

---

### NL-8. Wake-word / push-to-talk discipline + half-duplex turn management — P1, M

**Problem.** The mic streams continuously and the capture node is wired to `destination`
(`src/App.tsx:336`) over a shared context — round one flagged this as echo-prone with no
half-duplex muting while Janus speaks. For *me* the continuous open mic is also a
**false-trigger hazard**: I think out loud, I talk to coworkers, I cough. Without explicit
turn discipline, Janus will act on speech I never meant for it. Full barge-in is great; an
always-hot trigger is dangerous.

**Sketch.** Two complementary controls, configurable (NL-3 settings): (a) a **wake-word gate**
("Janus, …") so only addressed speech is acted on — implement client-side as a lightweight
keyword check before forwarding `{type:"audio"}` frames (`src/App.tsx:338-343`), or via a
command-mode toggle; and (b) **auto half-duplex**: while Janus is speaking, suppress sending mic
frames except for a designated barge-in word ("stop"/"wait") that triggers `resetAudioPlayback`
(`src/utils/audio.ts:57`). Add a hardware-key-free **voice push-to-talk** ("listen up" / "that's
all") as an alternative for noisy rooms. This makes the open mic *trustworthy*, which is the
precondition for me leaving it on all day.

---

## Visual / UI Improvements (in service of voice & accessibility)

These don't make the screen primary — they make the *occasional glance* and the *screen-reader
path* actually work, and give a helper/pair or a low-vision user a coherent view.

### UI-1. Persistent "whose turn is it / what is Janus doing" indicator — P0-aspirational, S

**Problem.** The only live-state surface is the "Gemini Voice" pill that toggles
LISTENING / MUTED / RECONNECTING / OFFLINE (`src/App.tsx:722-735`) and the header dot
(`src/App.tsx:667-671`). There is **no "Janus is speaking,"** no "Janus is thinking/executing,"
no "your turn." Round one noted I can't tell by eye *or* ear when it's my turn.

**Sketch.** Extend that pill into a first-class **conversational-state machine** display:
`LISTENING` / `JANUS SPEAKING` / `THINKING` / `EXECUTING` / `WAITING ON YOU` / `RECONNECTING`,
each with a distinct color and an `aria-live="polite"` region so screen readers announce
transitions. Derive `JANUS SPEAKING` from active audio sources (`activeSources` in
`src/utils/audio.ts:18`) and `THINKING/EXECUTING` from tool-call activity. Tiny change, but it's
the anchor a voice user (and a watching teammate) needs.

### UI-2. Live captions for the spoken channel (fix + elevate the voice log) — P1, S

**Problem.** Once transcription is enabled (round-one P1 fix), the existing "Janus Voice Log"
panel (`src/App.tsx:1430-1481`, fed by `transcript_text` at `src/App.tsx:383-387`) becomes my
*only* visual record of what was said — important when audio garbles or a teammate reads along.
But it's a side panel that's easy to miss and isn't a live caption.

**Sketch.** Add a **persistent caption bar** (last 1–2 lines, large high-contrast text) docked
above the system bar (`src/App.tsx:1484`), always visible, mirroring current Janus speech and my
recognized utterance in real time. Keep the full log panel for history. Mark the caption region
`aria-live` and the log as a `log` role. Closes the loop between ear and eye for me and makes the
session followable on a shared screen.

### UI-3. Attention queue — a visible list of decisions awaiting my voice — P1, M

**Problem.** Pending approvals are scattered as per-card amber alerts (`src/App.tsx:1152-1162`)
and `pendingCommands` state (`src/App.tsx:355-364`). With several agents, I can't see at a glance
*how many* decisions are queued or in what order — and the cards literally claim a voice-confirm
that didn't exist (`src/App.tsx:1159`). I need one ordered triage list.

**Sketch.** A single **Attention Queue** panel/strip listing every item needing a spoken
decision (approvals, confirmations from NL-4, blocked agents), newest-relevant first, each
showing pane, command, and the spoken phrase that resolves it ("say 'approve one'"). Back it with
`pendingApprovals` (`server.ts:684`) + the NL-7 digest data. This is the visual twin of NL-7 and
the honest replacement for the misleading per-card alert copy.

### UI-4. High-contrast / large-text mode + real ARIA & keyboard-free semantics — P1, M

**Problem.** The UI is gorgeous but hostile to accessibility: pervasive tiny type
(`text-[9px]`, `text-[10px]` throughout, e.g. `src/App.tsx:1141`, `src/App.tsx:1487`),
low-opacity gray-on-near-black (`opacity-30/40`), color-only status encoding (dots), and
interactive elements that lean on hover and raw `<select>`/`<input>` with no labels. For a
low-vision voice user or anyone on a screen reader, large swaths are unreadable/unnavigable.

**Sketch.** (a) A **high-contrast / large-text theme toggle** (also voice-settable via NL-3)
raising base font size and contrast ratios to WCAG AA, replacing color-only status with
text+icon. (b) An **accessibility pass**: `aria-label`s on icon buttons (mute/disconnect
`src/App.tsx:704-715`, copy buttons `src/App.tsx:1184`), labels tied to the permission selects
(`src/App.tsx:680-689`, `src/App.tsx:1199-1207`), `aria-live` on the notification toasts
(`autoApprovedNotification`/`blockedNotification`, `src/App.tsx:374-380`), and a logical focus
order so the rare keyboard interaction is possible. Foundational for "keyboard-free everything"
actually meaning everyone.

---

## Dependency / sequencing note

The spine is **NL-1 (push), NL-2 (read-back), NL-3 (voice setup), NL-4 (safe spoken confirm)**,
with **UI-1** as the cheap always-on anchor. Those four features are what convert Janus from
"voice demo that connects" into "I can run a five-agent session and never reach for the keyboard."
NL-5/6/7/8 and UI-2/3/4 make that session *comfortable and trustworthy* over a full workday.
