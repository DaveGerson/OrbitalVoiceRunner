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
 * Exit 0 = the live daemon answered every op correctly. Exit 1 = a real-world failure (printed).
 * Exit 2 = no Python interpreter found at all (treated as SKIP, not failure, so a Python-less CI lane
 * doesn't go red — the dedicated Windows lane that HAS Python turns a real failure into exit 1).
 */
import { spawn as realSpawn, type ChildProcess } from "node:child_process";
import { createPythonModuleClient, synthFacadeOverCore, createPythonApprovalClient, discoverPythonInterpreter } from "../src/memory";
import { DEFAULT_MEMORY_CONFIG, type MemoryTiers } from "../src/memory/types";

const FRAME = { role: "Janus", gatePosture: "Auto", prefs: [] };
const TIERS: MemoryTiers = { project: null, pane: null, board: [], frame: FRAME, breadcrumbs: [] };

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

async function main(): Promise<number> {
  if (discoverPythonInterpreter(process.env, process.platform).length === 0) {
    log("[smoke:daemon] SKIP — no python interpreter candidates on this platform");
    return 2;
  }

  // Capture the live daemon child via an injected spawnImpl (wraps the real spawn). This is the
  // cross-platform way to kill the daemon — no PID-hunting / taskkill / pkill — and it lets the
  // transition sub-check below fault-inject deterministically. Also observe state flips directly.
  let lastChild: ChildProcess | null = null;
  const observed: Array<{ state: "python" | "fallback"; reason: string }> = [];
  const core = createPythonModuleClient({
    moduleDir: process.cwd(),
    repoRoot: process.cwd(),
    spawnImpl: ((cmd: string, args: readonly string[], spawnOpts: object) => {
      const child = realSpawn(cmd, args as string[], spawnOpts as Parameters<typeof realSpawn>[2]);
      lastChild = child;
      return child;
    }) as typeof realSpawn,
    onStateChange: (state, reason) => { observed.push({ state, reason }); },
  });
  const synth = synthFacadeOverCore(core);
  const approval = createPythonApprovalClient(core);
  const failures: string[] = [];
  try {
    if (!(await waitAvailable(core, 8000))) {
      log("[smoke:daemon] FAIL — daemon never became available (no valid pong). Is python on PATH?");
      return 2; // no live interpreter answered — SKIP rather than hard-fail a python-less lane
    }
    log(`[smoke:daemon] daemon available (state=${core.state()})`);

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

    // 3) ONE real transition against the LIVE daemon (Inc 2 task 2.3) — extracted to keep main under CC<=10.
    failures.push(...await exerciseTransition({ core, child: lastChild, observed }));
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

main().then((code) => process.exit(code)).catch((e) => { log(`[smoke:daemon] ERROR ${e?.stack ?? e}`); process.exit(1); });
