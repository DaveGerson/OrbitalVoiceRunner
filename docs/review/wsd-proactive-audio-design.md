# OrbitalVoiceRunner — WS-D: Proactive Audio + Event Bus

**Author:** Expert 1 (Architecture/Design)
**Status:** DESIGN ONLY — no source edits. Build-ready spec for the implementer.
**Closes:** BUG-024 (P0-grade), BUG-010, BUG-035.
**Hard dependency:** WS-C (reliable Running→Idle) — committed. WS-D builds on the genuine,
debounced `onIdle` edge so proactive announcements never fire on a false idle.

---

## 0. MAINTAINER DECISION (BINDING — overrides §2 and the in-voice parts of §1/§3)

The maintainer reviewed the §2 mechanism options and **declined the in-voice
`sendClientContent` spoken-announcement layer.** The implementer MUST follow the decision
below; the in-voice analysis in §1/§2/§3 is retained for rationale only and is NOT to be built.

**Decision 1 — feedback mechanism: earcons + a stacking on-screen notification stack (NO
Gemini in-voice turns).** Proactive feedback is delivered as:
  - an **earcon** keyed to the event's status (distinct tones for done / error / exit / etc.), and
  - an **on-screen notification stack** that **stacks by status and coalesces**: when multiple
    updates concern the same pane/status, the stack does NOT spawn a new toast — it updates the
    existing entry to the **latest status message**. The attentionQueue (already coalesced per
    pane) is the natural backing model for this stack.
  - **Do NOT** build the module-scoped `activeVoiceSession` registry / `session.sendClientContent`
    speech path (Seam A). Only **Seam B (`broadcast()`)** remains: it drives the earcons, the
    notification stack, and the BUG-010 client branches. This removes the per-announcement token
    cost and most barge-in complexity (earcons are short tones, not spoken turns).

**Decision 2 — verbosity: brief summary by default, configurable.** Notification/earcon text
defaults to the **brief summary** (e.g. "Tests pane finished — all passing", sourced from the
WS-B command summary; numeric exit codes remain out of scope per the §1 finding). The message
templates MUST be **editable by the operator via Settings, with direct access to the message/
prompt strings** (same Settings surface the user edits prompts in today — implementer to locate
and extend it). Keep brief as the default.

**Still in scope, unchanged by this decision:** BUG-010 event-bus wiring (§5), the genuine
WS-C `onIdle` trigger gating + de-spam/coalescing/rate-limit (§4 — now applied to earcons +
the notification stack rather than spoken turns), `dismiss_attention` + attentionQueue cap/TTL
(§6, BUG-035), demoting the 3 s poll to a safety net, and all "what to preserve" items (§7:
WS-C status, WS-B redaction of any displayed pane content/`last_command`, existing earcons/barge-in).

---

## 1. Executive Summary (~10 lines)

- **Problem.** Completions/errors are detected server-side (`manager.onIdle`,
  `detectAndTriggerTransitions`, `server.ts:227-253`/`:386-461`) but only feed watch rules,
  plans, and a browser badge via `broadcast()`. The Gemini Live `session` is a **local
  variable inside `wss.on("connection")`** (`server.ts:1064`) that the event path cannot
  reach, so Janus never speaks state changes. Separately, the client `ws.onmessage`
  (`src/App.tsx:870-928`) has **no branch for 9 server broadcast event types** and leans on
  a 3 s poll (`src/App.tsx:593-599`).
- **Recommended mechanism (escalate to maintainer):** **inject a system/text turn into the
  live session via `session.sendClientContent({ turns: [...], turnComplete: true })`** so
  Janus speaks the announcement **in its own voice** (option a). The genai `Session` class
  exposes this exactly (`node_modules/@google/genai/dist/genai.d.ts:10155`,
  params `:7826-7833`). Pair it with an **immediate client-side earcon** for sub-100 ms
  feedback (the spoken summary follows). This is a **hybrid (option c)** but the *spoken*
  layer is firmly option (a) — one voice, no second TTS service, no token cost beyond a
  short turn.
- **Barge-in.** A proactive turn is gated by the existing half-duplex rule
  (`isAudioPlaying`, `src/App.tsx:857`) on the **server side**: if the operator is mid-
  utterance, the announcement is **deferred (queued), not dropped**, and the operator can
  always barge-in over a playing announcement exactly as they barge-in over any model turn
  (`message.serverContent.interrupted` → `resetAudioPlayback`, `src/App.tsx:874-875`).
- **Trigger/de-spam.** Announce only on genuine Running→Idle completion and high-severity
  attention (error/build-failed/exited); never routine output. De-spam via priority ranking,
  per-pane debounce, a coalescing window ("3 panes finished"), and a token-bucket rate limit.
- **Also in scope:** `dismiss_attention` voice tool + `attentionQueue` cap/TTL (BUG-035).
- **Dependency decision:** **none required** — `sendClientContent` is already in the
  installed `@google/genai@^2.4.0`. Escalate the *mechanism choice* (a vs c), not a dep.

---

## 2. Proactive-Speech Mechanism — Options & Decision

### The core architectural constraint

The Gemini Live `session` is created and held **per-connection** (`let session = null` at
`server.ts:1064`, assigned by `session = await sessionAi.live.connect(...)` at `:1086`). The
server-side completion/error emitters — `manager.onIdle` (`server.ts:227`) and
`detectAndTriggerTransitions` (`server.ts:386`) — live at the **outer `startServer` scope**
and have access only to `broadcast()` (to browser `clients`), **not** to `session`. So
**whichever mechanism we pick, the event path must first reach a live session.** Two seams:

- **Seam A (server-direct):** lift the active session into a module-scoped registry so the
  event path can call `session.sendClientContent(...)` directly. There is effectively one
  voice session (`activeFrontendWs`, `server.ts:255`/`:1054`), so a single
  `activeVoiceSession: Session | null` (set at `:1086`, cleared in `clientWs.on("close")`,
  `server.ts:1917-1937`) is sufficient and matches the existing single-active-frontend model.
- **Seam B (client round-trip):** `broadcast()` a typed event the client converts to audio.
  This is required **anyway** for BUG-010 (§5) and for the earcon, but for *spoken* output it
  would force the browser to do TTS or echo text back to the server — strictly worse than
  Seam A for the spoken layer.

> **Decision:** spoken announcements use **Seam A** (`sendClientContent` on the registered
> session); earcons + UI state use **Seam B** (`broadcast`). Both are needed; they are
> complementary, not alternatives.

### Option (a) — Inject a text/system turn; Janus speaks it in its own voice ✅ RECOMMENDED

Call, from the event path, on the registered session:

```ts
activeVoiceSession.sendClientContent({
  turns: [{
    role: "user",
    parts: [{ text:
      "SYSTEM EVENT (announce to the operator concisely, then stop): " +
      "Pane 'tests' finished. " + redactedSummaryLine
    }]
  }],
  turnComplete: true,   // triggers an immediate spoken model turn
});
```

- **Exact API:** `Session.sendClientContent(params: LiveSendClientContentParameters)` —
  `genai.d.ts:10155`; `turns?: ContentListUnion` + `turnComplete?: boolean` at
  `:7826-7833`. `turnComplete: true` makes the server "start generation with the currently
  accumulated prompt" — i.e. Janus speaks. This is the documented mechanism for a
  conversational turn (`genai.d.ts:10123-10155`), and `sendToolResponse` /
  `sendRealtimeInput` are already used in this file (`server.ts:1240`, `:1898`), so the
  session handle and audio-return plumbing (`onmessage → type:"audio"`, `server.ts:1224-1227`)
  are **already wired** — the announcement audio comes back through the exact same path the
  operator already hears.
- **Latency:** one model turn (~hundreds of ms to first audio). Acceptable for a completion
  announcement; the earcon (option c) covers the sub-100 ms gap.
- **Cost/tokens:** one short turn per announcement; coalescing + rate-limiting (§4) keep this
  minimal. No extra API/service.
- **Voice consistency:** **perfect** — same `voiceName` (`server.ts:1067`/`:1610`), same
  prosody, same session context. Janus can also weave the event into ongoing conversation
  ("…and by the way, the tests pane just finished").
- **Reliability:** rides the existing, working audio channel. Failure mode = a normal
  send-failure (wrap in try/catch like `server.ts:1167`); the earcon still fires, so the
  operator is never left with zero feedback.
- **Risk:** the injected turn enters model context — keep it short, prefixed as a SYSTEM
  EVENT, and **redacted** (§7). Use `role:"user"` with an explicit "announce then stop"
  instruction; the system instruction (§4) should also tell Janus how to handle these.

### Option (b) — Client-side earcon + pre-rendered / separate TTS

- Earcon-only: zero latency but **no content** ("something happened" — which pane? done or
  errored?). Insufficient for the eyes-off bar (BUG-024 demands *spoken* completion/error).
- Separate/pre-rendered TTS (e.g. Web Speech API or a second Gemini TTS call): **different
  voice**, voice-consistency break, and either an extra dependency or an extra API call.
  Web Speech `speechSynthesis` would also need its own half-duplex coordination with the
  Gemini playback context — duplicating the gate. **Rejected** as the spoken layer.

### Option (c) — Hybrid: earcon now + spoken summary via the model

- Fire a **distinct completion/error earcon immediately** (Seam B, client) for instant,
  glanceable-by-ear feedback, **and** speak the detail via option (a) (Seam A). This is the
  recommendation's full shape: earcon = "an event occurred" in <100 ms; spoken turn = the
  content a second later. Best of both; the earcon also covers the case where the operator
  is mid-utterance and the spoken turn is *deferred* (§3) — they still get the earcon now and
  the words when they pause.

### Decision

**Adopt option (c) with the spoken layer implemented as option (a)
(`session.sendClientContent`).** Single voice, no new dependency, instant earcon + spoken
detail, full barge-in compatibility. **ESCALATE to the maintainer** the a-vs-pure-(c) choice
and the acceptable verbosity/rate of injected turns (token-cost posture), since injected
turns consume context and the maintainer owns the cost/UX tradeoff.

---

## 3. Barge-in / Half-Duplex Correctness (critical)

**Invariant:** a proactive announcement MUST NOT talk over the operator, and the operator MUST
be able to barge-in over an announcement.

### What exists today (preserve it)
- **Capture gate (echo prevention):** the mic processor drops capture frames while synthesized
  speech is playing — `if (isAudioPlaying(voicePlaybackCtxRef.current)) return;`
  (`src/App.tsx:857-860`). `voicePlaybackCtxRef.current === playbackCtx`
  (`src/App.tsx:835-837`), and `isAudioPlaying` includes a 200 ms guard
  (`src/utils/audio.ts:69-73`). So when Janus speaks, the mic is muted — preventing loopback.
- **Barge-in / interruption:** when the model is interrupted, the server forwards
  `type:"interrupted"` (`server.ts:1228-1230`) and the client calls `resetAudioPlayback()`
  (`src/App.tsx:874-875`), which stops all queued sources (`audio.ts:57-67`). This already
  works for any model turn — and a `sendClientContent` announcement **is** a model turn, so
  **operator barge-in over an announcement works for free.**

### Server-side speaking gate (the new piece)

The decision of *whether the operator is currently mid-utterance* must be made on the
**server**, because the announcement is injected server-side. Two signals already exist:

1. **User-turn-in-progress:** the `onmessage` handler accumulates `currentSessionUserUtterance`
   and processes `userUtterance` (`server.ts:1097-1203`). Track a boolean
   `userSpeaking` flag: set true on a non-empty `userTurn`/`turn` parts arrival
   (`server.ts:1107-1120`), cleared on the model's next turn or after a short silence timer
   (Gemini Live emits VAD-driven activity; absent explicit `activityStart/End` plumbing,
   a 600–800 ms debounce after the last user-text fragment is adequate).
2. **Model-speaking:** track `modelSpeaking` from `modelUtterance`/audio parts
   (`server.ts:1204-1227`) so we don't stack two announcements on top of an in-flight Janus
   turn.

**Gate rule for an announcement at emit time:**

| Operator/Model state | Action |
|---|---|
| `userSpeaking === true` | **Defer** — enqueue the announcement; do NOT inject. Earcon still broadcasts (client) so the operator gets non-verbal awareness now. Flush the queue when `userSpeaking` clears (next model turn boundary / silence debounce). |
| `modelSpeaking === true` (Janus mid-turn) | **Defer** — enqueue; flush on turn completion. Avoids two overlapping spoken turns. |
| idle (neither speaking) | **Inject now** via `sendClientContent`. |

- **Queue/drop/defer policy:** **defer (queue)**, never drop, for completion/error
  announcements — but the queue is the same **coalescing/priority** queue as §4, so a deferred
  batch collapses ("3 panes finished") rather than replaying stale one-by-one. Items older
  than the attention TTL (§6) are dropped on flush (no stale "build finished" 10 minutes
  later).
- **Interruption while an announcement plays:** if the operator starts speaking *during* the
  announcement, the existing interrupt path fires (`interrupted` → `resetAudioPlayback`), the
  announcement audio is cut, and the operator's turn takes over — correct and already wired.
- **A HiTL approval is pending (Janus deliberately mute, BUG-001):** WS-D announcements must
  **not** be injected while a `propose_command` HiTL response is being withheld
  (`server.ts:1335-1352`) — injecting a turn there could confuse the open vote. Gate
  announcements behind "no open `pendingApprovals` for this session is awaiting the operator's
  spoken decision" (a soft check: defer if any pending approval exists; flush after it
  resolves). This is a conservative coupling to WS-E; revisit when WS-E.1 lands the two-phase
  proposal.

---

## 4. Trigger Policy

### What announces (and what must not)

| Source | Event | Announce? | Spoken content (redacted) |
|---|---|---|---|
| `manager.onIdle` (genuine Running→Idle, WS-C) | command/agent turn **completed** | **Yes** | "Pane 'tests' finished." + the WS-C/WS-B redacted `finalResponse` summary line (`server.ts:237-239`). Include exit code **only if available** (see note). |
| `detectAndTriggerTransitions` → `transition === "error"` | error text detected (`server.ts:407-413`) | **Yes (high severity)** | "Pane 'build' reported an error." + short redacted hint. |
| `detectAndTriggerTransitions` → `"build-failed"` | build failure (`server.ts:395-405`) | **Yes (high severity)** | "Build failed on pane 'build'." |
| `detectAndTriggerTransitions` → `"exited"` | process exited (`server.ts:391-392`) | **Yes** | "Pane 'X' exited." |
| `transition === "prompt"` / `"idle"` (routine) | shell prompt / routine idle | **No** | (badge/earcon only) |
| `plan_step_completed` / `plan_completed` / `plan_paused` | plan progress (`server.ts:311-383`) | **plan_completed / plan_paused: Yes**; step: earcon only | "Plan 'deploy' completed." / "Plan 'deploy' paused — step 3 failed." |
| `watch_rule_fired` | automation fired (`server.ts:283-287`) | **No** (earcon only) | — |
| routine `stdout_chunk` | streaming output | **Never** | — |

> **Never fire on a false idle.** The completion announcement is driven **only** by
> `manager.onIdle`, which WS-C fires **only on a genuine, debounced Running→Idle edge that
> followed real work** (`src/terminal.ts:345-350` — `realDone` gate). WS-D adds **no new
> idle inference**; it strictly reuses this edge. Add the §8 regression test asserting no
> announcement on a WS-C false-idle input.

> **Exit-code note (finding):** the exit code is **not currently captured** on a shell
> command's Running→Idle — `transport.onExit(...)` discards `exitCode` at
> `src/terminal.ts:466-467`, and `onIdle` reads `HistoryManager` history which has no exit
> code field. So "exit code 0" cannot be spoken reliably today. **Options:** (i) speak
> success/failure from the WS-B `finalResponse` summary text (already classifies
> success/failure) and the error-transition signal, omitting a numeric code; or (ii) a small
> follow-on to capture `exitCode` into the history entry. **Recommend (i)** for WS-D (no
> terminal.ts surface change beyond reading existing signals); flag (ii) as optional polish.

### De-spam controls

1. **Priority ranking** (highest speaks first when batched): `build-failed`/`error` > `exited`
   > `plan_paused` > completion (`onIdle`) > `plan_completed`. Errors are never starved by
   completions.
2. **Per-pane debounce / suppression.** Maintain `lastAnnouncedAt[terminalId]`. Suppress a
   second announcement for the same pane within a short window (e.g. 4 s) — a noisy build that
   flaps error lines must not machine-gun the operator. (Mirrors the existing
   `lastStates[terminalId]` edge-dedup at `server.ts:431-433`.)
3. **Coalescing window.** Buffer announcements for a short window (e.g. 1.5 s). On flush, if ≥2
   completions are pending, collapse to one turn: *"Three panes finished: tests, lint, and
   docs."* If a mix of severities, lead with the highest ("Build failed on 'api'; two other
   panes finished."). The coalescing buffer is the **same** queue used by the §3 deferral, so
   a barge-in deferral and a burst of completions share one collapse path.
4. **Rate limiting.** A token-bucket (e.g. max 1 spoken announcement / 3 s, burst 2). When the
   bucket is empty, items wait in the coalescing buffer rather than dropping. High-severity
   (error/build-failed) may spend the burst token; completions wait.
5. **Suppress while operator/model speaking or approval pending** — per §3.

All of the above live in **one new server module-scoped controller** (`AnnouncementBus`,
conceptually): `enqueue(item)` from the event path, an internal timer that respects the gate
+ rate bucket + coalescing, and `flush()` that calls `sendClientContent` (spoken) and
`broadcast` (earcon). This keeps `onIdle`/`detectAndTriggerTransitions` thin (they just
`enqueue`).

---

## 5. Event-Bus Wiring (BUG-010)

### Verified set: server broadcasts with NO client handler

Server `broadcast({type:...})` call sites grepped in `server.ts`, cross-checked against the
`ws.onmessage` branches in `src/App.tsx:872-927`:

| Event type | Broadcast site(s) | Client handler today? |
|---|---|---|
| `attention_updated` | `server.ts:341,369,455,772,781` | **MISSING** |
| `plans_updated` | `server.ts:382` | **MISSING** |
| `watch_rules_updated` | `server.ts:297` | **MISSING** |
| `pane_transition` | `server.ts:436-441` | **MISSING** |
| `plan_step_completed` | `server.ts:311-316` | **MISSING** |
| `plan_completed` | `server.ts:347-351` | **MISSING** |
| `plan_paused` | `server.ts:370-374` | **MISSING** |
| `history_updated` | `server.ts:241-245` | **MISSING** |
| `watch_rule_fired` | `server.ts:283-287` | **MISSING** |

Handled today (preserve): `audio`, `interrupted`, `approval_pending`, `prompt_buffer_updated`,
`terminals_updated`, `ledger_updated`, `settings_updated`, `command_auto_executed`,
`command_blocked`, `stdout_chunk`, `transcript_text`, `error`
(`src/App.tsx:872-927`). **Confirmed: exactly the 9 events in the brief are unhandled.**

### `ws.onmessage` branches to add (in `src/App.tsx`, after `:927`'s `error` branch)

| New branch | State setter(s) driven from payload | Earcon |
|---|---|---|
| `attention_updated` | `setAttentionQueue(msg.queue)` (replaces `fetchAttentionQueue()` poll, `App.tsx:377-386`) | new `"completion"`/`"alert"` per highest unread severity |
| `plans_updated` | `setPlans(msg.plans)` (replaces `fetchPlans()`, `:399`) | none |
| `watch_rules_updated` | `setWatchRules(msg.watchRules)` (replaces `fetchWatchRules()`, `:388`) | none |
| `pane_transition` | `fetchTerminals()` (lightweight) or patch the pane's state | `"completion"` on idle/exited, `"alert"` on error/build-failed |
| `plan_step_completed` | patch step status in `plans` (or `fetchPlans()`) | `"execute"` |
| `plan_completed` | mark plan complete; (spoken via §4) | `"success"` |
| `plan_paused` | mark plan paused; (spoken via §4) | `"alert"` |
| `history_updated` | update per-terminal history view if open | none |
| `watch_rule_fired` | toast / log; `fetchTerminals()` | `"chime"` |

Add a **new distinct `"completion"` earcon** (per BUG-018's spirit; e.g. a short rising
two-note) so completion is audibly distinct from `alert`/`execute`/`success`/`chime`
(`src/App.tsx:73-151`). This is the **non-verbal half of the option-(c) hybrid** and fires
immediately on the broadcast, before the spoken turn arrives.

### 3 s poll reduction

The poll (`src/App.tsx:593-599`) refreshes terminals/attention/watch/plans every 3 s. With the
push branches above driving the same setters, **demote the poll to a slow safety-net
(e.g. 15–30 s)** rather than removing it (keeps resilience if a broadcast is missed on a
flaky socket). Keep `fetchTerminals()` on `terminals_updated` (already wired). Do **not** add
a new poll for proactive audio — it is purely push.

---

## 6. `dismiss_attention` Voice Tool + `attentionQueue` Cap/TTL (BUG-035)

### `dismiss_attention` voice tool
- **Declare** in the `functionDeclarations` array (alongside `get_attention_digest`,
  `server.ts:1620-1881`):
  ```
  name: "dismiss_attention"
  description: "Dismiss one attention item by its id (or all items) once the operator has
                acknowledged it, so it stops appearing in the digest and announcements."
  parameters: { id?: STRING ("the attention item id; omit to dismiss all") }
  ```
- **Handle** in the `message.toolCall` switch (`server.ts:1233-1603`): mirror the REST dismiss
  (`server.ts:768-783`) — set `item.dismissed = true` (or all), `broadcast({type:"attention_updated", queue})`,
  and `session.sendToolResponse({ functionResponses:[{ name:"dismiss_attention", id: call.id,
  response:{ output: "..." }}]})`. Reuse the same array, so REST and voice share one path.
- This makes the eyes-off operator able to clear alerts by voice ("dismiss that") — today
  dismiss is **REST-only** (`server.ts:768`), a hands-free gap.

### `attentionQueue` cap + TTL
- The queue is an in-memory array pushed-to but **never evicted** (`server.ts:332-340`,
  `:359-368`, `:446-454`) — unbounded; stale items inflate the digest
  (`server.ts:1378-1601`) and would inflate announcements.
- **Cap:** keep at most N (e.g. 50) items; on push past N, drop the oldest **dismissed**
  first, else the oldest.
- **TTL:** on each push (and on digest/announcement read), evict items whose
  `timestamp` is older than a TTL (e.g. 10 min) OR are dismissed and older than ~1 min.
  Implement as a small `pruneAttentionQueue()` helper called at the push sites and before
  `get_attention_digest`/announcement flush.
- **Announcement coupling:** the §4 coalescing/deferral queue drops items past TTL on flush —
  consistent with the attention TTL so a deferred announcement never speaks a stale event.

---

## 7. Integration Points, Back-Compat, Preserve

### Integration points (file:line)

| Location | Change |
|---|---|
| `server.ts:1064`, `:1086` | Register the live session: set module-scoped `activeVoiceSession = session` after `live.connect`. |
| `server.ts:1917-1937` (`clientWs.on("close")`) | Clear `activeVoiceSession = null` (and flush/clear the announcement queue) when the session closes. |
| `server.ts:227-253` (`manager.onIdle`) | After the existing summary write, `announcementBus.enqueue({kind:"completion", terminalId, summary: lastEntry.finalResponse})`. Read existing redacted `finalResponse`; do NOT add new idle logic. |
| `server.ts:386-461` (`detectAndTriggerTransitions`) | On `error`/`build-failed`/`exited` (already gated by the `lastStates` edge at `:431-433`), `announcementBus.enqueue({kind: transition, terminalId, ...})`. Reuse the existing edge-dedup. |
| `server.ts:311-383` (`handlePlansTrigger`) | Enqueue `plan_completed`/`plan_paused` announcements alongside the existing broadcasts. |
| **New** server controller (`AnnouncementBus`) | Module-scoped (outer `startServer` scope, near `broadcast`, `server.ts:258`). Holds the coalescing queue, rate bucket, per-pane debounce, gate flags (`userSpeaking`/`modelSpeaking`/approval-pending), and `flush()` → `sendClientContent` + `broadcast` earcon. Injectable session + clock for tests (§8). |
| `server.ts:1097-1227` (`onmessage`) | Set `userSpeaking`/`modelSpeaking` flags feeding the gate (§3). On model turn completion / user-silence debounce, call `announcementBus.flush()`. |
| `server.ts:768-783` | (Reference) REST dismiss — voice `dismiss_attention` mirrors it. |
| `server.ts:332-340,359-368,446-454` | Call `pruneAttentionQueue()` (cap/TTL) at push sites. |
| `server.ts:1620-1881` | Declare `dismiss_attention`; add handler in the `toolCall` switch (`:1233-1603`). |
| `src/App.tsx:872-927` | Add the 9 `else if` branches (§5). |
| `src/App.tsx:73-151` | Add a distinct `"completion"` earcon type. |
| `src/App.tsx:593-599` | Demote the 3 s poll to a slow safety-net interval. |
| `src/App.tsx:377-399` | The push branches drive `setAttentionQueue`/`setPlans`/`setWatchRules` directly (the fetchers remain as initial-load + safety-net). |

### Back-compat
- New WS event handling is **additive** — unknown types are already ignored (no `else`
  throw). Existing handled types are untouched.
- `sendClientContent` exists in the pinned `@google/genai@^2.4.0` (`genai.d.ts:10155`); no
  version bump. No new runtime dependency.
- Wrap every `sendClientContent` in try/catch (like `server.ts:1167`); on failure the earcon
  broadcast still fires, so behavior degrades to today's (badge/earcon) not worse.
- The poll demotion keeps the fetchers; if a socket misses a push the slow poll still
  reconciles — no regression in eventual consistency.

### What to preserve (do not regress)
- **WS-C reliable status:** announcements consume `manager.onIdle` **only**; add no new idle
  inference (the `realDone` gate at `src/terminal.ts:345-350` stays authoritative).
- **WS-B redaction:** any spoken pane content / `last_command` / summary MUST pass through
  `redactSecrets` (`src/terminal.ts`, exported via `server.ts:10`). The `onIdle` summary is
  already redacted (`summarizeCommandOutcome`, `server.ts:203-218`); the error-hint snippet
  and any `last_command` in an announcement must be redacted before injection. **No raw pane
  text in a `sendClientContent` turn.**
- **Barge-in / half-duplex:** the capture gate (`App.tsx:857`), the 200 ms guard
  (`audio.ts:71`), and `interrupted → resetAudioPlayback` (`App.tsx:874-875`) are unchanged —
  announcements ride them.
- **Existing earcons** (`alert`/`success`/`execute`/`chime`) and their current triggers stay;
  `"completion"` is purely additive.
- **HiTL gate, per-session pending filtering** (`server.ts:1146`) and the auth gate
  (`server.ts:1046-1052`) untouched.

---

## 8. Test Plan (no live Gemini session; node:test + tsx)

The suite runs via `tsx --test tests/*.ts` (`package.json:10`) and **must exit cleanly** — no
leaked timers/handles. All new timers (coalescing, rate bucket, prune, user-silence debounce)
MUST be cleared in teardown, exactly as `tests/test_status_gating.ts` tears down via
`term.stop()`.

### Seams / mocks (no real session)
- **`AnnouncementBus` takes injected dependencies:** a fake `session` exposing
  `sendClientContent(spy)` and `sendToolResponse(spy)`, an injected `broadcast(spy)`, and an
  **injected clock** (fake timer / advanceable `now()`) so coalescing/rate-limit windows are
  driven deterministically without real `setTimeout` waits. This is the same DI pattern WS-C
  used for `StatusProbe` (`tests/test_status_gating.ts:16-44`).
- No PTY spawn and no `live.connect` are exercised — the bus is a pure unit with seams.

### Tests
1. **Completion announce.** `enqueue({kind:"completion", ...})` → after flush, `sendClientContent`
   spy called once with a turn containing the (redacted) summary and `turnComplete:true`.
2. **No announce on false idle (WS-C coupling, regression guard).** Drive a *false-idle* input
   through the real `UniversalTerminal` with an injected probe that reports a running child
   (per `tests/test_status_gating.ts`): assert `onIdle` does **not** fire and therefore no
   `enqueue`/`sendClientContent`. This is the §4 "never on false idle" guarantee.
3. **Debounce/coalescing.** Enqueue 3 completions within the window → exactly **one**
   `sendClientContent` whose text names all three panes ("three panes finished"). Enqueue a
   4th for the same pane within the per-pane window → suppressed.
4. **Priority.** Enqueue a completion + an `error` in one window → the single spoken turn leads
   with the error (severity ranking).
5. **Rate limit.** Enqueue N completions faster than the bucket allows → spoken turns are
   spaced (advance the fake clock), none dropped, order preserved.
6. **Barge-in deferral.** Set `userSpeaking=true`, enqueue a completion → no `sendClientContent`,
   but the earcon `broadcast` spy IS called. Clear `userSpeaking` + flush → the (coalesced)
   spoken turn now fires. Same for `modelSpeaking` and approval-pending gates.
7. **Redaction.** Enqueue a completion whose summary contains an AWS key / JWT → the
   `sendClientContent` turn text contains `[REDACTED:*]`, never the secret (table-driven,
   reuse `tests/test_redaction.ts` patterns).
8. **Event-bus branches (client).** Pure-function test of the `ws.onmessage` dispatch: feed each
   of the 9 event payloads to the handler (extract it to a testable reducer or test via a
   jsdom-free state shim) and assert the matching setter is called and the right earcon type is
   selected. At minimum, assert the **mapping table** (event → setter → earcon) as a data-driven
   unit so it can run without a DOM.
9. **`dismiss_attention` + TTL.** Push items past the cap/TTL → `pruneAttentionQueue` evicts the
   right ones; voice `dismiss_attention` sets `dismissed` and broadcasts `attention_updated`.

### Suite-exit hygiene
- Every test that constructs an `AnnouncementBus` (or a terminal) calls a teardown that clears
  its timers (the bus exposes `stop()`/`dispose()`), mirroring `teardown(term)` at
  `tests/test_status_gating.ts:46-50`. Use the injected clock so no real timers are armed.

---

## 9. Risk Register + Dependency Decision

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Injected `sendClientContent` turn talks over the operator. | Med | High | Server-side `userSpeaking`/`modelSpeaking`/approval gate (§3); defer-not-inject; barge-in cuts it via existing `interrupted` path. |
| R2 | Announcement spam (noisy build, fan-out burst) fatigues / desensitizes the operator. | Med | Med | Per-pane debounce + coalescing window + token-bucket rate limit + priority ranking (§4). |
| R3 | Fires on a false idle, training distrust. | Low (WS-C done) | High | Strictly reuse `manager.onIdle` (`terminal.ts:345-350`); add no new idle logic; regression test #2. |
| R4 | Secret leaks into a spoken turn (injected text bypasses redaction). | Med | High | All announcement text (summary, error hint, `last_command`) through `redactSecrets` before `sendClientContent` (§7); test #7. |
| R5 | `activeVoiceSession` registry races reconnect (stale handle after close). | Med | Med | Set on connect, null on close (`server.ts:1917-1937`); flush/clear queue on close; try/catch every send → earcon-only fallback. |
| R6 | `userSpeaking` debounce mis-tuned → announcements feel laggy or interrupt. | Med | Low | Tunable debounce (600–800 ms) + setting; default conservative (favor deferral). Escalate default to maintainer. |
| R7 | Injected turns inflate context/token cost. | Low | Med | Short SYSTEM-EVENT turns + coalescing + rate limit; context-window compression already on (`server.ts:1615-1618`). Escalate verbosity posture. |
| R8 | Leaked timers fail suite-exit. | Low | Med | Injected clock + `bus.stop()` teardown (§8). |
| R9 | Exit code not available for "exit code 0" phrasing. | Known | Low | Speak success/failure from WS-B summary + error transition; numeric code is optional follow-on (`terminal.ts:466-467`). |

**Dependency decision: NONE.** `session.sendClientContent` is in the already-installed
`@google/genai@^2.4.0` (`genai.d.ts:10155`). No new package, no version bump. The only thing
to **ESCALATE to the maintainer** is the *mechanism/verbosity choice*: (a) confirm spoken
announcements via `sendClientContent` (in-voice) vs a non-Gemini fallback; (b) the acceptable
announcement rate/verbosity (token-cost posture); (c) the `userSpeaking` deferral default.

---

## Appendix — Cited locations
- Live session create/hold (per-connection, local): `server.ts:1064`, `:1086`; config/tools/voice
  `:1607-1882`; system instruction `:1612`.
- Server→model send methods in use: `sendToolResponse` `server.ts:1240`+; `sendRealtimeInput`
  (mic) `:1898`. Audio return to client: `:1224-1227`. Interrupt forward: `:1228-1230`.
- Event emitters: `manager.onIdle` `server.ts:227-253`; `detectAndTriggerTransitions`
  `:386-461` (edge-dedup `:431-433`, severity push `:443-456`); plans `:301-384`; watch rules
  `:273-299`. `broadcast` `:258-269`; `clients`/`activeFrontendWs` `:255`,`:1054-1055`.
- WS-C genuine idle edge: `src/terminal.ts:344-350` (`realDone`), onIdle plumb `:716-717`.
- Exit code discarded: `src/terminal.ts:466-467`.
- Client `ws.onmessage`: `src/App.tsx:870-928`; capture half-duplex gate `:857-860`; audio ctx
  `:834-837`; earcons `:73-151`; poll `:593-599`; fetchers `:300-399`.
- Audio helpers: `src/utils/audio.ts:20-73` (`playAudioChunk`/`resetAudioPlayback`/`isAudioPlaying`).
- Attention queue: type `src/types.ts:110-119`; pushes `server.ts:332-340,359-368,446-454`;
  REST dismiss `:768-783`; digest `:1378-1601`.
- genai API: `Session.sendClientContent` `genai.d.ts:10155`; params `:7826-7833`;
  `sendRealtimeInput` `:10178`; `sendToolResponse` `:10193`.
- Tests/DI pattern: `tests/test_status_gating.ts:16-50`; redaction `tests/test_redaction.ts`;
  run via `package.json:10`.
