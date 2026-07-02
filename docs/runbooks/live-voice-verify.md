# Live voice verification runbook — bead wsm-e2e-pinned-vpy1

**Purpose:** Give a repeatable, honest answer to "is hands-free Gemini Live voice actually
wired correctly?" — not just "audited by code." Hands-free voice needs a Gemini key, mic/browser
permission, and a live audio loop, so a full-stack review can only ever *audit* the code without
this runbook. Two layers:

1. **Automated** (`scripts/verify-live-voice.ts` / `npm run verify:live-voice`) — a real
   `ai.live.connect()` session, driven headlessly with canned PCM16 audio clips over the same
   `/live` WS path the browser mic uses. Covers the transcript channel (real ASR round trip),
   the speakGate mute path, best-effort voice-approval resolution, and the visible degradation
   signal (`voice_channel_lost`) — all **without a physical microphone or speaker**.
2. **Manual** (this doc, steps below) — the parts that genuinely require a human: browser
   `getUserMedia` mic capture, real speaker playback, and subjective audio judgment. The manual
   section is NOT redundant with the script — it covers exactly what the script structurally
   cannot touch.

---

## Pre-flight

- A real `GEMINI_API_KEY` (or a key configured in Settings) with Gemini Live API access.
- Run the automated harness first:

```
GEMINI_API_KEY=<real key> npm run verify:live-voice
```

**Without a key**, the script exits `0` with a `SKIP:` message and makes no live call — this is
expected in CI and on any machine without a live key; it is not a failure.

**Expected PASS output** (voice-approval may be reported `INCONCLUSIVE` — see the script header;
that is expected LLM-tool-choice variance, not a bug):

```
[live-voice] check 1/4: transcript channel (real Gemini ASR round trip)...
[live-voice]   ok: transcript_text = "Janus, list panes"
[live-voice] check 2/4: speakGate mute on a thinking-aloud clip...
[live-voice]   ok: speak_gate mute entry observed
[live-voice] check 3/4: voice-driven approval resolution (best-effort — depends on real-model tool choice)...
[live-voice]   ok: pending approval resolved by voice   (or: INCONCLUSIVE: ...)
[live-voice] check 4/4: degradation signal (voice_channel_lost) on an invalid key...
[live-voice]   ok: voice_channel_lost observed (reason=invalid_api_key)
[live-voice] RESULT: PASS — ...
```

Exit codes: `0` pass (or clean skip), `2` transcript channel broken, `3` speakGate broken, `4` a
created pending approval never resolved by voice, `5` degradation signal missing, `1` harness
error. Do not proceed to the manual steps below if the script reports anything other than `PASS`
or a clean `SKIP` — fix the regression first.

**Cost note:** each run makes several real, metered Gemini Live API calls. Do not loop this in CI
or a pre-commit hook.

---

## Manual checklist (mic/speaker/eyeballs only — cannot be scripted)

### Step 1 — real mic capture end to end

1. Open the Janus UI in a browser, start a Gemini Live voice session, grant mic permission when
   prompted.
2. Say an addressed command, e.g. "Janus, list panes."
3. Confirm: the command executes (or is proposed, per the pane's permission mode) AND Janus
   **speaks the confirmation aloud** through your speakers.

**Pass criterion:** you hear Janus's spoken reply — this validates the one path the automated
script cannot touch: `getUserMedia` capture → browser audio encode → real speaker playback.

### Step 2 — speakGate is audibly silent, not just logged-silent

1. In Settings, enable the silence/thinking-aloud gate (`voiceAi.silenceGate`).
2. Say a clearly thinking-aloud phrase (not an addressed command), e.g. "I think we should
   probably refactor this before we ship it."
3. Confirm: the reply appears as **text** in the transcript panel but is **NOT spoken aloud**.

**Pass criterion:** you hear silence during what would otherwise be Janus's spoken reply. This is
inherently a subjective/audible judgment — the automated script can only confirm the
`speak_gate` log entry exists, not that your speakers stayed quiet.

### Step 3 — visible degradation on a real disconnect

1. With a live voice session open, kill your network connection (disable Wi-Fi / unplug
   ethernet) for a few seconds.
2. Confirm: the UI visibly shows a reconnect/degraded indicator (not a silent hang).
3. Restore the network and confirm the UI shows recovery (a "restored" indicator) once the
   session reconnects.

**Pass criterion:** the degraded state is visually obvious to an operator, and recovery is
visually confirmed. The automated script only proves the underlying `voice_channel_lost` /
`voice_channel_restored` broadcasts fire correctly (via a deliberately invalid key, not a real
network kill) — it does not render or observe the UI.

---

## Pass / fail checklist

| # | Criterion | Pass | Fail |
|---|-----------|------|------|
| 0 | `npm run verify:live-voice` exits `PASS` (or clean `SKIP` if no key) | | |
| 1 | Spoken command executes AND is spoken back aloud through real speakers | | |
| 2 | Thinking-aloud reply appears as text but is audibly NOT spoken | | |
| 3 | Network kill mid-session shows a visible degraded/reconnect indicator | | |
| 4 | Recovery after network restore shows a visible "restored" indicator | | |

All criteria must pass to declare hands-free Gemini Live voice verified in a real session.

---

## Notes

- The automated script's fixtures live under `tests/fixtures/voice/` (small TTS-synthesized
  PCM16 WAV clips; see that directory's README for how they were generated and their exact
  ground-truth transcripts).
- Real ASR output is nondeterministic — the script uses fuzzy (token-overlap) matching, not
  byte-exact comparison, and may occasionally need a re-run.
- The voice-approval check (script step 3/4) depends on the real model choosing to call
  `propose_command` for the spoken phrasing; when it doesn't, the script reports
  `INCONCLUSIVE`, not a failure. The deterministic mechanics of approval resolution itself are
  covered by `tests/test_approvals_wse.ts`.
- Do not skip the manual section because the script passed — the script is scoped to exclude
  exactly the mic/speaker/UI pieces this section covers.
