// src/mockData.ts — the demo/mock-mode fixture factory, extracted VERBATIM out of
// App.generateMockData (bead dbt4 — App.tsx decomposition). The data that was baked into the
// component body (three terminals, the mock project + panes ledger, two pending commands, the
// seeded transcript) now lives here as a pure factory so it is independently testable
// (tests/test_mock_data.ts). generateMockData spreads the result into the same setters in the same
// order — zero behavior change. `now` (was Date.now() inline) is the only seam, threaded in so the
// transcript timestamps are deterministic under test.

import type { Terminal, Workspace, PendingCommand } from "./types";

export const MOCK_PROJECT_ID = "mock_project_alpha";

/** Transcript turn shape mirrors App's `transcript` state (sender/text/timestamp). */
export interface MockTranscriptTurn {
  sender: "User" | "Janus";
  text: string;
  timestamp: Date;
}

export interface MockData {
  terminals: Terminal[];
  ledger: Record<string, Workspace>;
  activeProjectId: string;
  pendingCommands: PendingCommand[];
  transcript: MockTranscriptTurn[];
}

const MOCK_TERM_ID_1 = "terminal_mock_1";
const MOCK_TERM_ID_2 = "terminal_mock_2";
const MOCK_TERM_ID_3 = "terminal_mock_3";

/**
 * Build a fresh set of mock-mode fixtures. Returns brand-new objects on every call (no shared
 * mutable state), matching the inline `set*( [...] )` literals the component used to construct.
 */
export function buildMockData(now: number): MockData {
  const terminals: Terminal[] = [
    {
      id: MOCK_TERM_ID_1,
      cwd: "/home/user/workspace/web-app",
      command: "npm run dev",
      output: "\\n> web-app@1.0.0 dev\\n> vite\\n\\n  VITE v5.0.0  ready in 150 ms\\n\\n  ➜  Local:   http://localhost:5173/\\n  ➜  Network: use --host to expose",
      status: "Running",
      tool_preset: "Claude Code",
      permissions_mode: "Full Auto",
      context_size: 450,
    },
    {
      id: MOCK_TERM_ID_2,
      cwd: "/home/user/workspace/backend-api",
      command: "python main.py",
      output: "Starting server on port 8000...\\nConnecting to db...\\nDatabase connected.",
      status: "Idle",
      tool_preset: "Custom",
      permissions_mode: "Human-in-the-Loop",
      context_size: 2300,
    },
    {
      id: MOCK_TERM_ID_3,
      cwd: "/home/user/workspace/data-pipeline",
      command: "npm run build",
      output: "[ERROR] Failed to compile data-pipeline.\\nModuleNotFoundError: No module named 'pandas'\\n\\nError: Command failed with exit code 1.\\nPlease verify your dependencies are installed.",
      status: "Running",
      tool_preset: "Claude Code",
      permissions_mode: "Full Auto",
      context_size: 1024,
    },
  ];

  const ledger: Record<string, Workspace> = {
    [MOCK_PROJECT_ID]: {
      id: MOCK_PROJECT_ID,
      name: "Alpha Project",
      directory: "/home/user/workspace",
      summary: "This is a mock project to test UI capability.",
      notes: ["Remember to check API rate limits"],
      keyTerms: ["react", "vite", "nodejs"],
      panes: {
        [MOCK_TERM_ID_1]: {
          pane_id: MOCK_TERM_ID_1,
          name: "React Frontend",
          runtime_type: "shell",
          last_known_state: "Running",
          is_busy: true,
          alive: true,
          notes: ["Dev server running"],
          permissions_mode: "Full Auto",
          session_id: "mock-sess-1",
          tool_preset: "Claude Code",
          context_size: 450,
        },
        [MOCK_TERM_ID_2]: {
          pane_id: MOCK_TERM_ID_2,
          name: "Python Backend",
          runtime_type: "shell",
          last_known_state: "Idle",
          is_busy: false,
          alive: true,
          notes: ["DB Connected"],
          permissions_mode: "Human-in-the-Loop",
          session_id: "mock-sess-2",
          tool_preset: "Custom",
          context_size: 2300,
        },
        [MOCK_TERM_ID_3]: {
          pane_id: MOCK_TERM_ID_3,
          name: "Data Pipeline",
          runtime_type: "shell",
          last_known_state: "Running",
          is_busy: true,
          alive: true,
          notes: ["Needs to install pandas", "Troubleshoot build failure"],
          permissions_mode: "Full Auto",
          session_id: "mock-sess-3",
          tool_preset: "Claude Code",
          context_size: 1024,
        },
      },
    },
  };

  const pendingCommands: PendingCommand[] = [
    {
      messageId: "mock_msg_1",
      cmd: "npm install tailwindcss",
      terminalId: MOCK_TERM_ID_2,
      rationale: { trigger: "I need tailwind", summary: "To add styling support to the project." },
    },
    {
      messageId: "mock_msg_2",
      cmd: "pip install pandas",
      terminalId: MOCK_TERM_ID_3,
      rationale: { trigger: "Missing module", summary: "To fix the build error shown in the terminal output." },
    },
  ];

  const transcript: MockTranscriptTurn[] = [
    { sender: "User", text: "Please start the development server and prepare the background worker.", timestamp: new Date(now - 60000) },
    { sender: "Janus", text: "Understood. I will spin up the React frontend and initialize the Python backend.", timestamp: new Date(now - 55000) },
    { sender: "User", text: "Great, also install tailwind on the backend for some reason.", timestamp: new Date(now - 10000) },
    { sender: "Janus", text: "I noticed an error in the data pipeline build regarding a missing 'pandas' module. I have proposed a command to install it.", timestamp: new Date(now - 5000) },
  ];

  return { terminals, ledger, activeProjectId: MOCK_PROJECT_ID, pendingCommands, transcript };
}
