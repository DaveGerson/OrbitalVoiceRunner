# Orbital Harness — Janus Terminal Orchestrator

A web-based, voice-controlled orchestrator for multiple local terminal sessions.
You speak to **Project Janus** (a Gemini Live voice agent); it observes your
terminal panes, organizes them in a persistent ledger, and acts on shell
commands according to a configurable permissions policy — from full manual
approval to full autonomy.

## How it works

```
 Browser (mic)                  Node server (server.ts)              Gemini Live
 ─────────────                  ───────────────────────              ───────────
 PCM 16kHz  ──audio frames──▶   WebSocket /live  ──realtime audio──▶  model
 audio out  ◀──audio frames──   WebSocket /live  ◀──audio + tools───  (tool calls)
 live UI    ◀──stdout chunks──         │
                                       │ spawns / reads / writes
                                       ▼
                                UniversalTerminal(s)
                                (child_process panes)
                                       │
                                       ▼
                                Ledger (.janus_ledger.json)
                                Settings (.janus_settings.json)
```

1. The browser captures mic audio, encodes it as 16 kHz PCM, and streams it over
   the `/live` WebSocket to the server, which forwards it to a Gemini Live session.
2. Gemini replies with synthesized audio (default voice `Zephyr`) and may emit
   tool calls. Pane stdout is also pushed to the UI live as `stdout_chunk` events.
3. Read/observe tools (`list_panes`, `get_pane_summary`, `switch_context`) and
   organization tools (`add_project_note`, `add_pane_note`, `rename_project`,
   `rename_pane`) are answered from the orchestrator/ledger state.
4. `propose_command` is gated by the **effective permissions mode** (see below):
   - **Full Auto** — executed immediately; the UI is notified.
   - **Read-Only** — blocked; the model is told writes are disabled.
   - **Human-in-the-Loop** — held as a pending approval; the frontend shows an
     **Approval Dialog**, and only operator confirmation writes the command to
     the pane's stdin. The outcome is returned to the model.

## Permissions model

Every pane has a `permissionsMode`; a `globalPermissionsMode` can override it.
The effective mode is: use the global mode unless it is `Inherit`, in which case
the pane's own mode applies (defaulting to `Human-in-the-Loop`).

| Mode               | Effect on `propose_command`                          |
| ------------------ | ---------------------------------------------------- |
| `Full Auto`        | Runs immediately, no approval.                       |
| `Human-in-the-Loop`| Requires explicit operator approval in the UI.       |
| `Read-Only`        | Rejected; the pane accepts no writes.                |
| `Inherit` (global) | Falls back to the pane's own mode.                   |

Tool presets (`Claude Code`, `Codex`, `Antigravity`, `Custom`) seed a pane's
startup command and, for non-custom presets, manage the
`--dangerously-skip-permissions` flag based on the mode.

## Project structure

```
server.ts                     Express + WebSocket server; Gemini Live bridge; REST API
SETTINGS_SPEC.md              Specification for the configuration/settings system
index.html                    Vite entry point
vite.config.ts                Vite + React + Tailwind config
src/
  main.tsx                    React root
  App.tsx                     Main UI: pane list, terminal view, voice + permission controls
  types.ts                    Shared types (Terminal, PaneMeta, Workspace, CliPreset, SystemSettings)
  index.css                   Tailwind entry
  terminal.ts                 UniversalTerminal, OrchestratorManager, settings/preset handling
  ledger.ts                   Ledger: persisted projects/workspaces, panes, notes, briefings
  utils/audio.ts              PCM <-> base64 encode/decode and chunked playback
  components/
    ApprovalDialog.tsx        Human-in-the-loop command confirmation
    CreateTerminalDialog.tsx  Manual pane creation (tool preset + permissions)
    SettingsDialog.tsx        Settings editor (form + raw JSON, import/export)
tests/
  test_server.ts             Tests for terminal.ts / OrchestratorManager
  test_ledger.ts             Tests for the persisted project ledger
  test_universal_terminal.py Tests for the standalone Python port
universal_terminal.py         Standalone asyncio reference implementation of a pane
```

State is persisted next to the server as `.janus_ledger.json` (workspaces/panes)
and `.janus_settings.json` (system settings); both are local runtime files.

## Prerequisites

- Node.js 18+ (developed against Node 22)
- A Google Gemini API key with access to the Live API

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Create a `.env` file (see `.env.example`) and set your key:
   ```bash
   GEMINI_API_KEY="your-key-here"
   ```
   The key can alternatively be set at runtime via the Settings dialog.

## Running

```bash
npm run dev     # Start the server with Vite middleware at http://localhost:3000
npm run build   # Build the client (vite) and bundle the server to dist/server.cjs
npm start       # Run the production build (serves the bundled SPA from dist/)
npm test        # Run the TypeScript test suites with tsx
npm run lint    # Type-check with tsc --noEmit
npm run clean   # Remove build artifacts
```

Open http://localhost:3000, click **Connect**, and grant microphone access. A
default `primary-cli` pane is created on startup; add more with **Create Node**.

## HTTP & WebSocket API

| Method | Path                                                  | Purpose                                       |
| ------ | ----------------------------------------------------- | --------------------------------------------- |
| GET    | `/api/terminals`                                      | List panes with state, preset, and permissions.|
| POST   | `/api/terminals`                                      | Create a pane (`terminalId, cwd, command, ...`).|
| POST   | `/api/terminals/:id/restart`                          | Restart (or restore) a pane.                  |
| GET    | `/api/ledger`                                         | Full workspace/pane ledger.                   |
| POST   | `/api/projects`                                       | Create a project workspace.                   |
| PUT    | `/api/projects/:id/rename`                            | Rename a project.                             |
| POST   | `/api/projects/:id/switch`                            | Switch the active project context.            |
| DELETE | `/api/projects/:id`                                   | Delete a project workspace.                   |
| POST   | `/api/projects/:id/notes`                             | Add a project note.                           |
| PUT    | `/api/projects/:pid/panes/:paneId/rename`             | Rename a pane.                                |
| POST   | `/api/projects/:pid/panes/:paneId/notes`              | Add a pane note.                              |
| PUT    | `/api/projects/:pid/panes/:paneId/permissions`        | Change a pane's permissions mode.             |
| DELETE | `/api/projects/:pid/panes/:paneId`                    | Stop and remove a pane.                       |
| GET    | `/api/settings`                                       | Read settings (API key masked).               |
| PUT    | `/api/settings`                                       | Update settings; broadcasts to clients.       |
| GET    | `/api/commands/pending`                               | List pending approvals.                       |
| POST   | `/api/commands/approve`                               | Approve/reject a proposed command.            |
| WS     | `/live`                                                | Bidirectional audio + control/stdout messages.|

WebSocket server→client message types include `audio`, `interrupted`,
`approval_pending`, `terminals_updated`, `ledger_updated`, `settings_updated`,
`command_auto_executed`, `command_blocked`, `stdout_chunk`, and `error`.

See `SETTINGS_SPEC.md` for the full configuration schema and settings design.

## Agent tools

| Tool               | Effect                                                                       |
| ------------------ | ---------------------------------------------------------------------------- |
| `list_panes`       | Cheap orientation: all projects and panes with state, `is_busy`, `alive`.    |
| `get_pane_summary` | Markdown snapshot of one pane's recent output.                               |
| `switch_context`   | Make a project the active focus and return its briefing.                     |
| `propose_command`  | Propose a command for a pane; gated by the effective permissions mode.       |
| `add_project_note` | Append a durable note to a project.                                          |
| `add_pane_note`    | Append a durable note to a specific pane.                                    |
| `rename_project`   | Rename a project.                                                            |
| `rename_pane`      | Rename a pane.                                                               |

## Security note

The server runs commands on the host machine and the REST API has no
authentication. Run it only on trusted, local networks. Agent-proposed commands
are gated by the permissions model above, but `POST /api/terminals` and
`Full Auto` panes can execute processes without a manual approval step — keep the
server bound to a trusted environment, and avoid `Full Auto` for untrusted input.
