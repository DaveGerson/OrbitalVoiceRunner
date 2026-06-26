// src/memory/pythonClient.ts — the warm Python daemon client (P0b, D3/D4; seam Inc 1, tasks 1.1/1.2).
// Optional + self-healing: a strict UPGRADE, never a dependency. Mirrors the node-pty
// loader posture in src/ptyTransport.ts (try → degrade to a flag, never throw at the seam).
//
// SHAPE (seam Inc 1): `createPythonModuleClient` is the GENERIC, op-agnostic transport core — it owns
// interpreter discovery, spawn, the ping handshake, line-framing, the pending-id map, request expiry,
// backoff, and the circuit breaker, and exposes a generic `request(op, payload)` that resolves the raw
// response object (or null on any miss) for the caller to validate. `createPythonSynthClient` is a
// THIN TYPED FACADE over the core: its `request(tiers, cfg, now)` signature is byte-identical to the
// pre-extraction client, so no positional-call site (index.ts) or test changes. New ops (e.g. the
// approval parser, src/memory/approvalClient.ts) add their own thin facade over the SAME core — one
// multiplexed daemon, one router, many typed facades.
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

/** The raw response object a correlated request resolves to, or null on any miss (unavailable /
 *  expiry / daemon-down / dispose). The TYPED FACADES validate the object with their op's schema. */
export type ModuleResponse = Record<string, unknown> | null;

export interface PythonModuleClient {
  /** Send one request for `op` with `payload`; resolves the raw response object, or null on any miss.
   *  NEVER rejects. The caller validates the object against its op-specific schema. */
  request(op: string, payload: Record<string, unknown>): Promise<ModuleResponse>;
  /** True only when a daemon has answered a ping and the breaker is closed. */
  available(): boolean;
  /** Observability: which path the next call would take. */
  state(): "python" | "fallback";
  /** Tear down the child + timers (idempotent). */
  dispose(): void;
}

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

export interface PythonModuleClientOpts {
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
  // Inc 2 task 2.2 observability: best-effort transition callback fired ONLY on a real python<->fallback
  // flip (debounced). Absent ⇒ no-op. Never influences a decision/return/timing; throws are swallowed.
  onStateChange?: (state: "python" | "fallback", reason: string) => void;
}

/** Back-compat alias — the synth facade and the generic core take the same options. */
export type PythonSynthClientOpts = PythonModuleClientOpts;

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
  resolve: (r: ModuleResponse) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Coalesce raw opts to a fully-defaulted config (kept out of createPythonModuleClient so its
 *  per-field `??` branches don't inflate that function's cyclomatic complexity). Each field is
 *  resolved via a per-key `?? default` table so there is no per-field branch in any one function:
 *  `??` is applied uniformly inside a single reduce, preserving the exact "undefined → default"
 *  semantics of the original inline coalescing (including falsy-but-defined values passing through). */
function resolveOpts(opts: PythonModuleClientOpts) {
  const defaults = {
    spawnImpl: realSpawn,
    existsSync: fs.existsSync,
    platform: process.platform,
    env: process.env,
    log: ((l: string) => console.error(l)) as (line: string) => void,
    requestExpiryMs: 2000,
    pingTimeoutMs: 1500,
    backoffBaseMs: 250,
    backoffMaxMs: 2000,
    breakerThreshold: 3,
    breakerWindowMs: 10_000,
    cooldownMs: 60_000,
  };
  const out = { ...defaults };
  for (const k of Object.keys(defaults) as (keyof typeof defaults)[]) {
    const v = (opts as unknown as Record<string, unknown>)[k];
    if (v !== undefined && v !== null) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/**
 * The GENERIC, op-agnostic warm-daemon transport core (seam Inc 1, task 1.1). Owns the entire
 * spawn/discovery/breaker/framing/pending/expiry machine that used to live inside the synth client;
 * `request(op, payload)` writes `{ id, v, op, ...payload }` and resolves the raw correlated response
 * object (or null on any miss). Typed facades (synth, approval) validate that object themselves.
 */
export function createPythonModuleClient(opts: PythonModuleClientOpts): PythonModuleClient {
  const {
    spawnImpl, existsSync, platform, env, log, requestExpiryMs, pingTimeoutMs,
    backoffBaseMs, backoffMaxMs, breakerThreshold, breakerWindowMs, cooldownMs,
  } = resolveOpts(opts);
  const onStateChange = opts.onStateChange; // Inc 2 task 2.2: observability transition callback (optional)
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
  // Inc 2 task 2.2: last emitted observability state (debounce). Seeded "fallback" = the system's TRUE
  // initial posture (TS authoritative until the daemon pongs), so a never-up daemon stays SILENT and
  // only a genuine python<->fallback FLIP emits — the frame stream is transitions, not a boot artifact.
  let lastState: "python" | "fallback" = "fallback";
  let disposed = false;
  let buf = "";
  let seq = 0;
  const pending = new Map<string, Pending>();
  let candIndex = 0;             // which interpreter candidate we're on
  let discovering = true;        // true until one candidate pings OK (then we lock it)
  let attempt = 0;               // backoff exponent
  let pingTimer: ReturnType<typeof setTimeout> | null = null;
  let respawnTimer: ReturnType<typeof setTimeout> | null = null;

  function settleAll(result: ModuleResponse) {
    for (const [, p] of pending) { clearTimeout(p.timer); p.resolve(result); }
    pending.clear();
  }
  function clearPingTimer() { if (pingTimer) { clearTimeout(pingTimer); pingTimer = null; } }
  /** Inc 2 task 2.2 observability: fire onStateChange ONLY on a real flip. Computes state EXACTLY as
   *  state() (`ready && child ? "python" : "fallback"`), debounces on lastState, and swallows throws so
   *  a buggy callback can NEVER escape into the daemon state machine. Best-effort, fire-and-forget. */
  function emitState(reason: string) {
    const s: "python" | "fallback" = ready && child ? "python" : "fallback";
    if (s === lastState) return;
    lastState = s;
    try { onStateChange?.(s, reason); } catch { /* best-effort: a throwing callback must never escape */ }
  }

  function handlePong(obj: any) {
    if (PingResponseSchema.safeParse(obj).success) {
      ready = true; discovering = false; attempt = 0; consecutiveFails = 0; firstFailAt = 0; clearPingTimer();
      log(`[synth] ping ok (synthVersion=${obj?.synthVersion ?? "?"})`);
      emitState("ping-ok"); // observability up-edge: state resolves to "python" (debounced)
    } else {
      log(`[synth] ping rejected (v/shape mismatch)`); // the ping-timeout drives the candidate advance
    }
  }

  function handleResponse(id: any, obj: any) {
    const p = pending.get(id);
    if (!p) return; // late/expired — ignore defensively
    pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(obj as ModuleResponse); // the typed facade validates the shape against its op schema
  }

  function onLine(line: string) {
    line = line.trim();
    if (!line) return;
    let obj: any;
    try { obj = JSON.parse(line); } catch { log(`[synth] skip unparseable stdout line`); return; }
    const id = obj?.id;
    if (id === "__ping__") { handlePong(obj); return; }
    handleResponse(id, obj);
  }

  function spawnBlocked(): boolean { return Date.now() < breakerUntil; } // breaker OPEN ⇒ fallback-only

  function onDown(reason: string) {
    clearPingTimer();
    try { child?.kill(); } catch { /* already dead */ }
    ready = false; child = null;
    emitState(reason); // observability down-edge: child nulled ⇒ state resolves to "fallback" (debounced)
    settleAll(null);
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
      respawnTimer = setTimeout(() => { breakerUntil = 0; discovering = true; candIndex = 0; log("[synth] breaker probe (re-discover)"); spawnDaemon(); }, cooldownMs);
    } else {
      const wait = Math.min(backoffMaxMs, backoffBaseMs * Math.pow(2, attempt++));
      respawnTimer = setTimeout(spawnDaemon, wait);
    }
    if (respawnTimer && typeof (respawnTimer as any).unref === "function") (respawnTimer as any).unref();
  }

  /** Spawn the candidate's child; on a thrown spawn, tear down and return null. */
  function trySpawnChild(c: InterpreterCandidate): any {
    const script = nodePath.join(synthDir!, "synthesizer", "__main__.py");
    const args = [...c.baseArgs, "-X", "utf8", "-u", script];
    try {
      return spawnImpl(c.cmd, args, {
        cwd: synthDir!,
        env: { ...env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
        stdio: ["pipe", "pipe", "pipe"],
        // NEVER shell:true — argv array only (invariant I9).
      });
    } catch (e) {
      log(`[synth] spawn failed for "${c.cmd}": ${(e as Error).message}`);
      onDown("spawn-threw");
      return null;
    }
  }

  /** Wire stdout line-framing + stderr logging + exit/error teardown onto the live child. */
  function wireChildStreams() {
    // Belt-and-suspenders: unref the child so a forgotten dispose() can't pin the event loop.
    // Optional-chained — the fake child in tests has no unref.
    child.unref?.();
    child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString("utf-8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); onLine(line); }
    });
    child.stderr?.on("data", (d: Buffer) => log(`[synth:py] ${d.toString("utf-8").trimEnd()}`));
    child.on("exit", () => onDown("exit"));
    child.on("error", () => onDown("error"));
  }

  /** Arm the handshake deadline and send the ping that validates interpreter+script+version. */
  function sendHandshake() {
    // Handshake: ping validates interpreter + script + protocol version in one round-trip.
    // If no valid pong lands within pingTimeoutMs, advance to the next candidate (D4 discovery).
    pingTimer = setTimeout(() => { if (!ready) onDown("ping-timeout"); }, pingTimeoutMs);
    if (pingTimer && typeof (pingTimer as any).unref === "function") (pingTimer as any).unref();
    try { child.stdin?.write(JSON.stringify({ id: "__ping__", v: WIRE_VERSION, op: "ping" }) + "\n"); }
    catch { onDown("stdin-write-failed"); }
  }

  function spawnDaemon() {
    if (disposed || !synthDir || cands.length === 0) return;
    if (spawnBlocked()) return;
    const c = cands[candIndex % cands.length];
    child = trySpawnChild(c);
    if (!child) return;
    wireChildStreams();
    sendHandshake();
  }

  spawnDaemon(); // eager pre-warm

  return {
    available() { return ready && !!child; },
    state() { return ready && child ? "python" : "fallback"; },
    request(op, payload) {
      if (disposed || !ready || !child) return Promise.resolve(null);
      const id = `r${++seq}`;
      return new Promise<ModuleResponse>((resolve) => {
        // In-flight rule: the awaited request DEPENDS on this expiry to settle when the daemon is
        // silent, so it must hold the loop while pending. Every settle path clears it (onLine,
        // write-failure below, settleAll via onDown/dispose), so it can never outlive the request.
        const timer = setTimeout(() => { pending.delete(id); resolve(null); }, requestExpiryMs);
        pending.set(id, { resolve, timer });
        try {
          child.stdin.write(JSON.stringify({ id, v: WIRE_VERSION, op, ...payload }) + "\n");
        } catch {
          pending.delete(id); clearTimeout(timer); resolve(null);
        }
      });
    },
    dispose() {
      disposed = true; ready = false;
      clearPingTimer();
      if (respawnTimer) { clearTimeout(respawnTimer); respawnTimer = null; }
      settleAll(null);
      try { child?.kill(); } catch { /* already dead */ }
      child = null;
    },
  };
}

/**
 * The SYNTH typed facade OVER AN EXISTING CORE (seam Inc 1, task 1.2). Owns ONLY the synth op's wire
 * mapping: `synthesize` payload in, `SynthesizeResponseSchema` validation out. Exported so the server
 * can build BOTH the synth facade and the approval facade over ONE shared core (one multiplexed
 * daemon). `dispose()` tears down the shared core — call it once for all facades over that core.
 */
export function synthFacadeOverCore(core: PythonModuleClient): PythonSynthClient {
  return {
    available() { return core.available(); },
    synthesizerState() { return core.state(); },
    request(tiers, cfg, now) {
      return core.request("synthesize", { now, cfg, tiers }).then((obj) => {
        if (!obj) return { ok: false };
        const parsed = SynthesizeResponseSchema.safeParse(obj);
        return parsed.success && parsed.data.ok ? { ok: true, brief: parsed.data.brief } : { ok: false };
      });
    },
    dispose() { core.dispose(); },
  };
}

/**
 * Back-compat factory: a synth client with its OWN private core. The `request(tiers, cfg, now)`
 * signature is byte-identical to the pre-extraction client, so index.ts and the ~6 positional-call
 * test files don't change. Server code that wants to SHARE one daemon across ops builds the core
 * itself (createPythonModuleClient) and uses synthFacadeOverCore + createPythonApprovalClient.
 */
export function createPythonSynthClient(opts: PythonSynthClientOpts): PythonSynthClient {
  return synthFacadeOverCore(createPythonModuleClient(opts));
}
