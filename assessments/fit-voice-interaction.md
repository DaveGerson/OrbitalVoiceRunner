# Fit-for-Use Assessment — Voice as the Interaction Modality

**Reviewer:** Lena Brooks — Conversational-Voice / Real-Time-Interaction Designer-Engineer
(Alexa, voice assistants, live audio agents)
**Single question I'm here to answer:** Is *voice* actually the right, working modality for this system's core goal — steering 4–6 agent terminals hands-free — and does the implementation deliver a usable conversational loop?
**Lens:** fit-for-use of the voice interaction against the goal. NOT a generic frontend review.
**Scope read:** `src/App.tsx`, `src/utils/audio.ts`, `server.ts`, `src/components/ApprovalDialog.tsx`, `SETTINGS_SPEC.md`. Prior `frontend-ux-assessment.md` and `implementation-roadmap.md` skimmed for grounding — I do not restate their mechanics; I judge the *conversation*.
**Method:** analysis only — no code modified except this file.

---

## Executive Verdict

The conversational loop is **architecturally present but acoustically and behaviorally broken for hands-free use**, which is the one mode the product promises. The good bones are there: a barge-in/interrupt path (`App.tsx:213-214`), scheduled chunked playback (`audio.ts:39-44`), and a sensible "propose → approve" tool gate. But the capture context runs at 16 kHz while playback declares a 24 kHz buffer through that same 16 kHz context (`App.tsx:184`, `audio.ts:29`) — the agent's own voice plays back chipmunked and time-warped; with `getUserMedia({ audio: true })` requesting **no echo cancellation** (`App.tsx:190`) and the **raw mic wired straight to the speakers** (`App.tsx:199`), an open-mic no-headphone operator will have Janus hear itself, barge-in on itself, and spiral. Worse for trust: the Mute button is a stale-closure no-op (`App.tsx:201-206`) — it streams while displaying "MUTED". And the loop is a **black box**: there is no transcript of what Janus heard, no "you're being heard" level meter, no "agent is speaking" state, no surfacing of *why* it proposed a command. Voice is genuinely right for *issuing intent* and *receiving glanceable status*, but it is the wrong tool for the safety-critical act this system centers on — approving a literal shell command — and there is no robust multimodal fallback wired in.

**Readiness rating: Demo-only** (headphones + one pane + a forgiving demo script). Not pilot-ready until echo, mute, sample-rate, and approval-confirmation-loop are fixed.

---

## 1. Conversational loop quality — laggy and pitch-broken, not fluid

**Capture vs playback sample rate is mismatched at the context level.** The single `AudioContext` is pinned to 16 kHz (`App.tsx:184`: `new AudioContext({ sampleRate: 16000 })`). Playback then builds a buffer *declared* at 24 kHz inside that same context (`audio.ts:29`: `audioCtx.createBuffer(1, pcm16.length, 24000)`). A Web Audio context renders at its own `sampleRate`; a 24 kHz buffer pushed through a 16 kHz context is resampled — Gemini's reply comes out **pitch-shifted and time-distorted**, and chunk-boundary timing (`nextStartTime += buffer.duration`, `audio.ts:44`) drifts because `buffer.duration` is computed against the wrong rate. The agent literally does not sound like Zephyr. For a voice product, the persona being audibly wrong is a first-impression failure, not a nitpick.

**Capture latency from the ScriptProcessor block is conversationally significant.** `createScriptProcessor(4096, 1, 1)` (`App.tsx:195`) buffers 4096 frames before `onaudioprocess` fires. At 16 kHz that's **256 ms** of latency added *before a single byte leaves the browser*, on the main thread, contending with React re-renders that fire on every `stdout_chunk` (`App.tsx:237-247`). Add network + Gemini round-trip + the playback scheduling tail and end-of-turn-to-first-audio will routinely exceed the ~300–500 ms ceiling where dialogue stops feeling like conversation and starts feeling like walkie-talkie. `AudioWorkletNode` with a 128-frame quantum is the modern path; this is the deprecated one.

**Turn-taking relies entirely on Gemini server-side VAD with zero client cooperation.** There is no client endpointing, no push-to-talk, no "user is speaking" / "agent is speaking" state machine. The client streams continuously whenever `ws.readyState === OPEN && !isMicMuted` (`App.tsx:202`). All turn detection is delegated to Gemini, and the only turn signal the client honors is `interrupted` (`App.tsx:213`). That's a thin contract: the operator has no local sense of whose turn it is.

**Barge-in is correct in shape but undermined by the audio path.** On `interrupted`, `resetAudioPlayback()` zeroes `nextStartTime` (`audio.ts:47-49`) so already-scheduled chunks stop advancing — the right instinct. But `resetAudioPlayback()` does **not stop already-started `AudioBufferSourceNode`s**; `source.start(nextStartTime)` (`audio.ts:43`) fires nodes that keep playing to completion. So on barge-in the operator keeps hearing the tail of Janus's previous sentence for up to one chunk-duration while their new utterance is being captured — audible overlap, exactly the glitch barge-in is supposed to eliminate. A real implementation tracks live source nodes and calls `.stop()` on them.

**Verdict (1):** Not fluid. Pitch-wrong output, ~256 ms+ baseline capture latency, and an incomplete barge-in cut. Sounds like a glitchy walkie-talkie, not a conversation.

---

## 2. Echo / feedback — hands-free (no headphones) is not viable as built

This is the finding that most directly answers "is voice the right working modality." Three compounding defects:

1. **No echo cancellation requested.** `getUserMedia({ audio: true })` (`App.tsx:190`) passes no constraints — `echoCancellation`, `noiseSuppression`, `autoGainControl` all default to whatever the browser picks, and the bare `{audio:true}` form frequently yields AEC *off* on desktop. With speakers playing Janus and an open mic, **Janus's own voice is captured and streamed back to Gemini.** Gemini's server VAD then treats that as user speech, triggers `interrupted`, and you get a self-interruption loop — the classic open-mic feedback failure.

2. **Raw mic is routed to the speakers.** `source.connect(processor); processor.connect(audioCtx.destination)` (`App.tsx:198-199`). The ScriptProcessor passes input through unchanged and connects to `destination`, so the operator's own mic is echoed out the speakers in real time. That's a hard local feedback path independent of the agent — it can ring on its own.

3. **No headphone detection, no acoustic guidance, no setting that helps.** `SETTINGS_SPEC.md` exposes `audioBufferSize`/`latencyMode`/volume controls, but nothing wires AEC or warns the operator to wear headphones. The prior FE assessment correctly flags these settings as inert.

**Why this matters for the goal:** the product's promise is *hands-free* orchestration — by definition no headset hand on a button, often speakers in a room. Without AEC and without removing the mic→destination route, the only configuration that works is **headphones + manual mute discipline**, which is the opposite of hands-free. So as built, voice as a *hands-free* modality is not viable; voice with a headset is the most you can demo.

**Verdict (2):** Echo/feedback is disqualifying for the stated hands-free use. Fixable (constraints + drop the destination route) but currently a blocker.

---

## 3. Trust & control of the voice channel — the operator can't trust what the mic is doing

**Mute is a lie (stale closure).** `onaudioprocess` closes over `isMicMuted` captured when `startLive` ran — always `false` (`App.tsx:201-206`). Clicking Mute flips the badge to "MUTED" (`App.tsx:546`) but **keeps streaming PCM to Gemini**. In a voice tool this is the single most corrosive trust defect: the operator believes the channel is closed (says something private, or to a colleague) while Janus is still listening and can still act. The header even advertises this as a real control. Must read mute through a `useRef` inside the callback.

**No "you're being heard" feedback.** There is no input-level meter, no waveform, no VAD indicator. The only signal is the static word "LISTENING…" (`App.tsx:546`), which is present even if the mic was denied (see below) or the device is dead. For an eyes-free modality the operator needs *positive confirmation of capture* — silence-vs-heard is the most basic affordance in voice UX and it's absent.

**No "agent is speaking" state.** The UI never reflects that Janus is mid-utterance. There's no way to know whether to wait or barge in; the operator just talks over guesswork.

**Open-mic with no push-to-talk + ambient-speech command risk.** Capture is always-on while live (`App.tsx:202`). Combined with the no-AEC echo loop and the fact that `propose_command` can run with **zero confirmation** under `Full Auto` (`server.ts:380-395`), ambient room speech — a colleague, a meeting, the operator thinking aloud — can be transcribed by Gemini and turned into an executed shell command. There is no wake word, no PTT gate, no "did you mean to address Janus?" disambiguation. For a tool that runs commands in real directories, open-mic + Full Auto is a genuinely dangerous default.

**Mic-denial leaves a confident-but-dead UI.** `getUserMedia` is awaited *after* `setIsLive(true)` inside `ws.onopen` (`App.tsx:189-190`); on denial the rest of `onopen` is skipped but `isLive` stays true and the header shows "LISTENING…". The operator is told they're heard when no audio is flowing at all.

**Verdict (3):** The voice channel is not trustworthy. A muted state that transmits, no capture feedback, no speaking-state, and open-mic-into-Full-Auto are each individually serious; together they mean the operator never actually knows what the mic is doing or what it might trigger.

---

## 4. Does voice FIT the task? — Right for intent & status, wrong for approvals & diffs

This is the heart of the assessment. Voice is not uniformly right or wrong here — it's a mix, and the implementation treats it as uniform.

**(a) Get status across 4–6 panes — voice is GOOD, with caveats.** Asking "what's the state of everything?" and hearing a one-line-per-pane summary is a natural voice task; the `list_panes` and `get_pane_summary` tools (`server.ts:351-368, 478-507`) are well-shaped "pull, not push" calls and the system prompt pushes token-light querying (`server.ts:467`). Voice excels at *triage* ("which pane needs me?"). It fails at *detail* — you cannot listen to 40 lines of build output. The product already knows this implicitly: the visual grid (`App.tsx:741-928`) carries the detail. So status is correctly **multimodal**, and that's the right call. The gap is that the *spoken* summary has no on-screen transcript to anchor it.

**(b) Approve / deny commands — voice is the WRONG primary modality here.** This is the safety-critical act, and it's where speech is weakest:
- A shell command is *precise text*. Approving `rm -rf ./build` by saying "confirm" without reading every character is exactly the error voice invites — homophone-level ambiguity (`./build` vs `/build`), invisible flags, piped `curl | sh`. The ApprovalDialog correctly shows the command as monospace text (`ApprovalDialog.tsx:43`) and binds Enter/Esc (`ApprovalDialog.tsx:16-29`) — that's the *visual* path doing the real safety work.
- The UI invites voice approval anyway: "Execute with voice 'Confirm'" (`App.tsx:811`) and "voice 'Confirm' or hit the approve trigger" (`App.tsx:812`). **But there is no code that maps a spoken "confirm" to `handleApprove`.** Approval only fires from the dialog's keyboard/click handlers (`ApprovalDialog.tsx:48-56`) or the REST endpoint (`server.ts:275`). The agent has no `approve_command` tool. So the spoken-confirm affordance the UI advertises **does not exist** — and frankly *shouldn't* exist in that naive form, because confirming a destructive command by a single ambiguous spoken word is unsafe.
- Correct design: voice can *summon* and *describe* the proposal ("I want to run a recursive delete on the build folder of pane 2 — that's destructive"), but the *commit* should require a deliberate, mode-distinct act (read-and-tap, or a spoken confirmation that **reads the command back and requires an explicit, non-homophone token plus a destructive-action double-confirm**). Today it's a single open-mic word against a Full-Auto path that bypasses confirmation entirely.

**(c) Steer agents — voice is GOOD for intent, but the steering is one-directional and lossy.** Speaking high-level intent ("tell the Codex pane to run the tests") is a great fit; refining it into a command via `propose_command` (`server.ts:369-432`) is the right shape. Where it breaks: the operator can't *hear* what the agent CLIs are saying back except by asking for a summary, and complex steering (paste this stack trace, edit this regex) is hopeless by voice. Voice is the *remote control*, not the *workbench*.

**Where voice is great:** hands-busy triage ("anything need me?"), context switching ("focus the auth project"), coarse intent, and notifications ("pane 3 is asking for approval"). **Where voice is the wrong tool:** reading/approving exact command text, reading diffs or code, anything requiring precise multi-token input, and any destructive confirmation. The system currently uses voice for *all* of these uniformly, including the one place (destructive approval) where it's most dangerous, and advertises a voice-confirm that isn't implemented.

**Multimodal fallback needed:** the visual ApprovalDialog already is the right fallback for (b) — but it must be the *required* commit path, the spoken-confirm claim must be removed or properly (and safely) implemented, and Full Auto must never silently fire destructive commands from open-mic transcription.

**Verdict (4):** Voice fits intent and triage; it is the wrong modality for the approval and code-reading tasks the system leans on it for. The "approve by voice" promise is both unimplemented and ill-advised as stated.

---

## 5. Observability of the voice agent — it's a black box

For a voice agent that *executes commands*, the operator must be able to answer: what did it hear, what is it doing, why did it propose that? Today:

- **No transcript of user speech.** Audio is base64'd and shipped (`App.tsx:203-204`); nothing surfaces what Gemini transcribed. If Janus mishears "stop the server" as "start the server," the operator has no way to catch it before a command fires.
- **No transcript of agent speech.** Replies are audio-only (`responseModalities: [Modality.AUDIO]`, `server.ts:463`) and played, never shown. In a noisy room or on the broken sample-rate path (§1), the operator may not even parse what Janus said, with no text to fall back on.
- **No reasoning / tool-call trace.** When Janus calls `propose_command` the UI shows the *command* (`App.tsx:805-812`, `ApprovalDialog.tsx:43`) but not *why* — which pane summary it read, what the operator said that triggered it. The tool results go back to Gemini (`server.ts:353-456`) and vanish from the operator's view.
- **State indicators are coarse and partly false.** "LISTENING…" / "MUTED" (`App.tsx:546`) is the entire window into the agent's state, and "MUTED" is wrong (§3) and "LISTENING" persists on mic-denial. Toasts for auto-exec/blocked (`App.tsx:472-488`) are good for *outcomes* but say nothing about *intent or hearing*.

The minimum a command-executing voice agent owes the operator is a running **dual transcript** (heard / spoke) and a **proposal rationale**. Neither exists. This compounds every prior finding: you can't catch a mishear (§3), can't verify a destructive command was understood (§4), and can't tell whether the glitchy audio (§1) garbled the reply.

**Verdict (5):** Black box. No transcript, no rationale, no reliable state surface. Unacceptable for an agent with execute authority.

---

## Where voice genuinely fits vs. where it's the wrong modality

| Task | Voice fit | Notes |
|---|---|---|
| "Anything need my attention?" triage across panes | **Strong** | One-line-per-pane spoken summary is ideal; `list_panes` is well-shaped (`server.ts:478-484`). |
| Context / project switching | **Strong** | `switch_context` by name (`server.ts:362-368`) is a natural voice command. |
| Coarse intent ("run the tests on the Codex pane") | **Good** | `propose_command` refinement is the right pattern (`server.ts:369-432`). |
| Notifications ("pane 3 needs approval") | **Good** | Spoken alert + visual alert is the right multimodal pairing. |
| **Approving/denying exact command text** | **Wrong / dangerous** | Precise text + destructive risk demand a visual read-and-commit; spoken "confirm" is unsafe and currently unimplemented (`App.tsx:811`). |
| **Reading diffs, code, logs, build output** | **Wrong** | Detail belongs on screen (`App.tsx:723-726`); voice can summarize, not recite. |
| **Precise input** (regex, paths, pasted stack traces) | **Wrong** | High error rate; needs keyboard. |

The architecture *almost* embodies this split (spoken summaries + visual grid + visual approval dialog) but then undercuts it by (a) advertising voice approval, (b) allowing Full-Auto open-mic execution of destructive commands, and (c) giving voice no transcript safety net.

---

## Minimum-Viable-Fit for a trustworthy, usable voice loop

To move from **Demo-only** to **Pilot-with-caveats**, in priority order:

1. **Fix the audio acoustics (blocks hands-free at all).** Request `echoCancellation: true, noiseSuppression: true, autoGainControl: true` on `getUserMedia` (`App.tsx:190`); **stop routing mic → destination** (remove `processor.connect(audioCtx.destination)`, `App.tsx:199`). Until then, hard-require headphones with an in-UI gate.
2. **Fix the sample-rate split (blocks intelligible output).** Use a dedicated playback `AudioContext` at 24 kHz (or resample explicitly), separate from the 16 kHz capture context (`App.tsx:184`, `audio.ts:29`). Verify Zephyr sounds like Zephyr.
3. **Make Mute real (blocks trust).** Read mute via `useRef` inside `onaudioprocess` (`App.tsx:201-206`). A muted indicator that transmits is non-negotiable to fix.
4. **Make the approval commit visual-and-deliberate; never voice-only.** Remove the "say Confirm" claim (`App.tsx:811`) until/unless a safe, command-read-back, double-confirm spoken flow exists. Prohibit Full Auto from firing destructive patterns from voice without a confirm. The visual ApprovalDialog stays the required commit path.
5. **Give the operator a window in (blocks safety).** Surface a live **dual transcript** (what Janus heard / what it said) — enable text alongside audio output — and show the **proposal rationale** in the approval dialog (triggering utterance + pane summary read).
6. **Add turn/capture feedback.** Input-level meter ("you're being heard"), an explicit "Janus is speaking" state, and gate `isLive`/"LISTENING…" on actual successful mic acquisition (`App.tsx:189-190`).
7. **Complete barge-in.** Track live `AudioBufferSourceNode`s and `.stop()` them on `interrupted`, not just reset the schedule (`audio.ts:47-49`).
8. **Reduce capture latency.** Migrate to `AudioWorkletNode` (128-frame quantum) off the deprecated 4096-frame `ScriptProcessor` (`App.tsx:195`).
9. **(Pilot+) Add push-to-talk or a wake gate** for environments without headphones / with ambient speech, given the execute authority.

Items 1–5 are the floor: without them the loop is unintelligible, untrustworthy, or unsafe. They are mostly small-to-medium and concentrated in two files (`App.tsx`, `audio.ts`) plus the system/tool config in `server.ts`.

---

*Assessment only. The only file written is this one.*
