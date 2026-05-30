export interface Terminal {
  id: string;
  cwd: string;
  command: string;
  output: string;
  status: "Running" | "Exited" | "Idle";
  permissions_mode?: "Full Auto" | "Human-in-the-Loop" | "Read-Only";
  tool_preset?: "Claude Code" | "Codex" | "Antigravity" | "Custom";
  session_id?: string;
  context_size?: number;
}

export interface PendingCommand {
  messageId: string;
  cmd: string;
  terminalId: string;
  rationale?: {
    trigger?: string;
    summary: string;
  };
}

// Single source of truth for the ledger pane/workspace shapes (D7). These live
// here (frontend-safe, no `fs`) and are re-exported from ./ledger.ts so the
// browser App and the server ledger share one definition. The WS-C
// status-detection fields are OPTIONAL so existing persisted ledgers load
// unchanged.
export interface PaneMeta {
  pane_id: string;
  name: string;
  runtime_type: string;
  last_known_state: string;
  is_busy: boolean;
  alive: boolean;
  notes: string[];
  permissions_mode: "Full Auto" | "Human-in-the-Loop" | "Read-Only";
  session_id: string;
  tool_preset: "Claude Code" | "Codex" | "Antigravity" | "Custom";
  context_size: number;
  // WS-C status-detection additions (design §4.1).
  last_status_change_at?: string;   // ISO timestamp of last Running/Idle/Exited transition
  last_command?: string;            // most recent command written via writeInput
  elapsed_ms?: number;              // derived at read time: now - last_status_change_at
}

export interface Workspace {
  id: string;
  name: string;
  directory: string;
  summary: string;
  notes: string[];
  panes: Record<string, PaneMeta>;
  keyTerms?: string[];
}

export interface CliPreset {
  id: string;
  name: string;
  command: string;
  enabled: boolean;
  permissionsMode?: "Full Auto" | "Human-in-the-Loop" | "Read-Only";
  windowMode?: "Standard Split-Pane" | "Side Dock Panel" | "Overlay Modal Console" | "Background Agent Thread";
  visualTheme?: "Default Green Mono" | "Cosmic Slate" | "Crimson Warning" | "Royal Purple" | "Amber Slop-Shield";
  persistentRestore?: boolean;
  dangerouslySkipPermissions?: boolean;
  sessionResume?: boolean;
  portOffset?: string;
  customEnvVars?: string;
}

export interface SystemSettings {
  server: {
    port: number;
    host: string;
    appUrl: string;
  };
  voiceAi: {
    voice: string;
    voiceStyle: "Direct" | "Creative" | "Concise" | "Explanatory";
    volume: number;
    speechSpeed: number;
    isMicMuted: boolean;
    model: string;
  };
  projects: {
    activeContext: string;
    localWorkspacePath: string;
  };
  presets: CliPreset[];
  advanced: {
    webSocketUrl: string;
    latencyMode: "Low Latency" | "High Throughput" | "Balanced";
    throughputBps: number;
    audioBufferSize: number;
    debugLogging: boolean;
    connectionTimeoutMs: number;
    rateLimitRequestsPerMin: number;
    maxBufferLines: number;
    idleTimeoutMs: number;
    defaultShellCommand: string;
    globalPermissionsMode: "Full Auto" | "Human-in-the-Loop" | "Read-Only" | "Inherit";
    historyMaxCommands?: number;
    historyMaxOutputLength?: number;
  };
  secrets: {
    geminiApiKey: string;
  };
}

export interface AttentionItem {
  id: string;
  type: "approval" | "exited" | "error" | "build-failed" | "confirmation";
  terminalId: string;
  projectId: string;
  message: string;
  timestamp: string;
  dismissed: boolean;
  details?: any;
}

export interface WatchRule {
  id: string;
  triggerTerminalId: string;
  triggerTransition: "idle" | "prompt" | "error" | "build-failed" | "exited";
  actionTerminalId: string;
  actionCommand: string;
  enabled: boolean;
  oneShot: boolean;
}

export interface PlanStep {
  id: string;
  terminalId: string;
  command: string;
  expectedTransition: "idle" | "prompt";
  status: "pending" | "running" | "completed" | "failed";
}

export interface Plan {
  id: string;
  name: string;
  steps: PlanStep[];
  currentStepIndex: number;
  status: "idle" | "running" | "paused" | "completed";
}

export interface TemplateRecipe {
  id: string;
  name: string;
  description: string;
  panes: {
    id: string;
    name: string;
    command: string;
    preset: "Claude Code" | "Codex" | "Antigravity" | "Custom";
    permissionsMode: "Full Auto" | "Human-in-the-Loop" | "Read-Only";
  }[];
}


