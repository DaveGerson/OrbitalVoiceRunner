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
}

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
}

export interface Workspace {
  id: string;
  name: string;
  directory: string;
  summary: string;
  notes: string[];
  panes: Record<string, PaneMeta>;
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

