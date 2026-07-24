# Voice-First Assessment — Orbital Harness / Janus Terminal Orchestrator

> ⚠️ **HISTORICAL ASSESSMENT — round one, 2026-05-28. SUPERSEDED — DO NOT READ AS CURRENT FACT.**
> This review's headline blockers (no voice-approval path, dead transcripts, blind approvals,
> orphaned approvals) were RESOLVED on `main` after PR134. The prose below is preserved as a
> historical artifact, not a current assessment. For the current forward wishlist, see
> `docs/roadmap/next-level/`.

**Reviewer persona:** Sam Rivera, voice-first developer. I drive my dev work by speech, often
away from the keyboard (RSI). I do not care about how pretty the UI is — I care whether the
loop *mic → PCM → WebSocket → Gemini → audio back + tool calls* actually closes, whether I can
interrupt the model, whether errors reach my ears, and whether I ever get yanked back to the
mouse. A voice product is only real if I can finish a task without touching anything.

---

## Methodology

I read the whole codebase, not skimmed it:

- `README.md`, `SETTINGS_SPEC.md`
- `server.ts` (1–916, the `/live` WebSocket + Gemini Live wiring)
- `src/utils/audio.ts`, `src/utils/api.ts`
- `src/App.tsx` (1–1561, mic capture, WS handling, playback wiring)
- `src/components/ApprovalDialog.tsx`, `CreateTerminalDialog.tsx`, `SettingsDialog.tsx`, `TerminalView.tsx`
- `src/terminal.ts`, `src/ledger.ts`, `src/types.ts`
- `tests/test_server.ts`, `tests/test_approvals.ts`

I ran the tooling:

- `npm run lint` (`tsc --noEmit`) → **exit 0, clean.**
- `npm test` (`tsx --test tests/*.ts`) → **13 pass, 0 fail.**

I cannot run a real mic/browser in this environment, so all loop-completeness claims below are
traced from the code itself. Where I make a runtime claim I cite `file:line`.

---

## 1. Does it work? (Is the voice/audio pipeline complete and correct?)

Short version: the loop is *wired end-to-end on the happy path*, but it has at least one
flat-out **playback bug that will make Janus sound like a chipmunk**, the **transcript panel I'd
rely on for accessibility is almost certainly dead**, and the **interruption/barge-in handling is
half-built**. It is a demo that mostly connects, not a finished voice instrument.

### What is actually present and correct

- **Mic capture → PCM → WS upstream is real and correct.** `getUserMedia` →
  `createMediaStreamSource` → `ScriptProcessorNode(4096)` → `onaudioprocess` encodes the
  Float32 buffer to little-endian int16 base64 and sends `{type:"audio"}` frames
  (`src/App.tsx:327-343`, `src/utils/audio.ts:1-15`). The capture `AudioContext` is forced to
  `sampleRate: 16000` (`src/App.tsx:319`), and the server forwards to Gemini with
  `mimeType: "audio/pcm;rate=16000"` (`server.ts:851-853`). Upstream sample rate is consistent.
  Good — my voice gets there.
- **Server → Gemini session is real.** `sessionAi.live.connect` with `responseModalities:
  [Modality.AUDIO]` and a `prebuiltVoiceConfig` voice (`server.ts:541, 725-729`). Tool
  declarations are all present and the `onmessage` handler dispatches every tool
  (`server.ts:604-721`).
- **Downstream audio frames are forwarded.** Model audio is pulled from
  `modelTurn.parts[0].inlineData.data` and sent as `{type:"audio"}` (`server.ts:595-598`), and
  the client decodes/plays it (`src/App.tsx:351-352` → `playAudioChunk`).
- **Tool-call execution path works** for `list_panes`, `get_pane_summary`, `switch_context`,
  notes/renames, and `propose_command` gated by permission mode (`server.ts:609-720`). Tests
  cover the terminal/orchestrator layer and pass.

### Bug 1 — Playback sample-rate mismatch (HIGH, audible, certain)

`playAudioChunk` builds its `AudioBuffer` at **24000 Hz**
(`src/utils/audio.ts:30`: `audioCtx.createBuffer(1, pcm16.length, 24000)`), with a comment
correctly noting "Gemini Live PCM out is typically 24000Hz". But the `AudioContext` it plays
into was constructed at **16000 Hz** (`src/App.tsx:319`). A buffer's `sampleRate` field is the
rate of the *samples in the buffer*; the Web Audio engine resamples it to the context rate on
playback. Here the data is genuinely 24 kHz but the surrounding context is 16 kHz, and the same
context is shared for capture and playback. The practical result is pitch/speed distortion and
timing drift in Janus's voice — exactly the thing a voice-only user cannot tolerate, because the
*spoken channel is my only output*. This isn't a theoretical nit; it's the core output path.

Worse, `nextStartTime` scheduling (`src/utils/audio.ts:54`, `nextStartTime += buffer.duration`)
computes `buffer.duration` from the 24 kHz buffer while the context runs at 16 kHz, so the gap-
free scheduling math is also off — expect overlaps or gaps between chunks.

### Bug 2 — The transcript panel is almost certainly dead (HIGH for accessibility)

The whole "Janus Voice Log" panel (`src/App.tsx:1430-1481`) and the `transcript_text` events
(`server.ts:577-592`) are my only *visual* fallback for what was said — important when audio is
garbled or I'm reviewing. But the server only emits transcript text from
`modelTurn.parts[].text` / `turn.parts` / `userTurn.parts` (`server.ts:555-575`). The session is
configured with `responseModalities: [Modality.AUDIO]` **only** and **no
`inputAudioTranscription` or `outputAudioTranscription` config** (confirmed: those keys appear
nowhere in `server.ts`). In Gemini Live, audio-only responses do not populate `part.text`, and
user/model transcripts require explicitly enabling transcription. So in practice both the User
and Janus transcript streams will be empty almost all the time. The UI even advertises
"Speak to Janus ... to stream transcripts" (`src/App.tsx:1451`) — a promise the wiring doesn't keep.

### Bug 3 — Interruption / barge-in is only half-handled (MEDIUM-HIGH)

Barge-in matters enormously to me: when Janus is mid-sentence and I start talking, the old audio
must stop. The server does forward `serverContent.interrupted` (`server.ts:599-601`) and the
client calls `resetAudioPlayback()` on it (`src/App.tsx:353-354`), which stops active sources and
resets `nextStartTime` (`src/utils/audio.ts:57-67`). That part is plausibly correct **if** the
model emits an interruption signal. But:

- The mic stream runs continuously and is fed straight to Gemini with no client-side VAD or
  echo cancellation beyond the browser default. The `processor` is also connected to
  `audioCtx.destination` (`src/App.tsx:336`) — a ScriptProcessor passthrough — which combined
  with the shared 16k/24k context is a recipe for the mic re-capturing playback (echo), and
  there's no half-duplex muting while Janus speaks. So barge-in detection leans entirely on
  Gemini's server VAD with a feedback-prone audio path.
- There is no audible or even visual "Janus is speaking now" state; `isLive` only toggles
  LISTENING/MUTED/RECONNECTING (`src/App.tsx:723-735`). I can't tell by ear *and* eye when it's
  my turn.

### Bug 4 — `pendingApprovals` is never cleaned up on disconnect (MEDIUM; tests lie about this)

`tests/test_approvals.ts:44-72` asserts an `onCloseCleanup` that purges pending approvals tied to
a closed session, with a comment "(as added in server.ts)". **It was not added to server.ts.**
The real `clientWs.on("close")` handler (`server.ts:864-877`) closes the Gemini session but never
touches `pendingApprovals`. The test passes because it tests a *local mock*, not the real handler.
For me this means: if my connection drops while an approval is pending (and the client *auto-
reconnects* — `src/App.tsx:391-409`), the stale approval lingers server-side bound to a dead
session; approving it later hits `pending.session.sendToolResponse` on a closed session (guarded
by try/catch at `server.ts:472-482`, so no crash, but the command may still be written to the
pane at `server.ts:471` while the model never learns the real outcome). Ledger/approval state and
the model's belief diverge. That's the kind of silent desync that wrecks a hands-free session.

### Smaller correctness notes

- **No audible error reporting.** Connection failure sends `{type:"error", message:...}`
  (`server.ts:838-842, 510`) but the client `onmessage` (`src/App.tsx:349-389`) **has no `error`
  case** — the message is silently dropped. As a voice user I'd hear *nothing* when my Gemini key
  is bad or the socket is rejected; I'd just sit in "LISTENING..." forever. This is a serious
  gap: errors are not surfaced on the one channel I use.
- **`sessionResumption` token handling is shaky.** `lastSessionResumptionToken` is captured
  (`server.ts:546-548`) and read at connect time (`server.ts:731-732`), but it's a single
  module-level global shared across all clients and only applied at the *next* connect — fine for
  a single local operator, fragile otherwise.
- The 16 kHz capture context is non-standard (most browsers default 44.1/48k); forcing 16k can
  fail or get silently overridden on some browsers, but that's environment-dependent.

---

## 2. Does it support the intended voice-first workflow?

This is where it falls down for *me specifically*. The product's headline is "DRIVE real
development work hands-free by voice." I cannot.

### The approval gate forces me back to the keyboard/mouse — by design

`propose_command` in the default/`Inherit` → `Human-in-the-Loop` mode (`server.ts:631-695`)
parks the command and fires `approval_pending`. The only way to approve is the
**`ApprovalDialog`**, which is a mouse/keyboard modal: click "Confirm & Fire" or press
**Enter/Escape** (`src/components/ApprovalDialog.tsx:21-34, 68-81`). There is **no voice approval
path** anywhere in the code — no "confirm"/"yes" intent, no tool for the model to self-confirm,
nothing. The dashboard card even taunts me: *"Execute with voice 'Confirm' or hit the approve
trigger below"* (`src/App.tsx:1159`) — but **that voice-confirm feature does not exist.** Grepping
confirms no handler maps a spoken "confirm" to `handleApprove`. So in the *default* security
posture, every single command Janus proposes requires my hand on Enter. That is the opposite of
hands-free.

My only hands-free option is to flip everything to **Full Auto** (`server.ts:638-654`), which
runs commands immediately with `--dangerously-skip-permissions` baked into agent presets
(`src/terminal.ts:96-99`). So the choice the tool actually offers me is: *type to approve every
command*, or *give a voice agent unsupervised root-equivalent shell on my machine*. There is no
safe hands-free middle, which is precisely what a voice-first approval UX needs (spoken
read-back + spoken confirm).

### I can't hear what's happening in my panes

Pane stdout streams to the **UI** as `stdout_chunk` and renders in xterm (`server.ts:199-204`,
`src/App.tsx:381-382`, `TerminalView.tsx`). It is **never spoken**, never summarized aloud, and
not even pushed to Gemini proactively. The model only learns pane state when *it* decides to call
`get_pane_summary` (pull, not push — `server.ts:761-763`). So if a build fails or a command hangs,
I won't hear it; I'd have to *ask* Janus to look, and Janus only looks if it chooses to. For a
sighted keyboard user that's fine. For me, the pane is invisible. The "feedback loop tells you
what's happening in the panes" requirement is unmet on the audio channel.

### Other forced-to-screen moments

Essentially every management action that isn't a tool call is screen-only:
- Creating a node: the `CreateTerminalDialog` form (`src/components/CreateTerminalDialog.tsx`).
- Project create/rename/delete and pane notes use `GenericPromptModal` text inputs and a typed
  `"SURE"` confirmation to delete (`src/App.tsx:463-558, 488-501`).
- Settings, API key, voice selection — all in the `SettingsDialog` form.
The voice agent *can* rename/note/switch context via tools, but cannot create panes, change
permissions, mute itself, reconnect, or clear a stuck approval by voice.

### The auto-reconnect is silent and could fight me

On unexpected close the client auto-reconnects every 3s (`src/App.tsx:391-409`) and rebuilds the
whole mic graph. There's no audible "reconnecting" cue (the `error` case is dropped, see above),
and a fresh Gemini session means lost conversational context unless resumption happens to work.
Mid-task, I'd be talking into a void during the gap with no idea the session bounced.

---

## Severity-ranked concerns

| # | Severity | Concern | Evidence |
|---|----------|---------|----------|
| 1 | **Critical (workflow-defeating)** | No voice approval path; default mode requires keyboard Enter for every command. UI claims voice-confirm exists; it does not. | `ApprovalDialog.tsx:21-34,68-81`; `App.tsx:1159`; `server.ts:678-695` |
| 2 | **High** | Playback sample-rate mismatch (24k buffer in 16k context) → distorted/pitch-shifted Janus voice + broken chunk scheduling. | `audio.ts:30,54`; `App.tsx:319` |
| 3 | **High** | Transcript panel almost certainly always empty — no input/output transcription configured, audio-only modality. Kills my visual fallback. | `server.ts:555-592,725-729`; `App.tsx:1430-1481` |
| 4 | **High** | Pane output is never spoken/summarized aloud and not pushed to the model; I'm deaf to what my terminals do. | `server.ts:199-204,761-763`; `App.tsx:381-382` |
| 5 | **High** | Errors/disconnects are not surfaced audibly or visually — `error` WS message has no client handler. | `server.ts:510,838-842`; `App.tsx:349-389` |
| 6 | **Medium-High** | Barge-in relies on server VAD over an echo-prone full-duplex path (processor → destination, shared context, no half-duplex mute). | `App.tsx:336,353-354`; `audio.ts:57-67` |
| 7 | **Medium** | `pendingApprovals` not cleaned on WS close; test asserts a cleanup that isn't in `server.ts`. State desync on reconnect. | `server.ts:864-877`; `tests/test_approvals.ts:44-72` |
| 8 | **Medium** | Only-hands-free option is Full Auto with `--dangerously-skip-permissions`; no safe spoken middle ground. | `server.ts:638-654`; `terminal.ts:96-99` |

---

## Bottom line — Can I actually work hands-free with this today?

**No.**

The pipeline *connects* — my mic reaches Gemini and audio comes back — and the orchestrator/tool
layer is genuinely functional and tested. But as a voice-first developer I am blocked on three
independent show-stoppers, any one of which is disqualifying:

1. **I can't approve commands by voice.** In the default safe mode, every proposed command
   demands a physical Enter press. The code literally tells me to say "Confirm," then provides no
   code that listens for it. My only hands-free escape is handing a voice agent unsandboxed shell
   access. That is not a hands-free workflow; it's a keyboard workflow with a microphone bolted on.
2. **The one output channel I depend on is broken or mute.** Janus's voice is played at the wrong
   sample rate (distorted), the transcript fallback is dead, errors never reach me, and my panes
   never speak. When something goes wrong — which is most of real dev work — I'm flying blind and
   deaf.
3. **Barge-in is built on a feedback-prone, full-duplex audio path** with no half-duplex
   discipline, so even the interruption handling that exists is unreliable in practice.

It reads like a UI-first build that wired the voice transport correctly but never closed the loop
for someone who *only* has voice. The plumbing is real; the experience is not. Until command
confirmation, error reporting, and pane state all live on the audio channel — and the playback bug
is fixed — this is a half-wired demo, not a tool I could run a coding session on without my hands.
