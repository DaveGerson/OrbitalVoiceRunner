# Journey 1: Fan-out / Delegate in Parallel — Gap Analysis

**Scope:** All gaps relevant to the hands-free / eyes-off operator experience for
Journey 1 (multi-pane fan-out, parallel agent delegation, voice-driven context
switching, and plan execution). Phase-1 claims re-verified against actual code;
new gaps added where found.

---

## 1. Gap Register

| ID | Title | Severity | Category | User Impact | Evidence | Suggested Direction |
|----|-------|----------|----------|-------------|----------|---------------------|
| J1-G1 | `switch_context` does not update React `activeProjectId` | Critical | Missing | Voice context switch leaves the UI highlighting the wrong project; operator's displayed pane content and Janus's focus are permanently out of sync unless the operator clicks | `server.ts:1255–1265` — no `context_switched` WS event emitted; `App.tsx:897–898` — `ledger_updated` only calls `setLedger`, never `setActiveProjectId` | Emit a `context_switched` WS event with the new `activeProjectId`; handle it in App.tsx to call `setActiveProjectId` + `setActiveTerminalId(null)` |
| J1-G2 | `summarizeCommandOutcome` calls nonexistent model `gemini-3.5-flash` | Critical | Mocked | Every command history entry's `finalResponse` silently falls back to the fixed string `"Execution finished successfully."`, making `get_pane_command_history` useless as a token-light history tool | `server.ts:210` — `model: "gemini-3.5-flash"` (not a real Google model); `server.ts:214–216` — catch returns static fallback | Replace with a real model (`gemini-2.0-flash` or `gemini-2.5-flash`); add integration smoke test |
| J1-G3 | Three inconsistent command strings for the same preset on restart | Critical | Sub-capable | A pane restored after server restart launches with a different CLI binary than the operator originally configured, silently breaking session continuity | `terminal.ts:506` — constructor restore uses `"npx @anthropic-ai/claude-code"`; `terminal.ts:410` — `getDefaultSettings` uses `"npx @anthropic-ai/claude"`; `terminal.ts:49` — `parsePresetsSafe` fallback uses `"npx @anthropic-ai/claude --resume-previous-session --with-open-textbox"` | Derive restore command from the ledger's `PaneMeta.session_id` and settings presets, not hardcoded switch/case strings |
| J1-G4 | `execute_plan` is strictly sequential; no parallel fan-out primitive | High | Missing | Despite the journey's name, `create_orchestrator_plan` + `execute_plan` can only chain steps one-at-a-time. Dispatching simultaneous tasks to multiple panes is impossible via the plan mechanism | `server.ts:1463–1490` — `currentStepIndex` advances only after the previous step transitions; `types.ts:130–136` — `Plan` has no parallel step group | Add a `parallel_group` step type to `Plan`; dispatch all steps in the group simultaneously and join on all reaching their expected transition |
| J1-G5 | `App.tsx` WebSocket handler silently drops all orchestration broadcast events | High | Missing | `attention_updated`, `plans_updated`, `watch_rules_updated`, `pane_transition`, `plan_step_completed`, `plan_completed`, `plan_paused`, `history_updated`, `watch_rule_fired` are all broadcast by the server but are entirely unhandled in App.tsx's `ws.onmessage`. UI state (alerts tab, plan progress bar) is only updated via a 3-second polling loop, not push | `server.ts:422–443`, `303–377`, `474–479` — broadcast calls; `App.tsx:870–927` — onmessage handler has no cases for these event types; `App.tsx:593–601` — 3-second `setInterval` polls instead | Add `else if` branches for each event type in App.tsx `ws.onmessage`; use the pushed data to call the matching setters |
| J1-G6 | Session-ID extraction uses speculative regex with no CLI contract | High | Sub-capable | Janus's `list_panes` and briefing responses return a synthetic `claude-code-session-<hex>` ID that was never confirmed by the CLI. If the operator asks for a session resume, the wrong ID is used | `terminal.ts:107–115` — synthetic ID generated before process starts; `terminal.ts:136–153` — five regexes attempt post-hoc extraction; Claude Code's actual stdout format is not guaranteed to match any of them | Establish a startup handshake protocol (e.g., a well-known `JANUS_SESSION_ID=<uuid>` line); or use `--print-session-id` if the CLI supports it |
| J1-G7 | Voice approval (`go ahead`) resolves the lexicographically first pending command, not the most recently spoken one | High | Sub-capable | During fan-out with two Human-in-the-Loop panes, if Janus proposes commands to both panes before the operator speaks approval, saying "go ahead" approves an arbitrary command (whichever `Object.entries` returns first), not the one Janus just read aloud | `server.ts:1133–1136` — `pendingEntries[0]` with a comment claiming it sorts but no sort call present | Track the most recently described pending command ID in the session; resolve that one on voice approval; speak the pane name back for confirmation |
| J1-G8 | `create_project` tool schema omits `key_terms` parameter | Medium | Inaccurate-doc | Janus cannot populate codebase terms during voice project creation even though the handler reads `key_terms` from args; terms will always be `[]` | `server.ts:1690–1700` — tool schema has no `key_terms` property; `server.ts:1375–1376` — handler reads `key_terms || []` | Add `key_terms` as an array parameter to the `create_project` function declaration |
| J1-G9 | `idleTimeoutMs` setting (default 2000 ms) is never applied; all idle timers are hardcoded to 1000 ms | Medium | Inaccurate-doc | Configuring idle timeout via Settings has no effect; panes are always classified idle after 1 second regardless | `terminal.ts:187`, `267` — both setTimeout calls hardcode `1000`; `terminal.ts:423` — `idleTimeoutMs: 2000` in `getDefaultSettings` is never read back | Read `this.idleTimeoutMs` from settings in the constructor; apply it in `updateStatusOnOutput` and `start()` timers |
| J1-G10 | System prompt is rendered once at connection time; newly created panes are invisible to Janus's context | Medium | Sub-capable | After `create_pane` succeeds, the system prompt still shows zero panes (the state at connect time); Janus must call `list_panes` explicitly or it will propose commands to panes it believes don't exist | `server.ts:1568` — template literal evaluated once inside `session.connect()`; pane list is `Object.values(manager.terminals)` at that moment | Instruct the model in the system prompt to always call `list_panes` after any structural change; or inject an ephemeral context update after `create_pane` succeeds |
| J1-G11 | Default preset fallback commands include non-existent flags `--resume-previous-session` and `--with-open-textbox` | Medium | Sub-capable | When settings file is absent, the hardcoded fallback commands include flags that may not exist in the installed CLI version, causing spawn failures or unexpected output on first run | `terminal.ts:49–51` — fallback preset commands include these flags; additionally `start()` at `terminal.ts:232` then appends a second `--resume=<sessionId>` flag, producing conflicting resume directives | Validate flags against installed CLI; separate command base from modifier flags |
| J1-G12 | `handoff_context_between_panes` injects a shell comment block into the agent's stdin | Medium | Sub-capable | Injecting `# === HANDOFF CONTEXT INTERCEPT ===` into an agent pane's stdin assumes the receiving CLI interprets comment lines as context; Claude Code treats them as shell commands to run in the underlying shell and will produce an error | `server.ts:1533–1534` — `targetTerm.writeInput(commentCommand)` with a multiline `#` block | Use a blank-line followed by a structured prompt prefix the agent CLI understands (e.g., `<context>` tag) or a `propose_command` flow instead |
| J1-G13 | `apply_orchestration_recipe` pane commands have an `echo` stub prefix that triggers error classification | Medium | Sub-capable | Recipe panes open with `echo 'Frontend running' && npm run dev`; `detectAndTriggerTransitions` sees the echo output and may classify the pane as `idle` immediately before the real command starts, firing watch rules prematurely | `server.ts:734–736`, `744–745` — echo prefixes in all recipe pane commands; `server.ts:406–415` — idle detection fires on any prompt-pattern output | Remove echo prefixes; use a startup comment in the actual command or a dedicated `pre_command` field on `TemplateRecipe` |
| J1-G14 | No voice tool to dismiss attention items | Medium | Missing | The operator hears a digest of errors but cannot dismiss them by voice, so the queue accumulates and subsequent digests repeat the same stale items | `server.ts:1682–1688` — `get_attention_digest` is the only attention tool; dismiss is REST-only at `server.ts:755–770` | Add a `dismiss_attention` voice tool accepting an item ID or `"all"`; route it to the existing dismiss logic |
| J1-G15 | `get_pane_summary` has no access to scrollback beyond the 100-line in-memory buffer | Low | Sub-capable | An agent that has been running for minutes will have its earlier output truncated; the operator cannot ask "what did Claude do thirty minutes ago" | `terminal.ts:593–599` — `getPaneSummary` calls `getRecentOutput(limit)` only; `terminal.ts:204–218` — scrollback log file exists but is never read by `getPaneSummary` | Extend `getPaneSummary` to fall back to the `.janus_scrollback_<id>.log` file when the buffer is insufficient; add an optional `offset` parameter |
| J1-G16 | Attention items always record `activeProjectId` at trigger time, not the pane's actual project | Low | Sub-capable | An error in a non-active project's pane is attributed to whatever project was active at that moment, corrupting routing in `get_attention_digest` | `server.ts:431` — `projectId: manager.ledger.activeProjectId || "default_project"` used for all items; the pane's own `projectId` (`term.projectId`) is not used | Use `term.projectId` from `manager.terminals[terminalId]` when constructing the attention item |
| J1-G17 | No test coverage for UI `activeProjectId` divergence after `switch_context` | Low | Inaccurate-doc | The test in `test_journeys.ts` only asserts `manager.ledger.activeProjectId`, not the React state, giving a false pass that hides J1-G1 | `tests/test_journeys.ts:55–63` — asserts ledger only | Add a frontend integration test (Playwright or similar) that calls `switch_context` via voice and checks the highlighted project in the DOM |

---

## 2. Critical and High Gaps — Detail

### J1-G1 — Voice `switch_context` silently diverges from the UI (Critical)

When the operator says "Switch focus to project beta," Janus calls `switch_context`,
which updates `manager.ledger.activeProjectId` and saves settings
(`server.ts:1255–1265`). However, the server only broadcasts a `ledger_updated`
event; App.tsx's handler for `ledger_updated` calls only `setLedger(msg.ledger)`
and never `setActiveProjectId` (`App.tsx:897–898`). The React UI continues to
highlight the previous project and display its panes. There is no `context_switched`
event type defined anywhere. For a hands-free operator who cannot see the screen,
this means Janus's spoken briefing of project beta refers to content that does not
match what would be visible if the operator glanced at the screen. Every subsequent
voice/UI interaction until the operator manually clicks will operate on different
projects.

### J1-G2 — History summaries always return a static fallback string (Critical)

`summarizeCommandOutcome` at `server.ts:209–210` calls
`summarizeAi.models.generateContent({ model: "gemini-3.5-flash" })`.
`gemini-3.5-flash` does not exist in Google's model catalog (current generation is
`gemini-2.0-flash` / `gemini-2.5-flash`). Every call throws an API error and the
catch block at `server.ts:214–216` returns the hardcoded string
`"Execution finished successfully."` regardless of what the command actually did.
Because `get_pane_command_history` presents these `finalResponse` fields as the
primary token-light history signal, Janus receives useless summaries for every
past command. An operator asking "What did Claude do on the auth module?" will hear
"Execution finished successfully" repeated for every history entry.

### J1-G3 — Three inconsistent restart command strings break session continuity (Critical)

Three independent code paths determine what command is used to relaunch a Claude
Code pane after a server restart or terminal stop/start:

1. `getDefaultSettings` (terminal.ts:410): `"npx @anthropic-ai/claude"` — no resume flags  
2. `parsePresetsSafe` fallback (terminal.ts:49): `"npx @anthropic-ai/claude --resume-previous-session --with-open-textbox"` — unverified flags  
3. Constructor restore (terminal.ts:506): `"npx @anthropic-ai/claude-code"` — different package name  

The REST restart endpoint (`server.ts:551`) uses path 3, which uses
`@anthropic-ai/claude-code` instead of `@anthropic-ai/claude`, silently installing
a different package or invoking a nonexistent binary if only one is installed. A
Codex pane restart similarly diverges: path 3 uses `"npx codex"` while paths 1/2
use `"npx codex-cli"`. The operator has no indication of the mismatch; the restored
pane simply fails to start.

### J1-G4 — `execute_plan` is strictly sequential; fan-out is impossible via plans (High)

`handlePlansTrigger` (`server.ts:294–377`) advances `plan.currentStepIndex` by one
only after the current step's pane reaches its expected transition. There is no
mechanism to send multiple commands to multiple panes simultaneously within one
plan. The `Plan` type (`types.ts:130–136`) has no parallel step group. Because
`create_orchestrator_plan` is explicitly described as "multi-pane" and the journey
is called "Fan-out / Delegate in parallel," this is a direct capability gap: an
operator who says "run tests on all three panes at once" receives a strictly serial
execution regardless of how they phrase it.

### J1-G5 — Orchestration broadcast events are silently dropped by the frontend (High)

The server broadcasts at least eight distinct orchestration event types that App.tsx
never handles: `attention_updated`, `plans_updated`, `watch_rules_updated`,
`pane_transition`, `plan_step_completed`, `plan_completed`, `plan_paused`,
`history_updated`, and `watch_rule_fired`. App.tsx's `ws.onmessage` handler
(`App.tsx:870–927`) contains no `else if` branch for any of these. The UI relies
entirely on a 3-second `setInterval` polling loop (`App.tsx:593–601`) to learn
about alerts, plan state changes, and watch-rule firings. For the hands-free
operator, this means there is up to a 3-second lag before an earcon fires for an
error, and plan step completions never trigger real-time spoken confirmation from
Janus (since Janus receives no push either).

### J1-G6 — Session-ID extraction is speculative regex with no CLI contract (High)

Before the agent CLI process starts, `UniversalTerminal` generates a synthetic
`claude-code-session-<8 hex chars>` ID (`terminal.ts:110–115`). The five regex
patterns in `checkForSessionId` (`terminal.ts:140–153`) attempt to extract a real
session ID from stdout, but none match Claude Code's actual output format
(which does not emit a `Session ID:` line in its normal startup path). The
synthetic ID is therefore almost always the one that persists in the ledger and
is passed to the `--resume=<sessionId>` flag appended in `start()`
(`terminal.ts:229–234`). Resuming a session with a wrong ID will start a fresh
session silently, losing the agent's prior context without any error message to
the operator.

### J1-G7 — Voice approval targets an arbitrary pending command during fan-out (High)

When two Human-in-the-Loop panes both have pending approvals simultaneously (a
routine fan-out scenario), `server.ts:1133–1136` filters approvals for the
current session and takes `pendingEntries[0]`. The comment says "Sort to resolve
the earliest/most relative first" but no sort call exists — `Object.entries` over
a plain object returns keys in insertion order, but this is not guaranteed by the
spec for all key types. In practice, saying "go ahead" approves whichever command
was registered first, regardless of which one Janus most recently described
verbally. The operator cannot reliably approve a specific pane's command without
eyes-on confirmation.

---

## 3. What's Solid

- **`create_pane` spawns real processes.** Uses `script -q -f -c` on Linux for a
  genuine PTY, `detached: true`, and a 512 KB scrollback log. Multiple panes are
  independent OS child processes and run concurrently without serialization
  (`terminal.ts:220–316`).

- **Ledger persistence is atomic.** All saves use a write-then-rename swap via a
  `.tmp` file (`ledger.ts:88–127`). Async saves are debounced; sync flushes are
  available for critical paths. Survives server restart.

- **`get_attention_digest` and attention queue are functional.** Error and
  build-failure heuristics cover the most common patterns. Items accumulate
  correctly and are broadcast. The earcon fires reliably on new items
  (`App.tsx:564–573`).

- **`propose_command` Human-in-the-Loop gate works end-to-end.** The approval
  dialog shows command, pane summary, and voice utterance. Voice keywords
  ("go ahead", "approve") resolve the gate. The REST approval endpoint works for
  non-voice clients. Pending approvals are correctly purged on session close
  (`server.ts:1879–1884`).

- **`switch_context` returns a correct briefing to Janus.** The `getProjectBriefing`
  response includes live `PaneMeta` objects with `is_busy`, `alive`,
  `last_known_state`, `context_size`, `session_id`, and `permissions_mode`
  (`ledger.ts:197–209`). Janus has enough information to speak a useful summary.

- **`get_pane_summary` returns real terminal output.** The 100-line `outputBuffer`
  is a genuine ring-buffer of stripped stdout/stderr lines
  (`terminal.ts:279–283`). Markdown code block wrapping is correct
  (`terminal.ts:593–599`).

- **Watch rules provide a primitive parallel-coordination mechanism.** An operator
  can say "when pane A goes idle, run command X on pane B" and the one-shot watch
  rule fires reliably via `handleWatchRulesTrigger` (`server.ts:266–292`).

- **Audio earcons are differentiated by event type.** "alert" uses a sawtooth
  wave at 440 Hz; "execute" uses a square wave at 880 Hz; "chime" uses a sine
  wave — three distinct sounds (`App.tsx:73–151`). The half-duplex barge-in
  guard prevents audio loopback (`App.tsx:857–859`).

- **Multi-client broadcast is correct.** All WS clients in the `clients` Set
  receive every broadcast; per-session pending approvals are filtered by
  `details.session === session` to prevent cross-session leakage
  (`server.ts:1133`).
