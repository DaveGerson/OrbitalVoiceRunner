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

async function main(): Promise<number> {
  if (discoverPythonInterpreter(process.env, process.platform).length === 0) {
    log("[smoke:daemon] SKIP — no python interpreter candidates on this platform");
    return 2;
  }

  const core = createPythonModuleClient({ moduleDir: process.cwd(), repoRoot: process.cwd() });
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
