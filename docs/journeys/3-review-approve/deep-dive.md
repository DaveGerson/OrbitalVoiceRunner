# Journey 3: Review & Approve Code Across Panes — Deep Dive

> ⚠️ **HISTORICAL — audited 2026-05-30, NOT maintained.** This deep-dive describes the code as it
> stood in May 2026. The voice/approval stack has since been rewritten: approval routing now lives
> in `src/voiceApprovalRouting.ts` + `src/gating/index.ts` (TTL → last-call → grace → expire,
> defer/hold, stop-all brake) behind the turn arbiter, and persistence is the SQLite `JanusStore`
> — **not** the `.janus_ledger.json` `Ledger`. **Verify every `file:line` citation against current
> code before acting on it.** The companion per-journey gap register (`gaps.md`) was retired on
> 2026-08-05; live defects are tracked in beads (`bd ready`). Context and retrieval instructions:
> [`docs/journeys/README.md`](../README.md).

**Journey statement:** "Move between panes and approve or reject agent-proposed commands by voice, without leaving the conversation."

---

## 1. Journey Overview & Trigger

Journey 3 is the Human-in-the-Loop (HitL) safety gate at the heart of OrbitalVoiceRunner. It activates whenever Janus calls the `propose_command` tool against a pane whose effective permissions mode resolves to `Human-in-the-Loop`. The operator never touches a keyboard or mouse: pane navigation, command review, and accept/reject all happen through voice alone.

**Primary trigger condition:** `effectivePermissions === "Human-in-the-Loop"` inside the `propose_command` branch of the WebSocket tool-call handler (`server.ts:1278–1334`). The effective mode is computed by checking `manager.globalPermissionsMode`; if it is `"Inherit"`, the pane's own `term.permissionsMode` applies, defaulting to `Human-in-the-Loop` when no pane-level override exists (`server.ts:1272–1276`).

**Actors:**
- Janus (Gemini Live voice agent) — proposes commands, reads back content on request.
- The operator — approves or rejects entirely by voice (or optionally by UI).
- `server.ts` — hosts the voice interception parser, the `pendingApprovals` map, and the REST approval endpoint.
- `ApprovalDialog.tsx` — the visual confirmation modal rendered on top of the UI.

---

## 2. Current Flow (As Built) — Hands-Free / Eyes-Off Step by Step

### Step 1 — Operator speaks a task

The browser captures 16 kHz PCM audio from the microphone via `AudioContext` at `sampleRate: 16000` (`App.tsx:834`). A half-duplex barge-in gate (`App.tsx:857–860`) suppresses microphone frames while Janus is actively speaking through the playback context at 24 kHz, preventing echo loopback. Frames are base64-encoded and sent to the server over the `/live` WebSocket (`App.tsx:861–862`). The server forwards them to the Gemini Live session via `session.sendRealtimeInput` (`server.ts:1853`).

### Step 2 — Janus decides and calls `propose_command`

Janus (Gemini Live model) emits a `toolCall` message. The server iterates `message.toolCall.functionCalls` (`server.ts:1218–1219`). For `propose_command`, it resolves `pane_id` and `command` from `call.args` (`server.ts:1267–1269`).

**Effective permissions decision tree (`server.ts:1272–1334`):**

| `effectivePermissions` | Action |
|---|---|
| `"Full Auto"` | `term.writeInput(cmd)` immediately; sends `command_auto_executed` to client |
| `"Read-Only"` | Sends error response to Gemini; sends `command_blocked` to client |
| `"Human-in-the-Loop"` | Registers in `pendingApprovals` map; sends `approval_pending` event to client |

### Step 3 — Proposal enters the pending map

Under HitL, the server builds the rationale object:

```
const trigUtterance = currentSessionUserUtterance || "Spoken execute command";
const pSummary = manager.getPaneSummary(targetId, 5);
const rationale = { trigger: trigUtterance, summary: pSummary };
pendingApprovals[messageId] = { cmd, terminalId: targetId, callId: call.id, session, rationale };
```
`server.ts:1321–1324`

`messageId` is `call.id` — the Gemini function-call identifier, which is unique per tool invocation. The Gemini tool response is deliberately withheld at this point (`server.ts:1334` comment: "We do NOT send tool response here"). Gemini is left waiting; the session is suspended until the operator resolves the approval.

Crucially, `rationale.trigger` is the last transcribed utterance that led to the tool call, and `rationale.summary` is a fresh 5-line snapshot of the target pane's terminal output, obtained via `getPaneSummary`. Both are captured synchronously at the moment of interception.

### Step 4 — Frontend receives `approval_pending` and raises the alert

The client WebSocket handler in `App.tsx:876–887` processes the `approval_pending` message:

1. Plays a two-tone sawtooth earcon ("alert") via the Web Audio API (`App.tsx:877`, `playEarcon("alert")`).
2. Fires an OS-level desktop notification: "Node X is waiting for execute confirm: {cmd}" (`App.tsx:878`).
3. Appends to the `pendingCommands` React state array — deduplicating by `messageId` (`App.tsx:879–887`).

The header telemetry strip immediately shows the pending count as an amber pulsing badge (`App.tsx:2274–2276`). All pane cards in the grid where `pendingCommands.some(cmd => cmd.terminalId === term.id)` gain a visual amber alert highlight (`App.tsx:1376`, `App.tsx:1475`, `App.tsx:2434`, `App.tsx:2568`).

**Note — Janus does NOT proactively read the command aloud.** There is no built-in mechanism in the current flow where the server or Janus automatically vocalizes the proposed command string before asking for confirmation. The earcon and optional desktop notification are the only hands-free signals that a pending command exists. Janus's audio has already concluded by the time the tool call is emitted; it is not instructed to verbally state what it is about to run. The operator must either glance at the ApprovalDialog or request that Janus retrieve and speak the pending command.

### Step 5 — Operator reviews by ear (the gap)

The `get_attention_digest` tool (`server.ts:1360–1373`) provides a spoken list of attention-queue items (state-transition alerts), but it does not surface `pendingApprovals` content. There is no dedicated `get_pending_commands` tool that Janus can call to verbally recite the queued command strings. The operator can explicitly ask Janus to read back what was proposed; Janus would need to call `get_pane_command_history` on the target pane or rely on context already in the Gemini conversation window, which does not contain the pending command verbatim (since the tool response has not been sent yet).

### Step 6 — Voice interception parser fires on the next utterance

When the operator speaks again, Gemini transcribes the audio and the server captures it in the `onmessage` callback (`server.ts:1076`). The text surfaces through one of two server-content paths — `userTurn.parts` or `turn.parts` (`server.ts:1094–1107`). It is aggregated into `userUtterance`, stored in `currentSessionUserUtterance` (`server.ts:1110`), and broadcast as a `transcript_text` event to the frontend.

After the minimum-length guard (`cleanUtter.length > 2`, `server.ts:1118`), the voice interception parser runs:

```typescript
const lowerUtter = cleanUtter.toLowerCase();
const isApprove = ["approve", "go ahead", "execute", "run it", "yes run", "approve command", "confirm execution"].some(word => lowerUtter.includes(word));
const isReject = ["reject", "cancel", "deny", "don't run", "reject command"].some(word => lowerUtter.includes(word));
```
`server.ts:1127–1129`

This is a flat `Array.prototype.some` + `String.prototype.includes` scan — no regex, no NLP, no intent classification. It is a literal substring match against a hardcoded list of 7 approval phrases and 5 rejection phrases.

**Important discrepancy:** The test in `tests/test_journeys.ts:132–134` mirrors only 6 approval phrases (omitting `"confirm execution"`), while `server.ts:1128` includes 7. This is a minor drift between the test harness and the production code.

### Step 7 — Pending command selection (FIFO, always index 0)

If `isApprove || isReject`, the parser filters `pendingApprovals` to entries whose `.session === session` (scoping to the current WebSocket/Gemini session), then takes index `[0]` of the resulting array:

```typescript
const pendingEntries = Object.entries(pendingApprovals).filter(([mId, details]) => details.session === session);
if (pendingEntries.length > 0) {
  // Sort to resolve the earliest/most relative first
  const [messageId, pending] = pendingEntries[0];
```
`server.ts:1133–1136`

The comment says "sort to resolve the earliest/most relative first" but no actual `.sort()` call is present. The order is the insertion order of `Object.entries` on a plain JavaScript object — which follows property insertion order in modern V8, effectively FIFO. With multiple pending commands across different panes, there is no mechanism to target a specific command by name, pane, or index. A single "approve" utterance always resolves the oldest pending entry for the session, regardless of which pane the operator is currently reviewing.

### Step 8 — Approval branch: command dispatched

```typescript
if (isApprove) {
  const term = manager.terminals[pending.terminalId];
  if (term) {
    HistoryManager.getInstance().addCommand(pending.terminalId, pending.cmd);
    term.writeInput(pending.cmd);
    try {
      pending.session.sendToolResponse({
        functionResponses: [{
          name: "propose_command",
          id: pending.callId,
          response: { output: `Command dispatched to ${pending.terminalId} successfully via voice.` }
        }]
      });
    } catch (e) { ... }
    clientWs.send(JSON.stringify({
      type: "command_auto_executed",
      terminalId: pending.terminalId,
      cmd: pending.cmd,
      vocal: true
    }));
  }
}
```
`server.ts:1139–1163`

The tool response re-activates the suspended Gemini session, which can now continue reasoning and speaking the outcome. The `vocal: true` flag distinguishes voice-originated approvals from UI-click approvals in the frontend message. The client plays the "execute" earcon and shows a 4-second green toast notification (`App.tsx:904–909`).

### Step 9 — Rejection branch: tool response cancels the call

```typescript
pending.session.sendToolResponse({
  functionResponses: [{
    name: "propose_command",
    id: pending.callId,
    response: { output: "Execution cancelled by operator via voice." }
  }]
});
clientWs.send(JSON.stringify({
  type: "command_blocked",
  terminalId: pending.terminalId,
  cmd: pending.cmd,
  reason: "Execution cancelled by operator via voice."
}));
```
`server.ts:1165–1182`

The model receives the cancellation text and can speak a verbal acknowledgment. The frontend plays the "alert" earcon and shows a red toast notification (`App.tsx:910–914`).

In both branches, `delete pendingApprovals[messageId]` removes the entry and `broadcast({ type: "terminals_updated" })` triggers a terminal list refresh (`server.ts:1183–1184`).

### Step 10 — UI-side fallback: REST approval

If the operator is at a screen (or in a mixed-modality scenario), the `ApprovalDialog` provides manual confirmation. `handleApprove`/`handleReject` in `App.tsx:659–701` POST to `/api/commands/approve` with `{ messageId, approved: bool }`. The REST handler at `server.ts:989–1028` mirrors the voice path, calling the same `term.writeInput`, `session.sendToolResponse`, and `delete pendingApprovals` logic. There is no `vocal: true` flag on the REST path.

### Step 11 — Session cleanup

On WebSocket close, `server.ts:1878–1884` iterates all pending approvals scoped to the closing session and deletes them, preventing tool-call leaks into the Gemini session's function-response queue.

### Multi-pane / multi-pending scenario

Multiple proposals across different panes queue independently in `pendingApprovals`. The UI renders one `ApprovalDialog` per entry via `pendingCommands.map((pending) => (...))` (`App.tsx:2182–2192`) — resulting in stacked overlapping modals (all rendered simultaneously via `fixed inset-0`, the topmost being the most recently added). The voice parser always resolves the FIFO-first entry; the UI dialogs overlap, with the last-rendered dialog on top. There is no mechanism for the operator to say "approve the second one" or "approve the pane_backend command" by voice.

---

## 3. Ideal End-User Experience

The ideal hands-free/eyes-off journey for Journey 3:

1. Janus proposes a command and immediately speaks it aloud: "I'd like to run `npm run build` on the frontend pane. Should I proceed?"
2. The operator hears the command, can say "read that back" to get a repetition, or say "what does pane frontend currently show?" to hear a terminal summary before deciding.
3. When multiple commands are pending, Janus maintains a numbered spoken queue: "You have two pending commands. First: `npm run build` on frontend. Second: `pip install pandas` on data pipeline. Which would you like to handle?"
4. The operator says "approve the first one" or "reject pip install" — the system matches by command text, pane name, or queue position rather than purely by index.
5. After resolution, Janus confirms aloud: "Running npm run build now on frontend pane."
6. For destructive or high-risk commands, Janus requires explicit double-confirmation: "This removes the build directory permanently. Say 'confirm deletion' to proceed."
7. If the operator does not respond within a configurable timeout, the command is automatically rejected and Janus announces: "I've cancelled the pending command on frontend pane after no response."

---

## 4. Backend Support — Voice Parser Internals

### Parser implementation

**File:** `server.ts:1126–1186`

The voice interception parser is a naive substring matcher — real, not mocked. It runs synchronously inside the Gemini `onmessage` callback on every transcribed user utterance.

**Trigger keywords:**

| Intent | Keywords |
|---|---|
| Approve | `"approve"`, `"go ahead"`, `"execute"`, `"run it"`, `"yes run"`, `"approve command"`, `"confirm execution"` |
| Reject | `"reject"`, `"cancel"`, `"deny"`, `"don't run"`, `"reject command"` |

**Robustness assessment — NAIVE:**

- `String.includes` substring match: "I don't want to cancel" would match `"cancel"` and trigger a rejection. There is no negation detection.
- "I need to execute this carefully" would match `"execute"` and trigger an approval.
- There is no confidence threshold, no intent classification, and no disambiguation word.
- The `"don't run"` phrase requires an apostrophe: phonetic transcription from Gemini may produce `"dont run"` (no apostrophe), which would fail to match.
- No pane targeting: the utterance cannot specify which pending command to resolve when multiple are queued.
- Collision risk: `isApprove` and `isReject` can both be true simultaneously (e.g., "I'll execute this but cancel the other"). In this case, `isApprove` wins because the `if (isApprove)` branch is checked first (`server.ts:1139`).

**Pending approval matching:**

`pendingApprovals` is a plain object (`Record<string, {...}>`) keyed by `call.id` (Gemini function-call ID). Session scoping filters by `details.session === session` (`server.ts:1133`). Selection is `pendingEntries[0]` — insertion-order FIFO, no sorting is actually performed despite the comment (`server.ts:1135–1136`). This means:

- With N pending commands across N panes, a voice "approve" resolves the one registered first, regardless of current pane focus.
- The operator cannot target a specific pane's command by voice.

**Function-response feedback to Gemini:**

On approval: `session.sendToolResponse` with `response: { output: "Command dispatched to {terminalId} successfully via voice." }` — Gemini receives a plain text confirmation and can then speak a vocal acknowledgment (`server.ts:1145–1151`).

On rejection: `session.sendToolResponse` with `response: { output: "Execution cancelled by operator via voice." }` (`server.ts:1166–1172`).

Both are real `sendToolResponse` calls to the live Gemini session. Error handling wraps each in try/catch to survive a closed session gracefully (`server.ts:1152–1153`, `1173–1174`).

**REST fallback (`/api/commands/approve`):**

`server.ts:989–1028` — real, functional. Uses the same `term.writeInput` and `session.sendToolResponse` calls. Does not broadcast `terminals_updated` on success (unlike the voice path which does at `server.ts:1184`). Minor inconsistency.

**`pendingApprovals` type:**

```typescript
const pendingApprovals: Record<string, {
  cmd: string,
  terminalId: string,
  callId: string,
  session: any,
  rationale?: { trigger: string, summary: string }
}> = {};
```
`server.ts:978` — defined per WebSocket connection closure (inside `wss.on("connection")` but outside any per-session scope), so it is shared across all connected clients. Session scoping in the voice parser (`details.session === session`) is the only mechanism preventing cross-session interference.

---

## 5. UI Support — ApprovalDialog

**File:** `src/components/ApprovalDialog.tsx`

The component is a `fixed inset-0` full-screen backdrop with a centered `max-w-[620px]` modal card.

**Fields shown:**

| Field | Source | Location in component |
|---|---|---|
| Command string | `cmd` prop | Line 47: amber monospace `<p>` block with `break-all` |
| Target pane ID | `terminalId` prop | Line 44: small `<span>` label "Target: {terminalId}" |
| Trigger utterance | `rationale.trigger` | Lines 54–56: "Heard trigger / context" section |
| Pane summary snapshot | `rationale.summary` | Lines 57–63: "Proposed rationale / summary" `<pre>` block, max-height 24 with scroll |

**Animation:** `animate-in slide-in-from-bottom-10 fade-in duration-300` (`ApprovalDialog.tsx:36`) — CSS entry animation. There is no exit animation; the component is removed from the DOM immediately on `delete pendingApprovals`.

**Keyboard interaction:** `Escape` key triggers `onReject(messageId)` via a `keydown` listener attached in `useEffect` (`ApprovalDialog.tsx:22–32`). The Reject button has `autoFocus` (`ApprovalDialog.tsx:75`), making keyboard rejection the default path.

**Button labels:**
- Approve: "Confirm & Fire" (amber, `bg-amber-600`)
- Reject: "Reject [Esc]" (red-bordered, `bg-red-950/10`)

**Multi-pending rendering:** `App.tsx:2182–2192` maps `pendingCommands` to a separate `ApprovalDialog` per entry. With N pending commands, N dialogs render simultaneously, all at `z-50` `fixed inset-0`. They stack in DOM order; the last-rendered (newest) dialog visually covers older ones. The operator sees only the topmost (most recent) command. The "Confirm & Fire" button on the topmost modal calls `handleApprove` for that specific `messageId` via REST, independent of the voice parser's FIFO-first selection. This means the voice path and the UI path can resolve different pending commands when multiple are queued.

**Alert integration in the UI:** Pane cards with a pending command show an amber border and alert badge. The header strip shows a pulsing amber dot with animated "VERIFY" count badge (`App.tsx:2274–2276`). The "Guardrail Verify Desk" sidebar section shows an animated bouncing bell icon and "N Pending" badge (`App.tsx:3011–3022`). A `pendingCommands.find` call on `App.tsx:3311` also surfaces the raw command string in one of the pane list views.

---

## 6. Future-State Best-in-Class

### Required capabilities for a world-class voice review/approval experience

**A. Automatic verbal announcement of pending command**

Before pausing for operator input, Janus should speak the proposed command string aloud — e.g., "I'd like to run `git push origin main` on the backend pane. Say approve or cancel." This requires the model's system prompt or tool description to instruct it to verbalize the `propose_command` arguments before calling the tool, or a server-side hook that synthesizes a TTS announcement to the client immediately on `approval_pending`. No additional tool is needed; the system prompt instruction is sufficient.

**B. Named / indexed multi-pending disambiguation**

Replace the FIFO-always-first selection with a targeted matcher. When the operator says "approve the pip install" or "reject command two", the server should:
1. Extract a command fragment or ordinal from the utterance.
2. Match against the `cmd` field or queue position of each pending entry.
3. Resolve exactly the matched entry, not index `[0]`.

Requires enriching the parser with lightweight named-entity extraction or regex for ordinals, and exposing a spoken summary of the queue (e.g., "You have two pending commands: one, npm build on frontend; two, pip install on data pipeline").

**C. Negation-aware parsing**

Replace bare `includes` with a small negation context window. Before matching a trigger word, check for negation tokens (`"not"`, `"don't"`, `"no"`) within the preceding 3 words. This prevents "I don't want to cancel" from triggering a rejection.

**D. Partial approval / conditional approval**

Allow the operator to say "approve but change the flag to `--dry-run`". Requires a command-edit step: the server pauses, presents the modified command back vocally, and requests a final confirmation.

**E. Timeout-based auto-rejection**

If no operator response arrives within a configurable window (e.g., 60 seconds), the pending command is automatically rejected and Janus announces the timeout. Prevents orphaned tool calls from blocking the Gemini session indefinitely, which is the current behavior for commands the operator never responds to.

**F. Conflict resolution for simultaneous isApprove + isReject**

When both flags are true, ask for clarification rather than silently defaulting to approve. This requires the server to send a clarification request back to the Gemini session, which then speaks: "I heard both an approval and cancellation signal. Could you clarify?"

**G. Contextual verbal summary before decision**

Before presenting the command for approval, Janus should call `get_pane_summary` on the target pane and speak a one-sentence summary of the pane's current state. The rationale object already captures this snapshot (`server.ts:1322`), but it is only shown visually in the dialog — it is never spoken aloud.

**H. Accessibility-first confirmation sound design**

The current earcon is a generic alert tone. A best-in-class implementation would use distinct earcon profiles per command risk level (read-only vs. write vs. destructive), providing ears-off risk signaling before the operator even hears the verbal announcement.

---

## Code Citation Index

| Concern | Location |
|---|---|
| `pendingApprovals` map definition | `server.ts:978` |
| `propose_command` permissions decision | `server.ts:1272–1334` |
| Rationale capture (`trigger` + `pSummary`) | `server.ts:1321–1324` |
| `approval_pending` WS message sent | `server.ts:1327–1333` |
| Gemini tool response withheld | `server.ts:1334` |
| Voice interception parser (keyword lists) | `server.ts:1127–1129` |
| Parser collision (isApprove wins) | `server.ts:1139` |
| FIFO selection via `pendingEntries[0]` | `server.ts:1133–1136` |
| Approve branch: `writeInput` + tool response | `server.ts:1139–1162` |
| Reject branch: cancellation tool response | `server.ts:1164–1182` |
| `command_auto_executed` `vocal: true` flag | `server.ts:1157–1162` |
| Session cleanup on WS close | `server.ts:1878–1884` |
| REST `/api/commands/approve` handler | `server.ts:989–1028` |
| ApprovalDialog component | `src/components/ApprovalDialog.tsx:1–86` |
| Multi-pending dialog stacking render | `src/App.tsx:2182–2192` |
| `approval_pending` client handler + earcon | `src/App.tsx:876–887` |
| `command_auto_executed` client handler | `src/App.tsx:904–909` |
| `command_blocked` client handler | `src/App.tsx:910–914` |
| Test: voice keyword parser (6-word list, missing "confirm execution") | `tests/test_journeys.ts:132–134` |
| Test: multi-pending queue management | `tests/test_approvals.ts:8–41` |
| Test: session cleanup on close | `tests/test_approvals.ts:44–72` |
