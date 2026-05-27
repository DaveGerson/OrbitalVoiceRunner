import { spawn, ChildProcess } from "child_process";
import { Ledger, PaneMeta } from "./ledger";

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
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(terminalId: string, cwd: string, shellCmd: string) {
    this.terminalId = terminalId;
    this.cwd = cwd;
    this.shellCmd = shellCmd;
  }

  private resetIdleTimer() {
    if (this.status === "Exited") return;
    this.status = "Running";
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.status !== "Exited") this.status = "Idle";
    }, 2000);
  }

  start() {
    const isWindows = process.platform === "win32";
    const executable = isWindows ? "cmd.exe" : "/bin/sh";
    const args = isWindows ? ["/c", this.shellCmd] : ["-c", this.shellCmd];

    this.process = spawn(executable, args, {
      cwd: this.cwd,
      env: process.env,
    });
    
    this.resetIdleTimer();

    if (this.process.stdout) {
      this.process.stdout.on("data", (data) => {
        this.resetIdleTimer();
        const decoded = data.toString('utf-8');
        const cleanLines = stripAnsiSequences(decoded).split(/\r?\n/).filter((l: string) => l.trim() !== '');
        this.outputBuffer.push(...cleanLines);
        if (this.outputBuffer.length > this.maxBufferLines) {
          this.outputBuffer.splice(0, this.outputBuffer.length - this.maxBufferLines);
        }
      });
    }

    if (this.process.stderr) {
      this.process.stderr.on("data", (data) => {
        this.resetIdleTimer();
        const decoded = data.toString('utf-8');
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

  stop() {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }
}

export class OrchestratorManager {
  public terminals: Record<string, UniversalTerminal> = {};
  public activeId: string | null = null;
  public ledger: Ledger;

  constructor() {
    this.ledger = new Ledger();
    this.ledger.addProject("default_project", process.cwd(), "Default workspace");
    this.ledger.switchContext("default_project");
  }

  addTerminal(terminalId: string, cwd: string, command: string): string {
    if (this.terminals[terminalId]) {
      return `Terminal '${terminalId}' already exists.`;
    }
    const term = new UniversalTerminal(terminalId, cwd, command);
    term.start();
    this.terminals[terminalId] = term;
    if (!this.activeId) {
      this.activeId = terminalId;
    }
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
    const activeProject = this.ledger.getActiveProject();
    if (!activeProject) return;

    for (const [id, term] of Object.entries(this.terminals)) {
      const meta: PaneMeta = {
        pane_id: id,
        name: id,
        runtime_type: "interactive_cli",
        last_known_state: term.status === "Running" ? "Running active command" : term.status === "Idle" ? "Idle" : "Exited",
        is_busy: term.status === "Running",
        alive: term.status !== "Exited"
      };
      this.ledger.updatePane(activeProject.id, meta);
    }
  }

  getPaneSummary(paneId: string, limit = 20) {
    if (!this.terminals[paneId]) {
      return `Error: Pane ${paneId} does not exist.`;
    }
    const recentOut = this.terminals[paneId].getRecentOutput(limit);
    // Stub SDF (Semantic Delta Filter): wraps in markdown
    return `\`\`\`\n${recentOut || "[No new output]"}\n\`\`\``;
  }
}
