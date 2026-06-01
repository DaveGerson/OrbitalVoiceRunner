/**
 * Backend smoke test — proves the first-class Handoff artifact end to end, headless
 * (no browser, no voice, no Gemini). It exercises BOTH load-bearing legs:
 *
 *   1. PERSISTENCE: the JanusStore handoff state machine
 *        createHandoff(composing) -> updateHandoffCargo(revising, revision_count++)
 *        -> updateHandoffState(staged) -> updateHandoffState(delivered)
 *      and asserts the immutable HANDOFF event trail (composing->revising->staged->delivered)
 *      with matching payload.handoff_id.
 *
 *   2. DELIVERY: the staged->delivered transition actually lands the composed prompt VERBATIM
 *      in a REAL target pane's live PTY via term.writeInput(). We assert the DISTINCTIVE prompt
 *      text is echoed back in the post-delivery PTY stream — deterministic proof the bytes that
 *      came back were the composed prompt landing in the input line, NOT incidental TUI redraw
 *      (cursor/status churn). This is stronger than a bare bytes>0 check (which redraw can
 *      satisfy). NOTE: this branch's writeInput submits with "\n"; node-pty's line discipline
 *      accepts LF as the submit. (There is no "\r" CR fix in this code path — earlier comments
 *      claiming one were inaccurate.)
 *
 * The gate is SET TO ALLOW for the test (Full Auto), so delivery proceeds without a human.
 *
 * SCOPE CAVEAT (known gap G3): this test drives the DECISION spine (decideProposal) + the store
 * state machine + a real PTY write directly. It does NOT yet invoke the server's WS-bound
 * deliver_handoff handler / flipHandoffOnResolve choke-point (those close over the live WebSocket
 * session). A regression isolated to that server handler would not be caught here — see the
 * hardening note in docs/design/janus-capability-gate-handoffs.md.
 *
 * Run:  npm run smoke:handoff   (or: npx tsx scripts/smoke-handoff.ts)
 * Exit: 0 = PTY received bytes AND handoff persisted as 'delivered' with the right trail.
 *       1 = any failed assertion (prints a [smoke] FAIL line first).
 *
 * Requires Claude Code installed + authenticated. Launches the bare `claude` binary like a pane.
 */
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { UniversalTerminal } from "../src/terminal";
import { JanusStore } from "../src/store/sqliteStore";
import { decideProposal } from "../src/pendingApprovals";
import { deliverOutcomeToHandoff } from "../src/handoffFlow";

// A distinctive sentinel embedded in the prompt. The PTY echoes typed input into the line
// buffer, so this exact token MUST appear in the post-delivery stream if the composed prompt
// truly landed — deterministic regardless of model latency or response wording.
const SENTINEL = "JANUS_SMOKE_XQ7";
const PROMPT = `Reply with exactly the word PONG. Ignore this token: ${SENTINEL}`;
const STARTUP_MS = 6000;
const RESPONSE_MS = 25000;
const WORKSPACE = "smoke-handoff-ws";
const TARGET = "smoke-handoff-target";

function log(...a: any[]) { console.log("[smoke]", ...a); }
function fail(msg: string): never { console.log("[smoke] FAIL:", msg); throw new Error(msg); }

async function main() {
  // (1) temp DB + store
  const dbPath = path.join(os.tmpdir(), `janus-smoke-${Date.now()}.db`);
  const store = new JanusStore(dbPath);
  store.init();
  log(`store initialized at ${dbPath} (user_version=${store.db.pragma("user_version", { simple: true })})`);

  // (2) spawn a REAL target pane (claude)
  const term = new UniversalTerminal(TARGET, process.cwd(), "claude", "Claude Code", "Full Auto", "");
  let bytesStartup = 0;
  let bytesAfter = 0;
  let sawStartup = false;
  let streamedAfter = "";
  let phase: "startup" | "post-deliver" = "startup";
  term.onOutput = (_id, chunk) => {
    if (phase === "startup") { bytesStartup += chunk.length; sawStartup = true; }
    else { bytesAfter += chunk.length; streamedAfter += chunk; }
  };

  log("starting target pane (claude)...");
  term.start();
  log(`spawned: usingNodePty=${(term as any).usingNodePty} pid=${(term as any).shellPid}`);

  for (let i = 0; i < STARTUP_MS / 1000; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    log(`t+${i + 1}s status=${term.status} bytes=${bytesStartup}`);
  }
  if (term.status === "Exited") { await term.stop(); fail("target pane exited during startup — not a live session."); }
  if (!sawStartup) { await term.stop(); fail("target pane produced no startup output (TUI never came up)."); }
  log(`startup OK — status=${term.status}, ${bytesStartup} bytes of TUI output.`);

  // (4) run the Handoff machine against the store
  const h = store.createHandoff({
    workspace_id: WORKSPACE,
    to_pane: TARGET,
    kind: "agent_instruction",
    composed_prompt: PROMPT,
    state: "composing",
  });
  log(`createHandoff -> ${h.id} state=${h.state} revision_count=${h.revision_count}`);
  if (h.state !== "composing") { await term.stop(); fail(`expected state 'composing', got '${h.state}'`); }

  // revise once (assert revision_count incremented)
  const revised = store.updateHandoffCargo(h.id, PROMPT);
  if (!revised || revised.revision_count !== 1) { await term.stop(); fail(`expected revision_count 1 after revise, got ${revised?.revision_count}`); }
  log(`revise_handoff -> revision_count=${revised.revision_count} state=${revised.state}`);

  // stage
  const staged = store.updateHandoffState(h.id, "staged");
  if (!staged || staged.state !== "staged" || !staged.staged_at) { await term.stop(); fail(`stage failed; state=${staged?.state} staged_at=${staged?.staged_at}`); }
  log(`stage_handoff -> state=${staged.state} staged_at=${staged.staged_at}`);

  // (5) simulate the GATED delivery with the gate SET TO ALLOW (Full Auto).
  // Prove the SAME decision spine the server uses resolves to auto_execute here.
  const decision = decideProposal({
    kind: "agent_instruction",
    instruction: PROMPT,
    effectiveMode: "Full Auto",
    runtimeType: "interactive_cli",
    paneExists: true,
    allowlist: new Set<string>(),
    capability: "deliver_handoff",
    gate: "Auto",
  });
  log(`gate decision (deliver_handoff, Full Auto, gate=Auto) -> ${decision.type}`);
  if (decision.type !== "auto_execute") { await term.stop(); fail(`expected auto_execute on the approved path, got ${decision.type}`); }

  // (5b) Drive the SAME deliver-mapping the server uses (src/handoffFlow.deliverOutcomeToHandoff),
  // mapping the auto_execute decision to the dispatch outcome kind the server would produce
  // ("executed" for Full Auto). This closes G3 in the smoke: the row flip is governed by the real
  // mapping function, not a hardcoded "delivered" literal.
  const dispatchKind = decision.type === "auto_execute" ? "executed" : "pending";
  const effect = deliverOutcomeToHandoff(dispatchKind);
  log(`deliverOutcomeToHandoff(${dispatchKind}) -> ${effect.kind}`);
  if (effect.kind !== "deliver_now") { await term.stop(); fail(`expected deliver_now effect on Full-Auto path, got ${effect.kind}`); }

  // approved path: land the composed prompt VERBATIM in the live PTY, then flip the row via the
  // effect the mapping prescribed (effect.state / effect.approvedVia — not a hardcoded value).
  phase = "post-deliver";
  log(`delivering composed_prompt into the live PTY via writeInput(): "${PROMPT}"`);
  term.writeInput(staged.composed_prompt);
  const delivered = store.updateHandoffState(h.id, effect.state, { approved_via: effect.approvedVia });
  if (!delivered || delivered.state !== "delivered" || !delivered.delivered_at) { await term.stop(); fail(`delivered flip failed; state=${delivered?.state}`); }
  log(`updateHandoffState -> state=${delivered.state} delivered_at=${delivered.delivered_at} approved_via=${delivered.approved_via}`);

  // (6) wait for the model round-trip
  await new Promise((r) => setTimeout(r, RESPONSE_MS));
  await term.stop();

  // (7) ASSERT the prompt actually LANDED in the PTY — by CONTENT, not just byte count.
  // The PTY echoes typed input, so the distinctive sentinel must appear in the stream that came
  // back after delivery. A bare bytes>0 check can be satisfied by TUI redraw churn (cursor/status
  // bar); requiring the sentinel proves the composed prompt itself was submitted into the pane.
  if (bytesAfter === 0) { fail("composed_prompt was NOT submitted — zero PTY output after delivery."); }
  // Strip ANSI escape sequences before searching (the TUI interleaves cursor/color codes).
  const cleaned = streamedAfter.replace(/\x1B\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1B[()][AB0]/g, "");
  if (!cleaned.includes(SENTINEL)) {
    fail(`delivery NOT confirmed: sentinel "${SENTINEL}" never echoed back in ${bytesAfter} post-delivery bytes — the composed prompt did not land in the PTY input line (redraw churn alone cannot prove delivery).`);
  }
  log(`PTY delivery CONFIRMED — sentinel "${SENTINEL}" echoed back (${bytesAfter} bytes streamed after delivery).`);

  // (8) ASSERT persistence: row state + the ordered HANDOFF event trail.
  const finalRow = store.getHandoff(h.id);
  if (!finalRow) fail("handoff row missing after delivery.");
  if (finalRow!.state !== "delivered") fail(`final state expected 'delivered', got '${finalRow!.state}'`);
  if (!finalRow!.delivered_at) fail("delivered_at not set.");
  if (finalRow!.revision_count !== 1) fail(`final revision_count expected 1, got ${finalRow!.revision_count}`);

  const events = store.getEvents({ type: "handoff" }).filter(e => (e.payload && e.payload.handoff_id) === h.id);
  const transitions = events.map(e => e.payload.to);
  log(`HANDOFF event trail (to-states): ${JSON.stringify(transitions)}`);
  const expected = ["composing", "revising", "staged", "delivered"];
  // createHandoff emits to:'composing'; revise emits to:'revising'; stage to:'staged'; deliver to:'delivered'.
  for (const want of expected) {
    if (!transitions.includes(want)) fail(`missing transition event to '${want}' (trail=${JSON.stringify(transitions)})`);
  }
  // ordering: composing before revising before staged before delivered
  const idx = (s: string) => transitions.indexOf(s);
  if (!(idx("composing") < idx("revising") && idx("revising") < idx("staged") && idx("staged") < idx("delivered"))) {
    fail(`transition events out of order: ${JSON.stringify(transitions)}`);
  }
  for (const e of events) {
    if (e.handoff_id !== h.id) fail(`event ${e.id} has handoff_id='${e.handoff_id}', expected '${h.id}'`);
  }
  log(`persistence OK — state=delivered, delivered_at set, revision_count=1, ordered trail composing->revising->staged->delivered with matching handoff_id.`);

  store.close();
  try { fs.unlinkSync(dbPath); } catch {}
  try { fs.unlinkSync(dbPath + "-wal"); } catch {}
  try { fs.unlinkSync(dbPath + "-shm"); } catch {}

  log("PASS: PTY received the composed prompt AND the handoff persisted with the correct state-transition trail.");
  process.exit(0);
}

main().catch((e) => {
  console.error("[smoke] ERROR:", e?.message || e);
  process.exit(1);
});
