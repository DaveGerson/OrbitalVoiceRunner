# Chunk 1 — Voice Pipeline & Gemini Live Conversation — Quality & Correctness

**Score: 6/10** — The core mic→PCM→/live→Gemini→audio-out loop and the barge-in gate are correct and well-tested at the bus layer, but the voice-commanded `set_voice_mute` tool is functionally dead on the client, and there are resource-leak / stale-closure rough edges.

## Findings

- **`src/App.tsx:933-937` + `server.ts:1706-1716` — HIGH — `set_voice_mute` tool never mutes the mic.**
  The server tool sets `manager.settings.voiceAi.isMicMuted = muted`, saves, and broadcasts `settings_updated`. The client `settings_updated` handler only calls `setGlobalPermissionsMode(...)` and `setSettings(msg.settings)`. It never calls `setIsMicMuted(...)`, and the mic gate at `App.tsx:890` reads `isMicMutedRef.current`, which is only driven by the local `isMicMuted` state (effect at `App.tsx:637-638`). Result: when the operator (or model) says "mute," the model receives "Microphone now muted" and believes it succeeded, but capture frames keep streaming to Gemini. The hands-free mute journey is broken — real-world impact is an operator who cannot actually silence the mic by voice, and a model that confidently lies about the state.

- **`src/App.tsx:79-178` — MED — `playEarcon` creates a new `AudioContext` on every earcon and never closes it.**
  Each earcon (`completion`, `alert`, `success`, etc.) does `new AudioContext()` and only `osc.stop()`. The context is never `close()`d. Browsers cap concurrent AudioContexts (~6 in Chrome); under a busy proactive-notification stream (many earcons via `proactive_earcon` / event bus) the app will hit `Failed to construct 'AudioContext': number of hardware contexts reached the maximum` and earcons silently stop firing (caught by the empty `catch`). Degrades the entire non-verbal feedback channel over a long session.

- **`src/utils/audio.ts:17-18,57-67` — MED — module-global playback state (`nextStartTime`, `activeSources`) is shared process-wide and only ever reset, not torn down per-context.**
  `playAudioChunk` schedules against a single module-global `nextStartTime`. On reconnect, `connectLive` creates a *new* 24 kHz `playbackCtx` and calls `resetAudioPlayback()` (good), but `isAudioPlaying(voicePlaybackCtxRef.current)` compares `nextStartTime` against the *new* context's `currentTime`. Because both globals are reset on reconnect this is currently safe, but it is fragile: any code path that creates a second playback context without `resetAudioPlayback()` first would make the barge-in gate read stale scheduling state from the prior context and either suppress the mic forever or never suppress it.

- **`src/App.tsx:904-998` — MED — `ws.onmessage` is bound once per `connectLive()` and closes over render-time functions (`fetchTerminals`, `fetchPlans`, `fetchActiveTerminalHistory`, `setPlans`, etc.).**
  The critical history case correctly uses `activeTerminalIdRef.current` (App.tsx:968), but the event-bus dispatch (App.tsx:985-996) and several handlers invoke closures captured at connect time. For the duration of a single live session these can read stale state (e.g. `fetchActiveTerminalHistory` default arg binds the `activeTerminalId` at connect time, though here it's passed explicitly). Reconnect rebinds, so the blast radius is "until next reconnect," but it is a latent stale-closure class the manifest flagged.

- **`server.ts:1477-1480` — LOW — only `parts[0].inlineData.data` is forwarded as audio.**
  Model turns with audio in a non-zero part index (or multiple inline-data parts) drop audio frames. In practice Gemini Live places audio in part 0, but a multi-part turn would silently lose audio. No guard/loop over all parts.

- **`server.ts:1413-1455` — LOW — voice-approval parse runs on every `userUtterance` chunk, but `currentSessionUserUtterance` is overwritten (`=`, not `+=`) per chunk.**
  Partial-transcript chunking could split an approval phrase ("approve" / "command" across two chunks) so a streamed utterance may not match the intent parser. Low impact because Gemini typically delivers whole user transcripts, and the visual ApprovalDialog is the primary path.

## Does-it-do-the-job verdict
The primary voice loop (capture → encode → forward → playback → barge-in mute) works and is the most solid part of this chunk; the announcement/earcon bus is genuinely well-engineered and unit-tested. But a headline hands-free feature — voice "mute" — does not work end-to-end, and the earcon AudioContext leak will degrade feedback over long sessions. Fit for purpose for talking to Janus; not fit for the advertised hands-free mute control.

## Top fixes
1. **HIGH:** In the `settings_updated` handler (App.tsx:933), propagate `msg.settings?.voiceAi?.isMicMuted` to `setIsMicMuted(...)` (and ideally make `isMicMutedRef` authoritative from settings) so `set_voice_mute` actually gates capture.
2. **MED:** Make `playEarcon` reuse a single long-lived `AudioContext` (lazily created, resumed on user gesture) instead of `new AudioContext()` per call.
3. **MED:** Move `nextStartTime`/`activeSources` onto the playback `AudioContext` instance (or a ref) instead of module globals to harden the barge-in gate against multi-context lifecycles.
4. **LOW:** Forward all `modelTurn.parts[*].inlineData.data` audio frames, not just part 0 (server.ts:1477).
