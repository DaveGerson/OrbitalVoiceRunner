# A Day in the Life with Janus — The Experiential Lens

> First-person narrative from a power operator who runs OrbitalVoiceRunner
> **hands-free / eyes-off**. I am driving / vision-impaired / away from the keyboard.
> My only channels are: what I **say** to Janus, what Janus **says back**, and the
> **earcons** the browser plays. The screen does not exist for me. Every friction
> point below cites the code-verified gap ID, not the marketing ideal.
>
> The arc: fan out a few agent panes (J1) → supervise as air-traffic control (J2)
> → review & approve by voice (J3) → promote a trusted pane to Full Auto (J5) → ask
> for status (J6) → dictate a spec from memory (J7) → narrate a pane walk-through
> (J8) → capture notes and hand off (J4). This is how the journeys actually compose
> **today**.

---

## 07:42 — Connecting and fanning out (J1)

I'm in the car. I tap Connect on my phone before I pull out of the driveway, grant
the mic, and start talking.

**(a) I say:** "Janus, create a project called auth-module at slash workspace slash
auth, and start a Claude Code pane on it in Human-in-the-Loop mode. Then create a
project called ui-revamp at slash workspace slash frontend and start a Codex pane
there, also Human-in-the-Loop for now."

**(b) Janus does:** Emits `create_project` then `create_pane` twice. Real OS child
processes spin up via `script -q -f -c` with a genuine PTY (`terminal.ts:220–316`).
The ledger writes atomically. Janus speaks: "Both panes are up — claude-auth under
auth-module, codex-ui under ui-revamp."

**(c) Smooth:** The spawn is real and concurrent. Two agents are genuinely running
in parallel. The spoken confirmation lands fast. This is the strongest moment of my
whole morning — it feels exactly like the pitch.

**(d) Friction — J1-G10 (and J1-G1):** A minute later I say "Tell Claude to start on
the JWT refresh flow." Janus hesitates, then says something like "I don't see a pane
called claude-auth." The system prompt was rendered **once** at connect time
(`server.ts:1568`) and froze the pane list at zero — the panes I *just* created are
invisible to the model until it re-calls `list_panes`. I have to say "list the
panes first" to wake it up. **Operator consequence:** I'm teaching the agent about
state it created thirty seconds ago. Eyes-on I'd never notice; eyes-off it reads as
Janus being forgetful and erodes my trust on the very first task. And because
voice-driven `switch_context` never updates the UI's `activeProjectId` (J1-G1), if
my passenger glanced at the phone they'd see the wrong project highlighted — but
that's invisible to me, so I sail past it unaware.

---

## 08:05 — Air-traffic control (J2)

Both panes are in Human-in-the-Loop. This is the safety harness I came for: nothing
executes without my clearance. I'm watching the road, not the screen.

**(a) I say:** "Janus, what needs my attention across everything?"

**(b) Janus does:** Calls `get_attention_digest` (`server.ts:1360–1373`). It scans
`attentionQueue` — error/exit/build-failed transitions only.

**(c) Smooth:** When a build genuinely fails, the error heuristics catch the common
shapes and Janus reads them back. The earcon fires reliably on new items.

**(d) Friction — J2-G2 / J2-G3 / J3-G8:** I asked "what needs my attention?"
expecting to also hear what's **queued for approval**. But `get_attention_digest`
and the `pendingApprovals` map are entirely separate structures. Worse, the tool's
own description claims it covers "approvals" — so Janus calls it confidently and
tells me "Nothing needs your attention right now" while two commands sit frozen and
waiting for my voice. **Operator consequence:** I'm being told the runway is clear
while two planes are stacked in the pattern. There is *no* voice-queryable way to
ask "what's waiting for me?" I only learn about pending commands from the earcon at
the moment they were proposed — and if I missed that earcon (road noise, talking to
a passenger), the proposal is effectively silent and I have no recovery path by ear.

**(d) Friction — J2-G1 (the big one):** When Claude *does* propose a command, here's
what actually happens: the Gemini session is hard-blocked at the tool-call level the
instant `propose_command` enters the Human-in-the-Loop branch. Janus **cannot speak
while an approval is pending.** I get a two-tone sawtooth earcon and then... silence.
Janus is mute. It cannot tell me what it wants to run. **Operator consequence:** I'm
driving, I hear an alert tone, and that is the *entire* signal. I have no idea if
it's a harmless `npm install` or `rm -rf`. To find out I'd have to look at the
screen — which defeats the whole product.

---

## 08:09 — Review & approve by voice (J3)

This is where the eyes-off promise either holds or collapses. It mostly collapses.

**(a) I say** (guessing, because Janus won't tell me what's pending): "Janus, what
is the command you want to run?"

**(b) Janus does:** It can't answer cleanly — the proposed command string was never
sent back to the model (the tool response is deliberately withheld,
`server.ts:1334`), and there's no `get_pending_commands` tool. Janus either improvises
from stale conversation context or calls `get_pane_command_history`, which (see J4
below) returns garbage.

**(d) Friction — J3-G1:** Janus never vocalizes the proposed command before asking
me to approve it. There is no TTS hook on `approval_pending` and no system-prompt
instruction to speak the command aloud. **Every voice approval I give is a blind
approval.** I am saying "go ahead" to a command I have never heard.

**(a) I say:** "Go ahead."

**(b) Janus does:** The voice intercept (`server.ts:1127–1184`) substring-matches my
"go ahead," filters pending entries for my session, and resolves `pendingEntries[0]`
— the **oldest** entry, regardless of which pane I meant.

**(d) Friction — J3-G3 / J2-G7:** I have two panes with pending commands. I *wanted*
to approve the Codex one I was just thinking about. But "go ahead" always fires the
first-inserted entry — which is the Claude command from earlier. **Operator
consequence:** I just executed the wrong command on the wrong pane, by voice, with
no spoken confirmation of *which* pane or command I actually resolved. Eyes-off, I
believe I approved one thing; the system did another. This is the single most
dangerous seam in my morning.

**(d) Friction — J3-G2 / J3-G5:** Later I mutter to my passenger, "no, I don't want
to cancel the build, let it run" — and the bare substring `cancel` in my sentence
trips the reject path and kills a pending command I wanted. There's no negation
detection. Conversely, when I genuinely say "don't run that," Gemini's transcription
drops the apostrophe to "dont run," which isn't in the keyword list, so my rejection
silently does nothing and the command stays pending. **Operator consequence:** my
natural speech, narrated aloud while driving, is a minefield — incidental trigger
words fire real executions, and my actual intent sometimes registers as nothing at
all.

---

## 08:31 — Promoting a trusted pane to Full Auto (J5)

The Codex UI pane has been behaving. I trust it. I want it to stop asking.

**(a) I say:** "Janus, set the codex-ui pane to Full Auto, I trust it."

**(b) Janus does:** Calls `set_pane_permissions` (`server.ts:1542–1557`). Updates the
live terminal object and the ledger. Speaks: "Safety permission mode for pane
codex-ui updated to Full Auto successfully."

**(c) Smooth-sounding:** The confirmation is crisp and confident. I relax.

**(d) Friction — J5-G1 (silent no-op):** Earlier in the week I'd pinned my **global**
permission mode to Human-in-the-Loop as a safety blanket. Because the global is not
`Inherit`, the effective-mode resolver (`server.ts:1272–1275`) never even reads the
pane's mode. My promotion to Full Auto is written to disk and to the runtime object
and has **zero effect** on command gating. Janus said "successfully." It lied —
not maliciously, but because the handler never checks the global. **Operator
consequence:** I now believe codex-ui is autonomous. It isn't. The next time it
proposes a command I'll be confused about why I'm being asked to approve something I
explicitly trusted. The reverse bites too: if global were pinned to Full Auto, a
panic "lock this pane down" would *also* be a confident-sounding no-op.

**(d) Friction — J5-G3:** Even setting the global aside, the mode change emits only a
silent `terminals_updated` event — no earcon, no distinct sound, and Janus doesn't
echo the prior state. So I can't even tell by ear that "changed-and-effective"
differs from "changed-but-overridden." They sound identical: a confident "done."

**(d) Friction — J5-G2 / J5-G9:** Suppose the global *were* Inherit and the promotion
took. For a Claude Code or Codex preset, Full Auto needs `--dangerously-skip-permissions`
injected, which only happens on **restart** — and there is no `restart_pane` voice
tool. **Operator consequence:** I'm stranded mid-journey. Janus can flip the flag in
the stored command string but cannot relaunch the process hands-free. To actually
complete the promotion I'd have to reach for a keyboard, which I cannot do. The
eyes-off contract breaks right here.

---

## 09:15 — Status check on the move (J6)

A while later I want a pulse on everything.

**(a) I say:** "Janus, what's running right now and what's done?"

**(b) Janus does:** Calls `list_panes`, which runs `syncLedger()` first
(`terminal.ts:564–591`) and reports each pane's `is_busy` / `alive`.

**(c) Smooth:** `alive` is trustworthy — it's driven by real process exit/close
events. If a pane died, Janus tells me, and it's right.

**(d) Friction — J6-G1 / J6-G2 (false idle):** Claude-auth is two minutes into a
TypeScript compile — genuinely busy, just quiet. But `is_busy` flips to false after
**one second** of output silence (`terminal.ts:179–188`), and *any* line ending in
`$`, `#`, `>`, or `?` — which AI agent output and code blocks are full of — instantly
marks the pane "Idle." **Operator consequence:** Janus tells me "claude-auth is idle,
finished" while it's mid-build. I might fire the next task on top of a still-working
agent, or assume work is done that isn't. The central field of the status journey is
untrustworthy for anything slower than a trivial command.

**(d) Friction — J6-G4 / J6-G5:** There's no elapsed-time data, so even when a pane
*is* correctly "running," Janus can't tell me if it's been 4 seconds or 40 minutes —
I can't spot a hung pane by ear. And nothing is **proactive**: the `onIdle` and
error-detection machinery exists server-side but never pushes audio to Janus.
**Operator consequence:** I have to keep asking. The whole eyes-off premise is that I
*don't* watch — but Janus only ever speaks when spoken to. A build finishing or
crashing while I'm focused on the road is something I will simply never hear about
until I think to ask.

---

## 10:40 — Dictating a spec from memory (J7)

Stuck at a light, I remember a requirement. I want it captured before it evaporates.

**(a) I say:** "Janus, note for the auth module: the auth service must support PKCE,
not implicit flow; the token endpoint must reject grant_type password; refresh
window is thirty days."

**(b) Janus does:** Calls `add_project_note` (`server.ts:1336–1341`) →
`Ledger.addNote` → synchronous atomic write to `.janus_ledger.json`. Speaks "Noted."

**(c) Smooth:** This is genuinely solid. The explicit note write is durable, atomic,
survives restart. My full spoken sentence is stored verbatim — no truncation on this
path. Of everything this morning, deliberate note capture is the most reliable thing
Janus does.

**(d) Friction — J7-G5 / J7-G7:** Ten minutes later: "Janus, remind me what I just
noted about the token endpoint." Janus can't. Notes only re-enter its context via
`switch_context`'s full briefing — there is no lightweight `get_project_notes` or
`search_notes` tool, and the note content was never injected into the live session.
**Operator consequence:** I dictated it *to* Janus, it confirmed, and now it can't
recall it without a full context reset. The memory feels write-only. I end up
re-dictating to be safe — which risks a near-duplicate note I can never delete by
voice (J7-G4: no delete/amend tool exists at all).

**(d) Friction — J7-G6:** When I say "note this on the *current* pane," Janus has to
guess which pane is active — the client's `activeTerminalId` is never sent to the
server or injected into the prompt. So it either asks me to name the pane (friction)
or attaches the note to the wrong one (silent error). And if it picks a stale pane
ID, the note is **silently dropped** while Janus still says "note added" (J8-G10).

---

## 11:20 — Narrating a pane walk-through (J8)

The auth build finished (I think — see J6). I want Janus to read me what happened.

**(a) I say:** "Janus, walk me through what claude-auth has been doing."

**(b) Janus does:** Calls `get_pane_summary` (`terminal.ts:593–599`). Returns the
last 20 ANSI-stripped lines of the in-memory buffer, wrapped in a code fence. Janus
reads them aloud.

**(c) Smooth:** ANSI stripping is clean, so I don't hear color codes spoken. For a
short, recent output it's a reasonable read-back.

**(d) Friction — J8-G6 (audio-hostile):** What I actually hear is raw log noise read
syllable by syllable — timestamps, module paths, progress fragments. There's no
semantic extraction of errors/warnings/exit codes before it reaches Janus. Eyes-on
you skim; eyes-off I have to *listen* to every token. The "coherent narration" ideal
is just Gemini improvising over a raw slice.

**(d) Friction — J8-G4 / J8-G5:** The build produced ~200 lines; I only get the last
20. The errors that mattered scrolled out of the window, and there's no offset,
range, or `search_pane_output` tool to go back — the 512 KB scrollback file exists
but `get_pane_summary` never reads it. Then I ask "anything new since you checked?"
and Janus re-reads the **identical** 20 lines, because there's no delta cursor
despite the tool literally being described as a "delta." **Operator consequence:** I
can't tell if the build progressed. Every check-in sounds the same, so the
narration tells me nothing about change — the exact thing I wanted to know.

**(d) Friction — J8-G1 (security, invisible to me):** If that build printed a token
or a `.env` value, it went **verbatim** to Gemini — no redaction, despite the tool
description promising "redacted." Eyes-off, I have no idea this happened, and the
model has no reason to warn me because it was told the output was already clean.

---

## 11:35 — Capturing decisions and handing off (J4)

Wrapping up. I want a durable hand-off so my future self (or a teammate) can resume.

**(a) I say:** "Janus, summarize what claude-auth did and hand off context to the
codex-ui pane. And brief me on where auth-module stands."

**(b) Janus does:** For the brief, `switch_context` → `getProjectBriefing` returns
notes, summary, directory, pane metadata. For the hand-off,
`handoff_context_between_panes` pulls the last 5 history entries, builds a string,
saves it as a pane note, and injects a `#`-comment block into codex-ui's stdin.

**(c) Smooth:** The briefing's note array and pane metadata come back intact, and my
durable notes from 10:40 are in there. The hand-off note *does* persist to the
ledger.

**(d) Friction — J4-G3 / J1-G2 (the poison at the center):** Every command-history
`finalResponse` is the string **"Execution finished successfully."** — because
`summarizeCommandOutcome` calls a model name that doesn't exist (`gemini-3.5-flash`)
and silently falls back. **Operator consequence:** When Janus "summarizes what
claude-auth did," it's reading me "Execution finished successfully" for every step —
even the steps that failed. The hand-off packet built from those same entries is
contaminated with the identical placeholder. My hand-off literally says everything
succeeded when the build was broken. This is worse than no summary: it's a confident
false one.

**(d) Friction — J4-G5:** The "hand-off" I asked for isn't a document. It's a bash
comment shoved into codex-ui's stdin (which scrolls away in seconds, and which Claude
Code would try to *run* as a shell command per J1-G12) plus one untagged note
indistinguishable from any other. There's no named, dated, retrievable artifact.
**Operator consequence:** Tomorrow I cannot say "show me yesterday's hand-off" —
there's nothing to retrieve by name. The continuity I think I just created is mostly
vapor.

**(d) Friction — J4-G6:** And if the server bounces overnight, the Gemini session
resumption token (in-memory only) is gone. My notes survive on disk, but Janus's
live conversation memory resets to zero. Tomorrow's "pick up where we left off" is
actually "start over and re-brief from scratch."

---

## Where the seams show

These are the moments **between** journeys where the handoff fails — not bugs within
a single journey, but places where one journey's output is the next journey's broken
input:

1. **Fan-out → everything (J1-G10 / J1-G1):** Creating panes (J1) doesn't refresh
   Janus's awareness, and voice context switches never move the UI. So every
   downstream journey (supervise, approve, status) starts from a model that may not
   know the panes exist. The seam is that structural changes don't propagate to the
   two things that need them: the model's context and the screen.

2. **Supervise → review (J2-G1 + J3-G1):** The pending-approval state is the bridge
   from "agent proposed something" to "I decide." But Janus goes **mute** the moment
   a command is pending and never speaks the command. The handoff between noticing a
   proposal and reviewing it is pure silence + an undifferentiated earcon. Eyes-off,
   this is the seam that turns the safety harness into a blindfold.

3. **Review across multiple panes (J3-G3 / J2-G7):** When more than one pane has a
   pending command — the *normal* fan-out state — "approve" resolves the oldest, not
   the one I meant, with no spoken confirmation of which. The seam between "I supervise
   N agents" and "I approve a specific one" is where a voice command silently lands on
   the wrong runway.

4. **Promote autonomy → it actually takes effect (J5-G1 / J5-G9):** A global override
   can silently nullify my per-pane promotion, and even when it takes, completing it
   needs a restart with no voice tool. The seam between "I said trust this pane" and
   "this pane is actually trusted" is a confident "done" over a no-op.

5. **Status → action (J6-G1 / J6-G5):** Status (J6) feeds every decision, but
   `is_busy` lies on any non-trivial workload and nothing is proactive. The seam is
   that I act on "it's idle/done" when it isn't — chaining a false status into a wrong
   next move — and I'm never told about completions or failures unless I ask.

6. **Capture → hand-off / re-brief (J4-G3 / J1-G2):** The dead summarizer model poisons
   the shared spine — command history, status summaries, and hand-off packets all read
   "Execution finished successfully" regardless of reality. The seam between "what
   happened" (J6/J8) and "record it for next time" (J4) is where truth is replaced by
   a fixed placeholder, and the hand-off (J4-G5) leaves no retrievable artifact behind.

7. **Spec capture → recall (J7-G5 / J7-G7):** I can dictate a note (J7, durable) but
   cannot recall or search it by voice within the session, nor delete a mistaken one.
   The seam between "I told Janus" and "Janus remembers" is a one-way door: notes go
   in, but the only way back out is a full `switch_context` reset.

---

*Bottom line for the architect: the journeys each work in isolation about as well as
their gaps files claim, but they do **not** chain. The recurring failure pattern is
that the connective tissue — model context propagation, the spoken layer over pending
state, multi-pane targeting, effective-permission truth, proactive push, and a real
history summary — is exactly what's missing. Each individual journey assumes the
operator can see a screen to recover; eyes-off, the seams between them are where work
is silently lost or misdirected.*
