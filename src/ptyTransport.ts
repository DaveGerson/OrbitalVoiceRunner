import { spawn, ChildProcess } from "child_process";
import { createRequire } from "module";

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

/**
 * Choose the signal to hand node-pty's kill(). node-pty's Windows backend does
 * NOT support POSIX signals — passing one throws "Signals not supported on
 * windows" in a deferred context (an async uncaughtException that escapes a
 * synchronous try/catch). On win32 we therefore drop the signal entirely (a bare
 * kill() is an unconditional terminate); on POSIX the signal is preserved so the
 * SIGTERM→SIGKILL escalation in UniversalTerminal.stop() still works.
 */
export function killSignalForPlatform(platform: string, signal?: string): string | undefined {
  return platform === "win32" ? undefined : signal;
}

export interface PtyTransport {
  /** Root pid of the spawned shell/agent (for the StatusProbe). */
  readonly pid: number | undefined;
  /** Subscribe to merged stdout/stderr data (utf-8 strings). */
  onData(cb: (data: string) => void): void;
  /** Subscribe to process exit (real exit/close/error). */
  onExit(cb: (info: { exitCode: number; signal?: number }) => void): void;
  /** Write raw bytes to the process stdin / PTY master. */
  write(data: string): void;
  /** Resize the PTY grid so the program inside wraps to the operator's viewport.
   *  No-op on transports without a real PTY (legacy fallback). */
  resize(cols: number, rows: number): void;
  /** Terminate the process (and its group/tree where possible). */
  kill(signal?: string): void;
  /**
   * Resolve once the transport's native teardown is fully complete and safe for the
   * process to exit. On Windows ConPTY, node-pty arms a delayed (~FLUSH_DATA_INTERVAL)
   * teardown of its conout worker_threads.Worker (a libuv uv_async_t) AFTER kill();
   * if the process force-exits while that is in flight, libuv uv_close()'s a handle
   * already CLOSING and aborts (src\win\async.c:76). Awaiting this in stop() makes
   * teardown deterministic for every caller. No-op (resolved) on transports without a
   * native async resource (legacy child_process, POSIX, stubs). */
  drainTeardown?(): Promise<void>;
}

// node-pty's windowsConoutConnection.FLUSH_DATA_INTERVAL is 1000ms; the conout worker
// dispose() arms worker.terminate() on that timer AFTER kill(). Wait it out + margin.
const CONOUT_DRAIN_MS = 1300;

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
  // Resolve node-pty regardless of runtime. Under tsx/ESM (the dev server runs
  // `tsx server.ts`) a bare global `require` is NOT defined, so the old
  // `require(PKG)` threw and silently forced EVERY pane onto the legacy non-PTY
  // transport — piped (non-TTY) stdin, so Claude detects no terminal and exits
  // after a few seconds (the "panes never hold a live session" bug). We build a
  // CommonJS require via createRequire (statically imported, so it works in both
  // ESM/tsx and the built CJS bundle) bound to this module's location.
  try {
    const req =
      typeof require === "function"
        ? require
        : createRequire(import.meta.url);
    _nodePtyModule = req(PKG);
    _nodePtyAvailable = !!_nodePtyModule && typeof _nodePtyModule.spawn === "function";
  } catch (e) {
    _nodePtyModule = null;
    _nodePtyAvailable = false;
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
  private _killed = false;

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

  resize(cols: number, rows: number): void {
    try {
      // node-pty rejects non-positive dims; clamp to a sane floor.
      this.proc.resize(Math.max(1, Math.floor(cols)), Math.max(1, Math.floor(rows)));
    } catch {
      // process gone, or dims momentarily invalid mid-teardown
    }
  }

  kill(signal?: string): void {
    // Idempotent: node-pty's Windows ConPTY kill() arms the conout-worker dispose
    // (a worker_threads.Worker, i.e. a libuv uv_async_t) AND the native
    // _$onProcessExit callback independently tears the conout socket down. A second
    // kill() (e.g. the SIGTERM→SIGKILL escalation in UniversalTerminal.stop(), or a
    // double stop()) re-enters WindowsPtyAgent.kill()/ConoutConnection.dispose() and
    // can drive a second worker.terminate() on a handle already in UV_HANDLE_CLOSING
    // → the `src\win\async.c:76` abort under --test-force-exit. Guard so node-pty's
    // teardown runs at most once per pty.
    if (this._killed) return;
    this._killed = true;
    try {
      this.proc.kill(killSignalForPlatform(process.platform, signal));
    } catch {
      // already dead
    }
  }

  /**
   * Windows ConPTY only: after kill(), node-pty schedules its conout worker_threads
   * teardown (worker.terminate() = closing a libuv uv_async_t) ~1000ms later. Resolve
   * only once that window has elapsed so a subsequent process.exit (the unit runner's
   * --test-force-exit) can't uv_close() the handle mid-terminate. Cheap elsewhere:
   * resolves immediately when there was no kill or off Windows. */
  async drainTeardown(): Promise<void> {
    if (!this._killed || process.platform !== "win32") return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, CONOUT_DRAIN_MS);
      // Do NOT unref: this drain must hold the loop open so the conout worker fully
      // terminates before the runner force-exits. It is awaited only at teardown.
    });
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

  resize(_cols: number, _rows: number): void {
    // No real PTY behind a piped child process — nothing to resize. The pane is
    // already degraded to quiescence-driven idle (design §6, R1); line wrapping
    // is whatever the program assumes by default.
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
