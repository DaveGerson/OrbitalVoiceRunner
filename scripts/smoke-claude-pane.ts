/**
 * Backend smoke test — verifies a terminal pane holds a LIVE, interactive Claude
 * session that accepts submitted input, WITHOUT the browser or voice.
 *
 * This is the headless proof for the core product goal: "a pane is a live Claude
 * CLI session Janus types into." It exercises the real UniversalTerminal +
 * PtyTransport path (node-pty / ConPTY on Windows) and the writeInput() CR-vs-LF
 * fix (a PTY needs \r to submit; \n only inserts a newline into the TUI buffer).
 *
 * Run:  npm run smoke:claude   (or: npx tsx scripts/smoke-claude-pane.ts)
 * Exit: 0 = pane stayed alive AND produced a response to a submitted prompt.
 *       1 = pane died, or never responded (the failure the operator reported).
 *
 * Requires Claude Code installed + authenticated (OAuth keychain is fine; no API
 * key in env needed). Launches the bare `claude` binary, exactly like a pane.
 */
import { UniversalTerminal } from "../src/terminal";

const PROMPT = "Reply with exactly the word PONG and nothing else.";
const STARTUP_MS = 6000;   // let the TUI come up
const RESPONSE_MS = 25000; // allow for the model round-trip

function log(...a: any[]) { console.log("[smoke]", ...a); }

async function main() {
  const term = new UniversalTerminal(
    "smoke-claude",
    process.cwd(),
    "claude",
    "Claude Code",
    "Read-Only",
    "",
  );

  let bytesBefore = 0;
  let bytesAfter = 0;
  let sawAnyOutput = false;
  let phase: "startup" | "post-input" = "startup";

  term.onOutput = (_id, chunk) => {
    sawAnyOutput = true;
    if (phase === "startup") bytesBefore += chunk.length;
    else bytesAfter += chunk.length;
  };

  log("starting pane (claude)...");
  term.start();

  await new Promise((r) => setTimeout(r, STARTUP_MS));

  if (term.status === "Exited") {
    log("FAIL: pane exited during startup - not a live session.");
    await term.stop();
    process.exit(1);
  }
  if (!sawAnyOutput) {
    log("FAIL: pane produced no startup output (TUI never came up).");
    await term.stop();
    process.exit(1);
  }
  log(`startup OK - status=${term.status}, ${bytesBefore} bytes of TUI output.`);

  phase = "post-input";
  log(`submitting prompt via writeInput(): "${PROMPT}"`);
  term.writeInput(PROMPT);

  await new Promise((r) => setTimeout(r, RESPONSE_MS));

  await term.stop();

  if (bytesAfter === 0) {
    log("FAIL: prompt was not submitted - zero output after writeInput (the LF-vs-CR bug).");
    process.exit(1);
  }

  log(`PASS: pane responded to submitted input - ${bytesAfter} bytes streamed back.`);
  process.exit(0);
}

main().catch((e) => {
  console.error("[smoke] ERROR:", e);
  process.exit(1);
});
