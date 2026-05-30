# Journey 1: Fan-out / Delegate in Parallel — Deep Dive

## 1. Journey Overview & Trigger

**Who:** A developer or engineering operator who wants to run multiple AI coding
agents (e.g., Claude Code on one module, Codex on another) concurrently on
independent sub-tasks, then shift spoken attention freely between them as each
progresses.

**When:** At the start of a work session requiring parallel independent work
streams, or mid-session when a blocking dependency appears and a second agent
should be started on an unblocked track.

**Why:** The core value proposition is hands-free parallelism: the operator does
not stop and re-configure a single terminal for every task. They speak the scope
of each agent's work once, let them run concurrently, and verbally tour the
running panes as events surface.

**Voice trigger phrases that typically start this journey (inferred from the
system prompt and tool descriptions in server.ts:1568):**

- "Janus, start a Claude Code pane for the authentication module in project alpha"
- "Now open a Codex pane for the frontend redesign in a new project beta"
- "Switch focus to the alpha project"
- "What is the current state of pane claude-auth?"
- "Switch to the beta project and give me a briefing"
- "Apply the full-stack-web recipe to this workspace"

None of these trigger phrases are hard-coded keyword matches in the server — they
are interpreted naturally by the Gemini Live model, which then emits structured
tool calls. The only keyword matching in server.ts is the voice-approval
intercept at server.ts:1128 (approve/reject words), which is unrelated to
fan-out initiation.

---

## 2. Current Flow (as Built) — Step-by-Step, Hands-Free / Eyes-Off

All steps assume the operator has already clicked **Connect** in the UI and the
WebSocket `/live` session is open (server.ts:1032).

### Step 1 — Operator speaks a fan-out intent

The browser's `ScriptProcessorNode` captures 16 kHz PCM frames
(App.tsx:848–863). Frames are base64-encoded (`pcmToBase64` in
`src/utils/audio.ts`), wrapped in `{ type: "audio", audio: … }` JSON, and sent
over the `/live` WebSocket. A half-duplex barge-in guard
(App.tsx:857–859) drops frames while Janus is speaking, preventing audio
loopback.

Server.ts:1849–1858 receives each audio message from the browser and calls
`session.sendRealtimeInput({ audio: { data, mimeType: "audio/pcm;rate=16000" }
})` on the Gemini Live session. The model transcribes and interprets the spoken
intent.

### Step 2 — Janus calls `create_project` (optional but typical)

If the operator says "create a new project for the auth module at path
/workspace/auth", Gemini emits a `create_project` tool call. The handler at
server.ts:1374–1379 calls `manager.ledger.addProject(project_id, directory,
summary, key_terms)`. In ledger.ts:129–142, `addProject` creates a new
`Workspace` entry in `this.workspaces` and calls `this.save(true)` — a
synchronous atomic write to `.janus_ledger.json` via a `.tmp` rename swap
(ledger.ts:110–127). The ledger update is broadcast to all WS clients as
`{ type: "ledger_updated", ledger: manager.ledger.workspaces }`
(server.ts:485–490), causing the React UI to call `setLedger(msg.ledger)`
(App.tsx:898).

### Step 3 — Janus calls `create_pane` for each agent

For each parallel agent, Gemini emits a `create_pane` tool call with
`project_id`, `pane_id`, `command` (e.g., `npx @anthropic-ai/claude`),
`tool_preset` (e.g., `"Claude Code"`), and `permissions_mode` (e.g.,
`"Human-in-the-Loop"`).

Handler at server.ts:1381–1399:
1. If the project does not yet exist in the ledger, it creates it automatically
   (`manager.ledger.addProject`).
2. Calls `manager.addTerminal(pane_id, cwd, command, tool_preset,
   permissions_mode, "", project_id)` — terminal.ts:522–549.
3. `addTerminal` instantiates a `new UniversalTerminal(...)` (terminal.ts:79–116).
   - For non-Custom presets and `Full Auto` mode, `--dangerously-skip-permissions`
     is appended to the command at terminal.ts:96–104.
   - For non-Custom presets, a session ID of the form `claude-code-session-<hex>`
     is generated at terminal.ts:107–115.
4. `term.start()` is called (terminal.ts:220–316): on Linux/macOS this spawns
   `script -q -f -c <command> /dev/null` (terminal.ts:246–249) using Node's
   `child_process.spawn` with `detached: true` (terminal.ts:255–259). This
   allocates a real PTY, which is important for agent CLIs that detect
   interactivity.
5. stdout and stderr streams are captured at terminal.ts:270–302. Chunks are
   appended to a 100-line circular `outputBuffer` (terminal.ts:279–283), also
   written to a per-pane `.janus_scrollback_<id>.log` file (terminal.ts:204–218).
6. `manager.syncLedger()` is called (terminal.ts:564–591), writing the new pane's
   `PaneMeta` (pane_id, tool_preset, permissions_mode, session_id, is_busy,
   alive, context_size, etc.) into the workspace's `panes` record and debounce-
   saving the ledger.
7. The server broadcasts `{ type: "terminals_updated" }` and
   `{ type: "ledger_updated", … }`, causing App.tsx to call `fetchTerminals()`
   and `setLedger(msg.ledger)`.
8. The tool response `Pane ${pane_id} created under project ${project_id}` is
   sent back to the Gemini session (server.ts:1397–1398), and Janus speaks a
   spoken confirmation.

This step is repeated for each agent pane — they are launched concurrently as
independent OS child processes and run in parallel without any serialization.

### Step 4 — Janus (optionally) speaks initial task text to each pane

If the operator asks Janus to send an opening prompt to an agent pane, Janus
calls `propose_command` (server.ts:1267). Under `Human-in-the-Loop` mode, the
command is held pending (server.ts:1318–1334) and the frontend receives an
`approval_pending` event, displaying the `ApprovalDialog`
(src/components/ApprovalDialog.tsx). The operator says "go ahead" or clicks
"Confirm & Fire", the voice intercept at server.ts:1128–1187 or the REST handler
at server.ts:989–1028 resolves it, and `term.writeInput(cmd)` delivers the text
to the agent's stdin. Under `Full Auto` mode, the command fires immediately at
server.ts:1278–1293.

### Step 5 — Monitoring parallel agents via `get_pane_summary`

The operator says "What is pane claude-auth doing right now?" Gemini emits
`get_pane_summary({ pane_id: "claude-auth" })`. The handler at server.ts:1249–1254
calls `manager.getPaneSummary(pane_id)` (terminal.ts:593–599), which returns the
last 20 lines of the pane's `outputBuffer` wrapped in a markdown code block.
Janus speaks this back to the operator. This is the *only* mechanism Janus has to
observe pane content — there is no push/subscription model; it is pure pull.

### Step 6 — Context switching between projects

The operator says "Switch focus to project beta". Gemini emits
`switch_context({ project_id: "proj_beta" })`. The handler at server.ts:1255–1265:
1. Calls `manager.ledger.switchContext(projectId)` (ledger.ts:174–179) which sets
   `this.activeProjectId = id` and saves synchronously.
2. Updates `manager.settings.projects.activeContext` and
   `manager.settings.projects.localWorkspacePath` with the project's directory,
   then calls `manager.saveSettings()`.
3. Broadcasts `ledger_updated` to the UI.
4. Calls `manager.ledger.getProjectBriefing(projectId)` (ledger.ts:197–209), which
   returns a structured object containing `project_id`, `summary`, `directory`,
   all `panes` (with their full `PaneMeta`), `notes`, and `key_codebase_terms`.
5. Sends this briefing as the tool response back to Gemini.

Janus receives the briefing and speaks a contextual summary of the newly focused
project — all without the operator touching the keyboard or mouse.

### Step 7 — Getting the attention digest across panes

The operator says "What needs my attention?" Gemini emits `get_attention_digest`.
The handler at server.ts:1360–1372 scans `manager.attentionQueue` for undismissed
items (build failures, errors, exited panes) and constructs a spoken summary
string. This is returned to Gemini, which speaks it aloud.

Attention items are added to the queue whenever `detectAndTriggerTransitions`
(server.ts:379–447) classifies terminal output chunks as `build-failed`, `error`,
or `exited`. The classification is entirely string-based heuristics on the raw
output (server.ts:387–415).

### Step 8 — Leaving notes and renaming panes

Optionally, during the session the operator can say "Add a note to the alpha
project: decided to skip the auth refactor for this sprint." Gemini calls
`add_project_note`, handled at server.ts:1336–1341, writing to
`manager.ledger.addNote(args.project_id, args.note)` (ledger.ts:181–186) and
saving. Similarly `rename_pane` and `rename_project` update ledger metadata.

---

## 3. Ideal End-User Experience

An operator opens the UI, clicks Connect, and says:

> "Janus, I want to work on two parallel tracks. Create a project called auth-module at slash workspace slash auth, and start a Claude Code pane on it in Human-in-the-Loop mode. Also create a project called ui-revamp at slash workspace slash frontend, and start a Codex pane on that one in Full Auto mode."

Janus should immediately confirm both panes are spinning up, speaking their names
back. The operator then says:

> "Tell Claude Code to implement the JWT refresh flow."

Janus proposes the typed task. The operator hears a distinct audio earcon (alert
chime) and says "go ahead" — the text is sent to the agent's stdin. Concurrently,
Codex is running autonomously in Full Auto on the frontend.

A few minutes later the operator says:

> "Switch to ui-revamp and tell me what Codex has done."

Janus switches context, speaks the project briefing, then calls
`get_pane_summary` on the Codex pane and reads back the last few lines of output.
The operator can correct course entirely by voice without touching the screen.

At any point the operator says "What needs attention?" and hears a synthesized
digest of errors, stalled builds, or exited panes across *all* projects.

The entire session is logged: voice utterances appear in the transcript panel
(App.tsx:917–921), pane command histories are persisted to `.janus_history.json`
(server.ts:83–107), and project notes accumulate in `.janus_ledger.json`.

---

## 4. Backend Support

### 4.1 `create_project` — server.ts:1374–1379

**Real.** Delegates to `Ledger.addProject` (ledger.ts:129–142) which writes to
`.janus_ledger.json` atomically. No mocking. The project becomes a queryable
workspace with `directory`, `summary`, `notes`, and `panes`.

### 4.2 `create_pane` — server.ts:1381–1399 + `OrchestratorManager.addTerminal` — terminal.ts:522–549

**Real.** Spawns a genuine OS child process via `UniversalTerminal.start()`
(terminal.ts:220–316). Uses `script` on Linux/macOS to allocate a real PTY.
`detached: true` means the child process group can outlive the spawning Node
process. Preset commands for Claude Code, Codex, and Antigravity are hardcoded
defaults in `parsePresetsSafe` (terminal.ts:49–52) and can be overridden via
settings.

**Caveat (not mocked, but fragile):** The `--resume-previous-session` and
`--with-open-textbox` flags appended in `CreateTerminalDialog.tsx:47–48` are
hardcoded flag strings, not validated against any installed CLI version. If the
installed agent CLI does not support these flags, the spawn will fail or produce
unexpected output. `terminal.ts:109–115` generates a synthetic session ID
(`claude-code-session-<hex>`) before the process starts; the real session ID is
later extracted by regex matching from stdout (terminal.ts:136–153), but the
regex patterns (`/(?:session[_-]?id|session)[ :="']{1,3}([a-zA-Z0-9_\-]{8,})/i`,
etc.) are speculative — they work only if the agent CLI outputs a matching
pattern.

**Note on presets at settings level:** `OrchestratorManager.getDefaultSettings`
(terminal.ts:408–413) defines three default presets with commands `npx
@anthropic-ai/claude`, `npx codex-cli`, and `npx antigravity`. These are the
actual commands that get spawned. The `CliPreset` type in `types.ts:47–60`
supports `dangerouslySkipPermissions`, `sessionResume`, `portOffset`,
`customEnvVars` flags, but these extended modifiers are only applied by
`CreateTerminalDialog.tsx` in the UI path — the `create_pane` voice tool handler
in server.ts does NOT apply them; it only passes the raw `command` string from the
tool call arguments.

### 4.3 `switch_context` — server.ts:1255–1265 + `Ledger.getProjectBriefing` — ledger.ts:197–209

**Real.** The briefing returned is a live snapshot of the ledger state: `summary`,
`directory`, all registered `PaneMeta` objects, `notes`, and `keyTerms`. However,
it does NOT include live terminal output — that requires a separate
`get_pane_summary` call.

**Important gap:** `switch_context` only changes the ledger's `activeProjectId`
and saves settings. It does *not* tell the Gemini model about panes it has never
seen in prior tool responses. The system prompt (server.ts:1568) is rendered once
at session start and lists all live terminals at that moment. If panes are created
later in the session, the model learns about them only through tool response
messages — not through a dynamic system prompt update.

### 4.4 `list_panes` — server.ts:1223–1227 + `OrchestratorManager.listPanes` — terminal.ts:551–560

**Real.** Calls `syncLedger()` first (terminal.ts:563–591), updating all
`PaneMeta` from live terminal state before returning. Returns all workspaces and
their panes with `is_busy`, `alive`, `last_known_state`, `tool_preset`,
`permissions_mode`, `session_id`, `context_size`.

### 4.5 `get_pane_summary` — server.ts:1249–1254 + `OrchestratorManager.getPaneSummary` — terminal.ts:593–599

**Real but limited.** Returns the last N lines (default 20) of the in-memory
`outputBuffer` as a markdown code block. The buffer is capped at 100 lines
(terminal.ts:69) and is a running window — old output is dropped. There is no
access to earlier scrollback beyond what fits in the buffer or the
`.janus_scrollback_<id>.log` file (which is not used in `getPaneSummary`).

### 4.6 `get_attention_digest` — server.ts:1360–1372

**Real.** Reads from `manager.attentionQueue` which is populated by
`detectAndTriggerTransitions` (server.ts:379–447). The transition detection is
string-based pattern matching on raw terminal output (server.ts:387–415). It
covers common error patterns (`build failed`, `npm err!`, `modulenotfounderror`,
`traceback`, etc.) but will miss errors in unusual formats.

### 4.7 `apply_orchestration_recipe` — server.ts:1491–1515

**Partially real, partially hardcoded.** Two built-in recipes exist in the
`recipes` array at server.ts:728–748: `full-stack-web` (Vite + Express + Vitest)
and `python-worker` (FastAPI + RQ). Each recipe's pane commands are hardcoded
strings (e.g., `"echo 'Frontend running' && npm run dev"`). The `echo` prefix
means the recipe panes announce themselves but the real command (`npm run dev`)
still runs. There is no mechanism for the operator to define custom recipes via
voice — recipes are static server-side constants.

### 4.8 `Ledger` persistence — ledger.ts

**Real and robust.** Saves are atomic (write to `.tmp`, rename to final path —
ledger.ts:88–107). Async saves are debounced to 100ms (ledger.ts:73–78);
synchronous `save(true)` calls flush immediately. The ledger survives server
restarts because `OrchestratorManager.constructor` (terminal.ts:489–520) reads
the ledger on startup and attempts to re-spawn panes for the active project.

**Note:** The constructor at terminal.ts:503–518 attempts pane restore but uses
simplified command strings (`"npx @anthropic-ai/claude-code"` for Claude Code,
`"npx codex"` for Codex — note the inconsistency: the default preset in
`getDefaultSettings` uses `"npx @anthropic-ai/claude"` and `"npx codex-cli"`,
different strings). This means restored panes on restart may use different
commands than originally launched.

### 4.9 `HistoryManager` — server.ts:41–129

**Real.** Per-pane command histories are persisted in `.janus_history.json`,
keyed by `terminalId`. After each command goes idle, `summarizeCommandOutcome`
(server.ts:187–218) makes a secondary Gemini API call to produce a
1–2 sentence summary of the raw output, stored as `finalResponse`. This LLM-
summarized history is what `get_pane_command_history` returns to Janus — a
token-efficient narrative log rather than raw stdout. Note that
`summarizeCommandOutcome` uses model name `"gemini-3.5-flash"` (server.ts:209),
which may not exist; this call silently falls back to `"Execution finished
successfully."` on error (server.ts:214–216).

### 4.10 `syncLedger` — terminal.ts:563–591

**Real.** Walks all live `UniversalTerminal` instances and writes their
current state into the ledger. Called on every `addTerminal` and on every
`listPanes` query. `context_size` is computed from the byte length of
`outputBuffer.join('\n')` (terminal.ts:132–134) — a rough approximation, not a
token count.

### 4.11 `handoff_context_between_panes` — server.ts:1516–1541

**Real but blunt.** Pulls the last 5 command history entries from the source
pane, concatenates them, and injects a `# === HANDOFF CONTEXT INTERCEPT ===`
comment block into the target pane's stdin (server.ts:1533). This relies on the
receiving CLI agent treating a comment block in its stdin as context, which is
agent-specific behavior and not guaranteed.

---

## 5. UI Support

### 5.1 `CreateTerminalDialog` — src/components/CreateTerminalDialog.tsx

Used manually (not voice-driven) to create a pane with full configuration:
tool preset, permissions mode, CWD, and startup modifiers (session resume,
`--dangerously-skip-permissions`, port offset, custom env vars). The dialog
auto-composes the command string from these options (CreateTerminalDialog.tsx:29–60).
This is the UI-side complement to the voice `create_pane` tool.

### 5.2 `TerminalView` — src/components/TerminalView.tsx

Renders terminal output via xterm.js with an `FitAddon` for responsive sizing.
Incrementally writes new output chunks (TerminalView.tsx:145–160) by tracking the
previously written output length — this avoids full re-render on each output
event. Output is pushed to the UI via WebSocket `stdout_chunk` events, which
App.tsx batches in a `requestAnimationFrame` loop (App.tsx:265–286) for
performance.

**Limitation for this journey:** `TerminalView` is display-only. There is no
keyboard input path from the operator to the terminal through the UI (no stdin
textarea). Input can only happen via Janus tool calls (`propose_command`), the
REST `POST /api/terminals/:id/input` endpoint, or the broadcast feature.

### 5.3 `App.tsx` — project/pane switching UI

- The `handleSwitchProject` function (App.tsx:1208–1219) calls
  `POST /api/projects/:id/switch`, sets `activeProjectId` state, and clears
  `activeTerminalId`. This is triggered by clicking a project in the sidebar —
  there is no voice-initiated version of this UI action; voice uses
  `switch_context` which updates the ledger but does NOT update the React
  `activeProjectId` state. The two switching mechanisms are separate: Janus
  `switch_context` only updates `manager.ledger.activeProjectId` and the settings
  file; the UI's highlighted project is driven by `activeProjectId` state in
  App.tsx, which is only changed by the UI click handler or the `handleSwitchProject`
  call.
  
  **Consequence:** If Janus calls `switch_context` by voice, the ledger changes,
  but the terminal panel on screen does NOT scroll to the newly focused project's
  pane unless the operator also clicks. This is a behavioral gap for the
  eyes-off use case.

- The `recentlyIdled` state (App.tsx:23, 626–657) adds a 6-second highlight
  animation to panes that transition from Running to Idle, providing a passive
  visual signal when an agent finishes a task.

- `autoApprovedNotification` (App.tsx:35) and `blockedNotification` (App.tsx:36)
  trigger 4-second toast notifications when commands are auto-executed or blocked,
  and call `playEarcon("execute")` or `playEarcon("alert")` (App.tsx:73–151) to
  emit synthesized audio feedback earcons.

- The `attentionQueue` (App.tsx:47) is displayed in the Alerts tab and triggers
  earcon + optional browser desktop notification (App.tsx:564–573) when new
  undismissed items arrive.

### 5.4 `ApprovalDialog` — src/components/ApprovalDialog.tsx

Renders when the server sends `approval_pending` (App.tsx:876–888). Shows the
proposed command, its target pane, the voice utterance that triggered it, and the
pane summary as rationale context. Keyboard shortcut: Escape rejects. This is the
primary human-in-the-loop friction point during a fan-out session.

### 5.5 `SettingsDialog` and `ProjectDialog`

`ProjectDialog` (src/components/ProjectDialog.tsx) is the UI form for creating
or editing projects (name, directory, summary, key terms). It is the UI
complement to voice `create_project`. `SettingsDialog` manages global permissions
mode, preset commands, voice parameters, and advanced settings — all of which
affect how fan-out panes behave.

### 5.6 Mock mode — App.tsx:987–1113

A "Mock Mode" toggle (`generateMockData`, App.tsx:987) populates three fake
terminals, a mock ledger, two pending approval commands, and a sample transcript.
This is explicitly for UI testing/demo without a running backend and is not part
of any real journey. It is flagged here because it represents real UI behavior
(approval dialogs, pane list rendering, transcript panel) that is verified to work
even when the backend is absent.

---

## 6. Future-State Best-in-Class

A best-in-class version of this journey, still constrained to audio-only /
hands-free, would include:

### 6.1 Proactive spoken status push (vs. pull-only)

Currently Janus can only observe panes when asked. Best-in-class: a
`subscribe_pane` tool that registers a background listener on a pane's output.
When the pane transitions to idle, an error occurs, or a known pattern (e.g.,
test suite results) appears, Janus proactively speaks the result without the
operator asking. This would rely on the existing `onIdle` callback
(terminal.ts:73–74) and `detectAndTriggerTransitions` (server.ts:379–447) being
wired up to push a spoken utterance via the Gemini session.

### 6.2 Dynamic system prompt refresh

Currently the system prompt (server.ts:1568) is rendered once at session
initialization and lists only the terminals alive at that moment. Best-in-class:
after each `create_pane` or `switch_context`, the model's awareness should be
refreshed. This could be achieved via Gemini Live's context injection API or by
treating `list_panes` as a mandatory first call after each structural change —
and the system prompt should clearly instruct the model to always call `list_panes`
after creating panes.

### 6.3 Voice-addressable preset selection and recipe composition

Currently recipes are two hardcoded server-side objects. Best-in-class: the
operator can say "Create me a Python data pipeline recipe with a FastAPI pane in
Human-in-the-Loop mode and a Celery worker in Full Auto" and Janus composes and
executes a custom `create_pane` fan-out plan. The `create_orchestrator_plan` and
`execute_plan` tools (server.ts:1441–1488) already provide the scaffolding for
sequential plans, but there is no parallel fan-out plan primitive — plans are
strictly sequential.

### 6.4 True parallel fan-out plan type

The current `Plan` type (types.ts:122–136) is sequential: `currentStepIndex`
advances one at a time. A best-in-class "fan-out plan" would start all steps
concurrently across multiple panes, then use a join condition (e.g., all panes
reach `idle`) before proceeding to a next phase. This would require a new plan
type with a `parallel_group` step kind.

### 6.5 Improved session ID handshake

Agent CLIs write structured session information to stdout that Janus cannot
reliably parse. Best-in-class: a startup handshake protocol where each launched
agent pane writes a well-known machine-readable line (e.g.,
`JANUS_SESSION_ID=<uuid>`) that the server parser extracts with certainty. The
current regex-based approach (terminal.ts:136–153) is fragile.

### 6.6 Spoken attention routing with pane-specific wake

Best-in-class: Janus tracks that attention items for pane X belong to project Y,
and when the operator says "tell me about the build failure", Janus
auto-calls `switch_context` + `get_pane_summary` for the errored pane before
speaking. Currently, `get_attention_digest` speaks pane IDs but does not
automatically follow up with pane summaries.

### 6.7 Synchronized UI focus to voice context switch

The `switch_context` tool should broadcast a `context_switched` WebSocket event
that the React frontend listens to and responds to by updating `activeProjectId`
state and scrolling the relevant pane into the viewport. Currently, voice-driven
context switching and UI-highlighted project are two independent states
(see Section 5.3 above).

### 6.8 Earcon differentiation by agent type

Currently all execution earcons sound the same (a short square wave burst at 880
Hz — App.tsx:123–130). Best-in-class: different tool presets should emit distinct
earcon signatures so an eyes-off operator can distinguish "Claude Code proposed a
command" from "Codex completed a task" purely by sound.
