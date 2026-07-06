# Voice fixtures — bead wsm-e2e-pinned-vpy1

Small (~1-3s) 16kHz mono 16-bit PCM WAV clips used by `scripts/verify-live-voice.ts` to drive a
REAL Gemini Live session headlessly (no physical microphone needed — Gemini Live only needs an
audio source, not literally a mic; see `src/voice/index.ts`'s `sendRealtimeInput({ audio: { data,
mimeType: "audio/pcm;rate=16000" } })` path, which the `/live` WS `{type:"audio"}` frame already
feeds from the browser's mic capture today).

## Files & ground truth transcript

| File | Spoken text (ground truth) | Used for |
|---|---|---|
| `command-list-panes.wav` | "Janus, list panes" | Transcript-channel round trip (an addressed command; speakGate must NOT mute the reply) |
| `thinking-aloud.wav` | "I think we should probably refactor this module before we ship it" | speakGate mute assertion (thinking-aloud phrasing, `voiceAi.silenceGate` enabled) |
| `approve-it.wav` | "approve it" | Voice-approval resolution (HITL pending-command flow) |

## How they were generated

Windows built-in SAPI TTS (`System.Speech`), synthesized directly to a 16kHz mono 16-bit PCM WAV
— no external tools, no recording, no network:

```powershell
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
  16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$synth.SetOutputToWaveFile("command-list-panes.wav", $fmt)
$synth.Speak("Janus, list panes")
$synth.SetOutputToNull()
```

Repeat per clip/text above. Regenerate any clip the same way if Gemini's ASR starts consistently
mis-transcribing a phrase (synthetic TTS voices drift in intelligibility across Windows versions).

## Notes for the harness

- `scripts/verify-live-voice.ts` strips each WAV's 44-byte RIFF header and sends the raw PCM16
  payload as base64 over `{type:"audio", audio:<base64>}`, chunked to approximate realtime pacing
  — the same shape the browser's real mic capture sends.
- Assertions are **fuzzy** (case-insensitive substring / token-overlap), never byte-exact — real
  ASR output varies run to run even against a fixed clip. See the script header for the exact
  tolerance and the risk this still carries (documented in the bead's scout plan).
