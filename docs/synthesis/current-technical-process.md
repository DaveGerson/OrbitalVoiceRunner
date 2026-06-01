# OrbitalVoiceRunner — Current (AS-IS) Technical Process Map

> **Scope.** This is the honest *as-built* companion to the future-state synthesis. It describes
> how the system **actually works today**, grounded in the real code (`server.ts` ~1931 lines,
> `src/terminal.ts`, `src/ledger.ts`, `src/App.tsx` ~3866 lines, `src/types.ts`, `src/components/*`,
> `src/utils/{audio,api}.ts`). Every claim is cited `file:line`. It deliberately does **not**
> propose a future target — that lives in the sibling FUTURE-state doc. Section 6 is a dedicated
> catalogue of inconsistencies & oddities.
>
> OrbitalVoiceRunner is a voice-only, hands-free / eyes-off terminal orchestrator. The voice agent
> is "Project Janus" running on **Gemini Live**, **AUDIO-only** (no vision; the model never sees the
> screen, only textual tool results).

---

## 1. End-to-end process trace

### 1.1 ASCII flow

```
 ┌────────────────────────────────────────────────────────────────────────────────────────┐
 │ BROWSER (src/App.tsx + src/utils/audio.ts)                                               │
 │                                                                                          │
 │  mic getUserMedia ──> AudioContext{sampleRate:16000} ──> ScriptProcessor(4096)           │
 │      App.tsx:834,844,849                                                                  │
 │            │ onaudioprocess  App.tsx:855                                                  │
 │            ▼                                                                              │
 │   HALF-DUPLEX BARGE-IN GATE  App.tsx:856-860                                              │
 │     if (!micMuted && WS OPEN):                                                            │
 │        if isAudioPlaying(playbackCtx) -> DROP frame   (audio.ts:69-73, 200ms guard)      │
 │        else pcmToBase64(Float32 -> int16 LE)  audio.ts:1-15                               │
 │            └─> ws.send({type:"audio", audio:b64})  App.tsx:861-862                        │
 └───────────────────────────────────┬──────────────────────────────────────────────────┘
                                      │  WS /live  (audio/pcm;rate=16000)
                                      ▼
 ┌────────────────────────────────────────────────────────────────────────────────────────┐
 │ NODE SERVER PROXY (server.ts)                                                            │
 │  wss "/live"  server.ts:176, connection handler 1032                                     │
 │    auth: auth_token cookie must equal API_AUTH_TOKEN  server.ts:1033-1039                │
 │    clientWs.on("message"): {type:"audio"} -> session.sendRealtimeInput(...)              │
 │        server.ts:1846-1859  (mimeType audio/pcm;rate=16000)                              │
 │                                      │                                                   │
 │   sessionAi.live.connect(...)  server.ts:1073  model = voiceAi.model                     │
 │        (default "gemini-3.1-flash-live-preview"  terminal.ts:398 / server.ts:1070)       │
 └───────────────────────────────────┬──────────────────────────────────────────────────┘
                                      ▼
 ┌────────────────────────────────────────────────────────────────────────────────────────┐
 │ GEMINI LIVE ("Janus")                                                                    │
 │  systemInstruction server.ts:1568  (routing context injected at connect time)            │
 │  tools: 19 functionDeclarations  server.ts:1576-1834                                     │
 │  Emits: serverContent (audio + transcript), toolCall, interrupted, sessionResumption     │
 └───────────────────────────────────┬──────────────────────────────────────────────────┘
                                      │  onmessage callback  server.ts:1076
            ┌─────────────────────────┼───────────────────────────────────────────┐
            ▼                         ▼                                           ▼
   audio out                  transcript_text                            message.toolCall
   server.ts:1209-1212        server.ts:1109-1206                        DISPATCH server.ts:1218-1559
   {type:"audio"}             (user + Janus utterances also                       │
            │                  appended to promptBufferText                       │
            ▼                  & broadcast as prompt_buffer_updated)               ▼
   App.tsx:872 playAudioChunk        VOICE APPROVAL INTERCEPT             ┌──────────────────────────┐
   (24kHz)  audio.ts:20             server.ts:1126-1186                   │ TOOL EXECUTOR (big if/else)│
                                    ("approve"/"reject" keyword scan      │  list_panes ... propose_   │
                                     resolves a pendingApproval)          │  command ... set_pane_perms│
                                                                          └────────────┬─────────────┘
                                                                                       │ propose_command
                                                                                       ▼
                                                          EFFECTIVE-PERMISSIONS RESOLUTION  server.ts:1271-1276
                                                            eff = manager.globalPermissionsMode
                                                            if eff == "Inherit": eff = term.permissionsMode
                                                                                ├─ Full Auto  server.ts:1278-1303
                                                                                │     HistoryManager.addCommand
                                                                                │     term.writeInput(cmd)  ── PTY ──▶
                                                                                │     sendToolResponse + broadcast
                                                                                │     command_auto_executed
                                                                                ├─ Read-Only  server.ts:1304-1318
                                                                                │     toolResponse "blocked" +
                                                                                │     broadcast command_blocked
                                                                                └─ HITL (else)  server.ts:1318-1335
                                                                                      pendingApprovals[callId]={...}
                                                                                      broadcast approval_pending
                                                                                      (NO toolResponse yet)
                                                                                            │
                            ┌───────────────────────────────────────────────────────────┘
                            ▼
              RESOLUTION (one of):
               (a) UI button -> POST /api/commands/approve  server.ts:989-1028
               (b) Voice "approve"/"reject"  server.ts:1131-1186
                  -> term.writeInput(cmd)  ── PTY ──▶ terminal.ts:318-322
                  -> session.sendToolResponse(...) (unblocks the model)
                  -> delete pendingApprovals[id]

 PTY layer: UniversalTerminal.start() spawns `script` (UNIX) / cmd.exe (Win)  terminal.ts:220-316
   stdout/stderr -> onOutput(terminalId, chunk)  terminal.ts:271-301
     -> server.ts manager.onOutput  server.ts:453-483:
          stripAnsiSequences -> HistoryManager.appendOutputToLastCommand (.janus_history.json)
          detectAndTriggerTransitions (watch rules + plans + attention)  server.ts:379-448
          buffer 30ms -> broadcast {type:"stdout_chunk"}  server.ts:468-482
   onIdle -> summarizeCommandOutcome (Gemini) -> broadcast history_updated  server.ts:220-246
                            │
                            ▼
 BROWSER OUT: stdout_chunk -> queueStdoutChunk (App.tsx:915); audio -> playAudioChunk (App.tsx:872);
   approval_pending -> ApprovalDialog (App.tsx:876, ApprovalDialog.tsx); transcript_text (App.tsx:917)
```

### 1.2 Narrative (per hop, cited)

1. **Operator audio capture (16 kHz PCM).** On going live, the browser opens a capture
   `AudioContext({sampleRate:16000})` and a 4096-frame `ScriptProcessor`
   (`App.tsx:834,849`). Each audio frame triggers `onaudioprocess` (`App.tsx:855`).

2. **Half-duplex barge-in gate.** Before sending, the handler checks the socket is OPEN and the
   mic is not muted (`App.tsx:856`), then `isAudioPlaying(voicePlaybackCtxRef.current)`
   (`App.tsx:857`). If Janus's synthesized speech is currently playing (or within a 200 ms tail
   guard — `audio.ts:71-72`), the capture frame is **dropped** (`App.tsx:858-860`). This is the
   only echo/barge-in control: it is purely client-side and **suppresses the operator's voice while
   Janus talks** (operator cannot interrupt by speaking over Janus; they must mute or wait).

3. **Encode + send.** Surviving frames are converted to little-endian int16 base64 by `pcmToBase64`
   (`audio.ts:1-15`) and sent as `{type:"audio", audio:b64}` (`App.tsx:861-862`).

4. **Server `/live` WebSocket.** The `WebSocketServer` is mounted at `/live` (`server.ts:176`).
   On connect, the server enforces the `auth_token` cookie equals `API_AUTH_TOKEN`
   (`server.ts:1033-1039`); otherwise it closes with code 4001. Inbound `{type:"audio"}` frames are
   forwarded verbatim to Gemini via `session.sendRealtimeInput({audio:{data, mimeType:"audio/pcm;rate=16000"}})`
   (`server.ts:1849-1859`).

5. **Gemini Live session.** `sessionAi.live.connect` is called per WS connection (`server.ts:1073`)
   with `model = voiceAi.model || "gemini-3.1-flash-live-preview"` (`server.ts:1070`), AUDIO-only
   modality (`server.ts:1564`), a system instruction with live routing context (`server.ts:1568`),
   optional session resumption + context-window compression (`server.ts:1569-1575`), and the 19-tool
   declaration block (`server.ts:1576-1834`).

6. **Inbound model messages.** The `onmessage` callback (`server.ts:1076`) handles four things:
   - **Session resumption token** captured to module-level `lastSessionResumptionToken` (`server.ts:1078-1081`).
   - **Transcripts**: user/model text extracted (`server.ts:1087-1107`), echoed to the client as
     `transcript_text` (`server.ts:1111-1115`, `1191-1195`), and appended to `promptBufferText`
     then broadcast as `prompt_buffer_updated` (`server.ts:1120-1124`, `1200-1205`).
   - **Audio out** forwarded as `{type:"audio"}` (`server.ts:1209-1212`); `interrupted` forwarded
     (`server.ts:1213-1215`).
   - **Tool calls** dispatched (`server.ts:1218`).

7. **Voice approval intercept.** Before tool dispatch, on each user utterance the server scans for
   approve/reject keywords (`server.ts:1126-1129`) and, if a pending approval exists for this
   session, resolves the first one (`server.ts:1131-1186`).

8. **Tool-call dispatch / executor.** A long `if/else` chain (`server.ts:1223-1558`) handles all 19
   tools. Most synchronously `session.sendToolResponse(...)`.

9. **`propose_command` branch + effective-permissions resolution.** `propose_command`
   (`server.ts:1267`) computes effective permission: start from `manager.globalPermissionsMode`; if
   `"Inherit"`, fall back to the live terminal's `permissionsMode` (defaulting to
   `"Human-in-the-Loop"` if the terminal is missing) (`server.ts:1271-1276`). Then:
   - **Full Auto** (`server.ts:1278-1303`): log to history, `term.writeInput(cmd)`, respond to the
     tool, broadcast `command_auto_executed`.
   - **Read-Only** (`server.ts:1304-1318`): respond with a "blocked" tool output, broadcast
     `command_blocked`.
   - **HITL / else** (`server.ts:1318-1335`): store in `pendingApprovals[call.id]` with a rationale
     (`{trigger: last user utterance, summary: getPaneSummary}`), broadcast `approval_pending`, and
     **deliberately do not** send a tool response — the model blocks until approval arrives.

10. **PTY write.** `term.writeInput(cmd)` writes `cmd + "\n"` to the child process stdin
    (`terminal.ts:318-322`). The child is a real PTY allocated via `script` on UNIX
    (`terminal.ts:240-249`).

11. **Output → broadcast.** PTY stdout/stderr fire `onOutput` (`terminal.ts:271-301`) →
    `manager.onOutput` (`server.ts:453`): ANSI-stripped output is appended to history
    (`server.ts:457`), transitions are detected (`server.ts:460`), and raw chunks are coalesced over
    a 30 ms window and broadcast as `stdout_chunk` (`server.ts:468-482`).

12. **UI / audio out.** The client `onmessage` (`App.tsx:870`) plays audio (`App.tsx:872-873`),
    renders transcripts (`App.tsx:917`), shows the approval dialog (`App.tsx:876`), and queues
    terminal output (`App.tsx:915`).

---

## 2. Component inventory

| Component | File(s) | Real responsibilities | Persistence touchpoints |
|---|---|---|---|
| **Server proxy** (`startServer`) | `server.ts:143-1929` | Express REST API + `/live` WS proxy to Gemini Live; per-connection Gemini session; tool-call executor; transition detection; watch-rule/plan engine; broadcast hub | reads/writes `.janus_settings.json`, `.janus_ledger.json`, `.janus_history.json` (via the managers below) |
| **HistoryManager** (singleton) | `server.ts:41-129` | Per-terminal command history with output, timestamps, optional `finalResponse` summary; prune to `historyMaxCommands`/`historyMaxOutputLength` | **`.janus_history.json`** (object keyed by terminalId) |
| **OrchestratorManager** | `terminal.ts:379-600` | Owns all `UniversalTerminal`s, the `Ledger`, `attentionQueue`, `globalPermissionsMode`, `settings`; spawns/syncs terminals; `listPanes`, `getPaneSummary`; settings load/save | **`.janus_settings.json`** (`settingsFilePath`, `terminal.ts:388`) |
| **UniversalTerminal** | `terminal.ts:62-377` | One PTY-backed child process (`script`/`cmd.exe`); status heuristic (Running/Idle/Exited); session-id sniffing; scrollback persistence; `writeInput`; `setPermissionsMode` | **`.janus_scrollback_<id>.log`** per terminal (`terminal.ts:192,205`) |
| **Ledger** | `ledger.ts:28-210` | Workspaces (projects + panes), notes, key terms, watch rules, plans; atomic debounced/sync save; project briefings | **`.janus_ledger.json`** (atomic temp+rename, `ledger.ts:89-127`) |
| **React App** | `App.tsx` | The entire single-page UI; WS client; mic capture + barge-in gate; audio playback; REST polling (3 s); earcons; desktop notifications; mock mode; all dialogs | none server-side; relies on `auth_token` cookie |
| **ApprovalDialog** | `components/ApprovalDialog.tsx` | Modal showing proposed command + rationale; Confirm/Reject; Esc = reject | n/a |
| **CreateTerminalDialog / ProjectDialog / SettingsDialog / TerminalView** | `components/*.tsx` | Pane creation, project edit, settings edit, terminal output rendering | via REST endpoints |
| **audio utils** | `utils/audio.ts` | `pcmToBase64` (mic, 16 kHz), `playAudioChunk` (24 kHz playback, scheduled), `resetAudioPlayback`, `isAudioPlaying` (barge-in guard) | n/a |
| **api util** | `utils/api.ts` | `apiFetch` wrapper that reloads the page on HTTP 401 | n/a |

**Persistence file summary:** `.janus_ledger.json` (durable, atomic), `.janus_settings.json` (durable),
`.janus_history.json` (durable), `.janus_scrollback_<id>.log` (durable per pane). Note: `.gitignore`
excludes these; a committed sample `.janus_ledger_journeys_test.json` exists at repo root.

---

## 3. Actual tool surface (19 tools)

Declared in `server.ts:1576-1834`; executed in `server.ts:1223-1558`. "Honest behavior" describes what
the handler truly does today; the **MISLEAD** flag marks descriptions that misrepresent behavior.

| Tool | Declared description (server.ts) | Honest behavior | MISLEAD? |
|---|---|---|---|
| `list_panes` | "...with runtime_type, is_busy, alive, and a one-line state" (`:1579`) | Returns `manager.listPanes()` = projects + raw `PaneMeta` objects (`:1223`, `terminal.ts:551`). No "one-line state" field is synthesized; it returns the full pane meta. | minor |
| `propose_command` | "Does NOT execute. Triggers human approval; returns the outcome (executed \| edited \| denied)." (`:1588`) | Behavior depends on **effective permission**: **Full Auto silently executes immediately** with no human approval (`:1278-1303`); Read-Only blocks; only HITL actually triggers approval. "edited" is never a real outcome (no edit path exists). | **YES** |
| `get_pane_command_history` | "concise, high-level final responses/outcomes" (`:1599`) | Returns history entries with `finalResponse` **or** falls back to last 300 chars of raw output (`:1240-1245`). Because the summarizer model is broken (§6), `finalResponse` is usually the static string "Execution finished successfully." | partial |
| `get_pane_summary` | "clean, **redacted** markdown **delta**..." (`:1611`) | Returns the last N lines of buffer wrapped in a code fence (`terminal.ts:593-599`). It is **not redacted** (no secret scrubbing) and **not a delta** (full recent window, same lines every call). | **YES** |
| `switch_context` | "Make a project the active focus. Returns a fresh briefing... backgrounds the previous project." (`:1621`) | Sets active project, persists settings, broadcasts `ledger_updated`, returns briefing (`:1255-1266`). It does **not** emit a UI focus-sync event, so the React `activeProjectId` is not updated (§6). No process is actually "backgrounded." | **YES** |
| `add_project_note` | "durable note to a project" (`:1632`) | Accurate (`:1336`, `ledger.addNote`). | no |
| `add_pane_note` | "durable note to a pane" (`:1644`) | Accurate (`:1342`). | no |
| `rename_project` | accurate (`:1657`) | Accurate (`:1348`). | no |
| `rename_pane` | accurate (`:1669`) | Accurate (`:1354`). | no |
| `get_attention_digest` | "active items... requiring operator confirmation, **approvals**, or error states" (`:1683`) | Reads only `manager.attentionQueue` (`:1360-1370`). That queue is populated **only** by error/build-failed/exited transitions and plan failures (`server.ts:433,353`). **No `approval`-type items are ever pushed**, so it never reports pending approvals despite the description. | **YES** |
| `create_project` | declares `project_id, directory, summary` (`:1690-1700`) | Handler also reads `args.key_terms` (`:1374-1376`) but `key_terms` is **not in the declaration**, so the model has no documented way to pass it. | **YES** |
| `create_pane` | "create a new pane and live restore start its process environment" (`:1703`) | Spawns a terminal via `manager.addTerminal` (`:1381-1399`). | minor |
| `set_global_permissions` | "system wide voice execution permission mode" (Full Auto/HITL/Read-Only/Inherit) (`:1724`) | Sets `globalPermissionsMode` + persists (`:1400-1412`). When set to anything other than `Inherit`, it **overrides every pane's local permission** (§6 — silent total override). | partial |
| `set_voice_mute` | accurate (`:1738`) | Sets `voiceAi.isMicMuted` and broadcasts settings (`:1413-1423`). | no |
| `add_watch_rule` | accurate (`:1749`) | Pushes rule, persists, broadcasts `watch_rules_updated` (`:1424-1440`). | no |
| `create_orchestrator_plan` | "...automatic state verification of previous outputs" (`:1765`) | Stores a plan; "verification" is just transition-equality matching in `handlePlansTrigger` (`:1441-1462`, `server.ts:294-377`). | minor |
| `execute_plan` | accurate (`:1787`) | Runs step 0, writes to PTY (`:1463-1490`). | no |
| `apply_orchestration_recipe` | accurate (`:1798`) | Spawns recipe panes (`:1491-1515`). | no |
| `handoff_context_between_panes` | "package summaries/learnings to prime a model agent" (`:1809`) | Adds a pane note and **writes a commented block into the target PTY stdin** (`:1516-1541`). It primes via shell comment injection, not a model API. | minor |
| `set_pane_permissions` | accurate (`:1822`) | Updates live terminal + ledger pane (`:1542-1557`). | no |

---

## 4. Persistence & state model

### 4.1 Durable (survives restart)
- **Ledger** → `.janus_ledger.json`: `activeProjectId`, `workspaces` (projects + `PaneMeta`), `watchRules`,
  `plans` (`ledger.ts:91-98`). Atomic write via temp + rename (`ledger.ts:97-98,121-122`).
- **Settings** → `.janus_settings.json`: server/voiceAi/projects/presets/advanced/secrets
  (`terminal.ts:461-467`). `globalPermissionsMode` lives here under `advanced` (`terminal.ts:476`).
- **History** → `.janus_history.json`: per-terminal command list with output + `finalResponse`
  (`server.ts:83-107`).
- **Scrollback** → `.janus_scrollback_<id>.log` per terminal (`terminal.ts:204-218`).

### 4.2 In-memory only (LOST on restart)
- **`pendingApprovals`** (`server.ts:978`): all in-flight HITL approvals. A restart drops them; the
  Gemini tool-call is never answered and the operator's "in flight" command silently evaporates.
- **`promptBufferText`** (`server.ts:133-141`): the shared requirements/chronicle buffer. Resets to the
  hardcoded seed text on every boot. All dictation appended during a session is gone.
- **`lastSessionResumptionToken`** (`server.ts:1030`): module-level; lost on restart, so session
  resumption cannot survive a server bounce.
- **`attentionQueue`** (`terminal.ts:383`): all alerts cleared on restart.
- **`lastStates`** (`server.ts:264`): transition de-dup state; reset on restart.
- **Running PTYs / `manager.terminals`**: child processes die with the server. On restart the
  constructor re-creates pane shells from the ledger (`terminal.ts:502-519`) but **starts fresh
  processes** — no real session continuity (the `--resume=` flag is appended cosmetically,
  `terminal.ts:229-234`).
- **Live transcript / earcon / notification UI state**: all React state, lost on reload.

---

## 5. Event / broadcast model

### 5.1 Server-emitted WS events (21 distinct `type`s)
`approval_pending`, `attention_updated`, `audio`, `command_auto_executed`, `command_blocked`,
`error`, `history_updated`, `interrupted`, `ledger_updated`, `pane_transition`, `plan_completed`,
`plan_paused`, `plan_step_completed`, `plans_updated`, `prompt_buffer_updated`, `settings_updated`,
`stdout_chunk`, `terminals_updated`, `transcript_text`, `watch_rule_fired`, `watch_rules_updated`.

### 5.2 Client handlers (`App.tsx:872-927`) — only 12
`audio`, `interrupted`, `approval_pending`, `prompt_buffer_updated`, `terminals_updated`,
`ledger_updated`, `settings_updated`, `command_auto_executed`, `command_blocked`, `stdout_chunk`,
`transcript_text`, `error`.

### 5.3 Emitted but with NO client handler (9 events — silently ignored)
`attention_updated`, `history_updated`, `pane_transition`, `plan_completed`, `plan_paused`,
`plan_step_completed`, `plans_updated`, `watch_rule_fired`, `watch_rules_updated`.

The UI instead **polls** REST every 3 s for attention/watch-rules/plans (`App.tsx:593-599`,
`fetchAttentionQueue/fetchWatchRules/fetchPlans`). So plan progress, watch-rule firing, transitions,
and fresh history summaries reach the UI only via that 3 s poll (history only when its panel is open,
`App.tsx:613-620`) — never instantly via the events the server is already broadcasting. The real-time
broadcasts for these nine are effectively dead wiring.

---

## 6. INCONSISTENCIES & ODDITIES catalogue

> Each entry: what it is, `file:line`, and impact.

### A. Model & summarization
1. **Nonexistent `gemini-3.5-flash` model + silent fallback.** `summarizeCommandOutcome` calls
   `model: "gemini-3.5-flash"` (`server.ts:210`), which is not a real Google model. The `try/catch`
   returns the static string `"Execution finished successfully."` (`server.ts:214-217`). **Impact:**
   every auto-summary fails; `finalResponse` is a meaningless constant; `get_pane_command_history`
   degrades to raw-tail output. The live model name (`gemini-3.1-flash-live-preview`,
   `server.ts:1070`, `terminal.ts:398`) is also forward-of-cutoff and may not resolve.

### B. Divergent command strings (three different "Claude Code" launchers)
2. **Three divergent restart/launch command strings.** For tool_preset "Claude Code":
   - `server.ts:551` (REST restart restore): `npx @anthropic-ai/claude`
   - `terminal.ts:506` (constructor pane restore): `npx @anthropic-ai/claude-code`
   - `terminal.ts:49` (`parsePresetsSafe` default): `npx @anthropic-ai/claude --resume-previous-session --with-open-textbox`
   
   Codex likewise diverges: `npx codex-cli` (`server.ts:552`, `terminal.ts:50,411`) vs `npx codex`
   (`terminal.ts:507`). **Impact:** the same logical pane launches a *different binary* depending on
   which code path restores it (fresh create vs REST restart vs server-boot restore), so restart
   behavior is non-deterministic and at least one of these package names is wrong.

### C. The phantom `.sort()` comment
3. **Comment claims a sort that does not exist.** In the voice approval intercept, the code filters
   pending approvals for the session and the comment says *"Sort to resolve the earliest/most relative
   first"* (`server.ts:1135`) — but it simply takes `pendingEntries[0]` (`server.ts:1136`) with **no
   `.sort()` call**. Order is just `Object.entries` insertion order. **Impact:** a spoken "approve"
   with multiple pending commands resolves an arbitrary one, not the "earliest/most relevant"; the
   comment misleads maintainers into thinking ordering is handled.

### D. Tool descriptions that misrepresent behavior
4. **`get_pane_summary` "redacted delta".** Described as a *redacted markdown delta*
   (`server.ts:1611`) but is the full recent buffer window, **unredacted**, returned every call
   (`terminal.ts:593-599`). Not a delta, not redacted.
5. **`get_attention_digest` claims approvals.** Description says it surfaces items "requiring operator
   confirmation, approvals" (`server.ts:1683`), but the attention queue never receives `approval`-type
   items — only error/build-failed/exited/plan failures are pushed (`server.ts:433,353`). Pending
   approvals (`pendingApprovals`) are a separate store the digest never reads.
6. **`propose_command` "Does NOT execute".** Under Full Auto it executes immediately with zero human
   step (`server.ts:1278-1303`), directly contradicting the declaration (`server.ts:1588`). The claimed
   `edited` outcome has no code path.
7. **`create_project` undocumented `key_terms`.** Handler reads `args.key_terms` (`server.ts:1376`) but
   the declaration omits it (`server.ts:1690-1700`), so the model cannot reliably populate it.

### E. Missing UI sync events / dead broadcasts
8. **`switch_context` emits no UI focus-sync event.** It updates the active project and broadcasts only
   `ledger_updated` (`server.ts:1262`), and the `ledger_updated` handler calls `setLedger` but never
   `setActiveProjectId` (`App.tsx:897-898`). **Impact:** a voice context switch leaves the UI
   highlighting the previous project; Janus's focus and the operator's view diverge until a manual click.
9. **Nine broadcast events have no client handler** (§5.3). `pane_transition`, all `plan_*`,
   `watch_rule*`, `attention_updated`, `history_updated` are emitted but dropped client-side; the UI
   relies on a 3 s poll instead. Real-time push for orchestration progress is effectively dead code.

### F. Permissions
10. **Global permission override is silently total.** When `globalPermissionsMode` is anything but
    `Inherit`, `propose_command` uses it directly and **never consults the pane's own mode**
    (`server.ts:1271-1276`). Setting global to "Full Auto" silently makes *every* pane — including ones
    the operator deliberately set Read-Only — auto-execute, with no per-pane warning. `set_global_permissions`
    is voice-callable (`server.ts:1400-1412`) so Janus can self-escalate the whole system to Full Auto.

### G. Mock mode divergence
11. **Mock-mode paths diverge from the real flow.** `generateMockData` (`App.tsx:987-1106`) injects
    fake terminals/ledger/pending-commands directly into React state and sets
    `isMockModeRef.current = true`, which then **short-circuits every fetch and most mutations**
    (`App.tsx:301,313,368,378,389,400,411,660,690,711`). **Impact:** in mock mode the UI shows data
    that the server, ledger, and Gemini session know nothing about; approvals/exec in mock mode do not
    hit the real `pendingApprovals`/PTY flow. It is an isolated UI sandbox that looks identical to live.

### H. Volatile state lost on restart
12. **`pendingApprovals` in-memory only** (`server.ts:978`): in-flight approvals + their dangling
    Gemini tool-calls vanish on restart.
13. **`promptBufferText` resets to seed** (`server.ts:133-141`): all dictation/chronicle content lost on
    restart even though the UI presents it as durable shared memory.
14. **`lastSessionResumptionToken` in-memory only** (`server.ts:1030`): resumption cannot survive a
    server bounce; also it is module-level/global, so it is shared across *all* connecting clients
    rather than per-session.

### I. Security / data exposure
15. **Raw, unredacted terminal output (incl. secrets) is sent everywhere.** `manager.onOutput`
    broadcasts raw `stdout_chunk` to all clients (`server.ts:473-479`) and `get_pane_summary`/history
    feed raw PTY text to the model (`terminal.ts:597-598`, `server.ts:1244`). Despite the "redacted"
    tool description, **nothing scrubs API keys, tokens, or passwords** that scroll through a pane —
    they go to the model and over the wire. Settings only mask the Gemini key in the REST response
    (`server.ts:951-958`), not terminal content.
16. **Auth token auto-generated and only logged as "generated".** `API_AUTH_TOKEN` is `crypto.randomBytes`
    if no env var (`server.ts:17`); the cookie is seeded on any non-`/api`/`/live` page load
    (`server.ts:148-160`), so effectively any first visitor to the page is authorized. Single shared
    token, no per-user identity.

### J. Heuristics & detection
17. **Untested status heuristic.** Terminal Running/Idle/Exited is inferred from a regex on output plus a
    1 s idle timer (`terminal.ts:156-189`), and transitions (idle/prompt/error/build-failed/exited) from
    keyword matching on chunks (`server.ts:379-416`). This drives watch rules, plans, attention, and
    auto-summarization. **Impact:** brittle — interactive prompts, colored output, or apps that print
    "Error:" in normal logs will mis-trigger; e.g. any line containing `Error:`/`Exception:` flips a pane
    to "error" and spawns an attention item regardless of true severity (`server.ts:400-405`).
18. **Idle-timer / `onIdle` double-fire risk.** Both the prompt-pattern branch and the 1 s timer can call
    `onIdle` (`terminal.ts:173,183`), so a single command can trigger summarization more than once; the
    guard is only `!lastEntry.finalResponse` (`server.ts:226`).

### K. Additional smells found
19. **Private members reached via bracket-string indexing.** The server repeatedly calls
    `manager.ledger["save"](true)` (`server.ts:289,374,...`) with an inline comment "use string to bypass
    bracket checks if needed" (`server.ts:669`) to reach the public `save` — confusing and implies the
    author believed `save` was private.
20. **`switch_context` localWorkspacePath side effect.** It rewrites `settings.projects.localWorkspacePath`
    on every context switch (`server.ts:1259-1261`), coupling a transient voice focus change to a
    persisted setting.
21. **30 ms global flush timer shares one buffer map across all panes** (`server.ts:450-482`): a single
    `flushTimeout` flushes every terminal's buffer together; high-output on one pane can delay/interleave
    others' chunk delivery.
22. **`detected exited` transition only set after `status==="Exited"`**, but `lastStates` de-dup means an
    exit immediately followed by re-detection won't re-alert; combined with global `lastStates`
    (`server.ts:264`) reset on restart, exit alerts are not durable.
23. **Voice approval keyword scan is substring-based** (`server.ts:1128-1129`): utterances like "don't
    cancel" or "I won't approve" contain `cancel`/`approve` and will falsely resolve a pending command;
    `approve` is checked before deeper intent, and any utterance containing "execute"/"run it" auto-fires.

---

### Summary of the AS-IS reality
The system is a thin per-connection Gemini Live proxy: browser mic (16 kHz) → client-side half-duplex
gate → `/live` WS → Gemini → a 19-tool executor whose only real autonomy lever is the
`globalPermissionsMode`-then-pane effective-permission resolution feeding `propose_command` → PTY
(`script`) writes and history/ledger updates → broadcasts. Durable state is the ledger, settings,
history, and scrollback files; the genuinely live, operator-critical state (pending approvals, prompt
buffer, resumption token, attention queue) is in-memory and lost on restart, and nine of the server's
broadcast events have no client handler at all.
