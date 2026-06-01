# Chunk 1 — Voice Pipeline & Gemini Live Conversation — Maintainability

**Score: 5/10** — The announcement/earcon-metadata modules are exemplary (single source of truth, injected seams, well-tested), but the actual voice pipeline lives inside two god-functions in `server.ts` and `App.tsx` with split-brain mute state, untyped `any` message boundaries, and zero tests on the audio/WS path.

## Findings

### Strong (the small modules)
- `src/announcementKinds.ts:55-109` — exemplary single-source-of-truth: `KIND_META` is a `Record<AnnouncementKind, KindMeta>` so the compiler forces every new kind to be complete; `EARCON_FOR`/`PRIORITY` are *derived* projections, never hand-maintained. The header comment (`:1-11`) documents the prior 4-copy drift it fixed. This is the model the rest of the codebase should follow.
- `src/announcementBus.ts:135-262` — clean class with injected `Clock` and `broadcast` seams so de-spam timing is deterministically testable; magic numbers are named constants (`ATTENTION_TTL_MS` etc. `:36-38`); `applyTemplate` (`:124-133`) documents *why* it uses function replacers (verbatim `$`). High cohesion, single responsibility.
- `src/eventBus.ts:30-79` — DOM-free pure dispatch table; the `earconForTransition` comment (`:72-77`) documents the double-play hazard it avoids. Good.
- `src/utils/audio.ts` — small and focused, BUT module-level mutable state (`nextStartTime`, `activeSources` at `:17-18`) is a hidden singleton: two `AudioContext`s sharing one playback queue cannot be reasoned about independently and cannot be unit-tested in isolation. Minor leak.

### Weak (the god-functions)
- `server.ts:1380-2100` — the entire Gemini Live `onmessage` callback plus a **21-branch `} else if (name === ...)` tool-dispatch chain** lives inline inside `live.connect({ callbacks: { onmessage } })`. ~700 lines in one closure. Each tool handler (`list_panes`, `propose_command`, `set_voice_mute`, `create_orchestrator_plan`, `execute_plan`, …) should be a registry of `{name, handler}` entries. Adding a tool means editing this monolith in three places (declaration at `:1903-2200`, dispatch branch, and sometimes the system prompt at `:1895`). No cohesion; impossible to test a single tool in isolation.
- `server.ts:1380-1474` — transcript extraction reaches into `(message.serverContent as any)?.turn`, `?.userTurn`, `?.modelTurn` — three `as any` casts probing undocumented SDK shapes, with no helper and no comment on which is authoritative. Leaky abstraction over the `@google/genai` payload; a SDK bump silently breaks transcripts.
- `server.ts:1895` — the entire `systemInstruction` is a single ~1.5 KB template literal inlined in the connect call. Operator-critical behavior (routing rules, mute semantics, "always call list_panes") is buried mid-function with no extraction, no versioning, no test asserting its invariants.
- `App.tsx:79-178` — `playEarcon` is 100 lines of hand-tuned oscillator code with five inline branches and repeated `createOscillator/createGain/connect` boilerplate (5+ copies). Magic frequencies (`587.33`, `880`, `523.25`…) and envelope timings are uncommented except the D5/A5 hints. A new dev cannot safely add a tone. `catch (e) {}` (`:177`) swallows all errors silently.
- `App.tsx:904-998` — the `/live` `ws.onmessage` is a ~95-line if/else over ~20 message-`type` strings, each `msg` typed as the implicit `any` from `JSON.parse`. No discriminated-union type for the wire protocol; the message-type strings (`"approval_pending"`, `"command_auto_executed"`, …) are duplicated as untyped string literals on both server and client with no shared contract module.

### Split-brain / coupling bug surface (maintainability symptom)
- **Two sources of truth for mic mute.** `set_voice_mute` (`server.ts:1706-1716`) writes `manager.settings.voiceAi.isMicMuted` and broadcasts `settings_updated`. But the client mic gate (`App.tsx:890`) reads only the *local* `isMicMuted`/`isMicMutedRef` state (`App.tsx:33,321`), which is mutated solely by the UI buttons (`App.tsx:2404,3003`). The `settings_updated` handler (`App.tsx:933-937`) sets `settings` but never calls `setIsMicMuted`. So a model-driven mute never reaches the capture gate — duplicated state with no reconciliation. (Correctness lens owns the bug; flagged here as the duplicated-state design that makes it inevitable.)

## Test-coverage note
- **Tested:** `AnnouncementBus` is thoroughly covered — `tests/test_announcement_bus.ts` (27 cases) exercises debounce, coalescing, token-bucket, TTL via the injected clock. `announcementKinds`/`eventBus` are implicitly covered.
- **Untested (riskiest):** the **entire live audio + WS + tool-dispatch path** has no tests — `audio.ts` encode/playback, `playEarcon`, the server `onmessage`/tool chain, `set_voice_mute`, and the client `/live` message router. The riskiest untested path is the **mic-capture gate + half-duplex barge-in suppression** (`App.tsx:889-898`) combined with the un-synced mute state: a regression here silently streams the operator's mic to Gemini with no failing test.

## Top fixes (by impact)
1. **Extract the tool-call dispatch** (`server.ts:1486-2100`) into a `toolHandlers: Record<string, (args, ctx) => Promise<ToolResult>>` registry, colocated with each tool's `functionDeclaration`, so adding/editing a tool is one cohesive unit and each handler is independently testable.
2. **Define a shared, typed WS wire protocol** (discriminated union of message types) in one module imported by both `server.ts` and `App.tsx`; replace the `JSON.parse → any` + string-literal if/else in `App.tsx:904-998` with an exhaustive switch over the union.
3. **Reconcile mic-mute to a single source of truth** — have the `settings_updated`/`set_voice_mute` path drive `setIsMicMuted` on the client (or have the client gate read server settings), eliminating the duplicated state at `App.tsx:33` vs `settings.voiceAi.isMicMuted`.
4. **Data-drive `playEarcon`** (`App.tsx:79-178`) — a table of `{type → [{freq, type, start, dur, gain}]}` notes with a single render loop kills the 5x oscillator boilerplate and makes tones reviewable/testable; stop swallowing errors at `:177`.
5. **Extract & version the `systemInstruction`** (`server.ts:1895`) and the SDK transcript-extraction (`:1391-1411`) into named helpers with documented contracts, removing the `as any` SDK probing from the hot callback.
