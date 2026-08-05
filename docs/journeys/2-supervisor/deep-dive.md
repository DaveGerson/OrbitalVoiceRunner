# Journey 2 — Supervisor / "Air-Traffic Control"

> ⚠️ **HISTORICAL — audited 2026-05-30, NOT maintained.** This deep-dive describes the code as it
> stood in May 2026. The voice/approval stack has since been rewritten: approval routing now lives
> in `src/voiceApprovalRouting.ts` + `src/gating/index.ts` (TTL → last-call → grace → expire,
> defer/hold, stop-all brake) behind the turn arbiter, and persistence is the SQLite `JanusStore`
> — **not** the `.janus_ledger.json` `Ledger`. **Verify every `file:line` citation against current
> code before acting on it.** The companion per-journey gap register (`gaps.md`) was retired on
> 2026-08-05; live defects are tracked in beads (`bd ready`). Context and retrieval instructions:
> [`docs/journeys/README.md`](../README.md).

**Keep agents in Human-in-the-Loop and approve or redirect their proposed commands as they surface — hands-free oversight of autonomous work.**

---

## 1. Journey Overview and Trigger

The Supervisor journey is the primary safety harness of OrbitalVoiceRunner. It models the operator as an air-traffic controller who has autonomous agents taxiing on multiple runways but requires that every take-off (execution) receive explicit clearance. The scenario is:

- One or more terminal panes are running agent processes (Claude Code, Codex, Antigravity, or a custom shell) whose `permissions_mode` is `Human-in-the-Loop`.
- Janus monitors those panes via `get_pane_summary` and `get_attention_digest` (pulled on demand or triggered by a spoken request).
- Whenever an agent or Janus itself judges that a command should be executed, it calls `propose_command` instead of writing directly to the terminal.
- The system gates that call pending operator clearance, surfacing the proposal through an audio earcon, an on-screen approval dialog, and a desktop browser notification.
- The operator approves or rejects entirely by voice ("go ahead", "cancel") or via keyboard/mouse on the `ApprovalDialog`.

Oversight begins the moment at least one pane carries an effective permissions mode of `Human-in-the-Loop`. That can be set at pane creation, promoted/demoted mid-session via `set_pane_permissions`, or inherited from the global setting (`globalPermissionsMode`).

---

## 2. Current Flow (As Built) — Hands-Free / Eyes-Off

### 2.1 Permissions Resolution

`propose_command` is the single entry point for all command execution. When Janus calls it, the server immediately resolves the **effective** permission level before deciding what to do (`server.ts:1271-1276`):

```
let effectivePermissions = manager.globalPermissionsMode;          // server.ts:1272
if (effectivePermissions === "Inherit") {
  const term = manager.terminals[targetId];
  effectivePermissions = term ? term.permissionsMode : "Human-in-the-Loop";
}
```

`globalPermissionsMode` is the system-wide override stored in `OrchestratorManager` (`src/terminal.ts:386`), which defaults to `"Inherit"`. When `"Inherit"` is active, the resolution falls through to the individual pane's `UniversalTerminal.permissionsMode` (`src/terminal.ts:70`). The default for a new pane is `"Human-in-the-Loop"` (`src/terminal.ts:84`). So unless the operator has explicitly set `"Full Auto"` either globally or per-pane, every `propose_command` call is intercepted.

Three branches exist (`server.ts:1278-1335`):

| Effective mode | Outcome |
|---|---|
| `Full Auto` | Command written to terminal immediately; `command_auto_executed` broadcast sent. |
| `Read-Only` | Tool call returns an error string; `command_blocked` event sent; no execution. |
| `Human-in-the-Loop` | Command enters `pendingApprovals` map; `approval_pending` event sent to frontend; tool call is left open (no `sendToolResponse` yet). |

### 2.2 PendingApprovals Map

The map is declared at `server.ts:978`:

```ts
const pendingApprovals: Record<string, {
  cmd: string,
  terminalId: string,
  callId: string,
  session: any,
  rationale?: { trigger: string, summary: string }
}> = {};
```

When a command is gated, the server captures (`server.ts:1320-1324`):
- `messageId` — equals `call.id`, the unique function-call identifier assigned by the Gemini Live API.
- `cmd` — the proposed command string.
- `terminalId` — the target pane.
- `callId` — same as `messageId`; used when constructing the deferred `sendToolResponse`.
- `session` — a direct reference to the open Gemini Live session object.
- `rationale.trigger` — the last transcribed user utterance at call time (`currentSessionUserUtterance`, `server.ts:1321`).
- `rationale.summary` — the last 5-line `get_pane_summary` snapshot of the target pane (`server.ts:1322`).

The Gemini Live tool call deliberately does **not** receive a response at this point. The response is sent later (approve or reject path), which means the model is blocked from continuing until resolution. This is functionally correct for Human-in-the-Loop gating but means **Janus cannot speak or call further tools while any approval is pending** — the session is effectively paused.

### 2.3 Audio / Earcon Alert (Hands-Free)

When the frontend WebSocket receives `approval_pending` (`src/App.tsx:876-887`):
1. `playEarcon("alert")` fires a two-tone sawtooth oscillator pattern at 440 Hz / 554 Hz (`src/App.tsx:81-100`). This is the primary eyes-off cue.
2. `triggerDesktopNotification` issues a browser OS notification ("Approval Pending — Node X: command") if the Notifications API permission has been granted (`src/App.tsx:878`).
3. The pending command is appended to `pendingCommands` React state, which triggers the `ApprovalDialog` to render.

### 2.4 Voice Intercept (Hands-Free Approval/Rejection)

On every incoming user audio transcript, the server scans for approval or rejection keywords (`server.ts:1127-1184`):

- **Approve** keywords: `["approve", "go ahead", "execute", "run it", "yes run", "approve command", "confirm execution"]` (`server.ts:1128`).
- **Reject** keywords: `["reject", "cancel", "deny", "don't run", "reject command"]` (`server.ts:1129`).

When a match is detected, the server filters `pendingApprovals` to find entries whose `session` reference equals the active session (`server.ts:1133`), and resolves the **earliest** entry (`pendingEntries[0]`, `server.ts:1136`). On approve (`server.ts:1139-1162`):
1. `term.writeInput(pending.cmd)` dispatches the command to the PTY.
2. `HistoryManager.getInstance().addCommand(...)` logs it to `.janus_history.json`.
3. `pending.session.sendToolResponse(...)` unblocks Janus with `"Command dispatched ... successfully via voice."` — Janus then continues speaking.
4. `command_auto_executed` event (with `vocal: true`) is broadcast to the frontend.

On reject (`server.ts:1163-1184`):
1. `sendToolResponse` returns `"Execution cancelled by operator via voice."`.
2. `command_blocked` event broadcast with the reason string.
3. `delete pendingApprovals[messageId]` cleans the map.

The voice intercept fires from **user utterance parsing only** — it does not require Janus to ask a question. Any utterance containing an approval keyword while a pending command exists is sufficient to resolve it.

### 2.5 REST Approval Path (Keyboard / Mouse)

The frontend `ApprovalDialog` also calls `/api/commands/approve` (`server.ts:989-1028`) via `handleApprove` / `handleReject` in `src/App.tsx:659-702`. This path:
1. POST `{ messageId, approved: true/false }` to `/api/commands/approve`.
2. If approved: terminal write + history log + `sendToolResponse` success.
3. If rejected: `sendToolResponse` with cancellation message.
4. In both cases `delete pendingApprovals[messageId]` and HTTP 200.
5. The Reject button is `autoFocus`-ed and `Escape` is bound to reject (`src/components/ApprovalDialog.tsx:23-32`), so keyboard-only operators can act without a mouse.

### 2.6 Attention Digest

`get_attention_digest` is the complementary polling tool (`server.ts:1360-1373`). It scans `manager.attentionQueue` for undismissed items and returns a spoken string like: `"There are 3 items requiring attention. 1. Pane X in project Y transitioned to error: ..."`. Items are added to the queue when a terminal transitions to `error`, `build-failed`, or `exited` state (`server.ts:430-443`).

Note: `get_attention_digest` does **not** list pending approval commands. The `pendingApprovals` map and the `attentionQueue` are separate data structures. A pending approval is surfaced via the `approval_pending` WebSocket event; the attention queue covers state-transition alerts. An operator asking "what needs attention?" will hear error/exit conditions but not queued proposed commands.

There is also a client-side spoken digest button (`src/App.tsx:543-561`) that uses browser `SpeechSynthesis` to read out the attention queue — this is a separate, non-Janus-driven fallback.

### 2.7 PendingApprovals Lifecycle

```
propose_command called
        |
        v
effectivePermissions == "Human-in-the-Loop"?
        |
       YES
        |
        v
pendingApprovals[call.id] = { cmd, terminalId, callId, session, rationale }
        |
        +---> approval_pending WS event ---> frontend earcon + dialog
        |
        +---> (Gemini session blocked — no sendToolResponse yet)
        |
   [Voice utterance with keyword]  OR  [POST /api/commands/approve]
        |
   APPROVE                             REJECT
        |                                 |
  writeInput(cmd)                  (no terminal write)
  addCommand(history)              sendToolResponse("cancelled")
  sendToolResponse("dispatched")   delete pendingApprovals[messageId]
  delete pendingApprovals[messageId]
        |
  command_auto_executed broadcast   command_blocked broadcast
```

Session cleanup: on WebSocket close, all `pendingApprovals` entries whose `session` matches the closing session are purged (`server.ts:1878-1884`) — preventing orphaned, never-resolving Gemini tool calls.

---

## 3. Ideal End-User Experience

Frictionless air-traffic control should feel like this:

1. **Proactive verbal briefing**: Janus announces every proposed command in natural speech without the operator asking — "Attention: I'm proposing `npm run build` on the backend pane because the tests just passed. Say 'go ahead' to run it." The operator never needs to look at the screen.

2. **Priority ordering**: When multiple proposals queue simultaneously, Janus reads them in risk order (destructive commands first), not arrival order.

3. **Terse command summary with risk level**: Janus frames each proposal in a single sentence explaining the trigger context and assessed risk — e.g., "Low risk: routine dependency install. Say 'approve' or 'deny'."

4. **Named rejection with redirect**: The operator can say "reject and run `npm ci` instead" and Janus substitutes the alternative command, re-proposes it for confirmation.

5. **Batch approval**: "Approve all pending" resolves the queue in one utterance.

6. **Per-pane promotion shortcut**: "Trust this pane for the rest of the session" upgrades that one pane to Full Auto without a menu dive.

7. **Audio level differentiation**: A gentle chime for safe/read operations; an urgent double-tone for destructive patterns (file deletion, force-push, database drops).

8. **No screen required**: The operator with eyes off should receive enough audio context to make a confident decision without being forced to look at the `ApprovalDialog` modal.

---

## 4. Backend Support

### 4.1 propose_command Gating (REAL — fully implemented)

`server.ts:1267-1335` implements all three permission branches. The gating logic is real and exercised by `tests/test_journeys.ts:73-108` (Journey 2 test), which validates that `effectivePermissions == "Human-in-the-Loop"` results in commands being placed in a pending map rather than executed.

### 4.2 Effective Permissions Resolution (REAL)

The `globalPermissionsMode` → pane `permissionsMode` waterfall is at `server.ts:1271-1276`. The global mode is stored in `manager.globalPermissionsMode` (`src/terminal.ts:386`) and mirrored to `settings.advanced.globalPermissionsMode` (`src/types.ts:92`). The four valid values are `"Full Auto"`, `"Human-in-the-Loop"`, `"Read-Only"`, and `"Inherit"`. Pane-level mode is stored on both the live `UniversalTerminal` instance (`src/terminal.ts:70`) and the `PaneMeta` record in the ledger (`src/ledger.ts:12`). The `set_pane_permissions` tool (`server.ts:1542-1557`) updates both in sync. The `set_global_permissions` tool (`server.ts:1400-1412`) updates the manager field and persists to settings.

### 4.3 pendingApprovals Map (REAL)

In-memory `Record<string, {...}>` at `server.ts:978`. Keyed by Gemini `call.id`. **Not persisted** to disk — a server restart loses all pending approvals and leaves the Gemini session unable to continue (it would time out). There is no TTL or expiry mechanism; an unresolved approval lives indefinitely until the WebSocket closes or the operator responds.

### 4.4 Rationale Construction (REAL but shallow)

At `server.ts:1321-1323`:
- `trigger` is `currentSessionUserUtterance` — the last spoken phrase captured in the current session, not specifically the utterance that caused this particular tool call. If the user spoke a while ago this may be stale.
- `summary` is `manager.getPaneSummary(targetId, 5)` — the last 5 lines of cleaned terminal output for the target pane. This is real terminal content, not synthesized.

### 4.5 get_attention_digest (REAL — but does not cover pending approvals)

`server.ts:1360-1373`. The tool reads `manager.attentionQueue` and assembles a spoken string. The queue is populated by the `detectAndTriggerTransitions` function (`server.ts:430-443`) on `error`, `build-failed`, and `exited` transitions. It is **not** populated when a command is proposed. There is no tool that lists pending proposed commands by voice — an operator cannot ask Janus "what commands are queued for approval?" and receive a spoken answer. The `GET /api/commands/pending` REST endpoint (`server.ts:980-987`) exists for the UI poll cycle but is not surfaced as a Janus voice tool.

### 4.6 Polling Interval

The frontend polls `GET /api/commands/pending` every 3 seconds (`src/App.tsx:593-599`) as a fallback to the WebSocket `approval_pending` event. This covers reconnect scenarios but means there is up to a 3-second gap in proposal surfacing on reconnect.

---

## 5. UI Support

### 5.1 ApprovalDialog (`src/components/ApprovalDialog.tsx`)

The component renders as a fixed-position full-screen overlay with `z-50` backdrop blur when any entry exists in the `pendingCommands` state array. Fields displayed:
- **Target pane ID** (`terminalId`) — upper-right label.
- **Command string** (`cmd`) — monospace block.
- **Rationale block** — if `rationale` is present: the `trigger` utterance in italic and the `summary` terminal snapshot in a scrollable `<pre>` (max height 24, scrollable).
- **"Confirm & Fire"** button — calls `onApprove(messageId)`.
- **"Reject [Esc]"** button — `autoFocus`, calls `onReject(messageId)`. `Escape` key is also bound globally while the dialog is mounted.

The dialog has no built-in read-aloud capability. There is no `aria-live` region, no `aria-modal` attribute, and no `role="dialog"` — the accessibility story for screen-reader users is incomplete. For an eyes-off operator relying entirely on the earcon and Janus's voice, the dialog is irrelevant, but the missing ARIA marks it as incomplete from a formal accessibility standpoint.

### 5.2 Earcon System (`src/App.tsx:73-151`)

Four earcon types synthesized via the Web Audio API:
- `"alert"` — sawtooth double-tone at 440/554 Hz; fired on `approval_pending` and `command_blocked`.
- `"execute"` — short square-wave at 880 Hz; fired on `command_auto_executed` and attention-dismiss.
- `"success"` — ascending sine arpeggio; fired on attention-clear, watch-rule create, recipe apply.
- `"chime"` — two-note sine decay; fired on the spoken digest button.

The earcon `"alert"` is the primary hands-free signal that a proposed command is waiting. It is identical for both approval-pending and command-blocked events. An operator with eyes off cannot distinguish the two from audio alone.

### 5.3 ApprovalDialog State Management (`src/App.tsx`)

- `pendingCommands: PendingCommand[]` state at `src/App.tsx:20`.
- Populated via WebSocket `approval_pending` event (with dedup check) and via 3-second REST poll.
- `handleApprove(messageId)` at `src/App.tsx:659` — POSTs to `/api/commands/approve` with `approved: true`, then filters the entry from local state and re-fetches terminals after 500ms.
- `handleReject(messageId)` at `src/App.tsx:689` — same POST with `approved: false`.
- Mock mode path in both handlers (`src/App.tsx:660-677`, `src/App.tsx:690-693`) simulates approval locally without hitting the server, using hardcoded output strings. This is a **mock/stub** path triggered by `isMockMode` state — it is not representative of real behavior.

### 5.4 Desktop Notifications (`src/App.tsx:153-175`)

Browser `Notification` API is used on `approval_pending` with the text `"Node {terminalId} is waiting for execute confirm: {cmd}"` (`src/App.tsx:878`). This requires the operator to have granted notification permission via `handleToggleNotifications`. No auto-request on first pending command; the operator must pre-enable it.

---

## 6. Future-State Best-in-Class

### 6.1 Proactive Audio Announcement by Janus

Currently Janus's voice is silent during the approval wait — the session is blocked at the tool call level. A best-in-class design would use a non-blocking proposal mechanism: Janus receives an immediate `"pending_approval"` tool response, then proactively speaks the proposal in audio while the server maintains a side-channel queue. This requires either a two-phase tool call protocol or a separate `announce_proposal` tool that does not block the session.

### 6.2 Voice-Queryable Pending Queue

Add a `list_pending_approvals` voice tool that reads all queued proposals in spoken form including command, pane, and rationale. The current `get_attention_digest` does not cover this.

### 6.3 Named Redirect / Command Substitution

Support utterances like "reject and run `npm ci` instead". The voice intercept at `server.ts:1127-1184` only parses approve/reject; it does not parse alternative commands. Implementing this requires NLU on the rejection utterance and re-entry into the `propose_command` flow with the substituted command, re-triggering a new approval cycle.

### 6.4 Differentiated Audio Alerts

Introduce a third earcon — a low, urgent triple-tone — for high-risk patterns (destructive flags: `rm -rf`, `DROP TABLE`, `git push --force`, `--no-preserve-root`). The current `"alert"` earcon is identical for all pending approvals regardless of risk.

### 6.5 Batch Approval and Priority Sort

Allow "approve all" and "reject all" utterances to bulk-resolve the queue (`server.ts` voice intercept at `1127-1130` currently resolves only the first entry). Sort the queue by assessed risk before presenting to the operator: destructive commands first, read-only or idempotent last.

### 6.6 Approval TTL and Timeout Escalation

Add a configurable TTL per pending entry (e.g., 60 seconds). On expiry, the entry is auto-rejected and the Gemini session receives a `"Approval timed out"` response, preventing indefinite session freeze. A countdown earcon could warn the operator 10 seconds before auto-rejection.

### 6.7 Per-Command Risk Assessment

Before creating a `pendingApprovals` entry, run the proposed command through a lightweight pattern classifier (regex rules or a small LLM call) and attach a `risk_level: "low" | "medium" | "high"` field to the rationale. Surface this verbally and visually in the `ApprovalDialog`.

### 6.8 ARIA Accessibility Hardening

`ApprovalDialog` should have `role="dialog"`, `aria-modal="true"`, and an `aria-live="assertive"` region that reads the command aloud via assistive technology. The earcon substitutes for this for hearing operators but does not serve deaf operators relying on screen readers.

### 6.9 Persistent Pending Approvals on Reconnect

The in-memory `pendingApprovals` map is lost on server restart or session drop. A best-in-class design would serialize pending approvals to disk (alongside the ledger) and reconnect Janus to the same Gemini session via the `lastSessionResumptionToken` mechanism already wired at `server.ts:1078-1081`. This would allow an operator to reconnect and pick up exactly where the approval queue left off.

### 6.10 Required Capabilities Summary

| Capability | Status |
|---|---|
| Block execution pending approval | Implemented (`server.ts:1318-1334`) |
| Voice approve/reject | Implemented (`server.ts:1127-1184`) |
| Earcon alert on pending | Implemented (`src/App.tsx:877`) |
| Desktop notification | Implemented (`src/App.tsx:878`) |
| Rationale with pane snapshot | Implemented (`server.ts:1322-1323`) |
| Proactive spoken proposal by Janus | Not implemented |
| Voice-queryable pending list | Not implemented |
| Approval TTL / timeout | Not implemented |
| Named redirect / command substitution | Not implemented |
| Differentiated risk earcons | Not implemented |
| Batch approve/reject | Not implemented |
| Persistent approvals across restart | Not implemented |
| ARIA dialog accessibility | Not implemented |
