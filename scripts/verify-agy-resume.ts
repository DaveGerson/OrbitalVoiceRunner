/**
 * P5 / bead 1h0 — agy restart-resume ROUND-TRIP smoke.
 *
 * Proves the agy Full-Auto "magic" end to end: a conversation can be CAPTURED and RESUMED
 * with full context. Two real agy sessions over ConPTY:
 *   A) start a fresh pane, drop a unique codeword, let the turn settle → a new
 *      ~/.gemini/antigravity-cli/conversations/<uuid>.db appears (the conversation id, exactly
 *      what AntigravityAdapter.captureSessionId reads — implicit/<uuid>.pb is NOT it).
 *   B) relaunch `agy --conversation=<that-uuid>` and ask for the codeword → the model recalls
 *      it from the resumed history (agy log: "Resuming conversation <uuid>").
 *
 * Run:  npm run verify:agy-resume     (needs agy installed + signed in + folder trusted)
 * Exit: 0 = resume restored context (codeword recalled). 2 = no recall. 3 = no conversation
 *       captured in session A. 1 = harness error. (Windows: node-pty may exit 255 at teardown
 *       AFTER the RESULT prints — trust the RESULT line, not the code. See verify:modeswitch:agy.)
 */
import { UniversalTerminal } from "../src/terminal";
import { readdirSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const AGY_BIN = process.env.AGY_BIN || "C:\\Users\\gerso\\AppData\\Local\\agy\\bin\\agy.exe";
const CODEWORD = process.env.CODEWORD || "BANANA8821";
const CONV_DIR = join(homedir(), ".gemini", "antigravity-cli", "conversations");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STARTUP_MS = 11000, RESPONSE_MS = 30000, SETTLE_MS = 4000;

process.on("uncaughtException", (e) => { if (String((e as any)?.message ?? e).includes("AttachConsole")) return; console.error("[agy-rt] uncaught", e); process.exit(1); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function log(...a: any[]) { console.log("[agy-rt]", ...a); }
function convs(): { id: string; mtimeMs: number }[] {
  try {
    return readdirSync(CONV_DIR).filter((f) => f.toLowerCase().endsWith(".db"))
      .map((f) => ({ id: f.slice(0, -3), mtimeMs: statSync(join(CONV_DIR, f)).mtimeMs }))
      .filter((e) => UUID_RE.test(e.id));
  } catch { return []; }
}

async function clearTrust(term: UniversalTerminal, getTail: () => string) {
  for (let k = 0; k < 3; k++) {
    if (/trust|Navigate|Confirm|continue|get started/i.test(getTail())) { term.writeRaw("\r"); await sleep(3500); } else break;
  }
}

async function runSession(label: string, shellCmd: string, prompt: string, capture: boolean): Promise<{ raw: string; convId?: string }> {
  const baseline = new Set(convs().map((c) => c.id));
  let raw = "";
  const term = new UniversalTerminal(label, process.cwd(), shellCmd, "Antigravity", "Human-in-the-Loop", "");
  term.onOutput = (_id: string, c: string) => { raw += c; if (raw.length > 250_000) raw = raw.slice(-120_000); };
  const clean = (s: string) => s.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
  const tail = () => clean(raw).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-14).join("  ¶  ");
  term.start();
  log(`${label}: launch ${JSON.stringify((term as any).shellCmd)} pid=${(term as any).shellPid}`);
  await sleep(STARTUP_MS);
  await clearTrust(term, tail);
  log(`${label}: submitting prompt`);
  term.writeInput(prompt);
  await sleep(RESPONSE_MS);
  await sleep(SETTLE_MS); // let the trajectory store flush
  let convId: string | undefined;
  if (capture) {
    const fresh = convs().filter((c) => !baseline.has(c.id)).sort((a, b) => b.mtimeMs - a.mtimeMs);
    convId = fresh[0]?.id;
    log(`${label}: captured conversation id = ${JSON.stringify(convId)}`);
  }
  try { await term.stop(); } catch { /* teardown noise */ }
  await sleep(1200);
  return { raw: clean(raw), convId };
}

async function main() {
  log("CODEWORD =", CODEWORD);
  // Session A: plant the codeword. "Do not use tools" nudges a plain reply, but the codeword is
  // in the user turn regardless, so resume recall works even if agy goes agentic.
  const a = await runSession("A/plant", AGY_BIN,
    `Do not use any tools. Just remember this for our chat — my secret codeword is ${CODEWORD}. Reply with exactly: noted.`, true);
  if (!a.convId) { log("RESULT: FAIL(3) — session A created no new conversations/<uuid>.db to capture."); process.exit(3); }

  // Session B: resume by the captured id and ask for the codeword.
  const b = await runSession("B/resume", `${AGY_BIN} --conversation=${a.convId}`,
    "Without running any tools, what is the secret codeword I told you earlier in this conversation? Reply with only that word.", false);
  const recalled = new RegExp(CODEWORD, "i").test(b.raw);
  log(`B/resume tail: ${JSON.stringify(b.raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-12).join("  ¶  ").slice(-500))}`);

  if (recalled) {
    log(`RESULT: PASS ✓ — agy --conversation=${a.convId} RESUMED the conversation; model recalled ${CODEWORD}.`);
    log("⟹ AntigravityAdapter.captureSessionId (newest conversations/<uuid>.db) + buildResumeCommand are correct.");
    process.exit(0);
  }
  log(`RESULT: FAIL(2) — resume did not recall ${CODEWORD} (check the agy log for 'Resuming conversation ${a.convId}').`);
  process.exit(2);
}
main().catch((e) => { console.error("[agy-rt] ERR", e); process.exit(1); });
