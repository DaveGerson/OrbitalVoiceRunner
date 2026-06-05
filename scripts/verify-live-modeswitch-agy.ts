/**
 * P5 live mode-switch verification — ANTIGRAVITY (agy) column. Bead wsm-e2e-pinned-8sw.
 *
 * agy v1.0.4's permission-cycle axis is UNVERIFIED (spec §5 marks it LOW confidence):
 * the AntigravityAdapter assumes shift+down (ESC[1;2B) MIGHT cycle a permission mode
 * but ships readyForLiveCycle=false + restart-resume until proven. This harness drives a
 * REAL agy pane over ConPTY and answers empirically:
 *   1. Does an agy interactive TUI even come up here (vs. auth prompt / immediate exit)?
 *   2. Is there a permission/mode indicator in the status bar?
 *   3. Does shift+down (ESC[1;2B) — or shift+tab (ESC[Z) as a fallback axis — cycle it?
 *
 * Whatever the answer, it CONFIRMS or CORRECTS the adapter. A negative result (no live
 * axis in v1.0.4) is a valid completion: it proves restart-resume is the right floor.
 *
 * Run:  AGY_BIN="C:\\Users\\...\\agy.exe" npx tsx scripts/verify-live-modeswitch-agy.ts
 *       (optional AGY_ARGS="-i hello" to force an interactive seed prompt)
 * Exit: 0 = a cycle axis visibly moved the mode marker (>=2 distinct markers).
 *       2 = TUI came up but NO probed key changed the marker (no live axis → restart-resume confirmed).
 *       3 = pane exited immediately / never showed a TUI (needs auth or different launch).
 *       1 = harness error.
 * NOTE (Windows): node-pty's console-list WORKER can crash the process with exit 255
 *       during teardown (the known "AttachConsole failed" artifact) — uncatchable from the
 *       main thread. The VERDICT is printed BEFORE teardown, so trust the logged markers /
 *       RESULT line, not the final exit code, if you see 255.
 *
 * Requires agy installed (+ authenticated for a full session). agy is NOT on PATH —
 * pass AGY_BIN or it defaults to the known install path.
 */
import { UniversalTerminal } from "../src/terminal";

const AGY_BIN = process.env.AGY_BIN || "C:\\Users\\gerso\\AppData\\Local\\agy\\bin\\agy.exe";
const AGY_ARGS = process.env.AGY_ARGS || ""; // e.g. "-i hello" to force an interactive seed
const SHIFT_DOWN = "\x1b[1;2B"; // ESC [ 1 ; 2 B — the adapter's assumed cycle axis
const SHIFT_TAB = "\x1b[Z";     // ESC [ Z — fallback axis (the Claude convention)
const STARTUP_MS = 10000;       // agy may be slower to bring up its TUI
const SETTLE_MS = 2200;
const PROBES_PER_AXIS = 4;
const HARD_TIMEOUT_MS = 90000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function log(...a: any[]) { console.log("[p5-agy]", ...a); }

// node-pty/ConPTY throws "AttachConsole failed" from a worker during child teardown on
// Windows — a known display artifact, not a harness failure. Swallow ONLY that.
process.on("uncaughtException", (e) => {
  if (String((e as any)?.message ?? e).includes("AttachConsole")) return;
  console.error("[p5-agy] uncaught:", e);
  process.exit(1);
});

function stripAnsi(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1B\][^\x07]*(\x07|\x1B\\)/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}

let raw = "";
function tail(maxLines = 8): string {
  const lines = stripAnsi(raw).split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim().length > 0);
  return lines.slice(-maxLines).join("  ¶  ");
}
// agy permission tokens (spec §5): request-review | proceed-in-sandbox | always-proceed | strict.
// Broadened to catch any mode/permission/login indicator the status bar may use.
function modeMarker(): string | null {
  const kw = /(request-review|proceed-in-sandbox|always-proceed|strict|sandbox|permission|approve|auto-approve|shift\+|tab to cycle|sign in|log ?in|authenticat|⏵|⏸|❯)/i;
  const lines = stripAnsi(raw).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) if (kw.test(lines[i])) return lines[i];
  return null;
}

async function probeAxis(term: UniversalTerminal, name: string, bytes: string): Promise<string[]> {
  const seen: string[] = [];
  for (let i = 1; i <= PROBES_PER_AXIS; i++) {
    term.writeRaw(bytes);
    await sleep(SETTLE_MS);
    const m = modeMarker();
    seen.push(m ?? "(null)");
    log(`  ${name} #${i}: marker=${JSON.stringify(m)}`);
  }
  return seen;
}

async function main() {
  const hardKill = setTimeout(() => { console.error("[p5-agy] HARD TIMEOUT"); process.exit(1); }, HARD_TIMEOUT_MS);
  const cwd = process.cwd();
  const shellCmd = AGY_ARGS ? `${AGY_BIN} ${AGY_ARGS}` : AGY_BIN;

  // HITL launch floor (agy default = request-review). Constructor auto-wires AntigravityAdapter.
  const term = new UniversalTerminal("p5-agy", cwd, shellCmd, "Antigravity", "Human-in-the-Loop", "");
  term.onOutput = (_id: string, chunk: string) => {
    raw += chunk;
    if (raw.length > 250_000) raw = raw.slice(-120_000);
  };

  log("agy bin     :", AGY_BIN);
  log("launch cmd  :", JSON.stringify((term as any).shellCmd));
  term.start();
  log(`spawned     : pid=${(term as any).shellPid} usingNodePty=${(term as any).usingNodePty}`);

  for (let i = 0; i < STARTUP_MS / 1000; i++) {
    await sleep(1000);
    if (term.status === "Exited") {
      log(`EXITED during startup (t+${i + 1}s) — agy printed and quit (help/auth/bad-launch).`);
      log(`startup tail: ${JSON.stringify(tail().slice(-400))}`);
      clearTimeout(hardKill);
      process.exit(3);
    }
  }
  log(`startup OK  : status=${term.status}, ${stripAnsi(raw).length} cleaned chars`);
  log(`startup tail: ${JSON.stringify(tail().slice(-400))}`);

  const floorMarker = modeMarker();
  log(`floor marker: ${JSON.stringify(floorMarker)}`);

  log("=== probe axis A: shift+down (ESC[1;2B) — the adapter's assumed axis ===");
  const axisDown = await probeAxis(term, "shift+down", SHIFT_DOWN);
  log("=== probe axis B: shift+tab (ESC[Z) — fallback (Claude convention) ===");
  const axisTab = await probeAxis(term, "shift+tab", SHIFT_TAB);

  clearTimeout(hardKill);

  // Compute + print the verdict BEFORE teardown: on Windows the node-pty console-list
  // WORKER can crash the process with exit 255 during stop() (the AttachConsole artifact),
  // and a worker-thread throw is NOT catchable from the main thread. Emitting the result
  // first guarantees the finding survives even if the exit code is then clobbered.
  const all = [floorMarker ?? "(null)", ...axisDown, ...axisTab];
  const distinct = new Set(all.filter((m) => m !== "(null)"));
  const downDistinct = new Set(axisDown.filter((m) => m !== "(null)"));
  const tabDistinct = new Set(axisTab.filter((m) => m !== "(null)"));

  log("=== VERDICT ===");
  log(`  distinct non-null markers overall: ${distinct.size}`);
  log(`  shift+down moved it: ${downDistinct.size > 1 || (floorMarker && downDistinct.size >= 1 && !downDistinct.has(floorMarker))}`);
  log(`  shift+tab  moved it: ${tabDistinct.size > 1 || (floorMarker && tabDistinct.size >= 1 && !tabDistinct.has(floorMarker))}`);
  for (const m of distinct) log(`    • ${JSON.stringify(m)}`);

  const inconclusive = distinct.size <= 1;
  if (inconclusive) {
    log("RESULT: no permission/mode axis responded to either key — agy v1.0.4 exposes no live "
      + "cycle axis reachable this way (commonly because it is unauthenticated and sits at the "
      + "login selector). readyForLiveCycle=false + restart-resume is CONFIRMED correct.");
  } else {
    log("RESULT: a cycle axis moved the marker — capture the strings above into "
      + "AntigravityAdapter.parseCurrentMode and reconsider readyForLiveCycle.");
  }

  try { await term.stop(); } catch { /* ConPTY teardown noise — ignore */ }
  process.exit(inconclusive ? 2 : 0);
}

main().catch((e) => { console.error("[p5-agy] ERROR:", e); process.exit(1); });
