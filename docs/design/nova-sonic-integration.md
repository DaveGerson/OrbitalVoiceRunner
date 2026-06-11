# Nova Sonic 2 as an alternative conversational model

Status: **implemented on `claude/nova-sonic-2-integration-8tupzg`, awaiting operator review (do not merge until reviewed).**

This document describes how Amazon **Nova Sonic 2** (`amazon.nova-2-sonic-v1:0`) was added as a
selectable conversational backend alongside the existing **Google Gemini Live** voice model, the
design that keeps it "like-for-like" with Gemini from a context-management / integration / tool-usage
perspective, and the tradeoffs the operator should weigh.

---

## 1. The goal, restated

> Incorporate Nova Sonic 2 as a *possible* conversational model. To the greatest extent possible, make
> it set up like-for-like with Gemini from a context-management, integration, and tool-usage
> perspective — requiring only a slight UI change to (a) select the model and (b) capture the AWS
> secret key.

The decisive observation is that **the entire downstream voice machinery is already
provider-agnostic.** The per-connection voice loop (`src/voice/index.ts`) does only four things to a
live session object —

```
session.sendRealtimeInput({ audio: { data, mimeType } })   // mic → model
session.sendToolResponse({ functionResponses: [...] })      // tool result → model
session.sendClientContent({ turns: [...], turnComplete })   // injected system/narration text → model
session.close()                                             // teardown
```

— and reacts to a single callback, `params.callbacks.onmessage(message)`, where `message` is a Gemini
`LiveServerMessage`. Tool dispatch (`runAction` over the canonical `REGISTRY`), the capability-gate
matrix, approval routing, transcript capture, draft synthesis, barge-in handling, the should-I-speak
gate, reconnection, and the audio pipeline all sit *behind* those five touch-points and never name
Gemini in their logic.

So the integration did **not** introduce a new abstraction layer or rewrite the voice loop. Instead it
supplies a **Nova Sonic adapter that satisfies the existing contract on both sides**:

1. a session object exposing the same four methods, and
2. a translator that turns each Nova Sonic *output* event into the same `LiveServerMessage` shape the
   loop already parses.

The result: the voice loop, the tool registry, the gates, and the audio path are **byte-for-byte
unchanged**. The diff is confined to a new adapter, the provider-routing branch in the existing
connector seam, the settings types, and the Settings UI.

---

## 2. Where the seam already was

The Gemini session is created through an **injectable connector seam** that existed for the offline
simulator and tests:

```ts
// server.ts
export type LiveConnector = (ai: GoogleGenAI, params: any, key?: string | null) => Promise<any>;
export const realLiveConnector: LiveConnector = (ai, params, key) => { ... ai.live.connect(params) };
```

`attachVoiceSession` receives this as `boundLiveConnector` and calls it once per (re)connect. **That
seam is the single place provider routing was added** — no new plumbing was threaded through the loop.

---

## 3. What was built

### New files

| File | Responsibility |
| --- | --- |
| `src/voice/novaSonic.ts` | The Nova Sonic connector + session adapter + the pure output-event translator + input-event builders + the async input queue that drives the Bedrock bidirectional stream. |
| `src/actions/nova.ts` | `toNovaToolSpecs(...)` — re-projects the **same** `toGeminiDeclarations(REGISTRY)` output into Bedrock's `toolConfiguration.tools[]` shape. Registry stays the single source of truth for the toolset. |
| `tests/test_nova_provider.ts` | 14 pure-logic tests (no AWS, no socket): output-event translation, tool conversion, voice mapping, input-event builders. |
| `docs/design/nova-sonic-integration.md` | This document. |

### Edited files (small, additive)

| File | Change |
| --- | --- |
| `server.ts` | `realLiveConnector` routes to `connectNovaSonic(...)` when the Nova provider is selected; `resolveVoiceProvider()` + `novaAuthFromSettings()` helpers; `sanitizeSettingsForClient` masks the AWS secret key; the settings `PUT` restores the masked AWS secret + nudges reconnect on a new AWS credential. |
| `src/types.ts` | `voiceAi.provider?`, `voiceAi.awsRegion?`, `secrets.awsAccessKeyId?`, `secrets.awsSecretAccessKey?` — all **optional**, so existing settings files are unchanged and default to Gemini. |
| `src/components/SettingsDialog.tsx` | A provider selector (Gemini / Nova Sonic 2), a provider-conditional model list, and an AWS-credentials block (Access Key ID, masked Secret Access Key, Region) in the Secrets cabinet. |
| `package.json` | Adds `@aws-sdk/client-bedrock-runtime`. |

---

## 4. How the two halves map

### 4.1 Output: Nova event → Gemini `LiveServerMessage`

`translateNovaEvent(parsed)` (pure, never throws) is the heart of the "like-for-like" claim:

| Nova Sonic output event | Emitted `LiveServerMessage` | Consumed by (unchanged code) |
| --- | --- | --- |
| `audioOutput.content` (base64 PCM 24 kHz) | `serverContent.modelTurn.parts[0].inlineData.data` | the single audio choke-point → client `"audio"` frame |
| `textOutput` role `USER` (ASR) | `serverContent.inputTranscription.text` | `extractTranscripts` → approval parser + dictation + transcript |
| `textOutput` role `ASSISTANT` | `serverContent.modelTurn.parts[0].text` | `extractTranscripts` → "Janus" transcript + draft capture |
| `textOutput` content `{ "interrupted" : true }` | `serverContent.interrupted = true` | barge-in latch |
| `toolUse` `{ toolName, toolUseId, content }` | `toolCall.functionCalls[0] = { name, id, args }` | the unified `runAction` dispatch (replay-guarded, gated, audited) |
| `contentEnd` `stopReason: END_TURN` | `serverContent.turnComplete = true` | speak-gate mute latch clear |
| `contentEnd` `stopReason: INTERRUPTED` | `serverContent.interrupted = true` | barge-in latch |

Because the audio formats already match the app's pipeline (the client captures at **16 kHz** and plays
at **24 kHz** — `App.tsx` AudioContexts — exactly Nova Sonic's input/output rates), no resampling is
needed and the `"audio"` frames flow through untouched.

Nova streams **SPECULATIVE** (revisable) then **FINAL** text; the translator drops SPECULATIVE so the
on-screen transcript is not flooded with partials that get rewritten.

### 4.2 Input: the session adapter (`NovaLiveSession`)

| Voice-loop call | Nova Sonic input events pushed |
| --- | --- |
| `sendRealtimeInput({ audio: { data } })` | `audioInput` into the long-lived open audio content block |
| `sendToolResponse({ functionResponses })` | per response: `contentStart(TOOL, toolUseId)` → `toolResult(JSON)` → `contentEnd` |
| `sendClientContent({ turns })` | per text turn: `contentStart(TEXT, USER)` → `textInput` → `contentEnd` (this is how `pushApprovalNarration`, the spawn acks, the memory brief, and `switch_context` inject context — identical mechanism to Gemini) |
| `close()` | `contentEnd(audio)` → `promptEnd` → `sessionEnd`, then end the input stream |

The connect sequence primes the session: `sessionStart` → `promptStart` (carrying the **voice id** and
the registry-derived **toolConfiguration**) → a `TEXT`/`SYSTEM` block holding the **system prompt**
(`buildSystemInstruction(...)`, the same operator-editable prompt Gemini uses) → open the streaming
`AUDIO` block.

### 4.3 Tools: one registry, two projections

The voice toolset is **not** duplicated. `toGeminiDeclarations(REGISTRY)` already produces the canonical
declarations; `toNovaToolSpecs(...)` re-projects *those* into Bedrock's `{ toolSpec: { name,
description, inputSchema: { json } } }` shape (lowercasing the `Type` enum and stringifying the
JSON-Schema). Parity is by construction: identical names, descriptions, and parameter sets. Tool *use*
is therefore identical — the same `runAction` choke-point parses args, runs the handler-owned gate,
redacts read-only output, audits, and answers the call exactly once.

---

## 5. Credentials, masking, and selection (the "slight UI change")

- **Selection:** Voice settings gain a **Conversational Model Provider** dropdown (Gemini Live / Nova
  Sonic 2). Choosing Nova snaps the model list to `amazon.nova-2-sonic-v1:0`. `provider === "gemini"`
  persists as `undefined`, so Gemini stays the implicit default and existing settings files are
  unchanged.
- **AWS secret capture:** the Secrets cabinet gains **AWS Access Key ID**, a masked **AWS Secret Access
  Key**, and an **AWS Region** selector (us-east-1 / us-west-2 / ap-northeast-1 — Nova 2 Sonic's
  availability regions). The secret key is masked on the wire by `sanitizeSettingsForClient` and
  restored on `PUT` when the masked sentinel is echoed back — **exactly** the round-trip the Gemini key
  already uses. Setting a real secret **nudges the live session to reconnect**, so the operator does not
  reload. Credentials also fall back to the standard `AWS_*` environment variables.

Provider switching and credential changes take effect on the next session via the **existing Apply &
Reconnect path** — the same next-session semantics as the Gemini voice/model/prompt settings.

---

## 6. Context management — like-for-like, with one honest gap

| Concern | Gemini Live | Nova Sonic 2 (this integration) |
| --- | --- | --- |
| In-session conversation memory | model-managed | model-managed (within the open prompt) |
| System prompt | connect-time `systemInstruction` | connect-time `TEXT`/`SYSTEM` block (same builder, same tokens) |
| Mid-session context injection (memory brief, `switch_context`, narration) | `sendClientContent` USER turn | `sendClientContent` → `TEXT`/`USER` block (same call site) |
| Tool surface | `functionDeclarations` from REGISTRY | `toolConfiguration` from the **same** REGISTRY |
| Long-context compaction | `contextWindowCompression` (sliding window) | **model-managed**; the Gemini config field is ignored |
| **Cross-process / cross-reconnect resume** | `sessionResumption` handle (persisted, rehydrated at boot) | **not available** — a Nova reconnect starts a fresh prompt |

The one genuine asymmetry is **session resumption.** Gemini hands back a rotating resume handle that
the server persists so a reconnect (or a process restart) can resume the *same* conversation. Nova
Sonic's bidirectional API has no equivalent handle. Practical consequences:

- A Nova reconnect re-sends the system prompt + tools and starts a fresh prompt. The operator-visible
  state (panes, approvals, drafts, ledger, memory brief) is **fully intact** — it lives in the server,
  not the model — and the next turn's `switch_context` / memory-brief injection re-grounds the model.
  What is lost is only the model's *in-context* memory of the prior spoken turns.
- The Gemini-specific resume self-heal (poisoned-handle clearing on 1008, etc.) is simply inert on the
  Nova path; Nova close codes are treated as ordinary transient drops and the existing bounded
  reconnect applies.

This is documented rather than worked around because synthesizing a fake resume (replaying transcript
history into a fresh Nova prompt) would change behavior and is out of scope for a "like-for-like, slight
UI change" task. It is a reasonable follow-up if cross-reconnect continuity proves important for Nova.

---

## 7. Tradeoffs & risks

1. **Tool config availability.** Some operators reported `amazon.nova-2-sonic-v1:0` rejecting a
   `promptStart` that includes `toolConfiguration` ("Unable to parse input chunk") in regions where the
   tool-use feature had not finished rolling out. This app's voice surface is **tool-centric** (the
   whole point is dispatching to panes), so disabling tools is not a viable fallback. The adapter
   follows the documented + officially-sampled path (tools attached only when non-empty). If a target
   region rejects it, the operator should pick a region where Nova 2 Sonic tool use is enabled
   (us-east-1 has been the most reliable). This is called out so review can decide whether to add an
   explicit "tools off" escape hatch.

2. **Tool-calling loops.** There are reports of Nova Sonic looping on tool calls with large tool sets.
   Mitigations already present help: every dispatch is **idempotency-guarded** (a re-delivered
   `toolUseId` with a succeeded `action_log` row is answered "already handled" without re-running), and
   each tool response is sent promptly with a matching `toolUseId`. Worth watching in live testing given
   this app's ~40-tool surface.

3. **Voice identity differs.** Gemini voice names (Zephyr, Puck, …) don't exist on Nova (matthew,
   tiffany, amy, …). `voiceNameToNovaVoiceId` passes a real Nova voice through, maps the common Gemini
   defaults to a near equivalent, and otherwise defaults to `matthew`. An explicit Nova voice picker is
   a small follow-up if desired.

4. **Latency / cost / region.** Nova Sonic runs in your AWS account (Bedrock) and bills accordingly;
   it is region-limited (3 regions today). Gemini runs against Google's public API with an AI Studio
   key. These are operational, not code, differences — surfaced so the choice is informed.

5. **New dependency.** `@aws-sdk/client-bedrock-runtime` is added. It stays **external** in the esbuild
   bundle (`--packages=external`), so the server bundle is unaffected; it is a node-only import and is
   never pulled into the Vite client bundle (the client never imports the adapter).

6. **No live AWS in CI.** The pure translation/conversion/builder logic is unit-tested without AWS
   (`tests/test_nova_provider.ts`). The actual Bedrock round-trip needs real credentials and is a manual
   live-validation step (see §8). The connector is structured so all the brittle, behavior-bearing logic
   is in the pure, tested functions; only the thin streaming glue is untested by unit tests.

---

## 8. Validation

- `npm run typecheck` — clean.
- `npm test` — full suite **1556 pass / 0 fail** (no regressions; the new file adds 14 tests).
- `npm run build` — clean (the pre-existing `import.meta` cjs warning is unrelated).
- **Live (manual, not yet run):** select Nova Sonic 2 in Settings, enter an AWS access key id + secret
  + region with Bedrock `amazon.nova-2-sonic-v1:0` access, Apply & Reconnect, and confirm: mic audio
  reaches the model, spoken audio returns, the operator/Janus transcripts render, and a voice command
  (e.g. "list the panes", "relay to pane 2 …") dispatches a tool and the result is spoken back.

---

## 9. Reviewer's map (smallest-to-largest)

1. `src/actions/nova.ts` — tool projection (mechanical).
2. `tests/test_nova_provider.ts` — the behavioral contract in executable form.
3. `src/voice/novaSonic.ts` — the adapter; read `translateNovaEvent` and `NovaLiveSession` first.
4. `server.ts` — the routing branch in `realLiveConnector` + `resolveVoiceProvider` / `novaAuthFromSettings`, and the `sanitizeSettingsForClient` / `PUT` secret handling.
5. `src/types.ts` — the four optional settings fields.
6. `src/components/SettingsDialog.tsx` — provider selector + AWS credential fields.

Nothing in `src/voice/index.ts`, the action registry handlers, the gate matrix, or the audio pipeline
was changed — that invariance is the integration's core property and the thing most worth verifying in
review.
