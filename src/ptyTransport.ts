import { spawn, ChildProcess } from "child_process";

/**
 * PtyTransport — the spawn/IO seam (WS-C design §2.4 / §5).
 *
 * Two implementations:
 *  - NodePtyTransport (preferred): a real PTY via
 *    @homebridge/node-pty-prebuilt-multiarch. Gives Windows a real ConPTY and a
 *    uniform process root to probe on every platform.
 *  - LegacyChildProcessTransport (fallback): the historical
 *    spawn("script" | "cmd.exe", …) path, lifted verbatim from the old terminal.ts.
 *
 * Selection is a single try{require(node-pty)}catch{legacy} at startup
 * (createPtyTransport), which returns `usingNodePty`. When that is false the
 * caller (terminal.start) swaps the authoritative probe for a FallbackProbe so a
 * pane on the legacy transport degrades to quiescence-driven idle (design §6, R1).
 */

export interface PtyTransport {
  /** Root pid of the spawned shell/agent (for the StatusProbe). */
  readonly pid: number | undefined;
  /** Subscribe to merged stdout/stderr data (utf-8 strings). */
  onData(cb: (data: string) => void): void;
  /** Subscribe to process exit (real exit/close/error). */
  onExit(cb: (info: { exitCode: number; signal?: number }) => void): void;
  /** Write raw bytes to the process stdin / PTY master. */
  write(data: string): void;
  /** Terminate the process (and its group/tree where possible). */
  kill(signal?: string): void;
}

export interface PtySpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
}

let _nodePtyModule: any = null;
let _nodePtyResolved = false;
let _nodePtyAvailable = false;

function loadNodePty(): any {
  if (_nodePtyResolved) return _nodePtyModule;
  _nodePtyResolved = true;
  const PKG = "@homebridge/node-pty-prebuilt-multiarch";
  // Resolve a working `require` regardless of runtime. Under tsx/ESM (the dev
  // server's `tsx server.ts`), a bare global `require` is NOT defined, so the old
  // `require(...)` threw and silently forced EVERY pane onto the legacy non-PTY
  // transport — which gives the agent a piped (non-TTY) stdin, so Claude detects
  // no terminal and exits after a few seconds. createRequire gives us a real
  // CommonJS require in both ESM (tsx) and CJS (built dist/server.cjs) contexts.
  try {
    let req: NodeRequire | undefined =
      typeof require === "function" ? require : undefined;
    if (!req) {
      // ESM/tsx path: synthesize a require bound to this module's location.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { createRequire } = require("module");
      req = createRequire(import.meta.url);
    }
    _nodePtyModule = req!(PKG);
    _nodePtyAvailable = !!_nodePtyModule && typeof _nodePtyModule.spawn === "function";
  } catch {
    // Last-resort: try createRequire even if the first branch's `require` itself
    // was the thing that was undefined (belt-and-suspenders for odd loaders).
    try {
      const { createRequire } = eval("require")("module");
      const req2 = createRequire(import.meta.url);
      _nodePtyModule = req2(PKG);
      _nodePtyAvailable = !!_nodePtyModule && typeof _nodePtyModule.spawn === "function";
    } catch {
      _nodePtyModule = null;
      _nodePtyAvailable = false;
    }
  }
  return _nodePtyModule;
}

/** Whether the node-pty native module loaded successfully at startup. */
export function nodePtyAvailable(): boolean {
  loadNodePty();
  return _nodePtyAvailable;
}

// ---------------------------------------------------------------------------
// NodePtyTransport (preferred)
// ---------------------------------------------------------------------------

export class NodePtyTransport implements PtyTransport {
  private proc: any;

  constructor(file: string, args: string[], opts: PtySpawnOptions) {
    const pty = loadNodePty();
    this.proc = pty.spawn(file, args, {
      name: "xterm-color",
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 30,
      cwd: opts.cwd,
      env: opts.env as { [key: string]: string },
    });
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  onData(cb: (data: string) => void): void {
    this.proc.onData((d: string) => cb(d));
  }

  onExit(cb: (info: { exitCode: number; signal?: number }) => void): void {
    this.proc.onExit((e: { exitCode: number; signal?: number }) => cb(e));
  }

  write(data: string): void {
    try {
      this.proc.write(data);
    } catch {
      // process gone
    }
  }

  kill(signal?: string): void {
    try {
      this.proc.kill(signal);
    } catch {
      // already dead
    }
  }
}

// ---------------------------------------------------------------------------
// LegacyChildProcessTransport (fallback) — lifted verbatim from terminal.ts:286-334
// ---------------------------------------------------------------------------

export class LegacyChildProcessTransport implements PtyTransport {
  private proc: ChildProcess | null;
  private dataCbs: ((data: string) => void)[] = [];
  private exitCbs: ((info: { exitCode: number; signal?: number }) => void)[] = [];
  private isWindows: boolean;

  constructor(file: string, args: string[], opts: PtySpawnOptions) {
    // On Windows, detached:true gives the child its own console window (the
    // floating popup the operator sees on the desktop) AND orphans the stdio
    // pipes so stdout/stderr capture and stdin writes silently break.
    // attached + windowsHide keeps the child headless with working pipes.
    // On POSIX, detached:true is kept so process.kill(-pid) in kill() can
    // tear down the entire process group.
    this.isWindows = process.platform === "win32";
    this.proc = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env,
      detached: !this.isWindows,
      windowsHide: true,
    });

    if (this.proc.stdout) {
      this.proc.stdout.on("data", (data) => {
        const decoded = data.toString("utf-8");
        for (const cb of this.dataCbs) cb(decoded);
      });
    }
    if (this.proc.stderr) {
      this.proc.stderr.on("data", (data) => {
        const decoded = data.toString("utf-8");
        for (const cb of this.dataCbs) cb(decoded);
      });
    }
    this.proc.on("error", () => {
      for (const cb of this.exitCbs) cb({ exitCode: -1 });
    });
    this.proc.on("exit", () => {
      for (const cb of this.exitCbs) cb({ exitCode: 0 });
    });
    this.proc.on("close", () => {
      for (const cb of this.exitCbs) cb({ exitCode: 0 });
    });
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  onData(cb: (data: string) => void): void {
    this.dataCbs.push(cb);
  }

  onExit(cb: (info: { exitCode: number; signal?: number }) => void): void {
    this.exitCbs.push(cb);
  }

  write(data: string): void {
    if (this.proc && this.proc.stdin) {
      this.proc.stdin.write(data);
    }
  }

  kill(signal?: string): void {
    if (!this.proc || !this.proc.pid) return;
    const pid = this.proc.pid;
    const sig = (signal as NodeJS.Signals) || "SIGTERM";
    if (this.isWindows) {
      // taskkill /t tears down the full child tree; /f forces termination.
      // Ignore errors (process may already be gone).
      try {
        spawn("taskkill", ["/pid", String(pid), "/t", "/f"]);
      } catch {
        try {
          this.proc.kill(sig);
        } catch {
          // already dead
        }
      }
    } else {
      try {
        // Teardown the process group cleanly (matches legacy stop()).
        process.kill(-pid, sig);
      } catch {
        try {
          this.proc.kill(sig);
        } catch {
          // already dead
        }
      }
    }
  }
}

/**
 * Build a transport for a final command. node-pty preferred; legacy fallback.
 * The command is run under a shell so existing string commands (e.g. "echo hi",
 * "npm run build") work unchanged on both transports.
 */
export function createPtyTransport(
  finalCommand: string,
  opts: PtySpawnOptions
): { transport: PtyTransport; usingNodePty: boolean } {
  const isWindows = process.platform === "win32";

  if (nodePtyAvailable()) {
    let file: string;
    let args: string[];
    if (isWindows) {
      // Run inside cmd.exe so finalCommand strings work; ConPTY makes it interactive.
      file = process.env.COMSPEC || "cmd.exe";
      args = ["/c", finalCommand];
    } else {
      file = "/bin/sh";
      args = ["-c", finalCommand];
    }
    return { transport: new NodePtyTransport(file, args, opts), usingNodePty: true };
  }

  // Legacy fallback transport — verbatim spawn shape from the old terminal.ts.
  const isDarwin = process.platform === "darwin";
  let file: string;
  let args: string[];
  if (isWindows) {
    file = "cmd.exe";
    args = ["/c", finalCommand];
  } else {
    file = "script";
    if (isDarwin) {
      args = ["-q", "/dev/null", "/bin/sh", "-c", finalCommand];
    } else {
      args = ["-q", "-f", "-c", finalCommand, "/dev/null"];
    }
  }
  return { transport: new LegacyChildProcessTransport(file, args, opts), usingNodePty: false };
}
