// src/memory/pythonClient.ts — the warm Python synthesizer daemon client (P0b, D3/D4).
// Optional + self-healing: a strict UPGRADE, never a dependency. Mirrors the node-pty
// loader posture in src/ptyTransport.ts (try → degrade to a flag, never throw at the seam).
import { spawn as realSpawn } from "child_process";
import { fileURLToPath } from "url";
import * as nodePath from "path";
import * as fs from "fs";
import {
  WIRE_VERSION,
  PingResponseSchema,
  PythonBriefSchema,
  SynthesizeResponseSchema,
  type MemoryTiers,
  type MemoryConfig,
} from "./types";
import { z } from "zod";

export type SynthesizeResult =
  | { ok: true; brief: z.infer<typeof PythonBriefSchema> }
  | { ok: false };

export interface PythonSynthClient {
  /** Request a synthesized brief. Resolves ok:false on any miss; NEVER rejects. */
  request(tiers: MemoryTiers, cfg: MemoryConfig, now: number): Promise<SynthesizeResult>;
  /** True only when a daemon has answered a ping and the breaker is closed. */
  available(): boolean;
  /** Observability: which path the next call would take. */
  synthesizerState(): "python" | "fallback";
  /** Tear down the child + timers (idempotent). */
  dispose(): void;
}

interface InterpreterCandidate { cmd: string; baseArgs: string[]; }

export interface PythonSynthClientOpts {
  moduleDir: string;
  repoRoot: string;
  timeoutMs?: number;            // (unused by the client itself; the race lives in synthesizeAsync)
  requestExpiryMs?: number;      // internal pending-entry hard expiry (default 2000) — prevents id leaks
  pingTimeoutMs?: number;        // per-spawn handshake deadline; a miss advances to the next candidate (default 1500)
  interpreterOverride?: string;  // JANUS_PYTHON
  synthDirOverride?: string;     // JANUS_PYTHON_SYNTH_DIR
  platform?: string;
  env?: NodeJS.ProcessEnv;
  spawnImpl?: typeof realSpawn;
  existsSync?: (p: string) => boolean;
  log?: (line: string) => void;
  backoffBaseMs?: number; backoffMaxMs?: number;
  // Task 5 breaker knobs (declared now so the type is stable across tasks):
  breakerThreshold?: number; breakerWindowMs?: number; cooldownMs?: number;
}

/** Ordered interpreter candidates: JANUS_PYTHON wins, else per-platform discovery (D4). */
export function discoverPythonInterpreter(env: NodeJS.ProcessEnv, platform: string): InterpreterCandidate[] {
  const override = env.JANUS_PYTHON && env.JANUS_PYTHON.trim();
  if (override) return [{ cmd: override, baseArgs: [] }];
  if (platform === "win32") {
    return [{ cmd: "py", baseArgs: ["-3"] }, { cmd: "python", baseArgs: [] }, { cmd: "python3", baseArgs: [] }];
  }
  return [{ cmd: "python3", baseArgs: [] }, { cmd: "python", baseArgs: [] }];
}

/** First-exists of [override, moduleDir/python, repoRoot/python] that contains synthesizer/__main__.py. */
export function resolveSynthDir(
  opts: { override?: string; moduleDir: string; repoRoot: string },
  existsSync: (p: string) => boolean,
): string | null {
  // Normalize to forward slashes so existsSync predicates (and tests) can use '/' consistently
  // on both POSIX and Windows without callers needing to know the platform separator.
  const norm = (p: string) => p.replace(/\\/g, "/");
  const candidates = [
    opts.override,
    norm(nodePath.join(opts.moduleDir, "python")),
    norm(nodePath.join(opts.repoRoot, "python")),
  ].filter(Boolean) as string[];
  for (const dir of candidates) {
    if (existsSync(norm(nodePath.join(dir, "synthesizer", "__main__.py")))) return dir;
    if (opts.override && dir === opts.override && existsSync(dir)) return dir; // override may already be a leaf
  }
  return null;
}

/** Compute this module's directory in both tsx/ESM (dev) and the esbuild CJS bundle (prod). */
export function defaultModuleDir(): string {
  // In the esbuild CJS bundle `__dirname` is defined (so `import.meta.url` is never evaluated);
  // under tsx/ESM `__dirname` is undefined and we fall back to `import.meta.url`. This mirrors the
  // dual-runtime idiom already proven in src/ptyTransport.ts (which builds clean to dist/server.cjs).
  return typeof __dirname !== "undefined" ? __dirname : nodePath.dirname(fileURLToPath(import.meta.url));
}

interface Pending {
  resolve: (r: SynthesizeResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function createPythonSynthClient(opts: PythonSynthClientOpts): PythonSynthClient {
  const spawnImpl = opts.spawnImpl ?? realSpawn;
  const existsSync = opts.existsSync ?? fs.existsSync;
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((l: string) => console.error(l));
  const requestExpiryMs = opts.requestExpiryMs ?? 2000;
  const pingTimeoutMs = opts.pingTimeoutMs ?? 1500;
  const backoffBaseMs = opts.backoffBaseMs ?? 250;
  const backoffMaxMs = opts.backoffMaxMs ?? 2000;
  const breakerThreshold = opts.breakerThreshold ?? 3;
  const breakerWindowMs = opts.breakerWindowMs ?? 10_000;
  const cooldownMs = opts.cooldownMs ?? 60_000;
  let consecutiveFails = 0;
  let firstFailAt = 0;
  let breakerUntil = 0;          // epoch ms; 0 = breaker closed

  const synthDir = resolveSynthDir(
    { override: opts.synthDirOverride ?? env.JANUS_PYTHON_SYNTH_DIR, moduleDir: opts.moduleDir, repoRoot: opts.repoRoot },
    existsSync,
  );
  const cands = discoverPythonInterpreter(env, platform);

  let child: any = null;
  let ready = false;             // a ping has ponged with a matching wire version
  let disposed = false;
  let buf = "";
  let seq = 0;
  const pending = new Map<string, Pending>();
  let candIndex = 0;             // which interpreter candidate we're on
  let discovering = true;        // true until one candidate pings OK (then we lock it)
  let attempt = 0;               // backoff exponent
  let pingTimer: ReturnType<typeof setTimeout> | null = null;
  let respawnTimer: ReturnType<typeof setTimeout> | null = null;

  function settleAll(result: SynthesizeResult) {
    for (const [, p] of pending) { clearTimeout(p.timer); p.resolve(result); }
    pending.clear();
  }
  function clearPingTimer() { if (pingTimer) { clearTimeout(pingTimer); pingTimer = null; } }

  function onLine(line: string) {
    line = line.trim();
    if (!line) return;
    let obj: any;
    try { obj = JSON.parse(line); } catch { log(`[synth] skip unparseable stdout line`); return; }
    const id = obj?.id;
    if (id === "__ping__") {
      if (PingResponseSchema.safeParse(obj).success) {
        ready = true; discovering = false; attempt = 0; consecutiveFails = 0; firstFailAt = 0; clearPingTimer();
        log(`[synth] ping ok (synthVersion=${obj?.synthVersion ?? "?"})`);
      } else {
        log(`[synth] ping rejected (v/shape mismatch)`); // the ping-timeout drives the candidate advance
      }
      return;
    }
    const p = pending.get(id);
    if (!p) return; // late/expired — ignore defensively
    pending.delete(id);
    clearTimeout(p.timer);
    const parsed = SynthesizeResponseSchema.safeParse(obj);
    if (parsed.success && parsed.data.ok) p.resolve({ ok: true, brief: parsed.data.brief });
    else p.resolve({ ok: false });
  }

  function spawnBlocked(): boolean { return Date.now() < breakerUntil; } // breaker OPEN ⇒ fallback-only

  function onDown(reason: string) {
    clearPingTimer();
    try { child?.kill(); } catch { /* already dead */ }
    ready = false; child = null;
    settleAll({ ok: false });
    log(`[synth] daemon down (${reason})`);
    if (discovering) candIndex = (candIndex + 1) % Math.max(1, cands.length); // try the next interpreter
    scheduleRespawn();
  }

  function scheduleRespawn() {
    if (disposed || !synthDir || cands.length === 0) return;
    const now = Date.now();
    if (firstFailAt === 0 || now - firstFailAt > breakerWindowMs) { firstFailAt = now; consecutiveFails = 0; }
    consecutiveFails++;
    if (consecutiveFails >= breakerThreshold) {
      breakerUntil = now + cooldownMs;
      consecutiveFails = 0; firstFailAt = 0; attempt = 0;
      log(`[synth] circuit breaker OPEN for ${cooldownMs}ms (fallback-only)`);
      respawnTimer = setTimeout(() => { breakerUntil = 0; log("[synth] breaker probe"); spawnDaemon(); }, cooldownMs);
    } else {
      const wait = Math.min(backoffMaxMs, backoffBaseMs * Math.pow(2, attempt++));
      respawnTimer = setTimeout(spawnDaemon, wait);
    }
    if (respawnTimer && typeof (respawnTimer as any).unref === "function") (respawnTimer as any).unref();
  }

  function spawnDaemon() {
    if (disposed || !synthDir || cands.length === 0) return;
    if (spawnBlocked()) return;
    const c = cands[candIndex % cands.length];
    const script = nodePath.join(synthDir, "synthesizer", "__main__.py");
    const args = [...c.baseArgs, "-X", "utf8", "-u", script];
    try {
      child = spawnImpl(c.cmd, args, {
        cwd: synthDir,
        env: { ...env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
        stdio: ["pipe", "pipe", "pipe"],
        // NEVER shell:true — argv array only (invariant I9).
      });
    } catch (e) {
      log(`[synth] spawn failed for "${c.cmd}": ${(e as Error).message}`);
      onDown("spawn-threw");
      return;
    }
    child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString("utf-8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); onLine(line); }
    });
    child.stderr?.on("data", (d: Buffer) => log(`[synth:py] ${d.toString("utf-8").trimEnd()}`));
    child.on("exit", () => onDown("exit"));
    child.on("error", () => onDown("error"));
    // Handshake: ping validates interpreter + script + protocol version in one round-trip.
    // If no valid pong lands within pingTimeoutMs, advance to the next candidate (D4 discovery).
    pingTimer = setTimeout(() => { if (!ready) onDown("ping-timeout"); }, pingTimeoutMs);
    if (pingTimer && typeof (pingTimer as any).unref === "function") (pingTimer as any).unref();
    try { child.stdin?.write(JSON.stringify({ id: "__ping__", v: WIRE_VERSION, op: "ping" }) + "\n"); }
    catch { onDown("stdin-write-failed"); }
  }

  spawnDaemon(); // eager pre-warm

  return {
    available() { return ready && !!child; },
    synthesizerState() { return ready && child ? "python" : "fallback"; },
    request(tiers, cfg, now) {
      if (disposed || !ready || !child) return Promise.resolve({ ok: false });
      const id = `r${++seq}`;
      return new Promise<SynthesizeResult>((resolve) => {
        const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false }); }, requestExpiryMs);
        if (typeof (timer as any).unref === "function") (timer as any).unref();
        pending.set(id, { resolve, timer });
        try {
          child.stdin.write(JSON.stringify({ id, v: WIRE_VERSION, op: "synthesize", now, cfg, tiers }) + "\n");
        } catch {
          pending.delete(id); clearTimeout(timer); resolve({ ok: false });
        }
      });
    },
    dispose() {
      disposed = true; ready = false;
      clearPingTimer();
      if (respawnTimer) { clearTimeout(respawnTimer); respawnTimer = null; }
      settleAll({ ok: false });
      try { child?.kill(); } catch { /* already dead */ }
      child = null;
    },
  };
}
