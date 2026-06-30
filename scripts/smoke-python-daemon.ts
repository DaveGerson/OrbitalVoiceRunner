/**
 * Live-spawn smoke for the warm Python daemon (seam Inc 2, task 2.4 — Windows reliability).
 *
 * Everything in the unit suite uses a FAKE child process. This is the ONLY check that boots the REAL
 * interpreter (`py -3` / `python3`) running python/synthesizer/__main__.py and exercises the actual
 * stdio NDJSON round-trip end-to-end: ping handshake -> synthesize -> approval.parse. Run it on the
 * target OS (esp. Windows) to catch interpreter-discovery / launcher / encoding / import-path breakage
 * that fakes can never surface.
 *
 *   npm run smoke:daemon
 *
 * Exit 0 = the live daemon answered every op correctly. Exit 1 = a real-world failure (printed) —
 * this INCLUDES "an interpreter is present but the daemon never returned a valid PONG" (a broken
 * daemon is a real failure, NOT a skip). Exit 2 = no Python interpreter found AT ALL (treated as
 * SKIP, not failure, so a Python-less CI lane doesn't go red — the dedicated Windows lane that HAS
 * Python turns a real failure into exit 1). The ONLY exit-2 path is the zero-candidate gate below.
 */
import { spawn as realSpawn, type ChildProcess } from "node:child_process";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { createPythonModuleClient, synthFacadeOverCore, createPythonApprovalClient, discoverPythonInterpreter, type PythonSynthClient, type PythonApprovalClient } from "../src/memory";
import { DEFAULT_MEMORY_CONFIG, type MemoryTiers } from "../src/memory/types";

const FRAME = { role: "Janus", gatePosture: "Auto", prefs: [] };
const TIERS: MemoryTiers = { project: null, pane: null, board: [], frame: FRAME, breadcrumbs: [] };

// Cold-start tolerance for THIS diagnostic only (never production — the live client keeps its snappy
// 1500ms default so real callers fall back fast). On a fresh Windows CI runner the FIRST spawn of an
// interpreter pays Defender's real-time scan of the new process image (seconds), which blew the stock
// 1500ms handshake deadline → 4× ping-timeout → RED. A generous per-spawn deadline lets the one cold
// spawn pong; the wider availability window leaves headroom for a single warm retry. With JANUS_PYTHON
// pinned (CI), discovery is one candidate, so these govern that single known-good interpreter.
const SMOKE_PING_TIMEOUT_MS = 10_000;
const SMOKE_AVAILABLE_TIMEOUT_MS = 30_000;

function log(line: string): void { process.stdout.write(line + "\n"); }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitAvailable(core: { available(): boolean }, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (core.available()) return true;
    await sleep(50);
  }
  return core.available();
}

/** Poll core.state() until it equals `want` (or timeout). Cross-platform, no timers beyond sleep. */
async function waitState(core: { state(): "python" | "fallback" }, want: "python" | "fallback", timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (core.state() === want) return true;
    await sleep(50);
  }
  return core.state() === want;
}

interface TransitionCtx {
  core: { state(): "python" | "fallback" };
  child: ChildProcess | null;
  observed: Array<{ state: "python" | "fallback"; reason: string }>;
}

/**
 * Inc 2 task 2.3: exercise ONE real transition against the LIVE daemon — kill the daemon child, assert a
 * flip to "fallback" (the daemon-down / onStateChange signal), then assert SELF-HEAL back to "python"
 * (the client auto-respawns). Returns the failure list (empty = pass). Degrades gracefully: if we never
 * captured a child or `kill()` can't signal, it LOGS + SKIPs rather than hard-failing the smoke.
 * Extracted from main() so main stays under the CC<=10 lint gate.
 */
async function exerciseTransition(t: TransitionCtx): Promise<string[]> {
  const failures: string[] = [];
  const { core, child, observed } = t;
  if (!child || typeof child.pid !== "number") {
    log("[smoke:daemon] SKIP transition sub-check — no live daemon child handle to fault-inject");
    return failures;
  }
  const downBefore = observed.filter((o) => o.state === "fallback").length;
  let killed = false;
  try { killed = child.kill(); } catch { killed = false; }
  if (!killed) {
    log("[smoke:daemon] SKIP transition sub-check — could not signal the daemon child (kill returned false)");
    return failures;
  }
  // a) the down transition: state must flip to "fallback" and onStateChange must fire.
  const sawFallback = await waitState(core, "fallback", 5000);
  const downAfter = observed.filter((o) => o.state === "fallback").length;
  if (!sawFallback) failures.push("after killing the daemon child, core.state() never flipped to 'fallback'");
  else if (downAfter <= downBefore) failures.push("daemon went down but no onStateChange('fallback') was observed");
  else log(`[smoke:daemon] transition: observed daemon DOWN -> fallback (reason=${observed[observed.length - 1]?.reason})`);
  // b) self-heal: the client auto-respawns; state must return to "python".
  const sawHeal = await waitState(core, "python", 12000);
  if (!sawHeal) failures.push("after the daemon child died, the client never self-healed back to 'python'");
  else log("[smoke:daemon] transition: observed self-heal fallback -> python (auto-respawn)");
  return failures;
}

/**
 * Injectable deps for main(). Defaults are the real process/spawn/discovery so the npm `smoke:daemon`
 * lane (the auto-run at the bottom) is byte-for-byte unchanged. Tests override `discover` + `spawnImpl`
 * to drive the three-way exit contract (SKIP=2 / FAIL=1 / PASS=0) WITHOUT a real interpreter.
 */
export interface SmokeDeps {
  env: NodeJS.ProcessEnv;
  platform: string;
  cwd: () => string;
  spawnImpl: typeof realSpawn;
  discover: typeof discoverPythonInterpreter;
  // synth-dir existence probe (defaults to the real fs). Injectable so a test can drive the live path
  // with a fake child WITHOUT a real python/ tree on disk — otherwise resolveSynthDir returns null and
  // the client never spawns, masking the present-but-no-pong path under test.
  existsSync?: (p: string) => boolean;
  // Cold-start timeouts (injectable so the unit test drives the present-but-no-pong FAIL path fast
  // instead of waiting the full generous window). Defaults are the CI-tolerant constants above.
  pingTimeoutMs?: number;        // per-spawn handshake deadline handed to the daemon core
  availableTimeoutMs?: number;   // how long main() waits for the first valid pong before FAIL
}

const DEFAULT_DEPS: SmokeDeps = {
  env: process.env,
  platform: process.platform,
  cwd: process.cwd,
  spawnImpl: realSpawn,
  discover: discoverPythonInterpreter,
  pingTimeoutMs: SMOKE_PING_TIMEOUT_MS,
  availableTimeoutMs: SMOKE_AVAILABLE_TIMEOUT_MS,
};

/**
 * Build the shared daemon core wired through the injected deps. Returns the core, a live snapshot of
 * the last-spawned child (for the transition fault-injection), and the observed state-flip log.
 * Extracted from main() so main stays under the CC<=10 lint gate (the conditional existsSync spread
 * + the spawn-capturing wrapper otherwise push it over).
 */
function buildCore(deps: SmokeDeps): {
  core: ReturnType<typeof createPythonModuleClient>;
  getLastChild: () => ChildProcess | null;
  observed: Array<{ state: "python" | "fallback"; reason: string }>;
} {
  // Capture the live daemon child via an injected spawnImpl (wraps the real spawn). This is the
  // cross-platform way to kill the daemon — no PID-hunting / taskkill / pkill — and it lets the
  // transition sub-check below fault-inject deterministically. Also observe state flips directly.
  let lastChild: ChildProcess | null = null;
  const observed: Array<{ state: "python" | "fallback"; reason: string }> = [];
  const core = createPythonModuleClient({
    moduleDir: deps.cwd(),
    repoRoot: deps.cwd(),
    env: deps.env,
    platform: deps.platform,
    pingTimeoutMs: deps.pingTimeoutMs ?? SMOKE_PING_TIMEOUT_MS, // CI cold-start tolerance (diagnostic only; see constant above)
    ...(deps.existsSync ? { existsSync: deps.existsSync } : {}), // undefined ⇒ client's real-fs default (npm lane unchanged)
    spawnImpl: ((cmd: string, args: readonly string[], spawnOpts: object) => {
      const child = deps.spawnImpl(cmd, args as string[], spawnOpts as Parameters<typeof realSpawn>[2]);
      lastChild = child;
      return child;
    }) as typeof realSpawn,
    onStateChange: (state, reason) => { observed.push({ state, reason }); },
  });
  return { core, getLastChild: () => lastChild, observed };
}

/**
 * Run the two op round-trips against the LIVE daemon and collect any mismatches (empty = all passed):
 * (1) one synthesize, (2) the approval.parse golden grid. Extracted from main() so main stays under
 * the CC<=10 lint gate; the assertions are byte-identical to the inline versions they replaced.
 */
async function runDaemonOps(synth: PythonSynthClient, approval: PythonApprovalClient): Promise<string[]> {
  const failures: string[] = [];
  // 1) synthesize round-trip
  const brief = await synth.request(TIERS, DEFAULT_MEMORY_CONFIG, 0);
  if (!brief.ok || typeof brief.brief.text !== "string") failures.push(`synthesize returned ${JSON.stringify(brief)}`);
  else log(`[smoke:daemon] synthesize ok (text=${JSON.stringify(brief.brief.text.slice(0, 40))}...)`);

  // 2) approval.parse round-trips — exercise the boundary cases the golden grid pins offline.
  const cases: Array<[string, unknown]> = [
    ["approve the second one", { intent: "approve", targetHint: { ordinal: 2 } }],
    ["skip that for now", { intent: "defer" }],
    ["dont run", { intent: "reject" }],
    ["approve but reject", { intent: "clarify" }],
    ["what does this do", { intent: "none" }],
  ];
  for (const [utter, want] of cases) {
    const got = await approval.parse(utter);
    if (JSON.stringify(got) !== JSON.stringify(want)) failures.push(`approval.parse(${JSON.stringify(utter)}) = ${JSON.stringify(got)} (want ${JSON.stringify(want)})`);
  }
  if (!failures.length) log(`[smoke:daemon] approval.parse ok (${cases.length} live round-trips matched the offline golden behavior)`);
  return failures;
}

export async function main(deps: SmokeDeps = DEFAULT_DEPS): Promise<number> {
  if (deps.discover(deps.env, deps.platform).length === 0) {
    log("[smoke:daemon] SKIP — no python interpreter candidates on this platform");
    return 2; // the ONLY legitimate exit-2: a genuinely python-less box. Everything else is 0 or 1.
  }

  const { core, getLastChild, observed } = buildCore(deps);
  const synth = synthFacadeOverCore(core);
  const approval = createPythonApprovalClient(core);
  const failures: string[] = [];
  try {
    if (!(await waitAvailable(core, deps.availableTimeoutMs ?? SMOKE_AVAILABLE_TIMEOUT_MS))) {
      log("[smoke:daemon] FAIL — daemon never became available (no valid pong). Is python on PATH?");
      return 1; // interpreter present but no valid pong — broken daemon, FAIL (1), NOT skip. (We
      //           only reach here AFTER the zero-candidate gate above passed, so an interpreter
      //           exists; a present-but-broken daemon is a real-world failure and must go RED.)
    }
    log(`[smoke:daemon] daemon available (state=${core.state()})`);

    // 1+2) the two op round-trips (synthesize + approval golden grid) — extracted to keep main CC<=10.
    failures.push(...await runDaemonOps(synth, approval));

    // 3) ONE real transition against the LIVE daemon (Inc 2 task 2.3) — extracted to keep main under CC<=10.
    failures.push(...await exerciseTransition({ core, child: getLastChild(), observed }));
  } finally {
    core.dispose();
  }

  if (failures.length) {
    log("[smoke:daemon] FAIL:");
    for (const f of failures) log("  - " + f);
    return 1;
  }
  log("[smoke:daemon] PASS — the live Python daemon answered ping + synthesize + approval.parse correctly.");
  return 0;
}

// Only run the live smoke when invoked as a script (not when imported by tests/test_smoke_python_daemon.ts).
const INVOKED_DIRECTLY =
  process.argv[1] != null && nodePath.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (INVOKED_DIRECTLY) {
  main().then((code) => process.exit(code)).catch((e) => { log(`[smoke:daemon] ERROR ${e?.stack ?? e}`); process.exit(1); });
}
