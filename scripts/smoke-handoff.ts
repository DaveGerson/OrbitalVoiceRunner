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
import { fileURLToPath } from "url";
import { UniversalTerminal } from "../src/terminal";
import { JanusStore } from "../src/store/sqliteStore";
import { decideProposal } from "../src/pendingApprovals";
import { deliverOutcomeToHandoff } from "../src/handoffFlow";
import type { Handoff } from "../src/types";

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

// ---------------------------------------------------------------------------
// Pure helpers — extractable and unit-testable without a live server/PTY
// ---------------------------------------------------------------------------

/** Strip ANSI escape sequences from a string. */
export function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1B[()][AB0]/g, "");
}

/**
 * Assert that the PTY stream captured after delivery contains the sentinel.
 * Pure: no I/O side effects, throws on failure.
 */
export function assertPtyDelivery(streamedAfter: string, bytesAfter: number, sentinel: string): void {
  if (bytesAfter === 0) {
    fail("composed_prompt was NOT submitted — zero PTY output after delivery.");
  }
  // Strip ANSI escape sequences before searching (the TUI interleaves cursor/color codes).
  const cleaned = stripAnsi(streamedAfter);
  if (!cleaned.includes(sentinel)) {
    fail(`delivery NOT confirmed: sentinel "${sentinel}" never echoed back in ${bytesAfter} post-delivery bytes — the composed prompt did not land in the PTY input line (redraw churn alone cannot prove delivery).`);
  }
}

/**
 * Assert the handoff row final state and ordered event trail in the store.
 * Pure: reads store, throws on failure, no other side effects.
 */
export function assertPersistence(store: JanusStore, hId: string): void {
  const finalRow = store.getHandoff(hId);
  if (!finalRow) fail("handoff row missing after delivery.");
  if (finalRow!.state !== "delivered") fail(`final state expected 'delivered', got '${finalRow!.state}'`);
  if (!finalRow!.delivered_at) fail("delivered_at not set.");
  if (finalRow!.revision_count !== 1) fail(`final revision_count expected 1, got ${finalRow!.revision_count}`);

  const events = store.getEvents({ type: "handoff" }).filter(e => (e.payload && e.payload.handoff_id) === hId);
  const transitions = events.map(e => e.payload.to);
  log(`HANDOFF event trail (to-states): ${JSON.stringify(transitions)}`);
  assertTransitionOrder(transitions, hId);
  for (const e of events) {
    if (e.handoff_id !== hId) fail(`event ${e.id} has handoff_id='${e.handoff_id}', expected '${hId}'`);
  }
}

/**
 * Assert the four expected transitions appear in order.
 * Pure: no I/O, throws on failure.
 */
export function assertTransitionOrder(transitions: string[], hId: string): void {
  const expected = ["composing", "revising", "staged", "delivered"];
  // createHandoff emits to:'composing'; revise emits to:'revising'; stage to:'staged'; deliver to:'delivered'.
  for (const want of expected) {
    if (!transitions.includes(want)) {
      fail(`missing transition event to '${want}' (trail=${JSON.stringify(transitions)})`);
    }
  }
  // ordering: composing before revising before staged before delivered
  const idx = (s: string) => transitions.indexOf(s);
  if (!(idx("composing") < idx("revising") && idx("revising") < idx("staged") && idx("staged") < idx("delivered"))) {
    fail(`transition events out of order: ${JSON.stringify(transitions)}`);
  }
}

// ---------------------------------------------------------------------------
// Orchestration helpers — async phases extracted from main
// ---------------------------------------------------------------------------

/** Wait for the PTY startup phase; fail if pane exited or produced no output. */
async function waitForStartup(
  term: UniversalTerminal,
  startupMs: number,
  getStats: () => { bytes: number; sawStartup: boolean },
): Promise<void> {
  for (let i = 0; i < startupMs / 1000; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    log(`t+${i + 1}s status=${term.status} bytes=${getStats().bytes}`);
  }
  if (term.status === "Exited") { await term.stop(); fail("target pane exited during startup — not a live session."); }
  if (!getStats().sawStartup) { await term.stop(); fail("target pane produced no startup output (TUI never came up)."); }
  log(`startup OK — status=${term.status}, ${getStats().bytes} bytes of TUI output.`);
}

/** Run the handoff state machine (create → revise → stage) and return the staged row. */
async function runHandoffMachine(store: JanusStore, term: UniversalTerminal, prompt: string): Promise<Handoff> {
  const h = store.createHandoff({
    workspace_id: WORKSPACE,
    to_pane: TARGET,
    kind: "agent_instruction",
    composed_prompt: prompt,
    state: "composing",
  });
  log(`createHandoff -> ${h.id} state=${h.state} revision_count=${h.revision_count}`);
  if (h.state !== "composing") { await term.stop(); fail(`expected state 'composing', got '${h.state}'`); }

  const revised = store.updateHandoffCargo(h.id, prompt);
  if (!revised || revised.revision_count !== 1) { await term.stop(); fail(`expected revision_count 1 after revise, got ${revised?.revision_count}`); }
  log(`revise_handoff -> revision_count=${revised.revision_count} state=${revised.state}`);

  const staged = store.updateHandoffState(h.id, "staged");
  if (!staged || staged.state !== "staged" || !staged.staged_at) { await term.stop(); fail(`stage failed; state=${staged?.state} staged_at=${staged?.staged_at}`); }
  log(`stage_handoff -> state=${staged.state} staged_at=${staged.staged_at}`);
  return staged;
}

/** The narrowed deliver_now effect shape — only reachable on the Full-Auto approved path. */
type DeliverNowEffect = { kind: "deliver_now"; state: "delivered"; approvedVia: "full_auto" };

/**
 * Verify the gate decision and effect for the Full-Auto approved path.
 * Returns the narrowed deliver_now effect so the caller can drive the PTY write + row flip.
 */
async function assertGateAndEffect(term: UniversalTerminal, prompt: string): Promise<DeliverNowEffect> {
  const decision = decideProposal({
    kind: "agent_instruction",
    instruction: prompt,
    effectiveMode: "Full Auto",
    runtimeType: "interactive_cli",
    paneExists: true,
    allowlist: new Set<string>(),
    capability: "deliver_handoff",
    gate: "Auto",
  });
  log(`gate decision (deliver_handoff, Full Auto, gate=Auto) -> ${decision.type}`);
  if (decision.type !== "auto_execute") { await term.stop(); fail(`expected auto_execute on the approved path, got ${decision.type}`); }

  const dispatchKind = decision.type === "auto_execute" ? "executed" : "pending";
  const effect = deliverOutcomeToHandoff(dispatchKind);
  log(`deliverOutcomeToHandoff(${dispatchKind}) -> ${effect.kind}`);
  if (effect.kind !== "deliver_now") { await term.stop(); fail(`expected deliver_now effect on Full-Auto path, got ${effect.kind}`); }
  // TypeScript narrows effect to DeliverNowEffect here after the fail() guard above.
  return effect as DeliverNowEffect;
}

/** Deliver the composed_prompt into the PTY and flip the store row; return the delivered row. */
async function deliverAndFlip(
  term: UniversalTerminal,
  store: JanusStore,
  staged: Handoff,
  effect: DeliverNowEffect,
  setPhase: (p: "post-deliver") => void,
): Promise<Handoff> {
  setPhase("post-deliver");
  log(`delivering composed_prompt into the live PTY via writeInput(): "${staged.composed_prompt}"`);
  term.writeInput(staged.composed_prompt);
  const delivered = store.updateHandoffState(staged.id, effect.state, { approved_via: effect.approvedVia });
  if (!delivered || delivered.state !== "delivered" || !delivered.delivered_at) { await term.stop(); fail(`delivered flip failed; state=${delivered?.state}`); }
  log(`updateHandoffState -> state=${delivered.state} delivered_at=${delivered.delivered_at} approved_via=${delivered.approved_via}`);
  return delivered;
}

/** Remove the temp SQLite files (wal/shm included); ignores missing-file errors. */
function cleanupDb(dbPath: string): void {
  try { fs.unlinkSync(dbPath); } catch {}
  try { fs.unlinkSync(dbPath + "-wal"); } catch {}
  try { fs.unlinkSync(dbPath + "-shm"); } catch {}
}

// ---------------------------------------------------------------------------
// main — orchestrates the phases; CC stays low because logic lives in helpers
// ---------------------------------------------------------------------------

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

  // (3) wait for startup
  await waitForStartup(term, STARTUP_MS, () => ({ bytes: bytesStartup, sawStartup }));

  // (4) run the Handoff state machine
  const staged = await runHandoffMachine(store, term, PROMPT);

  // (5) gate decision + effect
  const effect = await assertGateAndEffect(term, PROMPT);

  // (5b) deliver: PTY write + row flip
  const _delivered = await deliverAndFlip(term, store, staged, effect, (p) => { phase = p; });

  // (6) wait for the model round-trip
  await new Promise((r) => setTimeout(r, RESPONSE_MS));
  await term.stop();

  // (7) ASSERT the prompt actually LANDED in the PTY — by CONTENT, not just byte count.
  assertPtyDelivery(streamedAfter, bytesAfter, SENTINEL);
  log(`PTY delivery CONFIRMED — sentinel "${SENTINEL}" echoed back (${bytesAfter} bytes streamed after delivery).`);

  // (8) ASSERT persistence: row state + the ordered HANDOFF event trail.
  assertPersistence(store, staged.id);
  log(`persistence OK — state=delivered, delivered_at set, revision_count=1, ordered trail composing->revising->staged->delivered with matching handoff_id.`);

  store.close();
  cleanupDb(dbPath);

  log("PASS: PTY received the composed prompt AND the handoff persisted with the correct state-transition trail.");
  process.exit(0);
}

// Run only when executed directly (not when imported by tests).
// This guards against the module being import-unsafe: exported pure helpers can now be imported
// without spawning a live PTY or a real claude process.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error("[smoke] ERROR:", e?.message || e);
    process.exit(1);
  });
}
