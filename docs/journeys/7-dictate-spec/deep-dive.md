# Journey 7: Dictate a Specification from Knowledge — Deep-Dive

> ⚠️ **HISTORICAL — audited 2026-05-30, NOT maintained.** This deep-dive describes the code as it
> stood in May 2026. The voice/approval stack has since been rewritten: approval routing now lives
> in `src/voiceApprovalRouting.ts` + `src/gating/index.ts` (TTL → last-call → grace → expire,
> defer/hold, stop-all brake) behind the turn arbiter, and persistence is the SQLite `JanusStore`
> — **not** the `.janus_ledger.json` `Ledger`. **Verify every `file:line` citation against current
> code before acting on it.** The companion per-journey gap register (`gaps.md`) was retired on
> 2026-08-05; live defects are tracked in beads (`bd ready`). Context and retrieval instructions:
> [`docs/journeys/README.md`](../README.md).

**Classification:** Secondary Journey  
**Primary tools:** `add_project_note`, `add_pane_note`  
**Modality constraint:** Audio-only input (16 kHz PCM). No vision. Content is terminal output, not screen pixels.

---

## 1. Journey Overview & Trigger

The operator holds a requirement, architectural decision, or constraint in their head and wants to make it durable without switching to a keyboard or a separate notes app. In OrbitalVoiceRunner's hands-free model, the trigger is simply speaking the requirement aloud while Janus is live.

The journey fires in two distinct postures:

- **Ambient capture** — the operator is already talking to Janus for another reason (e.g., delegating a task) and incidentally dictates a spec fragment. Every spoken utterance is auto-logged to the in-memory prompt buffer with no explicit command needed.
- **Deliberate ledger commit** — the operator explicitly asks Janus to "note that …" or "add this to the project notes". Janus responds by calling `add_project_note` or `add_pane_note`, writing the note durably to `.janus_ledger.json`.

These two paths use different storage backends and have very different retrieval properties (see §4).

---

## 2. Current Flow (As Built)

### 2a. Ambient capture — the prompt buffer

Every user utterance transcribed by Gemini Live is appended as a Markdown bullet to an in-memory string `promptBufferText` (server.ts:133–137). The append logic runs unconditionally on any utterance longer than two characters:

```
// server.ts:1117–1124
const cleanUtter = userUtterance.trim();
if (cleanUtter.length > 2) {
  promptBufferText += `\n* **User Dictation**: ${cleanUtter}`;
  broadcast({ type: "prompt_buffer_updated", text: promptBufferText });
}
```

Janus's own spoken responses are similarly appended (server.ts:1198–1204):

```
promptBufferText += `\n* **Agentic Thought**: *${cleanUtter}*`;
```

The buffer is **not persisted to disk**. It is an in-memory `let` variable (server.ts:133) that resets on server restart. Clients receive it synchronously on WebSocket connect (server.ts:1046–1049) and on every update via a `prompt_buffer_updated` broadcast. A REST `GET /api/prompt-buffer` serves the current state (server.ts:933–935).

**No structuring, summarization, or deduplication is applied.** Every utterance, regardless of content, is appended verbatim with a bold label prefix.

### 2b. Deliberate ledger commit — `add_project_note` / `add_pane_note`

When Janus decides (or is explicitly directed) to call the note tools, the tool handler path is:

1. Gemini Live emits a `toolCall` frame with `name === "add_project_note"` or `name === "add_pane_note"` and an `args.note` string containing the spoken text (server.ts:1336–1347).
2. The handler calls `manager.ledger.addNote(args.project_id, args.note)` or `manager.ledger.addPaneNote(args.project_id, args.pane_id, args.note)`.
3. `Ledger.addNote` (src/ledger.ts:181–186) pushes the raw string onto `workspace.notes[]`.  
   `Ledger.addPaneNote` (src/ledger.ts:158–163) pushes the raw string onto `workspace.panes[paneId].notes[]`.
4. Both methods call `this.save(true)` — a synchronous atomic write via a `.tmp` rename to `.janus_ledger.json` (src/ledger.ts:110–127).
5. `broadcastLedgerUpdate()` pushes a `ledger_updated` WebSocket event so the React UI re-renders immediately (server.ts:1338, 1344).
6. A tool response `{ output: "Note added to project …" }` is sent back to Gemini so it can speak a confirmation.

**No structuring or formatting is applied to the note string.** The raw transcribed text from `args.note` is stored as-is. There is no summarization, tagging, timestamp injection, or schema enforcement at the server layer.

The tool schema (server.ts:1632–1654) accepts only `project_id`, `pane_id` (for pane notes), and `note` — all strings with no additional metadata fields.

### 2c. REST path for UI-typed notes

The same ledger append is reachable via REST for keyboard-typed notes from the UI:

- `POST /api/projects/:id/notes` (server.ts:634–639) calls `ledger.addNote`.
- `POST /api/projects/:projectId/panes/:paneId/notes` (server.ts:648–653) calls `ledger.addPaneNote`.

### 2d. "Sync Note" button — buffer-to-ledger bridge

`handleSyncNoteToActiveNode` (src/App.tsx:222–232) takes the first 100 characters of the prompt buffer, prepends the label `"Requirement Spec Captured: "`, and POSTs to the pane notes endpoint. This is the only bridge between the ephemeral buffer and the durable ledger. It is keyboard/click-only — no voice equivalent exists.

### 2e. Retrieval path

Notes re-enter the Gemini context via `getProjectBriefing` (src/ledger.ts:197–209), which is called inside the `switch_context` tool handler to reconstruct the system prompt with `notes: ws.notes` and per-pane `notes: paneMeta.notes`. This means dictated notes surface to Janus automatically the next time the operator switches to that project, not continuously within the same session unless the operator explicitly asks.

---

## 3. Ideal End-User Experience

The operator is heads-down, hands-off. The ideal experience is:

1. **Speak naturally** — "Janus, note: the auth service must support PKCE, not implicit flow. Tag it security-critical." Janus responds with a spoken confirmation.
2. **Structured capture** — the note is stored with a timestamp, a category tag ("security-critical"), and attribution to the project or pane the operator is currently focused on, without the operator having to specify IDs.
3. **Instant retrieval by voice** — "Janus, what security notes do I have on the auth service?" returns a spoken list drawn from the ledger.
4. **Spec continuity** — when the operator returns to the workspace after a restart, Janus opens the briefing and mentions "You have 3 spec notes, including one marked security-critical."
5. **No silent loss** — if the server restarts, dictated specs are not lost. The prompt buffer is a risk surface; durable notes are not.
6. **Edit and retract by voice** — "Remove the last note on the auth pane" or "Correct note 2: change PKCE to PKCE and MTLS."

---

## 4. Backend Support

### Note persistence (REAL, fully implemented)

| Layer | What happens | File:line |
|---|---|---|
| `Ledger.addNote` | Pushes raw string to `workspace.notes[]`, calls `save(true)` | src/ledger.ts:181–186 |
| `Ledger.addPaneNote` | Pushes raw string to `pane.notes[]`, calls `save(true)` | src/ledger.ts:158–163 |
| Atomic write | JSON serialized via `.tmp` rename to `.janus_ledger.json` | src/ledger.ts:110–127 |
| `add_project_note` tool handler | Calls `ledger.addNote`, broadcasts, responds to model | server.ts:1336–1341 |
| `add_pane_note` tool handler | Calls `ledger.addPaneNote`, broadcasts, responds to model | server.ts:1342–1347 |
| Retrieval into context | `getProjectBriefing` returns `notes[]` for system-prompt reconstruction | src/ledger.ts:197–209 |
| REST note append | `POST /api/projects/:id/notes` and `POST /api/projects/:projectId/panes/:paneId/notes` | server.ts:634–653 |

**Storage format:** Plain string array. No timestamps, no tags, no categories, no author attribution. Example stored value: `"Decision: use Python 3.11"`.

**Tests (REAL, implemented):** `test_ledger.ts:36–50` verifies `addNote` persistence across Ledger re-instantiation. `test_journeys.ts:160–180` (Journey 4) tests `addNote` and `addPaneNote` and verifies both appear in `getProjectBriefing`.

### Prompt buffer (IN-MEMORY ONLY — not durable)

The `promptBufferText` variable (server.ts:133) is a module-level `let`. Every utterance is appended with no structuring beyond a bold Markdown label (server.ts:1120, 1200). The buffer:

- Survives as long as the Node process is alive.
- Is broadcast to all clients on connect (server.ts:1046–1049) and on every change.
- Has a REST GET/PUT API (server.ts:933–949).
- Is **not written to `.janus_ledger.json`** and is **not included in `getProjectBriefing`**.
- Has no size cap or rotation — it grows unboundedly until server restart.

The "Sync Note" button in the UI (src/App.tsx:222–232) is the only mechanism to promote a buffer fragment to a durable ledger note, and it truncates to 100 characters, losing most of a long dictation.

### What is genuinely missing at the backend level

- No timestamp injection on any note storage path.
- No category, severity, or tag fields on the `Workspace.notes[]` or `PaneMeta.notes[]` arrays (src/types.ts:37–45, src/ledger.ts:4–16).
- No deduplication or summarization step.
- No voice-triggered "save buffer to ledger" path — only the click-driven `handleSyncNoteToActiveNode`.
- No note deletion or amendment tool.
- Notes are not returned in `list_panes` output; they only surface via `switch_context` / `getProjectBriefing`.

---

## 5. UI Support

### Prompt buffer panel ("Sync Spec" tab)

The right-hand helper panel's "Sync Spec" tab (src/App.tsx:1591–1656) renders `promptBufferText` as Markdown via `MiniMarkdown`. It supports:

- A read-only preview mode and an editable textarea mode (src/App.tsx:1598–1615).
- A `+ Task` macro button inserting `\n- [ ] ` (src/App.tsx:1621–1626).
- A `Template` macro button that stamps a hardcoded requirements checklist template string into the buffer (src/App.tsx:1628–1633). This is a static string, not a configurable template.
- A `Sync Note` button (src/App.tsx:1639–1645) that calls `handleSyncNoteToActiveNode` — appends a truncated buffer excerpt to the active pane's notes in the ledger.
- A `Clear` button (src/App.tsx:1647–1651) that wipes the buffer.

The panel is labeled "Shared Spec Sandbox" (src/App.tsx:1593) and described as being read by Janus in real-time — this is accurate for the same session but misleading across restarts since the buffer is not persisted.

### Ledger notes in the sidebar

**Project notes** appear as a bordered bulleted list beneath the active project's header in the left sidebar, rendered only when `activeProjectId === project.id` and `project.notes.length > 0` (src/App.tsx:2528–2535). Each note is a raw `<span>` with no timestamp or edit control.

A "Note" button per project (src/App.tsx:2522) opens a `GenericPromptModal` (src/App.tsx:1311–1334) — a single text input that POSTs to `/api/projects/:id/notes`. This is keyboard-only.

**Pane notes** appear in the right-side pane detail card under the label "Node Chronicle" (src/App.tsx:3372–3408). The panel shows a scrollable list of raw note strings, a count badge, and an inline text input with an Enter-key/plus-button submit (src/App.tsx:3392–3406). Voice-typed notes (via `add_pane_note`) appear here via the `ledger_updated` WebSocket push. The display is read-only with no edit or delete controls per note.

Notes in pane sidebar list (compact view) are shown as small text below the pane row label (src/App.tsx:2619–2622) when the pane is active.

---

## 6. Future-State Best-in-Class

### What best-in-class voice spec capture looks like

**Structured capture with typed fields.** Rather than a raw string, each note should carry: timestamp (ISO 8601), category (e.g., `requirement`, `decision`, `constraint`, `risk`, `todo`), severity/priority, source (voice vs. typed vs. imported), and an optional reference tag linking to a pane or command in history. The `Workspace.notes[]` type (src/types.ts:40) and `PaneMeta.notes[]` (src/types.ts:32) would need to change from `string[]` to a structured `NoteEntry[]`.

**Contextual auto-attachment.** When the operator dictates a note while a specific pane is active (i.e., `activeTerminalId` is set), the note should default to `add_pane_note` targeting that pane, not `add_project_note`, with no ID disambiguation required from the operator.

**Voice-triggered buffer flush.** A phrase like "Janus, commit the spec buffer to notes" should call `add_project_note` with the full current `promptBufferText` content — not a 100-character truncation. The buffer should also have a configurable auto-flush interval (e.g., every 10 minutes of silence) to prevent silent loss on server restart.

**Prompt buffer persistence.** `promptBufferText` should be saved to `.janus_ledger.json` (or a sidecar file) on every mutation, the same way note arrays are. Alternatively, promote it to a first-class ledger field alongside `notes[]`.

**Edit and retract by voice.** New tools `delete_project_note` and `delete_pane_note` (by index or by content match) and `amend_note` would allow the operator to correct a dictated note without using a keyboard. The current tool surface has no amendment or deletion capability for notes.

**Template system for spec capture.** The hardcoded "Requirements Specification Checklist" template string (src/App.tsx:1628–1633) should become a configurable templates registry, callable by voice: "Janus, start a security review spec" or "Janus, open the API design template." Templates would be stored in settings or the ledger and rendered with contextual variable substitution (project name, active pane, current date).

**Briefing-time note surfacing.** `getProjectBriefing` (src/ledger.ts:197–209) should include per-note metadata so Janus can speak "You have 2 security-critical requirements and 1 open decision from your last session" rather than a flat dump.

**Export by voice.** "Janus, export the spec notes for this project as Markdown" should produce a downloadable `.md` file or copy the structured note set to the prompt buffer for review and export. No export capability exists today.

### Required capabilities not yet present

| Capability | Needed change |
|---|---|
| Structured note schema (timestamp, category, priority) | Extend `PaneMeta.notes` and `Workspace.notes` types in src/types.ts and src/ledger.ts |
| Voice-triggered full buffer commit to ledger | New server.ts utterance pattern match or explicit tool invocation path |
| `delete_note` / `amend_note` tools | New tool definitions in server.ts tool list (near line 1632) and ledger methods |
| Prompt buffer persistence across restarts | Add `promptBufferText` to ledger JSON schema and save on every mutation |
| Configurable spec templates | Template registry in settings or ledger; callable via voice |
| Note export (Markdown / clipboard) | REST endpoint + optional voice trigger |
| Note search by voice | New `search_notes` tool or extension of `get_attention_digest` |
| Contextual auto-attachment to active pane | Inject `activeTerminalId` context into `add_project_note` decision logic in server.ts |
