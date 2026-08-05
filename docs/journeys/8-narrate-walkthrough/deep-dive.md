# Journey 8: Narrate a Terminal Walk-through — Deep Dive

> ⚠️ **HISTORICAL — audited 2026-05-30, NOT maintained.** This deep-dive describes the code as it
> stood in May 2026. The voice/approval stack has since been rewritten: approval routing now lives
> in `src/voiceApprovalRouting.ts` + `src/gating/index.ts` (TTL → last-call → grace → expire,
> defer/hold, stop-all brake) behind the turn arbiter, and persistence is the SQLite `JanusStore`
> — **not** the `.janus_ledger.json` `Ledger`. **Verify every `file:line` citation against current
> code before acting on it.** The companion per-journey gap register (`gaps.md`) was retired on
> 2026-08-05; live defects are tracked in beads (`bd ready`). Context and retrieval instructions:
> [`docs/journeys/README.md`](../README.md).

**OrbitalVoiceRunner / Janus — Secondary Journey**

---

## 1. Journey Overview & Trigger

**Summary:** The operator asks Janus (audio only, no vision) to read a pane's recent terminal output aloud, then dictates one or more notes for changes that need to be made. The output of the journey is a spoken summary plus a set of durable, persisted notes attached either to the pane or to its parent project.

**Trigger conditions:**

- Operator says something like: *"Janus, walk me through what pane `build-pane` has been doing"* or *"Summarise the last output of `api-server` and let me add some notes."*
- Can be invoked at any point during a session: after a build finishes, while reviewing a running agent, or as a retrospective after a long task.
- No approval, no command execution, and no vision are required. This is a fully read-only, observe-and-dictate interaction.

**Modality constraint:** Janus receives audio only (16 kHz PCM frames via WebSocket `/live` — `README.md` lines 27–28). Its only window into terminal state is the tool surface; it cannot see the xterm canvas rendered in the browser.

---

## 2. Current Flow (As Built) — Step-by-Step

### Step 1 — Audio arrives at the server

The browser captures mic PCM and streams it over the `/live` WebSocket (`server.ts` line 14 / `README.md` line 27). The Node server forwards each audio frame directly to a Gemini Live session (`server.ts` ~line 800–850, standard `session.sendRealtimeInput` pattern).

### Step 2 — Gemini emits a `get_pane_summary` tool call

Janus interprets the operator's spoken request and emits a structured function call for `get_pane_summary`. The tool is declared to the model at `server.ts` lines 1610–1619:

```
name: "get_pane_summary",
description: "Return the clean, redacted markdown delta of one pane's recent
              screen activity. Primary observation path. Pull, not push.",
parameters: { pane_id: { type: STRING } }
```

The model description uses the words *"clean, redacted markdown delta"* — this is the description given to the model. Whether the implementation honours those words is examined in Section 4.

### Step 3 — Server dispatches `getPaneSummary`

The tool call handler at `server.ts` lines 1249–1254:

```typescript
} else if (name === "get_pane_summary") {
  const targetId = args.pane_id;
  const out = manager.getPaneSummary(targetId);
  session.sendToolResponse({
    functionResponses: [{ name, id: call.id, response: { output: out } }]
  });
}
```

`manager.getPaneSummary` is defined in `src/terminal.ts` lines 593–599:

```typescript
getPaneSummary(paneId: string, limit = 20) {
  if (!this.terminals[paneId]) {
    return `Error: Pane ${paneId} does not exist.`;
  }
  const recentOut = this.terminals[paneId].getRecentOutput(limit);
  return `\`\`\`\n${recentOut || "[No new output]"}\n\`\`\``;
}
```

`getRecentOutput` is defined in `src/terminal.ts` lines 324–326:

```typescript
getRecentOutput(linesCount = 10): string {
  return this.outputBuffer.slice(-linesCount).join('\n');
}
```

`outputBuffer` is populated on every stdout/stderr data event at `src/terminal.ts` lines 279–283:

```typescript
const cleanLines = stripAnsiSequences(decoded).split(/\r?\n/).filter((l: string) => l.trim() !== '');
this.outputBuffer.push(...cleanLines);
if (this.outputBuffer.length > this.maxBufferLines) {
  this.outputBuffer.splice(0, this.outputBuffer.length - this.maxBufferLines);
}
```

The buffer holds at most `maxBufferLines` lines (default `100`, configurable via `settings.advanced.maxBufferLines` — `src/terminal.ts` line 68 / `OrchestratorManager.getDefaultSettings` line 422). `getPaneSummary` slices the last 20 lines from that buffer and wraps them in a markdown code fence.

### Step 4 — Janus speaks the content aloud

The tool response travels back to the Gemini Live model as a `functionResponse`. Gemini synthesises audio from it and emits PCM frames. The server relays those frames to the browser client over the `/live` WebSocket (`server.ts` ~line 870–900 audio relay block). The browser's `playAudioChunk` function in `src/utils/audio.ts` queues and plays them. The operator hears Janus narrating the last 20 lines of the pane's recent output.

### Step 5 — Operator dictates a note

Operator says: *"Note: the build is failing on the TypeScript strict-null check in `auth.ts` — needs a fix before merging."*

### Step 6 — Janus emits `add_pane_note` or `add_project_note`

The relevant tool declarations are at `server.ts` lines 1644–1655 (`add_pane_note`) and lines 1632–1642 (`add_project_note`).

Handler at `server.ts` lines 1342–1347:

```typescript
} else if (name === "add_pane_note") {
  manager.ledger.addPaneNote(args.project_id, args.pane_id, args.note);
  broadcastLedgerUpdate();
  session.sendToolResponse({
    functionResponses: [{ name, id: call.id, response: { output: `Note added to pane ${args.pane_id}` } }]
  });
}
```

`addPaneNote` in `src/ledger.ts` lines 158–163:

```typescript
addPaneNote(projectId: string, paneId: string, note: string) {
  if (this.workspaces[projectId] && this.workspaces[projectId].panes[paneId]) {
    this.workspaces[projectId].panes[paneId].notes.push(note);
    this.save(true);
  }
}
```

The note string is the raw text Janus transcribed from the operator's speech. It is pushed to `PaneMeta.notes: string[]` (`src/ledger.ts` line 12) and written synchronously to `.janus_ledger.json` via atomic rename (`src/ledger.ts` lines 110–127).

`add_project_note` follows an identical pattern via `Ledger.addNote` (`src/ledger.ts` lines 181–186), appending to `Workspace.notes: string[]`.

### Step 7 — UI refreshes

`broadcastLedgerUpdate()` sends a `ledger_updated` WebSocket message to all connected browser clients. `App.tsx` line 897–898 picks this up and calls `setLedger(msg.ledger)`, which triggers a React re-render. Pane notes are visible in the left sidebar under the pane listing (`App.tsx` lines 2619–2622) and in the right "buffer" panel note list (`App.tsx` lines 3381–3389).

### Step 8 — Repeat as needed

The operator can continue: *"Also note for the project: we need to upgrade the TypeScript target to ES2022."* → Janus calls `add_project_note`. Multiple notes can be dictated in a single session turn.

---

## 3. Ideal End-User Experience

The operator, working hands-free and eyes-off, should be able to:

1. Say *"Walk me through what `build-pane` has been doing"* with zero prior setup.
2. Hear a coherent, human-readable spoken narration — not a raw log dump — covering what happened, what succeeded, and what failed.
3. Naturally interrupt or continue with *"Add a note: ..."* and have the note persisted without leaving the voice flow.
4. Be notified by an earcon (like the chimes in `App.tsx` `playEarcon`) when the note is saved.
5. Later retrieve those notes by asking *"What notes are on `build-pane`?"* — answered from the briefing returned by `switch_context` or inferred from `list_panes`.

The key gap between this ideal and the current build is in Step 2: what the operator hears is whatever Gemini makes of 20 raw log lines. There is no structured pre-processing that isolates errors, highlights exit codes, or produces a semantic diff.

---

## 4. Backend Support — Actual Behavior vs. Design Doc Claims

### 4a. What `get_pane_summary` actually returns

**Verdict: raw, ANSI-stripped, line-capped stdout — not redacted, not analyzed, not a "delta".**

The full call chain is:

```
getPaneSummary(paneId, limit=20)           // src/terminal.ts:593
  └── getRecentOutput(20)                  // src/terminal.ts:324
        └── outputBuffer.slice(-20).join('\n')
```

`outputBuffer` is populated by stripping ANSI escape sequences from raw stdout/stderr at `src/terminal.ts` lines 279–283 using `stripAnsiSequences` (`src/terminal.ts` lines 56–60). The only processing applied is:

- ANSI escape sequence removal (colour codes, cursor movement).
- Blank line filtering.
- A hard cap of `maxBufferLines` (default 100) on the ring buffer.
- A `limit` parameter slicing the last N lines (default 20 for Janus, 5 for the `propose_command` rationale snapshot at `server.ts` line 1322).

**There is no redaction of secrets or paths.** There is no semantic summarisation, no error highlighting, no diff computation, and no second model pass. The string is wrapped in a markdown code fence and handed directly to Gemini as a tool response.

### 4b. Verification of the JOURNEYS_DESIGN.md claim

`JOURNEYS_DESIGN.md` lines 112–113 states, in the Secondary Journeys table:

> **Narrate Terminal Walk-through** | `get_pane_summary` | **Redacted terminal visual logs are analyzed and spoken back to notes.**

This claim is false on both counts:

| Claim | Reality |
|---|---|
| "Redacted" | No redaction logic exists anywhere in `getPaneSummary`, `getRecentOutput`, or the `stripAnsiSequences` utility. |
| "Analyzed" | No analysis, no NLP pass, no model-side pre-processing. The raw line slice is returned directly. |
| "spoken back to notes" | Notes are dictated by the operator. Janus speaks the summary, but it is not automatically converted to a note — the operator must explicitly dictate one. |

Furthermore, the tool description registered with the Gemini model at `server.ts` line 1611 calls the output a *"clean, redacted markdown delta"*. This description is aspirational rather than descriptive of what the function produces.

### 4c. Note capture — real and functional

Both `add_pane_note` and `add_project_note` are fully implemented:

- Tool handler: `server.ts` lines 1336–1347.
- Ledger persistence: `src/ledger.ts` lines 158–163 (`addPaneNote`) and 181–186 (`addNote`).
- Atomic file write with temp-rename: `src/ledger.ts` lines 89–107 (`flushSave`) and 110–127 (`flushSaveSync`).
- REST endpoints (usable by UI): `server.ts` lines 634–639 (project notes) and 648–653 (pane notes).
- UI display: `App.tsx` lines 2528–2533 (project notes in sidebar), 2619–2622 (pane notes in sidebar), 3381–3389 (pane notes in buffer panel), 3395 (inline note input field).

Note capture is real, not mocked or stubbed.

### 4d. Test coverage

`tests/test_journeys.ts` covers Journey 4 (knowledge capture / notes) at lines 160–180 and validates `addNote`, `addPaneNote`, and `getProjectBriefing` against the ledger. There is **no dedicated test for Journey 8** (narrate walk-through). `get_pane_summary` is not exercised in any test file.

---

## 5. UI Support

### Terminal output rendering (`src/components/TerminalView.tsx`)

`TerminalView` receives a raw `output: string` prop (`TerminalView.tsx` line 8) and writes it incrementally to an xterm.js instance (`TerminalView.tsx` lines 62–63, 145–159). Raw ANSI sequences including colour codes are passed through to xterm, which renders them natively. This means the browser terminal shows coloured, formatted output — but `get_pane_summary` strips ANSI before returning the text to Janus. The spoken narration therefore loses colour/bold cues; Janus only sees plain text.

### Live stdout streaming

`App.tsx` line 915–916 handles `stdout_chunk` WebSocket messages and calls `queueStdoutChunk`, which appends raw bytes to the active terminal's display buffer. This is separate from `outputBuffer` in the server and is UI-only — it does not affect what `get_pane_summary` returns.

### Notes display

Pane notes from the ledger are rendered in two places:

- Left sidebar pane card: `App.tsx` lines 2619–2622, shown when the pane is the active pane in the active project.
- Right panel "Buffer" tab, pane detail section: `App.tsx` lines 3372–3395, including an inline text input for manual note entry (`App.tsx` lines 3393–3395).

Project notes are rendered in the sidebar project card at `App.tsx` lines 2528–2533.

There is **no dedicated "walk-through narration" UI panel.** There is no visual indicator that a narration is in progress, no highlighted diff view of which lines Janus summarised, and no automatic transcript-to-note conversion.

### Transcript panel

`App.tsx` lines 39 / 917–921 / 3618–3632 implement a transcript panel that records `sender: "User" | "Janus"` turns. This is a read-only history of conversation text, not connected to note creation. An operator reviewing the transcript must manually trigger note capture by speaking to Janus.

---

## 6. Future-State Best-in-Class

### What best-in-class looks like

A production-grade voice-driven narration walk-through would have the following capabilities, none of which currently exist in this codebase:

**A. Semantic error/warning extraction before returning to the model**

Pre-process the raw output buffer server-side: detect lines matching common error patterns (`error:`, `FAILED`, non-zero exit codes, stack trace shapes, `WARNING`). Return a structured object — `{errors: [], warnings: [], exit_code: null, last_command: "..."}` — rather than a flat text blob. This makes the spoken summary precise and actionable rather than a re-reading of raw log noise.

**B. Delta / diff mode**

Track a `lastSummarisedLine` cursor per pane. On each `get_pane_summary` call, return only lines appended since the last call. This prevents Janus from re-narrating the same output when the operator asks for an update, and is what the current tool description (falsely) calls a "delta."

**C. Redaction layer**

Before returning the content to Gemini, scan for patterns matching secrets: AWS key shapes, JWT tokens, private key headers, `.env` values. Mask or omit them. This is the "redacted" behaviour described in the tool declaration and design doc but absent from code.

**D. Structured change-note generation**

After summarising output, Janus should be able to propose a draft note based on what it found — *"It looks like the build failed on a TypeScript error. Should I add a note: 'Build broken — strict null check in auth.ts'?"* — and the operator can confirm or amend by voice. This closes the loop between observation and note capture.

**E. Multi-turn narration with operator annotation**

Allow the operator to interrupt mid-narration with corrections: *"Stop — note that last error."* The model would need a `pause_narration` or `annotate_current_line` tool that writes a note referencing the specific line being discussed.

**F. Earcon confirmation on note save**

`App.tsx` already implements `playEarcon` with four tones (alert, success, execute, chime — lines 73–121). Currently there is no earcon triggered when a voice-dictated note is saved. Adding a `"chime"` earcon on successful `add_pane_note` / `add_project_note` tool responses would close the feedback loop for eyes-off operation.

**G. Scrollback search**

`UniversalTerminal` persists a scrollback file `.janus_scrollback_<id>.log` up to 512 KB (`src/terminal.ts` lines 204–218). `get_pane_summary` only reads the in-memory `outputBuffer` (last 100 lines). A `search_pane_output` tool that queries the scrollback file by keyword or time range would enable *"find the last time this pane showed an error"* queries.

### Required capabilities for best-in-class

| Capability | What needs to be added |
|---|---|
| Semantic error extraction | Server-side pre-processor in `getPaneSummary` or a new `get_pane_errors` tool |
| Delta tracking | Per-pane `lastSummaryIndex` cursor in `UniversalTerminal` or `OrchestratorManager` |
| Redaction | Regex/pattern scan before tool response assembly in the `get_pane_summary` handler |
| Draft-note proposal | Model system-prompt guidance + new `propose_pane_note` tool that holds for operator confirmation |
| Earcon on note save | Single `playEarcon("chime")` call on `ledger_updated` when source is a note operation |
| Scrollback search | New `search_pane_output` tool reading `.janus_scrollback_<id>.log` |
| Journey 8 test | Test exercising `getPaneSummary` + `addPaneNote` sequence in `tests/test_journeys.ts` |

---

*File citations: `server.ts` lines 1249–1254, 1336–1347, 1610–1619; `src/terminal.ts` lines 56–60, 68, 279–283, 324–326, 593–599; `src/ledger.ts` lines 12, 158–163, 181–186; `src/App.tsx` lines 39, 897–898, 915–916, 917–921, 1262, 1281–1291, 2528–2533, 2619–2622, 3381–3395; `src/components/TerminalView.tsx` lines 8, 62–63, 145–159; `JOURNEYS_DESIGN.md` lines 112–113.*
