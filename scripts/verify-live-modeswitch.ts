/**
 * P5 live mode-switch verification — bead wsm-e2e-pinned-8sw (spec §12).
 *
 * Live-verifies what unit tests CANNOT (the fixture-vs-real gap): that a real
 * Claude pane over ConPTY actually cycles its permission ring when we deliver
 * ESC[Z (Shift+Tab) through the new writeRaw() primitive, and CAPTURES the real
 * status-bar marker strings at each ring stop — the strings that back
 * `parseCurrentMode` in src/agents/claude.ts.
 *
 * It exercises the REAL stack end to end: UniversalTerminal + ClaudeAdapter
 * (P2/P3 launch flags: --session-id <uuid> --allow-dangerously-skip-permissions
 * --permission-mode) + writeRaw (P1) + PtyTransport/ConPTY. No browser, no voice.
 *
 * Run:  npm run verify:modeswitch   (or: npx tsx scripts/verify-live-modeswitch.ts)
 * Exit: 0 = ESC[Z visibly cycled the live mode ring (>=2 distinct markers seen).
 *       2 = inconclusive (delivery worked but markers didn't change — needs tuning).
 *       1 = pane died / harness error.
 *
 * Requires Claude Code installed + authenticated (OAuth keychain is fine).
 * Codex (not installed locally) and agy (interactive, v1.0.4 axis) stay manual —
 * see the runbook the harness prints at the end.
 */
import { UniversalTerminal } from "../src/terminal";

const ESC_SHIFT_TAB = "\x1b\x5b\x5a"; // ESC [ Z = 0x1b 0x5b 0x5a — Claude live mode-cycle key
const STARTUP_MS = 8000;   // let the TUI come up
const SETTLE_MS = 2000;    // let the status bar redraw after each ESC[Z
const RING_PROBES = 5;     // default -> acceptEdits -> plan -> auto -> (wrap)
const HARD_TIMEOUT_MS = 70000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function log(...a: any[]) { console.log("[p5]", ...a); }

// Strip ANSI/CSI, OSC, and stray control bytes so mode markers survive the TUI's
// cursor-move / color redraw noise.
function stripAnsi(s: string): string {
  return s
    .replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B\][^\x07]*(\x07|\x1B\\)/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}

let raw = "";
function tail(maxLines = 6): string {
  const lines = stripAnsi(raw).split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim().length > 0);
  return lines.slice(-maxLines).join("  ¶  ");
}
// The mode indicator is a bottom line mentioning a permission keyword; scan from
// the newest line so we read the CURRENT ring stop, never a stale frame.
function modeMarker(): string | null {
  const kw = /(accept edits|plan mode|plan on|bypass|dangerously|normal mode|ask each|auto mode|shift\+tab to cycle|⏵)/i;
  const lines = stripAnsi(raw).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) if (kw.test(lines[i])) return lines[i];
  return null;
}

async function main() {
  const hardKill = setTimeout(() => { console.error("[p5] HARD TIMEOUT"); process.exit(1); }, HARD_TIMEOUT_MS);
  const cwd = process.cwd();

  // Start in Human-in-the-Loop so the launch floor is Claude `default`; ESC[Z then
  // walks the full ring. Constructor auto-wires ClaudeAdapter (P2/P3).
  const term = new UniversalTerminal("p5-claude", cwd, "claude", "Claude Code", "Human-in-the-Loop", "");
  term.onOutput = (_id: string, chunk: string) => {
    raw += chunk;
    if (raw.length > 200_000) raw = raw.slice(-100_000);
  };

  log("launch argv :", JSON.stringify((term as any).shellCmd));
  term.start();
  log(`spawned     : pid=${(term as any).shellPid} usingNodePty=${(term as any).usingNodePty}`);
  log(`session pin : ${term.sessionId}`);

  for (let i = 0; i < STARTUP_MS / 1000; i++) {
    await sleep(1000);
    if (term.status === "Exited") { log("FAIL: pane exited during startup."); clearTimeout(hardKill); process.exit(1); }
  }
  log(`startup OK  : status=${term.status}, ${stripAnsi(raw).length} cleaned chars of TUI output`);

  const obs: { step: number; marker: string | null; tail: string }[] = [];
  await sleep(SETTLE_MS);
  obs.push({ step: 0, marker: modeMarker(), tail: tail() }); // launch floor

  for (let step = 1; step <= RING_PROBES; step++) {
    term.writeRaw(ESC_SHIFT_TAB); // the P1 primitive — verbatim ESC[Z, no appended CR
    await sleep(SETTLE_MS);
    obs.push({ step, marker: modeMarker(), tail: tail() });
  }

  await term.stop();
  clearTimeout(hardKill);

  log("=== OBSERVED CLAUDE RING (step = cumulative Shift+Tab presses) ===");
  for (const o of obs) {
    log(`  step ${o.step}: marker=${JSON.stringify(o.marker)}`);
    log(`           tail=${JSON.stringify(o.tail.slice(-200))}`);
  }

  log("=== REMAINING (manual — out of harness reach) ===");
  log("  Codex : binary NOT installed locally → install `codex`, then verify the");
  log("          /permissions picker live-switch path (Shift+Tab is Plan/Default, NOT perms).");
  log("  agy   : v1.0.4 at %LOCALAPPDATA%\\agy\\bin\\agy.exe → verify shift+down (ESC[1;2B)");
  log("          cycle axis + that /permissions is absent (1.0.5+). Interactive seed via -i.");

  const distinct = new Set(obs.map((o) => o.marker).filter(Boolean));
  if (distinct.size <= 1) {
    log(`INCONCLUSIVE: ESC[Z did not visibly change the marker (${distinct.size} distinct). `
      + `ConPTY delivery or marker capture needs tuning — inspect the tails above.`);
    process.exit(2);
  }
  log(`PASS: ESC[Z cycled the LIVE Claude ring over ConPTY — ${distinct.size} distinct markers across ${RING_PROBES} probes.`);
  log("These captured strings back ClaudeAdapter.parseCurrentMode (see tests/test_agent_adapters.ts).");
  process.exit(0);
}

main().catch((e) => { console.error("[p5] ERROR:", e); process.exit(1); });
