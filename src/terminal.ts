import { spawn, ChildProcess } from "child_process";
import { Ledger, PaneMeta } from "./ledger";
import fs from "fs";
import { SystemSettings, CliPreset } from "./types";

export function parsePresetsSafe(input: any): CliPreset[] {
  if (Array.isArray(input)) {
    return input.map((item: any) => ({
      id: String(item?.id || ""),
      name: String(item?.name || ""),
      command: String(item?.command || ""),
      enabled: Boolean(item?.enabled ?? true),
      permissionsMode: item?.permissionsMode || "Human-in-the-Loop",
      windowMode: item?.windowMode || "Standard Split-Pane",
      visualTheme: item?.visualTheme || "Default Green Mono",
      persistentRestore: Boolean(item?.persistentRestore ?? false),
      dangerouslySkipPermissions: Boolean(item?.dangerouslySkipPermissions ?? false),
      sessionResume: Boolean(item?.sessionResume ?? true),
      portOffset: item?.portOffset !== undefined ? String(item.portOffset) : "",
      customEnvVars: item?.customEnvVars !== undefined ? String(item.customEnvVars) : ""
    }));
  }
  if (input && typeof input === "object") {
    return Object.entries(input).map(([key, val]: [string, any]) => {
      let displayName = key;
      if (key === "claudeCode") displayName = "Claude Code";
      else if (key === "codex") displayName = "Codex CLI";
      else if (key === "antigravity") displayName = "Antigravity Agent";
      else {
        displayName = key.charAt(0).toUpperCase() + key.slice(1);
      }
      return {
        id: key,
        name: val?.name || displayName,
        command: String(val?.command || ""),
        enabled: Boolean(val?.enabled ?? true),
        permissionsMode: val?.permissionsMode || "Human-in-the-Loop",
        windowMode: val?.windowMode || "Standard Split-Pane",
        visualTheme: val?.visualTheme || "Default Green Mono",
        persistentRestore: Boolean(val?.persistentRestore ?? false),
        dangerouslySkipPermissions: Boolean(val?.dangerouslySkipPermissions ?? false),
        sessionResume: Boolean(val?.sessionResume ?? true),
        portOffset: val?.portOffset !== undefined ? String(val.portOffset) : "",
        customEnvVars: val?.customEnvVars !== undefined ? String(val.customEnvVars) : ""
      };
    });
  }
  return [
    { id: "claudeCode", name: "Claude Code", command: "npx @anthropic-ai/claude --resume-previous-session --with-open-textbox", enabled: true, permissionsMode: "Human-in-the-Loop", windowMode: "Standard Split-Pane", visualTheme: "Royal Purple", persistentRestore: true, dangerouslySkipPermissions: false, sessionResume: true, portOffset: "", customEnvVars: "" },
    { id: "codex", name: "Codex CLI", command: "npx codex-cli --resume-previous-session --with-open-textbox", enabled: true, permissionsMode: "Human-in-the-Loop", windowMode: "Standard Split-Pane", visualTheme: "Amber Slop-Shield", persistentRestore: false, dangerouslySkipPermissions: false, sessionResume: true, portOffset: "", customEnvVars: "" },
    { id: "antigravity", name: "Antigravity Agent", command: "npx antigravity --dangerously-skip-permissions --resume-previous-session --with-open-textbox", enabled: true, permissionsMode: "Full Auto", windowMode: "Standard Split-Pane", visualTheme: "Cosmic Slate", persistentRestore: true, dangerouslySkipPermissions: true, sessionResume: true, portOffset: "", customEnvVars: "" }
  ];
}


export function stripAnsiSequences(text: string): string {
  // Matches ANSI color/style escape sequences
  const ansiEscape = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
  return text.replace(ansiEscape, '');
}

export class UniversalTerminal {
  public terminalId: string;
  public cwd: string;
  public shellCmd: string;
  public process: ChildProcess | null = null;
  public outputBuffer: string[] = [];
  public maxBufferLines = 100;
  public status: "Running" | "Exited" | "Idle" = "Idle";
  public permissionsMode: "Full Auto" | "Human-in-the-Loop" | "Read-Only";
  public toolPreset: "Claude Code" | "Codex" | "Antigravity" | "Custom";
  public sessionId: string;
  public onOutput: ((terminalId: string, chunk: string) => void) | null = null;
  public projectId: string;
  private idleTimer: NodeJS.Timeout | null = null;
  private cachedCpu = 0.0;

  constructor(
    terminalId: string,
    cwd: string,
    shellCmd: string,
    toolPreset: "Claude Code" | "Codex" | "Antigravity" | "Custom" = "Custom",
    permissionsMode: "Full Auto" | "Human-in-the-Loop" | "Read-Only" = "Human-in-the-Loop",
    sessionId = "",
    projectId = "default_project"
  ) {
    this.terminalId = terminalId;
    this.cwd = cwd;
    this.toolPreset = toolPreset;
    this.permissionsMode = permissionsMode;
    this.projectId = projectId;
    
    let cmd = shellCmd;
    if (toolPreset !== "Custom") {
      const skipFlag = "--dangerously-skip-permissions";
      if (permissionsMode === "Full Auto") {
        if (!cmd.includes(skipFlag)) {
          cmd = `${cmd} ${skipFlag}`;
        }
      } else {
        cmd = cmd.replace(` ${skipFlag}`, "");
      }
    }
    this.shellCmd = cmd;
    
    if (sessionId) {
      this.sessionId = sessionId;
    } else if (toolPreset !== "Custom") {
      const toolLower = toolPreset.toLowerCase().replace(/\s+/g, "-");
      const randomId = Math.random().toString(16).substring(2, 10);
      this.sessionId = `${toolLower}-session-${randomId}`;
    } else {
      this.sessionId = "";
    }
  }

  public setPermissionsMode(mode: "Full Auto" | "Human-in-the-Loop" | "Read-Only") {
    this.permissionsMode = mode;
    if (this.toolPreset !== "Custom") {
      const skipFlag = "--dangerously-skip-permissions";
      if (mode === "Full Auto") {
        if (!this.shellCmd.includes(skipFlag)) {
          this.shellCmd = `${this.shellCmd} ${skipFlag}`;
        }
      } else {
        this.shellCmd = this.shellCmd.replace(` ${skipFlag}`, "");
      }
    }
  }

  get contextSize(): number {
    return this.outputBuffer.join('\n').length;
  }

  private checkForSessionId(text: string) {
    if (this.sessionId && this.sessionId.includes("-session-") && this.toolPreset !== "Custom") {
      // Keep preset/simulated unless a more granular one is found in output
    }
    const matchers = [
      /(?:session[_-]?id|session)[ :="']{1,3}([a-zA-Z0-9_\-]{8,})/i,
      /(?:claude|codex|antigravity)[_-]session[_-]?([a-zA-Z0-9_\-]+)/i,
      /Session established:[ ]*([a-zA-Z0-9_\-]+)/i,
      /Session ID:[ ]*([a-zA-Z0-9_\-]+)/i,
      /session_id[ :="']{1,3}([a-zA-Z0-9_\-]{6,})/i
    ];
    for (const regex of matchers) {
      const match = text.match(regex);
      if (match && match[1]) {
        this.sessionId = match[1];
        break;
      }
    }
  }

  private updateStatusOnOutput(decoded: string) {
    if (this.status === "Exited") return;

    const stripped = stripAnsiSequences(decoded).trim();
    const fullStripped = stripAnsiSequences(this.getRecentOutput(5)).trim();

    // Prompts matching: ending in standard patterns
    const inputPromptPattern = /([\?$#>]|\[[yY]\/[nN]\]|\([yY]\/[nN]\)|password:|confirm\??)\s*$/i;

    if (inputPromptPattern.test(stripped) || inputPromptPattern.test(fullStripped)) {
      this.status = "Idle";
      if (this.idleTimer) {
        clearTimeout(this.idleTimer);
        this.idleTimer = null;
      }
    } else {
      this.status = "Running";
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        if (this.status !== "Exited") {
          this.status = "Idle";
        }
      }, 1000);
    }
  }

  private loadScrollback() {
    const file = `.janus_scrollback_${this.terminalId}.log`;
    try {
      if (fs.existsSync(file)) {
        const data = fs.readFileSync(file, "utf-8");
        const lines = data.split(/\r?\n/).filter(l => l.trim() !== "");
        this.outputBuffer = lines.slice(-this.maxBufferLines);
      }
    } catch (e) {
      console.warn("Failed to load scrollback:", e);
    }
  }

  private appendScrollback(chunk: string) {
    const file = `.janus_scrollback_${this.terminalId}.log`;
    try {
      fs.appendFileSync(file, chunk);
      const stat = fs.statSync(file);
      if (stat.size > 1024 * 512) { // 512KB limit
        const data = fs.readFileSync(file, "utf-8");
        const lines = data.split(/\r?\n/).filter(l => l.trim() !== "");
        const pruned = lines.slice(-this.maxBufferLines).join("\n") + "\n";
        fs.writeFileSync(file, pruned, "utf-8");
      }
    } catch (e) {
      // ignore
    }
  }

  start() {
    const isWindows = process.platform === "win32";
    const isDarwin = process.platform === "darwin";
    
    let executable: string;
    let args: string[];

    // Ensure session ID is mapped back into resume flag for actual agent/agent sessions
    let finalCommand = this.shellCmd;
    if (this.toolPreset !== "Custom" && this.sessionId) {
      const resumePattern = /--resume|--session/;
      if (!resumePattern.test(finalCommand)) {
        finalCommand = `${finalCommand} --resume=${this.sessionId}`;
      }
    }

    if (isWindows) {
      executable = "cmd.exe";
      args = ["/c", finalCommand];
    } else {
      // Allocate a real pseudo-terminal (PTY) using standard UNIX 'script'.
      // Enables prompt rendering, terminal colors, and disables block output buffering.
      executable = "script";
      if (isDarwin) {
        // macOS script usage: script -q /dev/null <command>
        args = ["-q", "/dev/null", "/bin/sh", "-c", finalCommand];
      } else {
        // Linux script usage: script -q -f -c <command> /dev/null
        args = ["-q", "-f", "-c", finalCommand, "/dev/null"];
      }
    }

    // Populate historical output buffer from persistent scrollback log
    this.loadScrollback();

    this.process = spawn(executable, args, {
      cwd: this.cwd,
      env: process.env,
      detached: true,
    });
    
    // Set running state and watch for idle state
    if (this.status !== "Exited") {
      this.status = "Running";
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        if (this.status !== "Exited") this.status = "Idle";
      }, 1000);
    }

    if (this.process.stdout) {
      this.process.stdout.on("data", (data) => {
        const decoded = data.toString('utf-8');
        this.appendScrollback(decoded);
        this.updateStatusOnOutput(decoded);
        this.checkForSessionId(decoded);
        if (this.onOutput) {
          this.onOutput(this.terminalId, decoded);
        }
        const cleanLines = stripAnsiSequences(decoded).split(/\r?\n/).filter((l: string) => l.trim() !== '');
        this.outputBuffer.push(...cleanLines);
        if (this.outputBuffer.length > this.maxBufferLines) {
          this.outputBuffer.splice(0, this.outputBuffer.length - this.maxBufferLines);
        }
      });
    }

    if (this.process.stderr) {
      this.process.stderr.on("data", (data) => {
        const decoded = data.toString('utf-8');
        this.appendScrollback(decoded);
        this.updateStatusOnOutput(decoded);
        this.checkForSessionId(decoded);
        if (this.onOutput) {
          this.onOutput(this.terminalId, decoded);
        }
        const cleanLines = stripAnsiSequences(decoded).split(/\r?\n/).filter((l: string) => l.trim() !== '');
        this.outputBuffer.push(...cleanLines);
        if (this.outputBuffer.length > this.maxBufferLines) {
          this.outputBuffer.splice(0, this.outputBuffer.length - this.maxBufferLines);
        }
      });
    }

    this.process.on('error', (err) => {
      this.status = "Exited";
      this.outputBuffer.push(`[Session error: ${err.message}]`);
    });
    
    this.process.on('exit', () => {
      this.status = "Exited";
    });
    
    this.process.on('close', () => {
      this.status = "Exited";
    });
  }

  writeInput(command: string) {
    if (this.process && this.process.stdin) {
      this.process.stdin.write(command + "\n");
    }
  }

  getRecentOutput(linesCount = 10): string {
    return this.outputBuffer.slice(-linesCount).join('\n');
  }

  public async stop(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.process && this.process.pid) {
      const pid = this.process.pid;
      const proc = this.process;
      this.process = null;

      return new Promise<void>((resolve) => {
        let resolved = false;
        const cleanupAndResolve = () => {
          if (!resolved) {
            resolved = true;
            resolve();
          }
        };

        proc.on("exit", cleanupAndResolve);
        proc.on("close", cleanupAndResolve);

        try {
          // Teardown the process group cleanly
          process.kill(-pid, "SIGTERM");
        } catch (e) {
          try {
            proc.kill("SIGTERM");
          } catch (err) {}
          cleanupAndResolve();
          return;
        }

        const killTimeout = setTimeout(() => {
          try {
            process.kill(-pid, "SIGKILL");
          } catch (e) {
            try {
              proc.kill("SIGKILL");
            } catch (err) {}
          }
          cleanupAndResolve();
        }, 1000);

        proc.on("exit", () => clearTimeout(killTimeout));
        proc.on("close", () => clearTimeout(killTimeout));
      });
    }
  }
}

export class OrchestratorManager {
  public terminals: Record<string, UniversalTerminal> = {};
  public activeId: string | null = null;
  public ledger: Ledger;
  public onOutput: ((terminalId: string, chunk: string) => void) | null = null;
  public globalPermissionsMode: "Full Auto" | "Human-in-the-Loop" | "Read-Only" | "Inherit" = "Inherit";
  public settings!: SystemSettings;
  private settingsFilePath = ".janus_settings.json";

  private getDefaultSettings(): SystemSettings {
    return {
      server: {
        port: 3000,
        host: "0.0.0.0",
        appUrl: process.env.APP_URL || "http://localhost:3000"
      },
      voiceAi: {
        model: "gemini-3.1-flash-live-preview",
        voice: "Zephyr",
        voiceStyle: "Creative",
        volume: 80,
        speechSpeed: 1.0,
        isMicMuted: false
      },
      projects: {
        activeContext: "default_project",
        localWorkspacePath: process.cwd()
      },
      presets: [
        { id: "claudeCode", name: "Claude Code", command: "npx @anthropic-ai/claude", enabled: true },
        { id: "codex", name: "Codex CLI", command: "npx codex-cli", enabled: true },
        { id: "antigravity", name: "Antigravity Agent", command: "npx antigravity", enabled: true }
      ],
      advanced: {
        webSocketUrl: "",
        latencyMode: "Balanced",
        throughputBps: 16000,
        audioBufferSize: 1024,
        debugLogging: false,
        connectionTimeoutMs: 10000,
        rateLimitRequestsPerMin: 60,
        maxBufferLines: 100,
        idleTimeoutMs: 2000,
        defaultShellCommand: process.platform === "win32" ? "cmd.exe" : "bash",
        globalPermissionsMode: "Inherit",
        historyMaxCommands: 50,
        historyMaxOutputLength: 5000
      },
      secrets: {
        geminiApiKey: process.env.GEMINI_API_KEY ? "CONFIGURED_IN_ENV" : ""
      }
    };
  }

  public loadSettings() {
    try {
      if (fs.existsSync(this.settingsFilePath)) {
        const raw = fs.readFileSync(this.settingsFilePath, "utf-8");
        const parsed = JSON.parse(raw);
        this.settings = {
          ...this.getDefaultSettings(),
          ...parsed,
          server: { ...this.getDefaultSettings().server, ...parsed.server },
          voiceAi: { ...this.getDefaultSettings().voiceAi, ...parsed.voiceAi },
          projects: { ...this.getDefaultSettings().projects, ...parsed.projects },
          presets: parsePresetsSafe(parsed.presets ? parsed.presets : this.getDefaultSettings().presets),
          advanced: { ...this.getDefaultSettings().advanced, ...parsed.advanced },
          secrets: { ...this.getDefaultSettings().secrets, ...parsed.secrets }
        };
      } else {
        this.settings = this.getDefaultSettings();
        this.saveSettings();
      }
    } catch (e) {
      console.error("Failed to load settings, using defaults:", e);
      this.settings = this.getDefaultSettings();
    }
    this.globalPermissionsMode = this.settings.advanced.globalPermissionsMode || "Inherit";
  }

  public saveSettings() {
    try {
      fs.writeFileSync(this.settingsFilePath, JSON.stringify(this.settings, null, 2), "utf-8");
    } catch (e) {
      console.error("Failed to save settings:", e);
    }
  }

  public updateSettings(newSettings: Partial<SystemSettings>) {
    if (newSettings.server) this.settings.server = { ...this.settings.server, ...newSettings.server };
    if (newSettings.voiceAi) this.settings.voiceAi = { ...this.settings.voiceAi, ...newSettings.voiceAi };
    if (newSettings.projects) this.settings.projects = { ...this.settings.projects, ...newSettings.projects };
    if (newSettings.presets) this.settings.presets = parsePresetsSafe(newSettings.presets);
    if (newSettings.advanced) {
      this.settings.advanced = { ...this.settings.advanced, ...newSettings.advanced };
      this.globalPermissionsMode = this.settings.advanced.globalPermissionsMode;
      if (newSettings.advanced.maxBufferLines !== undefined) {
        for (const term of Object.values(this.terminals)) {
          term.maxBufferLines = newSettings.advanced.maxBufferLines;
        }
      }
    }
    if (newSettings.secrets) {
      this.settings.secrets = { ...this.settings.secrets, ...newSettings.secrets };
    }
    this.saveSettings();
  }

  constructor() {
    this.loadSettings();
    this.ledger = new Ledger();
    const activeCtx = this.settings.projects?.activeContext || "default_project";
    const workspacePath = this.settings.projects?.localWorkspacePath || process.cwd();
    this.ledger.addProject(activeCtx, workspacePath, "Default workspace");
    this.ledger.switchContext(activeCtx);
  }

  addTerminal(
    terminalId: string,
    cwd: string,
    command: string,
    toolPreset: "Claude Code" | "Codex" | "Antigravity" | "Custom" = "Custom",
    permissionsMode: "Full Auto" | "Human-in-the-Loop" | "Read-Only" = "Human-in-the-Loop",
    sessionId = "",
    projectId = ""
  ): string {
    if (this.terminals[terminalId]) {
      return `Terminal '${terminalId}' already exists.`;
    }
    const realProjId = projectId || this.ledger.activeProjectId || "default_project";
    const term = new UniversalTerminal(terminalId, cwd, command, toolPreset, permissionsMode, sessionId, realProjId);
    term.onOutput = (tid, chunk) => {
      if (this.onOutput) this.onOutput(tid, chunk);
    };
    term.start();
    this.terminals[terminalId] = term;
    if (!this.activeId) {
      this.activeId = terminalId;
    }
    this.syncLedger();
    return `Created terminal '${terminalId}' executing '${command}' at '${cwd}'.`;
  }

  listPanes() {
    this.syncLedger();
    const result: any[] = [];
    for (const [projId, ws] of Object.entries(this.ledger.workspaces)) {
      result.push({
        project_id: projId,
        panes: Object.values(ws.panes)
      });
    }
    return result;
  }

  // Synchronize actual terminal state to ledger
  private syncLedger() {
    for (const [id, term] of Object.entries(this.terminals)) {
      const pId = term.projectId || "default_project";
      const project = this.ledger.getProject(pId);
      if (project) {
        const existingPane = project.panes[id];
        const meta: PaneMeta = {
          pane_id: id,
          name: existingPane?.name || id,
          runtime_type: existingPane?.runtime_type || "interactive_cli",
          last_known_state: term.status === "Running" ? "Running active command" : term.status === "Idle" ? "Idle" : "Exited",
          is_busy: term.status === "Running",
          alive: term.status !== "Exited",
          notes: existingPane?.notes || [],
          permissions_mode: term.permissionsMode,
          tool_preset: term.toolPreset,
          session_id: term.sessionId || existingPane?.session_id || "",
          context_size: term.contextSize
        };
        this.ledger.updatePane(pId, meta, false);
      }
    }
    this.ledger.save(false);
  }

  getPaneSummary(paneId: string, limit = 20) {
    if (!this.terminals[paneId]) {
      return `Error: Pane ${paneId} does not exist.`;
    }
    const recentOut = this.terminals[paneId].getRecentOutput(limit);
    return `\`\`\`\n${recentOut || "[No new output]"}\n\`\`\``;
  }
}
