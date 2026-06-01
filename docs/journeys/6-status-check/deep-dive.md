# Journey 6: On-Demand Status Check — Deep Dive

**Scope:** "Ask 'what's busy or done?' across all panes whenever you want a spoken status of in-flight work."
**Modality constraint:** Janus input is audio-only (16 kHz PCM in; audio + tool calls out). No vision. All "content" is terminal output accessed via `get_pane_summary`. Fully hands-free, eyes-off.

---

## 1. Journey Overview & Trigger

The operator speaks a natural-language status question at any moment during a work session — for example: *"What's running right now?"*, *"Which panes are done?"*, or *"Give me a status across everything."*

Janus has no background polling loop. The journey is entirely **pull-based and on-demand**: the operator's voice utterance is the only trigger. There is no scheduled heartbeat, no push notification, and no proactive interruption unless an `AttentionItem` already exists in the queue from a prior error or exit event.

The journey relies on three interconnected mechanisms:
1. `syncLedger()` in `src/terminal.ts` — propagates live `UniversalTerminal.status` into ledger `PaneMeta`.
2. `list_panes` tool in `server.ts` — calls `manager.listPanes()`, which calls `syncLedger()` first, then returns ledger state.
3. `get_attention_digest` tool in `server.ts` — reads `manager.attentionQueue` for any unread error, exit, build-failed, or approval items.

---

## 2. Current Flow (As Built) — Step-by-Step Hands-Free

### Step 1: Operator speaks a status question

The browser streams 16 kHz PCM audio over the `/live` WebSocket. `server.ts` proxies frames to a Gemini Live session established per connection. Janus receives the audio, transcribes it, and decides which tool(s) to call.

### Step 2: Janus calls `list_panes`

Defined in `server.ts:1579–1585` with description: *"List all projects and their panes with runtime_type, is_busy, alive, and a one-line state. Cheap orientation call."*

At `server.ts:1223–1227`, the handler runs:
```
manager.listPanes()
```

`listPanes()` is defined in `src/terminal.ts:551–561`. It calls `this.syncLedger()` before returning, so the data is as fresh as the moment of the call.

### Step 3: syncLedger maps terminal status to ledger fields

`syncLedger()` is defined in `src/terminal.ts:564–591`. For each entry in `manager.terminals`, it writes a `PaneMeta` into the ledger with:

```typescript
is_busy: term.status === "Running",         // terminal.ts:579
alive:   term.status !== "Exited",          // terminal.ts:580
last_known_state: term.status === "Running"
  ? "Running active command"
  : term.status === "Idle" ? "Idle" : "Exited"  // terminal.ts:576–578
```

So `is_busy` and `alive` are computed **synchronously from `term.status`** at the exact moment `listPanes()` is called. The ledger value is only as fresh as the last output chunk received by the process.

### Step 4: Janus may also call `get_attention_digest`

Defined in `server.ts:1682–1688`. The handler at `server.ts:1360–1373` reads `manager.attentionQueue`, filters for `!item.dismissed`, and assembles a spoken string:

- If empty: *"There are no pending alerts or actions requiring your attention right now."*
- If items exist: *"There are N items requiring attention. 1. Pane X in project Y transitioned to [type]: [message]. ..."*

The attention queue is populated reactively when `detectAndTriggerTransitions()` in `server.ts:379–447` observes `error`, `build-failed`, or `exited` transitions in stdout chunks. It is **not polled** — items are pushed at the time output is received.

### Step 5: Janus synthesizes and speaks a summary

Janus combines the `list_panes` response (structured JSON with per-pane `is_busy`, `alive`, `last_known_state`, `tool_preset`, `permissions_mode`) and the attention digest text, then speaks a natural-language summary over the audio output channel back to the operator.

The system instruction injected at session start (`server.ts:1568`) also embeds a snapshot of `t.status` for each terminal at connection time, but this is **static** for the session lifetime unless Janus re-calls `list_panes`.

### How Fresh / Accurate Is the Data?

`list_panes` triggers `syncLedger()` which reads `term.status` **at invocation time** — so the data is fresh at the instant of the tool call. However, `term.status` itself is computed from a heuristic on output stream events (see Section 4). There is no timestamp on `is_busy` or `alive`, so Janus cannot tell the operator whether a pane has been busy for 2 seconds or 20 minutes.

---

## 3. Ideal End-User Experience

An operator working hands-free with three agent panes open asks: *"Hey Janus, what's the current status across everything?"* The ideal interaction:

1. **Immediate spoken summary** naming each pane by its human label (not raw ID), its status, and a one-sentence description of what it was last doing — e.g.: *"Claude Code on proj-alpha is running and has been active for about 4 minutes. The Codex backend pane finished and is idle, last command completed successfully. The data-pipeline pane exited unexpectedly — there's a build failure queued for your review."*
2. **No extra steps required.** The operator does not need to ask follow-up questions to get the failure summary; it is included in the first response.
3. **Actionable routing.** Janus offers a next step: *"Would you like me to read the error output from data-pipeline, or shall I propose a fix?"*
4. **Accuracy guarantee.** `is_busy` reflects whether the shell is actually executing something, not whether output happened to arrive recently.
5. **Elapsed time context.** *"Running for 4 minutes"* rather than just *"Running"* — critical for detecting stuck or hung panes.

Currently, steps 1 and 2 are partially met. Steps 3, 4, and 5 are not.

---

## 4. Backend Support

### syncLedger — Detection Logic

**File:** `src/terminal.ts:564–591` (syncLedger), `src/terminal.ts:156–189` (updateStatusOnOutput)

`UniversalTerminal.status` is one of `"Running" | "Idle" | "Exited"`. It is set by two mechanisms:

**Mechanism A — Prompt-pattern heuristic (`updateStatusOnOutput`, called on every stdout/stderr chunk):**

```typescript
// src/terminal.ts:163
const inputPromptPattern = /([\?$#>]|\[[yY]\/[nN]\]|\([yY]\/[nN]\)|password:|confirm\??)\s*$/i;
```

If the last line of the most recent 5 lines matches this regex, status is set to `"Idle"`. Otherwise status is set to `"Running"` and a 1-second idle timer is started.

**Mechanism B — 1-second idle timer fallback (`src/terminal.ts:179–188`):**

If no prompt pattern is matched within 1 second after the last output chunk, the status falls back to `"Idle"` regardless of whether the process is actually waiting for input.

**Mechanism C — Process lifecycle events (`src/terminal.ts:304–315`):**

`process.on('exit')` and `process.on('close')` both set `status = "Exited"`. `process.on('error')` also sets `"Exited"`. These are reliable.

**`is_busy` mapping (`src/terminal.ts:579`):**
```typescript
is_busy: term.status === "Running",
```
`is_busy` is `true` only while `status === "Running"`, which occurs between receiving a non-prompt output chunk and either: (a) seeing a prompt pattern in subsequent output, or (b) the 1-second idle timeout firing.

**`alive` mapping (`src/terminal.ts:580`):**
```typescript
alive: term.status !== "Exited",
```
`alive` is `false` only after a `close`/`exit`/`error` event on the child process. This is reliable via Node.js child_process event hooks.

**Assessment of `is_busy` reliability:**

`is_busy` is **a weak heuristic, not a reliable signal.** The core limitations are:

- **1-second timeout creates false Idle.** A long-running command that produces no output for >1 second (compilation, network wait, disk I/O) will flip `is_busy` to `false` and `status` to `"Idle"` even while actively executing. `src/terminal.ts:179–188`.
- **Prompt-pattern false positives.** Any output line ending in `$`, `#`, or `>` — including code samples, shell script output, or log lines from AI agents — will immediately flip status to `"Idle"` even mid-execution. `src/terminal.ts:163–175`.
- **PTY wrapping adds noise.** The process is spawned via `script -q -f -c ... /dev/null` (Linux) or `script -q /dev/null` (macOS) at `src/terminal.ts:243–249`. PTY output frequently includes prompt-like sequences from terminal emulation escape codes, even after `stripAnsiSequences` is applied.
- **No kernel-level busy signal.** There is no `waitpid`, process group state, or `/proc` check. The system has no authoritative mechanism to distinguish "shell waiting for input" from "shell running subprocess."
- **`is_busy` is computed at `syncLedger` call time**, not maintained continuously. Between `list_panes` calls, the ledger's `is_busy` value is stale. `src/terminal.ts:551–561`.

**`alive` reliability:** High. It is driven by `process.on('exit'|'close'|'error')` at `src/terminal.ts:304–315`, which are reliable Node.js event loop signals. The only edge case is a zombie process where the child process group survives but the tracked PID exits; the detached spawn at `src/terminal.ts:255–259` with `detached: true` makes this a concern.

**Real vs. mocked/stubbed:**

- `syncLedger`, `listPanes`, `is_busy`, `alive`: **Real — live code path** in production. Tested in `tests/test_terminal_manager.ts:14–32` and `tests/test_journeys.ts:212–237`, but both tests **manually set `term.status`** rather than driving actual process output, so the heuristic detection itself is not tested end-to-end.
- `attentionQueue`: **Real** — populated by `detectAndTriggerTransitions` in `server.ts:379–447`, which scans stdout text for error keywords and process exit events.
- Mock mode (`App.tsx:991–1088`): Populates hardcoded terminal state with `is_busy: true/false` and `status: "Running"/"Idle"` values for UI development only. Not relevant to production path.

### list_panes Tool

**File:** `server.ts:1579–1585` (declaration), `server.ts:1223–1227` (handler), `src/terminal.ts:551–561` (implementation)

Calls `manager.listPanes()` which iterates `ledger.workspaces` after calling `syncLedger()`. Returns an array of `{ project_id, panes: PaneMeta[] }`. Each `PaneMeta` includes `is_busy`, `alive`, `last_known_state`, `name`, `tool_preset`, `permissions_mode`, `context_size`, `session_id`. No timestamp of last-change is included.

### get_attention_digest Tool

**File:** `server.ts:1682–1688` (declaration), `server.ts:1360–1373` (handler)

Reads `manager.attentionQueue` (in-memory array, not persisted to ledger). Filters `!item.dismissed`. Generates a flat spoken text string. Queue items have `type: "approval" | "exited" | "error" | "build-failed" | "confirmation"` (defined in `src/types.ts:101–110`) and include `terminalId`, `projectId`, `message`, `timestamp`.

The attention queue is populated at `server.ts:430–442` (error/build-failed/exited transitions) and `server.ts:325–334` / `server.ts:353–362` (plan failures). It is **never automatically cleared**; items remain until explicitly dismissed via `GET /api/attention` → `PATCH /api/attention/:id/dismiss` or the dismiss-all endpoint at `server.ts:767–768`.

---

## 5. UI Support

**File:** `src/App.tsx`

The UI renders pane status via a heatmap grid of tile components:

**Heatmap tile color logic (`src/App.tsx:1380–1408`):**
- `term.status === "Running"`: emerald border + pulsing green dot (`animate-pulse bg-emerald-500`)
- `term.status === "Idle"`: yellow border + static yellow dot
- `term.status === "Exited"`: red border + static red dot
- Pending approval (overrides status): amber pulsing border + pinging amber dot

**Hover popover (`src/App.tsx:1470–1560`):**
- Shows `statusLabel`: `"ACTIVE EXECUTING"`, `"Idle & Listening"`, `"TERMINATED"`, or `"AWAITING APPROVAL"`
- Shows last 4 lines of `term.output`, `tool_preset`, `permissions_mode`, CWD
- Does **not** show `is_busy` or `alive` from ledger `PaneMeta` — it reads `term.status` from the React `Terminal` state directly

**Status filter bar (`src/App.tsx:1363`):**
```
{terminals.filter(t => t.status === "Running").length}/{terminals.length} Running
```
Shows count of Running panes at a glance.

**recentlyIdled animation (`src/App.tsx:626–656`):**
When a terminal transitions from `"Running"` to `"Idle"`, it is added to `recentlyIdled` state, which can trigger brief UI feedback for 6 seconds. This is a visual-only signal with no audio counterpart for the hands-free operator.

**TerminalView component (`src/components/TerminalView.tsx`):**
Renders raw terminal output via xterm.js. No status indicator is embedded in `TerminalView` itself — status context lives only in the parent `App.tsx` pane card. No `is_busy` or `alive` field from `PaneMeta` is surfaced in the UI at all; the UI relies solely on `Terminal.status` from the WebSocket-synced React state.

**Attention queue visual (`src/App.tsx:1773–1790`):**
Items in `attentionQueue` are rendered with type-colored badges (`error` → red, `approval` → amber, `exited` → orange, `build-failed` → red). Unread count shown as a pulsing red badge on the alerts tab. The tab itself is not voice-announced proactively; Janus must call `get_attention_digest` explicitly.

---

## 6. Future-State Best-in-Class

### Target Experience

A best-in-class hands-free status check would provide:

1. **Accurate busy detection.** Replace the 1-second heuristic with a real shell-prompt sentinel. Write a known unique sentinel string to the PTY at a regular interval or after each command, and detect its return as a reliable "shell is idle and at prompt" signal. Alternatively, track the child process group via `/proc/[pid]/stat` on Linux to detect whether subprocesses are in `S` (sleeping/waiting) vs. `R` (running) state.

2. **Elapsed-time in spoken output.** Store a `last_status_change_at` ISO timestamp on `PaneMeta` alongside `is_busy`. When Janus speaks the summary, it can say *"Running for 6 minutes"* or *"Idle since 14:32"* — critical for detecting hung panes.

3. **Proactive spoken completion alerts.** When `onIdle` fires at `src/terminal.ts:173–175` (transition from Running to Idle), push an audio notification event to the browser WebSocket so Janus speaks *"Pane [name] just finished."* without the operator having to ask. The `onIdle` callback is already wired from `UniversalTerminal` through `OrchestratorManager` at `src/terminal.ts:539–541` but currently only feeds watch rules and plan progression — not Janus voice output.

4. **Error surfacing without asking.** The `detectAndTriggerTransitions` function at `server.ts:379–447` already identifies error/build-failed/exited transitions and pushes `AttentionItem`s. The missing link is an audio push: when a high-severity `AttentionItem` is added, send a `type: "attention_alert"` WebSocket event to the client that triggers an earcon chime (`playEarcon("alert")` is already defined in `src/App.tsx:73`) and has Janus speak *"Warning: data-pipeline exited with a build error."*

5. **Per-pane last-command context in spoken summary.** Currently `list_panes` returns only `last_known_state` — a static string. A richer status summary would call `get_pane_command_history` for each busy pane and include the last command name in the spoken output: *"Claude Code on proj-alpha is running 'npm run build', started 2 minutes ago."*

6. **Reliable alive detection for detached process groups.** The current `detached: true` spawn at `src/terminal.ts:255–259` means the process group survives independently. A watchdog that periodically checks `process.kill(pid, 0)` (signal 0 = existence probe) would let `alive` accurately reflect zombie or orphaned process states.

### Required New Capabilities

| Capability | Mechanism |
| --- | --- |
| Real prompt-sentinel idle detection | Write unique token to PTY stdin; detect echo in stdout to flip status |
| Elapsed-time field on PaneMeta | Add `last_status_change_at: string` to `PaneMeta` in `src/ledger.ts` and `src/types.ts`; set in `syncLedger` |
| Proactive completion audio push | Wire `onIdle` callback to emit `type: "pane_completed"` WebSocket event; have client trigger Janus TTS |
| Proactive error audio push | Extend `detectAndTriggerTransitions` to emit `type: "attention_alert"` WS event on high-severity items |
| Process-group alive probe | Periodic `kill(pid, 0)` watchdog to validate `alive` beyond process event hooks |
| Spoken per-pane elapsed time | Include `last_status_change_at` in `list_panes` response; Janus incorporates into spoken summary |

---

## Summary (5 lines)

1. `is_busy` is a **weak output-stream heuristic** (`src/terminal.ts:156–188`): it flips false after 1 second of output silence or on any line ending in `$`/`>`/`#`, meaning long-running silent commands will falsely appear idle, and any agent output containing shell-like suffixes causes false idle transitions.
2. `alive` is **reliable**: it is driven by actual `process.on('exit'|'close'|'error')` Node.js events at `src/terminal.ts:304–315`, not inferred from output patterns.
3. The Journey 6 test suite (`tests/test_journeys.ts:212–237`) only validates that `syncLedger` correctly **propagates a manually-set `term.status`** into the ledger — it does not exercise the heuristic detection at all, so the heuristic's failure modes are completely untested.
4. `get_attention_digest` (`server.ts:1360–1373`) is accurate for **error/exit/build-failure events** already surfaced to the attention queue, but misses in-flight busy status entirely and has no elapsed-time information.
5. The largest gap between current and best-in-class is the absence of **proactive spoken alerts**: `onIdle` and `detectAndTriggerTransitions` already detect completions and errors server-side but never push audio to Janus, requiring the operator to actively ask rather than being notified hands-free.
