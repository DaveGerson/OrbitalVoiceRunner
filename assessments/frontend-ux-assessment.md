# Frontend / UX Capability & Fit Assessment — Orbital Harness / Janus Terminal Orchestrator

**Reviewer:** Priya Raman — Senior Frontend / UX Engineer
**Lens:** React architecture, real-time/streaming UIs, Web Audio, accessibility, voice-interaction UX. I review for *capability* (what's built and polished) and *fit* (is this architecture right for a real-time, voice-driven, multi-pane terminal orchestrator, and where will it break under load).
**Scope:** `src/App.tsx`, `src/main.tsx`, `src/components/{ApprovalDialog,CreateTerminalDialog,SettingsDialog}.tsx`, `src/utils/audio.ts`, `src/types.ts`, `index.html`, `vite.config.ts`; `server.ts` for the WebSocket message contract. Analysis only — no code modified.

---

## Executive Summary

The UI is visually confident and the happy path is genuinely impressive: a single `/live` WebSocket multiplexes audio, tool calls, approvals, and stdout; the Approval Dialog is keyboard-driven; and the dashboard surfaces per-pane status, CPU, and permission policy cleanly. However, the architecture is built for the demo, not for sustained real-time operation. The two largest fit risks are (1) **no WebSocket reconnection** — a single dropped frame silently kills voice, mic, and live stdout with no user feedback, and (2) a **fatal audio-capture bug**: the mic-mute toggle is captured in a stale closure inside `onaudioprocess`, so "Mute" never actually stops transmitting. Audio playback uses the deprecated `ScriptProcessorNode`, shares one `AudioContext` at 16 kHz for 24 kHz playback (pitch/quality degradation), and has no echo cancellation, so the agent will hear itself. Accessibility is largely absent (no focus traps, no ARIA roles/labels on dialogs, `focus:outline-none` everywhere), and the 1,184-line `SettingsDialog` duplicates ~30 state fields that will drift from the server schema. The core concept is sound; the real-time plumbing and resilience layer need a rebuild before this is production-credible.

---

## Strengths

- **Single multiplexed WebSocket contract is clean.** `App.tsx:209-249` handles a well-typed set of message types (`audio`, `interrupted`, `approval_pending`, `terminals_updated`, `ledger_updated`, `settings_updated`, `command_auto_executed`, `command_blocked`, `stdout_chunk`) that map directly to server broadcasts (`server.ts:50-63, 339-430`). The contract is coherent and easy to extend.
- **Approval Dialog UX is strong.** `ApprovalDialog.tsx:16-29` wires Enter=approve / Esc=reject, shows the exact command in a monospace block, and identifies the target pane. The `focus:ring-2` on both buttons (lines 49, 55) is the one place focus styling is done right.
- **Interrupt/barge-in handling exists.** On `interrupted`, `resetAudioPlayback()` flushes the playback schedule (`App.tsx:213-214`, `audio.ts:47-49`) — the right instinct for conversational voice.
- **Scheduled-playback model is correct in shape.** `audio.ts:39-44` schedules each chunk at `nextStartTime` and advances by buffer duration, which avoids gaps/overlaps for back-to-back chunks — a good baseline streaming approach.
- **Rich, legible status system.** Per-pane status dots, CPU meters, alert pulses, and the toast system (`App.tsx:472-488`) give strong at-a-glance state. The dashboard cards (`App.tsx:770-925`) are well-organized.
- **Settings has bidirectional JSON ↔ form sync, import/export, masked secrets.** `SettingsDialog.tsx:246-291` keeps a raw-JSON editor in sync with form state, and the API key is masked server-side (`server.ts:240-244`) and never overwritten with the masked value on save (`server.ts:251-253`) — a genuinely thoughtful security detail.
- **Optimistic local stdout merge** keeps the active pane feeling live (`App.tsx:237-247`) instead of waiting on polling.

---

## Weaknesses / Risks (ranked)

### 1. [CRITICAL] Mic mute never works — stale closure in `onaudioprocess`
`App.tsx:201-206`. The audio processor callback closes over `isMicMuted` at the moment `startLive` runs (always `false`). Because the handler is never re-created when the React state changes, clicking "Mute" (`App.tsx:527`) updates the UI badge to "MUTED" but **keeps streaming mic PCM to Gemini**. This is both a privacy/trust failure and a functional bug — the headline "Spacebar toggle" in Settings (`SettingsDialog.tsx:537`) doesn't exist at all. **Impact:** users believe they are muted while the agent is still listening. Fix requires a `useRef` for mute state read inside the callback.

### 2. [CRITICAL] No WebSocket reconnection or error surfacing
`App.tsx:251-253`: `ws.onclose` just calls `stopLive()`. There is no `ws.onerror` handler, no retry/backoff, no "reconnecting…" state. Any transient drop (server restart, network blip, laptop sleep) silently tears down voice, mic, and live stdout, leaving the header dot grey with no explanation. The server even emits a `type: "error"` message on Gemini connect failure (`server.ts:575-578`) that the **client never handles** — the `onmessage` switch has no `error` case (`App.tsx:209-248`), so a failed voice session produces total silence. **Impact:** the app's core value (voice control) is one packet loss away from dying invisibly. This is the single biggest fit problem for a "real-time" tool.

### 3. [HIGH] Audio pipeline: wrong sample rate, deprecated node, no echo cancellation
- The capture `AudioContext` is forced to 16 kHz (`App.tsx:184`) and the **same context** is used to play back 24 kHz Gemini audio (`audio.ts:29` declares a 24 kHz buffer played through a 16 kHz context) → resampling artifacts / pitch and timing drift.
- `createScriptProcessor(4096,...)` (`App.tsx:195`) is deprecated, runs on the main thread, and a 4096-frame block at 16 kHz adds ~256 ms of capture latency before anything is sent — poor for conversational turn-taking. `AudioWorkletNode` is the modern path.
- `getUserMedia({ audio: true })` (`App.tsx:190`) requests no `echoCancellation`/`noiseSuppression`/`autoGainControl`. Combined with playing agent audio out the speakers, **the agent hears its own voice**, causing self-interruption loops in any non-headphone setup.
- `processor.connect(audioCtx.destination)` (`App.tsx:199`) routes the *raw mic* to the speakers, which can cause audible feedback.
- The `audioBufferSize`/`latencyMode`/`throughputBps` settings (`SettingsDialog.tsx:876-953`) are pure theater — none are wired into the audio pipeline. **Impact:** degraded audio quality, high latency, echo/feedback, and settings that lie about what they do.

### 4. [HIGH] No mic-permission UX; getUserMedia failure breaks state
`App.tsx:188-207`: `getUserMedia` is awaited *inside* `ws.onopen` after `setIsLive(true)` already ran. If the user denies the mic (or no device exists), the promise rejects, the rest of `onopen` is skipped, but `isLive` stays `true` and the WS stays open — the UI shows "LISTENING…" with a dead mic and no error. There is no pre-flight permission prompt, no "microphone blocked" empty state, and no recovery path. **Impact:** denied-mic is a common first-run case and it leaves the app in a broken, confusing state.

### 5. [HIGH] Concurrent approvals collapse to a single slot
`App.tsx:14` stores `pendingCommand` as a single object; `approval_pending` overwrites it (`App.tsx:215-220`). If two panes (or a chatty agent) request approval near-simultaneously, the second silently replaces the first — the first command's `pendingApprovals` entry lives forever on the server (`server.ts:422`) with the tool response never sent, hanging that Gemini tool call. The Settings modal independently fetches `/api/commands/pending` as a list (`SettingsDialog.tsx:136-141`), proving the backend supports multiple — but the main UI can only show one. **Impact:** in a multi-pane orchestrator (the entire premise), approvals are lost and agent turns hang.

### 6. [HIGH] Accessibility is largely absent
- No dialog has `role="dialog"`, `aria-modal`, `aria-labelledby`, or a **focus trap**. ApprovalDialog, CreateTerminalDialog, SettingsDialog, and `GenericPromptModal` all let Tab escape to the obscured page behind them.
- `focus:outline-none` is applied pervasively with no replacement ring (e.g. `App.tsx:505, 520, 552`; CreateTerminalDialog inputs; Settings selects) → keyboard users cannot see focus.
- Status is encoded almost entirely by color (status dots, CPU bars) with no text/ARIA alternative — fails for color-blind and screen-reader users.
- Icon-only buttons (restart `App.tsx:714-720`, clipboard `App.tsx:834-839`, settings `App.tsx:550`) rely on `title` only; no `aria-label`.
- Live regions: toasts (`App.tsx:472-488`) and the approval alert are not `aria-live`, so screen readers never announce "approval required" — critical for an app whose whole point is non-visual interaction.
**Impact:** the product is effectively unusable for assistive-tech users and fails WCAG basics, ironic for a voice-first tool.

### 7. [MEDIUM] `GenericPromptModal` declares hooks inside a nested component during render
`App.tsx:414-437`: `GenericPromptModal` is defined inside `App` and calls `useState` (line 416). It's rendered as `<GenericPromptModal />` (line 469), so React treats it as a child component — but because it's re-created every `App` render, its identity changes and its internal `val` state is **remounted/reset on every parent re-render** (and `stdout_chunk` re-renders happen constantly while live). Typing into a rename/note prompt while a terminal is streaming will drop characters. **Impact:** prompt inputs lose state under live load; also an antipattern that will bite future maintainers.

### 8. [MEDIUM] Fast stdout will thrash React and lose data
`App.tsx:237-247`: every `stdout_chunk` does a full `terminals.map` + string concat + `split("\n").slice(-40)` in React state. Under a verbose build/test process this fires many times per second, causing a full re-render of the entire `App` (sidebar, dashboard, everything) per chunk. The hard cap of 40 lines (vs. the configurable `maxBufferLines`, default 100, in `types.ts`/server) silently discards scrollback, and there is **no terminal emulator** (xterm.js) so ANSI colors, cursor moves, and progress bars render as raw/garbled `<pre>` text (`App.tsx:724`). **Impact:** jank with many panes, no usable scrollback, broken rendering of any TUI/colorized CLI — which is exactly what Claude Code / Codex emit.

### 9. [MEDIUM] SettingsDialog: 1,184 LOC with ~30 mirrored state fields
`SettingsDialog.tsx:89-123` declares ~30 `useState` hooks that shadow the server schema, hydrated via a giant `useEffect` (`143-178`) and recompiled in `getCompiledSettings` (`181-218`) and `handleJsonChange` (`246-291`). Every new setting must be touched in 4+ places, and the form schema has already diverged from `SETTINGS_SPEC.md` (spec uses `orchestrator.*` / `voiceAi.geminiApiKey`; code uses `advanced.*` / `secrets.geminiApiKey`). No validation on numeric fields (port, timeouts accept any number/NaN). **Impact:** high maintenance cost, guaranteed schema drift, and silent persistence of invalid values.

### 10. [MEDIUM] Polling + WS dual source of truth, with races
`App.tsx:102` polls `/api/terminals` every 3 s *in addition to* WS-driven updates, and several handlers use `setTimeout(fetchTerminals, 500)` (`App.tsx:114`). The optimistic stdout merge (`237-247`) is periodically clobbered by the poll's authoritative `output` (server returns only `getRecentOutput(20)`), causing the visible terminal to flicker/jump between 40-line and 20-line views. **Impact:** visible content flicker and wasted requests; the data model has no single owner.

### 11. [LOW] Settings tab fetches pending approvals once, never refreshes; `terminals` not passed to it for live updates beyond initial. Minor staleness inside the modal (`SettingsDialog.tsx:136-141`).

### 12. [LOW] `process.cwd()` / `process.platform` used in browser code
`App.tsx:308` (`process.cwd()`), `CreateTerminalDialog.tsx:38` (`process.platform`). These are Node globals; in the browser they are `undefined`/throw unless Vite shims them, so the "Custom Shell" default command and new-project directory are likely broken at runtime. **Impact:** custom shell preset and project creation produce wrong/empty values.

### 13. [LOW] `index.html` title still says "My Google AI Studio App"; no favicon, no `<meta description>`, no error boundary (`main.tsx` has no `ErrorBoundary`), so any render throw white-screens the whole app.

---

## Capability Gaps (missing UX/functionality for the stated goal)

- **Reconnection & connection-health UX** — backoff retry, "reconnecting" banner, surfacing the server's `error` message, restoring mic/stream after reconnect. (Currently none.)
- **Multi-approval queue** — a stack/list of pending approvals with per-item approve/reject, matching the backend's multi-pending model.
- **Real terminal emulation** — xterm.js (or similar) for ANSI/color/cursor handling, proper scrollback, copy/select, and resize (PTY cols/rows). A `<pre>` cannot represent agent CLIs.
- **Mic permission lifecycle** — pre-flight check via `permissions.query({name:'microphone'})`, denied state, device picker, input-level meter so users can confirm they're being heard.
- **Push-to-talk / VAD affordance** — for a voice tool, continuous streaming with no visible "agent is speaking / you're being heard" indicator is a UX gap; no waveform/level feedback.
- **Audio output controls actually wired** — the volume/speed sliders (`SettingsDialog.tsx:495-517`) and `latencyMode`/`audioBufferSize` don't affect playback at all.
- **Focus management & keyboard nav** — focus trap on open, restore focus on close, Esc-to-close on every modal (only ApprovalDialog handles Esc), Tab order.
- **Empty/loading/error states for data** — `settings === null` shows a fully-populated default form (no skeleton); fetch failures are swallowed silently (`App.tsx:33-63`) with zero user feedback.
- **Responsive layout** — fixed `w-72` sidebar + `w-[600px]` approval dialog + `max-w-3xl` settings assume desktop; no mobile/tablet story.
- **Per-pane output isolation** — only the active pane shows output; background panes accumulate state but there's no unread/activity indicator tied to actual stdout volume.

---

## Recommendations

| # | Recommendation | Effort | Impact |
|---|----------------|--------|--------|
| R1 | Fix mic mute: read mute via `useRef` inside `onaudioprocess` (or stop sending by gating on a ref). Add a visible "you are muted" guarantee. | **S** | **High** |
| R2 | Add WS reconnection with exponential backoff + jitter, `onerror` handler, a "reconnecting / disconnected" banner, and handle the server `error` message type. Re-acquire mic/stream on reconnect. | **M** | **High** |
| R3 | Rebuild audio: separate playback `AudioContext` at 24 kHz, migrate capture to `AudioWorkletNode`, enable `echoCancellation/noiseSuppression/autoGainControl`, and **do not** connect mic to destination. | **M** | **High** |
| R4 | Convert `pendingCommand` to a queue (`PendingCommand[]`) and render stacked approval cards; reconcile with `/api/commands/pending`. | **M** | **High** |
| R5 | Add mic-permission UX: pre-flight `permissions.query`, denied empty-state, input-level meter; move `getUserMedia` out of `onopen` and gate `isLive` on success. | **M** | **High** |
| R6 | Accessibility pass: add `role="dialog"`/`aria-modal`/`aria-labelledby`, focus trap + restore on all modals, replace `focus:outline-none` with visible rings, `aria-live="assertive"` on the approval alert and toasts, `aria-label` on icon buttons, text alternatives for color-coded status. | **M** | **High** |
| R7 | Replace the `<pre>` output with xterm.js; respect `maxBufferLines`; batch `stdout_chunk` updates (rAF/throttle) and store terminal output outside the main React tree (ref + forced subtree update) to stop full-app re-renders. | **L** | **High** |
| R8 | Refactor SettingsDialog to a single reducer/`useReducer` over the typed schema (or react-hook-form), reconcile field paths with `SETTINGS_SPEC.md`, and add numeric validation. | **L** | **Med** |
| R9 | Lift `GenericPromptModal` out of `App` into its own stable component with its own state. | **S** | **Med** |
| R10 | Make WS the single source of truth for terminals; drop the 3 s poll (or use it only as a reconnect fallback) to remove flicker. | **S** | **Med** |
| R11 | Remove `process.cwd()`/`process.platform` from client code; derive platform from `navigator` or server. Add a top-level `ErrorBoundary`; fix `<title>`/favicon/meta. | **S** | **Med** |
| R12 | Wire volume/speed/latency settings into the actual playback path, or remove them to stop misleading users. | **S** | **Low** |

---

## Top 5 Prioritized Roadmap Items

1. **R1 — Fix the mic-mute stale-closure bug** (S/High). A voice tool that keeps transmitting while showing "MUTED" is a trust- and privacy-breaking defect; cheapest, highest-trust fix.
2. **R2 — WebSocket resilience** (M/High). Without reconnection and error surfacing, the product's core (voice + live stdout) dies invisibly on any network hiccup; this is the dominant *fit* risk for a real-time orchestrator.
3. **R3 — Audio pipeline rebuild** (M/High). Correct sample rates, AudioWorklet, and echo cancellation are prerequisites for usable conversational voice; today the agent will hear and interrupt itself.
4. **R4 — Approval queue** (M/High). Multi-pane orchestration is the premise; single-slot approvals lose commands and hang agent turns the moment two panes act.
5. **R6 — Accessibility & focus management** (M/High). No focus traps, no ARIA, invisible focus, and no live-region announcements make a voice-first tool unusable for assistive tech and fail WCAG basics — a glaring contradiction with the product's mission.
