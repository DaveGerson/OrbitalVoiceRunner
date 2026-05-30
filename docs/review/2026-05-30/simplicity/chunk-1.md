# Chunk 1 — Voice Pipeline & Gemini Live Conversation — Simplicity & Clarity

**Score: 6/10** — The pure helper modules (audio.ts, announcementKinds.ts, eventBus.ts) are exemplary and tight, but the server-side Live session is one enormous nested closure that buries the audio pipeline inside an ~800-line inline tool-dispatch chain, and the client earcon synthesizer is heavily repetitive boilerplate.

## Findings

- `server.ts:1377-2206` — The entire Gemini Live session (`sessionAi.live.connect`) is a single `await` whose `callbacks.onmessage` closure runs from L1380 to roughly L1995, containing transcript extraction, approval-intent parsing, audio forwarding, AND the full `if (name === ...) else if` tool-dispatch chain for ~25 tools. This is the single largest cognitive-load problem in the chunk: the audio-out path (3 lines, L1477-1483) is visually lost in the middle of a 600-line function. The tool handlers should be a dispatch table (`Record<string, (args, call) => response>`) so the message handler is ~30 lines.
- `server.ts:1477-1483` — Indentation breaks here: L1477-1478 are indented to the `for` body, then the `if (audio)` and `interrupted` blocks are dedented two levels relative to surrounding code. Braces balance but the visual structure no longer reflects the logic — a readability red flag in the hottest path.
- `server.ts:1391-1411` — Three near-identical part-extraction loops (`modelTurn.parts`, `(...).turn.parts`, `(...).userTurn.parts`), two reaching through `as any`. They differ only in which accumulator they append to. One `collectText(parts)` helper called three times removes ~15 lines and the triple `as any` casts.
- `src/App.tsx:79-178` — `playEarcon` is a 100-line if/else over 5 earcon types, each hand-rolling oscillator+gain wiring with copy-pasted `osc.connect(gain); gain.connect(ctx.destination)` and `exponentialRampToValueAtTime(0.001, ...)` repeated ~10 times. This is pure data (freq, type, start offset, duration, gain). A `playTone(ctx, {type,freq,at,dur,gain})` helper + a per-earcon note table cuts this to ~25 lines. It also leaks a fresh `AudioContext` on every earcon (`new AudioContext()` at L81, never closed).
- `src/App.tsx:822-859` — `cleanupSocketOnly` is five structurally identical `if (ref.current) { try {...} catch {} ref.current = null; }` blocks. A tiny `closeRef(ref, fn)` helper collapses this to 5 one-liners.
- `src/App.tsx:904-998` — The `ws.onmessage` handler is a 90-line flat `if/else if` over ~18 message types. Several arms duplicate the `playEarcon(...) + triggerDesktopNotification(...) + setTimeout(()=>setX(null),4000)` toast pattern (L938-948); a `showTransientToast` helper would dedupe. The terminal `else` correctly delegates to the data-driven `effectForEvent` — good; the rest could move to a similar table.
- `src/App.tsx:1000-1034` — The auto-reconnect logic (clear timer, 3s timeout, re-check `desiredLiveRef`) is duplicated verbatim in both the `onclose` handler and the outer `catch`. Extract one `scheduleReconnect()`.
- `src/utils/audio.ts` — Clean and minimal; module-level `nextStartTime`/`activeSources` singletons are slightly surprising (global mutable state in a "util") but the scheduling is clear. No action needed for this lens.
- `src/announcementKinds.ts` / `announcementBus.ts` / `eventBus.ts` — Genuinely well-factored: single-source-of-truth KIND_META with derived projections, injected clock seam, data-driven event mapping. These are the model the server-side dispatch should follow. No simplification needed.

## Top fixes
1. Convert the inline Live tool-dispatch `if/else if` chain (`server.ts:1491-~1995`) into a registered dispatch table; shrinks the onmessage closure by an order of magnitude and makes the audio path visible.
2. Fix the broken indentation at `server.ts:1477-1483` so structure matches logic.
3. Replace `playEarcon`'s 100-line if/else (`App.tsx:79-178`) with a `playTone` primitive + per-earcon note table; reuse one shared `AudioContext` instead of leaking one per call.
4. Collapse `cleanupSocketOnly` (`App.tsx:822-859`) and the duplicated reconnect blocks (`App.tsx:1000-1034`) with small helpers.
5. Factor the triple part-extraction loops (`server.ts:1391-1411`) into one `collectText(parts)` helper, dropping the `as any` casts.
