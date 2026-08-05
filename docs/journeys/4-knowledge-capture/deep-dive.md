# Journey 4: Knowledge Capture & Continuity — Deep Dive

> ⚠️ **HISTORICAL — audited 2026-05-30, NOT maintained.** This deep-dive describes the code as it
> stood in May 2026. The voice/approval stack has since been rewritten: approval routing now lives
> in `src/voiceApprovalRouting.ts` + `src/gating/index.ts` (TTL → last-call → grace → expire,
> defer/hold, stop-all brake) behind the turn arbiter, and persistence is the SQLite `JanusStore`
> — **not** the `.janus_ledger.json` `Ledger`. **Verify every `file:line` citation against current
> code before acting on it.** The companion per-journey gap register (`gaps.md`) was retired on
> 2026-08-05; live defects are tracked in beads (`bd ready`). Context and retrieval instructions:
> [`docs/journeys/README.md`](../README.md).

> "Log decisions, rationale, and TODOs as notes while you work; on return, have Janus
> re-brief you from the project summary, notes, and recent history; and generate a
> hand-off for the next person (or your future self)."

---

## 1. Journey Overview & Trigger

The user wants a persistent, voice-accessible memory layer that survives session
restarts. The trigger pattern is any of:

- **Capture trigger**: mid-session insight ("Janus, note that we decided to use
  CommonJS output for the server bundle").
- **Return trigger**: opening the app after a gap ("Janus, brief me on the active
  project").
- **Hand-off trigger**: context switch to a new person or pane ("Janus, hand off
  context from pane-dev to pane-staging").

All three arms rely on the same data spine: the `Ledger` class (notes, workspace
metadata, command history), the `switch_context` briefing, and the
`handoff_context_between_panes` tool.

---

## 2. Current Flow (As Built)

### 2a. Capturing Notes by Voice

The user speaks a note-worthy observation. Janus calls one of two tools:

**`add_project_note`** — server.ts:1336-1341
```
manager.ledger.addNote(args.project_id, args.note)
```
Delegates to `Ledger.addNote` (src/ledger.ts:181-186), which pushes the raw string
onto `workspaces[projectId].notes[]` and calls `this.save(true)` (sync atomic write).

**`add_pane_note`** — server.ts:1342-1347
```
manager.ledger.addPaneNote(args.project_id, args.pane_id, args.note)
```
Delegates to `Ledger.addPaneNote` (src/ledger.ts:158-163), which pushes into
`workspaces[projectId].panes[paneId].notes[]` and persists synchronously.

The tool descriptions (server.ts:1633, 1644) are minimal: "Add a durable note to a
project" / "Add a durable note to a specific pane." There is no schema enforcement —
the `note` field is a free-form `Type.STRING`. Notes are untyped, untagged, and
unsorted. There is no timestamp on individual notes (notes are plain strings in the
`Workspace` and `PaneMeta` interfaces, src/types.ts:38-45 and 23-35).

Both notes and project-level REST paths are also exposed for UI-driven capture:
- `POST /api/projects/:id/notes` — server.ts:634-639
- `POST /api/projects/:projectId/panes/:paneId/notes` — server.ts:648-653

### 2b. Re-brief on Return: What switch_context Actually Assembles

When the user says "brief me on this project", Janus calls `switch_context`. The
server handler is at server.ts:1255-1266:

```typescript
manager.ledger.switchContext(projectId);          // sets activeProjectId, saves
manager.settings.projects.activeContext = projectId;
manager.settings.projects.localWorkspacePath = wsPath;
manager.saveSettings();
broadcastLedgerUpdate();
const briefing = manager.ledger.getProjectBriefing(projectId);
session.sendToolResponse({ functionResponses: [{ name, id: call.id, response: { output: briefing } }] });
```

The briefing payload is built by `Ledger.getProjectBriefing` (src/ledger.ts:197-209):

```typescript
return {
  project_id: ws.id,
  summary:    ws.summary,           // human-entered description string
  directory:  ws.directory,         // CWD for this workspace
  panes:      Object.values(ws.panes),  // all PaneMeta objects (including notes[])
  notes:      ws.notes,             // project-level notes array
  key_codebase_terms: ws.keyTerms || []
};
```

**What is included**: static project summary, notes array (raw strings, no
timestamps), directory path, key terms, and the full `PaneMeta` array (each pane
carries its own `notes[]`, `last_known_state`, `is_busy`, `alive` flags).

**What is NOT included**: live terminal screen content (that requires a separate
`get_pane_summary` call), command history (that requires `get_pane_command_history`),
watch rules, plans, or any synthesized narrative. The briefing is a raw data dump —
Janus must narrate it verbally from this JSON. There is no server-side prose
composition step.

The tool description at server.ts:1622 says: "Returns a fresh project briefing
(summary, directory, panes, notes)." This is accurate but undersells that Janus has
to do all the summarization work client-side (within the Gemini model's context
window).

### 2c. History Simplification on Return

When Janus calls `get_pane_command_history` (server.ts:1228-1248):

1. `HistoryManager.getInstance().loadHistory(targetId)` reads
   `.janus_history.json` (keyed by `terminalId`), capped at
   `historyMaxCommands` (default 50, server.ts:58-61).
2. Each raw `HistoryEntry` (command, timestamp, output) is reduced to a concise
   object:
   ```typescript
   { command, timestamp, finalResponse: entry.finalResponse || stripAnsiSequences(entry.output).slice(-300) }
   ```
3. The `finalResponse` field is populated asynchronously by `summarizeCommandOutcome`
   (server.ts:187-218), which calls `gemini-3.5-flash` with the last 3000 chars of
   raw output and a 1-2 sentence synthesis prompt. This is a **real LLM call** — the
   only actual AI summarization in the knowledge capture pipeline. It fires in the
   `manager.onIdle` callback (server.ts:220-246) once the pane returns to idle.

The history is stored in `.janus_history.json` (not `.janus_ledger.json`), meaning
it does **not** round-trip through the ledger and is not included in `getProjectBriefing`.
History and ledger notes are separate silos.

### 2d. Generating a Hand-off

**Via voice / Janus tool** — `handoff_context_between_panes` — server.ts:1516-1541:

1. Loads last 5 history entries from the source pane.
2. Formats them as `cmd -> finalResponse` joined with ` | `.
3. Builds a single string: `"Handoff from [source] with notes: <context_notes>. Last events: <lastFiveOutlines>"`.
4. Calls `manager.ledger.addPaneNote(activeProjectId, target_pane_id, handoffNote)` — saves the string as a pane note on the **target** pane.
5. Writes a shell comment block directly into the target terminal's stdin via `targetTerm.writeInput(commentCommand)`.

**Via UI** — `handleExecuteHandoff` in App.tsx:494-513, which calls
`POST /api/handoff` (server.ts:909-930). The REST handler is identical logic to the
tool handler above.

**Verdict on the hand-off**: `handoff_context_between_panes` does **not** produce a
structured hand-off document. It writes a bash comment block into the target pane's
stdin (which scrolls away immediately) and appends a single free-text note to the
target pane's ledger entry. There is no markdown file, no searchable doc, no
timestamped artifact. The "hand-off" is a transient stdin injection and a ledger
note — useful for priming an AI agent's context but not useful as a human-readable
record.

---

## 3. Ideal End-User Experience

A best-practice voice-first knowledge continuity session would feel like:

1. **During work** — The user says "Janus, note: we switched from ESM to CJS to fix
   the require issue." Janus confirms verbally and the note is stamped with a
   timestamp and optionally tagged (decision / TODO / warning / observation).

2. **Returning after a break** — The user says "Brief me." Janus:
   - States the project name, directory, last-active time.
   - Reads project-level notes in reverse-chronological order.
   - Summarizes last N commands across all panes (not per-pane lookup required).
   - Flags any panes that exited or errored since last session.
   - All without requiring the user to invoke multiple tools manually.

3. **Handing off** — The user says "Generate a hand-off for the pane." Janus
   produces a named, timestamped markdown document (or at minimum a durable ledger
   artifact) containing: what was done, decisions made, open TODOs, pane states,
   and recommended next steps. The document persists and is retrievable by the next
   operator.

---

## 4. Backend Support — Real vs. Thin

### Note Capture & Persistence (REAL)

- `Ledger.addNote` / `addPaneNote` — src/ledger.ts:181-186, 158-163.
- Persistence via atomic temp-file-rename write: src/ledger.ts:89-107 (async) and
  110-127 (sync). Notes survive process restarts.
- REST endpoints: server.ts:634-653. Both voice tool and REST paths are live and
  tested in tests/test_ledger.ts:36-50.
- **Limitation**: notes are plain `string[]` — no timestamp, no type/tag, no author
  field. The `Workspace` and `PaneMeta` types (src/types.ts:37-45, 23-35) do not
  carry per-note metadata.

### Briefing Assembly (THIN)

- `Ledger.getProjectBriefing` — src/ledger.ts:197-209.
- Returns a raw JSON object. No prose is assembled on the server. Janus synthesizes
  the verbal briefing from raw JSON in the Gemini context window.
- The `summary` field is whatever the user typed in ProjectDialog at creation time
  (ProjectDialog.tsx:178-185) — it is static, never auto-updated.
- Live terminal state (screen content) is deliberately excluded; the caller must
  follow up with `get_pane_summary` per pane. Command history is also excluded;
  caller must call `get_pane_command_history`.
- No synthesis, no diff from last session, no "what changed since you were last here"
  logic exists.

### History Simplification Engine (REAL, for single-pane retrieval)

- `HistoryManager` singleton — server.ts:41-129. Reads/writes `.janus_history.json`.
- Per-command AI summarization via `summarizeCommandOutcome` — server.ts:187-218.
  Uses `gemini-3.5-flash` with a 1-2 sentence outcome prompt. This is a **real
  secondary LLM call**, not mocked, triggered asynchronously on pane idle
  (server.ts:220-246).
- History is capped (default 50 commands, 5000 chars output) via
  `historyMaxCommands` / `historyMaxOutputLength` settings (src/types.ts:93-94).
- **Limitation**: history lives outside the ledger — not included in briefing, not
  searchable across projects, and cleared by `POST /api/terminals/:id/history/clear`.
  No cross-pane aggregate history view exists.

### System-Prompt Reconstruction on Session Resume (THIN)

- The `systemInstruction` is built inline at WebSocket connection time —
  server.ts:1568. It is a single template-string embedding:
  - `manager.ledger.activeProjectId`
  - `Object.keys(manager.ledger.workspaces)` with names
  - `Object.values(manager.terminals)` with status and CWD
- This runs once at Gemini Live session creation. There is no re-injection of notes,
  briefing content, history summaries, file trees, or watch rules into the system
  prompt. The design comment on server.ts:1568 says: "Always use switch_context to
  get the full project briefing when starting" — meaning the system prompt is
  intentionally minimal and Janus is expected to call `switch_context` itself.
- Session resumption tokens are stored in `lastSessionResumptionToken`
  (server.ts:1030, 1078-1080) and passed back on reconnect (server.ts:1570), which
  lets Gemini restore its conversation context window — but this token is in-memory
  only and lost on server restart. After a restart, the full session context is
  gone; only the persisted ledger and history files remain.
- JOURNEYS_DESIGN.md §4 claims "system instruction is reconstructed dynamically with
  available workspaces, file trees, notes, and the live status indicators." The file
  trees and notes claim is inaccurate — neither file tree nor notes content appears
  in the system instruction at server.ts:1568. Only workspace IDs/names and terminal
  status/CWD are injected.

### Handoff (THIN)

- `handoff_context_between_panes` — server.ts:1516-1541.
- Takes last 5 history entries, concatenates as `cmd -> outcome`, and:
  1. Saves a single pane note on the target pane (ledger note, persists).
  2. Writes a bash comment block to the target pane's stdin (transient, scrolls off).
- No structured document. No markdown artifact. No timestamped record beyond the
  single ledger note. The note has no special type or tag to distinguish it from
  regular notes.
- REST equivalent: server.ts:909-930 (identical logic).

---

## 5. UI Support

### Project Notes
- **Left sidebar** — project listing at App.tsx:2510-2535. For the active project,
  notes render inline below the project name as a cyan-tinted list (App.tsx:2528-2535).
- **"Note" button** per project — App.tsx:2522. Triggers `handleAddProjectNote`
  (App.tsx:1257-1267), which opens the `GenericPromptModal` text input and POSTs to
  `/api/projects/:id/notes`.
- **Summary and key terms** also render for the active project — App.tsx:2540-2553.

### Pane Notes ("Node Chronicle")
- **Right pane detail panel** — App.tsx:3372-3408. Each pane has a "Node Chronicle"
  section showing its notes with a scrollable list capped at `max-h-24`.
- **Inline note input** with Enter-key shortcut — App.tsx:3392-3407. Calls
  `handleAddPaneNoteInline` (App.tsx:1293-1303) which POSTs to
  `/api/projects/:projectId/panes/:paneId/notes`.
- **Modal note button** per pane in the sidebar — App.tsx:2619-2621 shows pane notes
  inline for the active pane.

### Handoff UI
- **Synergy Console — Section 3 "Terminal-To-Terminal Context Bridge"** —
  App.tsx:1969-2028. Dropdown source/target pane selectors, a free-text "Focus
  Instructions" textarea, and "Inject Bridge Context Data" button. Button calls
  `handleExecuteHandoff` (App.tsx:494-513), which POSTs to `/api/handoff`.
- Requires at least 2 active panes; a warning renders if fewer (App.tsx:1976-1979).

### History Panel
- **History side panel** triggered from the UI via `showHistoryPanel` state —
  `fetchActiveTerminalHistory` at App.tsx:234-245 calls
  `GET /api/terminals/:id/history`. The list is displayed with command and timestamp
  fields only (App.tsx:42, historyList state). This is a UI-only read panel; notes
  cannot be created from it.

### Project Dialog (creation/editing)
- ProjectDialog.tsx handles project creation and editing. Fields: ID, name, directory,
  summary (textarea), key terms (comma-separated). **No notes field** — notes can
  only be added after project creation via the sidebar button or voice.

---

## 6. Future-State Best-in-Class

### Structured Note Schema
Currently notes are `string[]`. A best-in-class implementation would use typed note
objects:
```typescript
interface Note {
  id: string;
  text: string;
  timestamp: string;
  type: "decision" | "todo" | "warning" | "observation" | "handoff";
  author: "janus" | "user";
  paneId?: string;   // if pane-scoped
}
```
This enables filtering ("show only decisions"), sorting, and voice queries like
"what TODOs do I have for this project?".

### Timestamped Decision Log
A searchable, filterable decision log scoped to a project, surfacing the most recent
N entries on `switch_context` automatically. Would require changes to `Ledger`,
`getProjectBriefing`, and a new `/api/projects/:id/decisions` endpoint.

### Auto-Summarization of the Re-brief
`getProjectBriefing` returns raw JSON that Janus must narrate. The server should
optionally call `gemini-flash` (as it already does for command outcomes) to produce
a 3-5 sentence project status narrative cached per session, refreshed when notes or
history change. This would reduce latency and make the re-brief deterministic and
testable.

### Notes Injected into System Prompt
The `systemInstruction` at server.ts:1568 should optionally include the active
project's most recent N notes so Janus has decision context without requiring a
`switch_context` round-trip. This addresses the inaccuracy in JOURNEYS_DESIGN.md §4
which describes but does not implement notes in the system prompt.

### Structured Hand-off Document
`handoff_context_between_panes` should produce a named, persisted artifact (e.g., a
file in the project directory or a `handoffs[]` array in the ledger workspace)
containing: timestamp, source/target panes, last N command outcomes, project notes
at the time of handoff, and operator-provided context. The current stdin comment
injection should be retained as a bonus but not be the primary artifact.

### Cross-Session Continuity Summary
On server startup, if `.janus_history.json` and `.janus_ledger.json` exist, the
server could pre-generate a "session gap" summary via `gemini-flash`: "Since your
last session [N hours ago] on project X, pane Y ran these commands and pane Z
exited." This could be injected into the system prompt or spoken automatically when
the first WebSocket client connects.

### Required Capabilities for Best-in-Class
| Capability | Current State | Gap |
|---|---|---|
| Typed, timestamped notes | Plain `string[]` | Schema change to `Ledger`, `types.ts` |
| Notes in system prompt | Not injected | Template change in server.ts:1568 |
| Briefing prose synthesis | Raw JSON only | New Gemini call in `getProjectBriefing` or `switch_context` handler |
| Cross-pane aggregate history | Per-pane only | New `HistoryManager.loadAllHistory()` |
| Structured handoff doc | Transient stdin comment | New `handoffs[]` in `Workspace`, write to file |
| Session-gap summary | Not present | Server-start synthesis using history + ledger delta |
| Searchable note query | Not present | New tool `search_notes` + text index |
