// tests/test_return_channel_journeys.ts
//
// AgentExchange spine — Phase 4, Step 4.4: the INTEGRATED return-channel journey battery.
//
// Every journey below drives the REAL production seams together — not just one subsystem's own
// unit suite:
//   - the REAL server boot (tests/helpers/mockLive.ts's installMockLive + startServer), so a
//     spoken/narrated line is asserted against the ACTUAL mockLive session's `clientContents`
//     (what the operator would hear/see), not a hand-rolled stand-in.
//   - the REAL observation pipeline (src/observe/index.ts's attachObserve), driven through the
//     manager's own `onRunning` / `onOutput` / `onIdle` / `onExit` handles that a real PTY would
//     invoke — exactly the seam tests/test_exchange_observation.ts pins at the unit level, here
//     wired to a live mockLive voice session and a real on-disk-capable JanusStore.
//   - the REAL exchange-aware notification stack (src/voice/sitrep.ts composeExchangeBoard +
//     syncExchangeAttentionItems, src/announcementBus.ts's ExchangeNarrationGate, src/voice/
//     index.ts's pushSignal enrichment) triggered through actual voice tool calls
//     (get_status_summary / catch_me_up) and actual paneSignalBus publishes.
//   - the REAL recovery surface (src/exchanges/recovery.ts, src/exchanges/recoveryActions.ts) via
//     `runAction`/REGISTRY, against a real file-based JanusStore closed and reopened.
//
// Does NOT duplicate the exhaustive per-subsystem unit coverage already landed:
//   test_agent_result_envelope.ts (envelope parse/scan contract, 26 cases), test_exchange_
//   observation.ts (attachObserve unit coverage, 20), test_exchange_notifications.ts (board/gate/
//   sync pure-function coverage, 27), test_exchange_recovery.ts (boot-quarantine + interruption
//   table, +31), test_exchange_recovery_actions.ts (resume/retry/cancel policy, 44),
//   test_catch_me_up.ts, test_voice_resumption.ts. This suite is the GLUE: it proves the pieces
//   compose correctly end to end, with exactly-once counting at every notification-bearing edge.
//
// ── PANE-SIGNAL-BUS TIMING NOTE (read before touching any journey below) ───────────────────────
// The REAL PaneSignalBus (src/paneSignalBus.ts, wired with its production defaults inside
// server.ts — not test-injectable) enforces an L1 "cross-kind cooldown": once ANY kind of signal
// is delivered for a pane, every OTHER kind below `exited`/`error` priority is suppressed for the
// next 5000ms (real wall-clock, `Date.now()` — not a fake clock). A real dispatched command
// normally takes far longer than 5s between its `running` edge and its `idle`/`prompt` edge, so
// this never bites in production; a synchronous test driving both edges back-to-back WOULD get
// silently suppressed and produce a false "no narration" result that actually proves nothing about
// the exchange logic under test. Rather than fake the clock (not an injectable seam, and faking it
// would stop testing the REAL bus), every journey below that needs a clean narration assertion
// after a pane's `running` edge is pre-armed in `before()` (pane registered, exchange delivered,
// `onRunning` fired) and the whole battery waits ONE real ~5.3s gap before any journey's own body
// runs — collapsing what would otherwise be N per-journey waits into one shared wait.
//
// ── Journey -> test mapping (also see the final assistant report) ──────────────────────────────
//   1  normal result envelope: deliver -> running -> valid envelope -> agent_complete, ONE
//      attention item, ONE narration, durable event chain in order      -> describe "journey 1"
//   2  legacy prose completion, confidence-honest wording                -> describe "journey 2"
//   3  agent question -> needs_input -> answered -> running again        -> describe "journey 3"
//   4  idle with no completion -> terminal_idle only, never "complete"   -> describe "journey 4"
//   5  malformed envelope near a valid-looking sentinel -> ignored       -> describe "journey 5"
//   6  wrong exchange_id envelope -> ignored, zero side effects          -> describe "journey 6"
//   7  stale result after retry (interrupted A, follow-up B) -> ignored  -> describe "journey 7"
//   8  repeated idle after needs_input -> sticky, ONE narration total    -> describe "journey 8"
//   9  background-project question -> named exception, no focus steal    -> describe "journey 9"
//   10 pane exit mid-exchange -> agent_failed, narrated once             -> describe "journey 10"
//   11 browser reconnect -> no duplicate narration, draft still present  -> describe "journey 11"
//   12 python daemon death -> communication continues, no corruption     -> describe "daemon death"
//   13 restart after delivery -> quarantine + recovery actions via REST  -> describe "journey 13"
//
// Runner: npx tsx --test --test-force-exit tests/test_return_channel_journeys.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";
import type { MockLiveHandle, MockLiveSession } from "./helpers/mockLive";
import { teardownServerSuite } from "./helpers/teardown";
import type { RunningServer } from "../server";

// JANUS_EXCHANGE_SPINE / JANUS_AGENT_RESULT_ENVELOPE must be set BEFORE the first import of
// anything touching src/exchanges/flag.ts / src/exchanges/resultEnvelope.ts in THIS process — both
// cache their mode at module load (tests/test_exchange_observation.ts's / tests/test_exchange_
// recovery.ts's documented idiom). `node --test` runs each test FILE as its own process, so this
// cannot leak into any other test file.
process.env.JANUS_EXCHANGE_SPINE = "shadow"; // active (writes + reads via ExchangeService), not authoritative-only — sufficient here (matches test_exchange_observation.ts's own choice).
process.env.JANUS_AGENT_RESULT_ENVELOPE = "accept";

// These are pure logic modules — none of them transitively import `../server` (verified: no
// `from "../server"` anywhere in their own import graphs), so loading them at module top level,
// BEFORE any `process.chdir()`, is safe. `../server` itself (and `./helpers/mockLive`, which
// re-exports its `setLiveConnector` seam) is NOT imported here — server.ts boots its SQLite store
// as a MODULE-TOP-LEVEL side effect against `process.cwd()` at import time (not inside an
// exported function), so importing it before a test's own `chdir()` into a fresh tmpdir would boot
// the store against the REPO ROOT instead — exactly the mistake every other real-server test file
// in this suite avoids by importing `../server` dynamically INSIDE its `before()` hook, AFTER
// `chdir`. That import (and `installMockLive`) happens in the main battery's `before()` below.
const { getExchangeService } = await import("../src/exchanges/spine");
const { recoverExchangesOnBoot, interruptionDispositionFor } = await import("../src/exchanges/recovery");
const { resumeInspectExchange, retryExchange } = await import("../src/exchanges/recoveryActions");
void resumeInspectExchange; // exercised via the runAction "resume_inspect_exchange" def below, not called directly
const { getOpenDraft, setOpenDraft } = await import("../src/exchanges/draftRegistry");
const { createDraft, buildEnvelope } = await import("../src/exchanges/instructionEnvelope");
const { JanusStore } = await import("../src/store/sqliteStore");
const { ExchangeService } = await import("../src/exchanges/service");
const { REGISTRY } = await import("../src/actions/registry");
const { runAction } = await import("../src/actions/gemini");
const { setCortexPrimary, resetCortexFallbackStats } = await import("../src/memory/cortexShadow");

const svc = getExchangeService();

// Populated inside the main battery's `before()` (the FIRST thing in this process to chdir + import
// `../server`) — server.ts's module-level store/manager singleton is shared by every `startServer()`
// call in this SAME process regardless of which describe block calls it (module caching), so every
// describe below reuses these same bindings rather than re-importing.
let startServer: (opts?: any) => Promise<RunningServer>;
let apiToken: string;
let installMockLive: () => MockLiveHandle;
let waitFor: <T>(p: () => T | undefined | false, t?: number, i?: number) => Promise<T>;
let HistoryManagerRef: { getInstance(): { saveHistory(id: string, h: any[]): void } };

// ── shared helpers ──────────────────────────────────────────────────────────────────────────────

/** A structural pane stub — no real PTY. Mirrors tests/test_approval_resolved_broadcast.ts's
 *  StubTerminal, with the extra fields src/observe/index.ts's classifier reads (status,
 *  runtimeType, lastCommand, projectId, lastStatusChangeAt). */
class StubTerminal {
  status: "Running" | "Idle" | "Exited" = "Running";
  runtimeType = "interactive_cli";
  lastCommand = "";
  projectId: string;
  lastStatusChangeAt = Date.now();
  writes: string[] = [];
  constructor(public terminalId: string, projectId: string) {
    this.projectId = projectId;
  }
  writeInput(s: string) { this.writes.push(s); }
  getRawBackfill() { return ""; }
  getRecentOutput() { return ""; }
  async stop() { this.status = "Exited"; }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
/** Just past PaneSignalBus's production 5000ms cross-kind cooldown default — see the file-header note. */
const PAST_COOLDOWN_MS = 5300;

/** Register a pane both in `manager.terminals` (no real PTY) — sufficient for every journey here;
 *  journey 9 additionally registers the owning project so cross-project narration routes. */
function makePane(running: RunningServer, paneId: string, projectId: string): StubTerminal {
  const t = new StubTerminal(paneId, projectId);
  (running.manager.terminals as any)[paneId] = t;
  return t;
}

/** Deliver a fresh exchange onto `paneId` — the Full-Auto-equivalent path (draft -> staged ->
 *  delivered) tests/test_exchange_observation.ts's own `deliverExchange` helper uses. Represents
 *  "the voice lane already decided to send this" — the routing/approval theater is Phase 3's
 *  territory (tests/test_instruction_routing_journeys.ts); this suite starts from delivery. */
function deliverExchange(paneId: string, projectId: string, instruction = "run the tests"): string {
  const snap = svc.createExchange({
    projectId, paneId, operatorUtterance: `please ${instruction}`, distilledInstruction: instruction,
  });
  assert.ok(svc.stageForDelivery(snap.exchangeId).ok, "stageForDelivery must succeed from draft");
  assert.ok(svc.recordDelivery(snap.exchangeId).ok, "recordDelivery must succeed from staged");
  return snap.exchangeId;
}

/** Seed one history entry directly (bypassing the real onOutput chunk-append + the async Gemini
 *  outcome-summarizer network round-trip, which is orthogonal to what these journeys test) — the
 *  idle-time definitive pass (src/observe/index.ts settleTerminalOutcome) reads `history[last]
 *  .output` for the envelope/legacy scan, and computeIdleSummary short-circuits to
 *  `lastEntry.finalResponse` when already set, so pre-setting BOTH keeps onIdle deterministic and
 *  fast while still exercising the REAL scan/settle code. */
function seedHistory(paneId: string, command: string, output: string, finalResponse: string): void {
  HistoryManagerRef.getInstance().saveHistory(paneId, [
    { command, timestamp: new Date().toISOString(), output, finalResponse },
  ]);
}

/** The text of every `sendClientContent` push since index `fromIdx`, in order. */
function clientTextsSince(session: MockLiveSession, fromIdx: number): string[] {
  return session.clientContents
    .slice(fromIdx)
    .map((c: any) => c?.turns?.[0]?.parts?.[0]?.text)
    .filter((t: unknown): t is string => typeof t === "string");
}

/** True for an EXCHANGE-AWARE enriched narration line (src/voice/sitrep.ts terseExchangeOutcomeLine
 *  shapes: "Pane 'x' ...", or the background-project "In project 'x', ..." wrapper) — false for the
 *  plain "PANE STATUS UPDATE (context only...)" fallback (src/paneSignals.ts formatPaneSignal),
 *  approval narration ("SYSTEM EVENT..."), or a CONTEXT brief push. This is the exactly-once
 *  counting unit for every "ONE narration" assertion below. */
function isExchangeNarration(text: string): boolean {
  return text.startsWith("Pane '") || text.startsWith("In project '");
}

function exchangeNarrationsSince(session: MockLiveSession, fromIdx: number): string[] {
  return clientTextsSince(session, fromIdx).filter(isExchangeNarration);
}

/** Attention items the exchange board synced (details.exchange_id) for one exchange. */
function attentionForExchange(running: RunningServer, exchangeId: string): any[] {
  return running.manager.attentionQueue.filter((q: any) => q.details?.exchange_id === exchangeId);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Main battery — one real server boot, shared across journeys 1..11.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("return-channel journeys (real server, real observation pipeline, real mockLive voice session)", () => {
  let mock: MockLiveHandle;
  let running: RunningServer;
  let session: MockLiveSession;
  let client: WebSocket;
  let wsFrames: any[];
  let tmpDir: string;
  let prevCwd: string;
  const store = () => running._testStore!()!;

  const api = (pathname: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`http://127.0.0.1:${running.port}${pathname}`, {
      ...init,
      headers: { "x-api-token": apiToken, "content-type": "application/json", ...(init.headers || {}) },
    });

  async function callTool(name: string, args: Record<string, any> = {}): Promise<string> {
    const callId = session.emitToolCall(name, args);
    const raw = await waitFor(() => mock.responseFor(callId));
    return String(raw ?? "");
  }

  // Pre-armed (pane + delivered exchange + genuine `running` edge) fixtures for every journey that
  // needs a clean spoken-narration assertion AFTER the running edge — see the file-header timing
  // note. Filled in `before()`, consumed by each journey's own `it`.
  let j1Pane: string, j1Id: string;
  let j2Pane: string, j2Id: string;
  let j3Pane: string, j3Id: string;
  let j4Pane: string, j4Id: string;
  let j5Pane: string, j5Id: string;
  let j6Pane: string, j6ActiveId: string;
  let j8Pane: string, j8Id: string;
  let j9PaneA: string, j9Id: string;
  let j11Pane: string, j11Id: string;

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";
    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-rcj-"));
    process.chdir(tmpDir);

    // `../server` (and `./helpers/mockLive`, which re-exports its setLiveConnector seam) is
    // imported dynamically HERE, after chdir — see the file-header note. This is the FIRST import
    // of `../server` in this process, so its module-level SQLite store boots scoped to `tmpDir`.
    ({ installMockLive, waitFor } = await import("./helpers/mockLive"));
    const serverMod = await import("../server");
    startServer = serverMod.startServer;
    apiToken = serverMod.API_AUTH_TOKEN;
    HistoryManagerRef = serverMod.HistoryManager;

    mock = installMockLive();
    running = await startServer({ port: 0, enableVite: false });

    wsFrames = [];
    client = new WebSocket(`ws://127.0.0.1:${running.port}/live`, { headers: { Cookie: `auth_token=${apiToken}` } });
    client.on("message", (data) => { try { wsFrames.push(JSON.parse(data.toString())); } catch { /* non-JSON */ } });
    await new Promise<void>((resolve, reject) => { client.on("open", () => resolve()); client.on("error", reject); });
    session = await waitFor(() => mock.latest());

    // Project + pane registration for journey 9 (cross-project routing needs a REAL addProject —
    // mirrors tests/test_cortex_cutover_journeys.ts's own background-routing journeys).
    running.manager.ledger.addProject("rcj-proj-a", tmpDir, "Project A");
    running.manager.ledger.addProject("rcj-proj-b", tmpDir, "Project B");

    j1Pane = "rcj-j1"; makePane(running, j1Pane, "rcj-proj-a"); j1Id = deliverExchange(j1Pane, "rcj-proj-a");
    j2Pane = "rcj-j2"; makePane(running, j2Pane, "rcj-proj-a"); j2Id = deliverExchange(j2Pane, "rcj-proj-a");
    j3Pane = "rcj-j3"; makePane(running, j3Pane, "rcj-proj-a"); j3Id = deliverExchange(j3Pane, "rcj-proj-a");
    j4Pane = "rcj-j4"; makePane(running, j4Pane, "rcj-proj-a"); j4Id = deliverExchange(j4Pane, "rcj-proj-a");
    j5Pane = "rcj-j5"; makePane(running, j5Pane, "rcj-proj-a"); j5Id = deliverExchange(j5Pane, "rcj-proj-a");
    j6Pane = "rcj-j6"; makePane(running, j6Pane, "rcj-proj-a"); j6ActiveId = deliverExchange(j6Pane, "rcj-proj-a");
    j8Pane = "rcj-j8"; makePane(running, j8Pane, "rcj-proj-a"); j8Id = deliverExchange(j8Pane, "rcj-proj-a");
    j9PaneA = "rcj-j9-a"; makePane(running, j9PaneA, "rcj-proj-a"); j9Id = deliverExchange(j9PaneA, "rcj-proj-a");
    j11Pane = "rcj-j11"; makePane(running, j11Pane, "rcj-proj-a"); j11Id = deliverExchange(j11Pane, "rcj-proj-a");

    for (const p of [j1Pane, j2Pane, j3Pane, j4Pane, j5Pane, j6Pane, j8Pane, j9PaneA, j11Pane]) {
      running.manager.onRunning!(p);
    }

    await sleep(PAST_COOLDOWN_MS); // one shared wait past the bus's cross-kind cooldown for ALL of the above.
  });

  after(async () => {
    if (client && client.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => { client.once("close", () => resolve()); try { client.terminate(); } catch { resolve(); } });
    }
    await teardownServerSuite(running);
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  describe("journey 1: normal result envelope -> agent_complete, exactly-once attention + narration, ordered events", () => {
    it("delivered -> running -> a valid envelope at idle -> agent_complete, ONE attention item, ONE narration, delivery_succeeded..agent_completion_reported in order", async () => {
      const idx = session.clientContents.length;
      seedHistory(j1Pane, "run the tests", JSON.stringify({ exchange_id: j1Id, status: "complete", summary: "142 tests passing" }), "142 tests ran");
      await running.manager.onIdle!(j1Pane);

      const row = store().getExchange(j1Id)!;
      assert.strictEqual(row.state, "agent_complete");
      assert.strictEqual(row.result_summary, "142 tests passing");
      assert.deepStrictEqual(store().listExchangeEvents(j1Id).map((e: any) => e.event_type), [
        "exchange_created", "target_resolved", "delivery_attempted", "delivery_succeeded", "terminal_running", "terminal_idle", "agent_completion_reported",
      ]);

      // ONE narration, exactly the terse completion line.
      const narrations = exchangeNarrationsSince(session, idx);
      assert.deepStrictEqual(narrations, [`Pane '${j1Pane}' finished: 142 tests passing`]);

      // ONE attention item — surfaced via the REAL voice tool call (composeExchangeBoard's pull-based sync).
      await callTool("get_status_summary");
      assert.strictEqual(attentionForExchange(running, j1Id).length, 1);
      // Idempotent: calling it again never duplicates.
      await callTool("get_status_summary");
      assert.strictEqual(attentionForExchange(running, j1Id).length, 1, "a repeated sync never duplicates the attention item");
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  describe("journey 2: legacy prose completion — honest, non-overclaiming narration", () => {
    it("no envelope, a conservative literal done-line -> agent_complete via the legacy path; the narration relays exactly what was said, nothing fabricated", async () => {
      const idx = session.clientContents.length;
      seedHistory(j2Pane, "run the build", "Compiling...\nLinking...\n", "Done: build succeeded.");
      await running.manager.onIdle!(j2Pane);

      const row = store().getExchange(j2Id)!;
      assert.strictEqual(row.state, "agent_complete");
      assert.strictEqual(row.result_summary, "Done: build succeeded.");
      assert.strictEqual(row.result_envelope_json, null, "the legacy path never fabricates a structured envelope");

      const narrations = exchangeNarrationsSince(session, idx);
      assert.deepStrictEqual(narrations, [`Pane '${j2Pane}' finished: Done: build succeeded.`]);
      // Confidence-honest: relays the agent's own words verbatim, never adds a verification claim
      // Orbital never actually performed (spec §9.3 — a report, never a verification).
      for (const text of narrations) {
        assert.ok(!/verified|confirmed|tested and passed/i.test(text), `narration must not overclaim verification: ${text}`);
      }
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  describe("journey 3: agent question -> needs_input -> answered -> running again", () => {
    it("a detected question is redacted+capped and attached; a fresh running edge (the answer landing) clears it", async () => {
      const idx = session.clientContents.length;
      (running.manager.terminals as any)[j3Pane].status = "Idle";
      (running.manager.terminals as any)[j3Pane].runtimeType = "shell";
      running.manager.onOutput!(j3Pane, "proceed with token=SECRETVALUE (y/n)? $ ");

      assert.strictEqual(svc.get(j3Id)!.state, "needs_input");
      const needsInputEvt = store().listExchangeEvents(j3Id).find((e: any) => e.event_type === "needs_input_detected");
      assert.ok(needsInputEvt, "a needs_input_detected event is recorded");
      const payload = JSON.parse(needsInputEvt.payload_redacted_json);
      assert.ok(payload.detail.length <= 80, "the attached question text is capped");
      assert.ok(!payload.detail.includes("SECRETVALUE"), "the attached question text is redacted");

      // FIXED (step 4.5): the exchange settles BEFORE the 'prompt' paneSignalBus publish
      // (src/observe/index.ts runObservationSteps' settle-before-publish ordering, mirroring
      // onIdle), so pushSignal's enrichment reads POST-transition state and produces exactly ONE
      // enriched needs_input narration — with the question text redacted+capped, REPLACING (not
      // duplicating) the plain fallback line.
      assert.deepStrictEqual(
        exchangeNarrationsSince(session, idx),
        [`Pane '${j3Pane}' needs your input: "proceed with token=[REDACTED:secret] (y/n)? $"`],
        "exactly ONE enriched needs_input narration, redacted",
      );
      const plainPrompt = clientTextsSince(session, idx).filter((t) => t.startsWith("PANE STATUS UPDATE") && t.includes("waiting at a prompt"));
      assert.strictEqual(plainPrompt.length, 0, "the enriched line REPLACES the plain fallback — never a double delivery");

      // The operator answers (a gated write lands) -> a genuine `running` edge is the ONLY way off
      // needs_input via observation (pinned by tests/test_exchange_observation.ts).
      (running.manager.terminals as any)[j3Pane].status = "Running";
      running.manager.onRunning!(j3Pane);
      assert.strictEqual(svc.get(j3Id)!.state, "running");
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  describe("journey 4: idle with no completion report -> terminal_idle only, never 'complete'", () => {
    it("delivered -> running -> idle, no envelope, no legacy done-line -> terminal_idle; the exchange board never claims it complete; the plain pane-idle signal still reaches the operator (comms continue)", async () => {
      const idx = session.clientContents.length;
      seedHistory(j4Pane, "run the watcher", "Compiling files...\nWatching for changes...\n", "128 files compiled");
      await running.manager.onIdle!(j4Pane);

      const row = store().getExchange(j4Id)!;
      assert.strictEqual(row.state, "terminal_idle", "idle alone is NEVER agent_complete");
      assert.deepStrictEqual(store().listExchangeEvents(j4Id).map((e: any) => e.event_type).slice(-2), ["terminal_running", "terminal_idle"]);

      // No exchange-specific narration at all — terminal_idle has nothing terse to say
      // (src/voice/sitrep.ts's TERSE_LINE_BUILDERS carries no entry for it).
      assert.deepStrictEqual(exchangeNarrationsSince(session, idx), []);
      // But the ordinary pane-status signal still went out (communication continues) — just framed
      // as context, never claiming task completion.
      const plain = clientTextsSince(session, idx).filter((t) => t.startsWith("PANE STATUS UPDATE"));
      assert.ok(plain.some((t) => t.includes(`pane ${j4Pane}`) && t.includes("went idle")), "the plain idle signal still reached the operator");

      // The catch-up digest is idle-worded, never "complete" — assert the exact wording class by
      // confirming this pane never appears on the exchange board's rendered text (terminal_idle is
      // invisible to composeExchangeBoard by design) and no completion claim leaks in for it.
      const digest = await callTool("catch_me_up", { window_minutes: 30 });
      assert.ok(!digest.includes(j4Pane), `terminal_idle must never surface on the board: ${digest}`);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  describe("journey 5: malformed envelope near a valid-looking sentinel -> ignored, no state change, no announcement", () => {
    it("garbage JSON (unquoted value) is scanned, found invalid, and silently skipped — both at the mid-run chunk pass and the idle-time pass", async () => {
      const idx = session.clientContents.length;
      const garbage = `Attempting to report: {"exchange_id":"${j5Id}","status":"complete",summary:UNQUOTED_AND_BROKEN}\n`;
      running.manager.onOutput!(j5Pane, garbage);
      assert.strictEqual(svc.get(j5Id)!.state, "running", "a malformed candidate must never settle anything, mid-run");

      seedHistory(j5Pane, "run the deploy", garbage, "no meaningful summary yet");
      await running.manager.onIdle!(j5Pane);
      const row = store().getExchange(j5Id)!;
      assert.strictEqual(row.state, "terminal_idle", "still no settlement from the malformed candidate at idle-time either");
      assert.strictEqual(row.result_envelope_json, null);

      assert.deepStrictEqual(exchangeNarrationsSince(session, idx), [], "no exchange-aware announcement for a malformed candidate");
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  describe("journey 6: wrong exchange_id envelope -> ignored, zero side effects on BOTH exchanges", () => {
    it("an envelope naming a different (real) exchange never settles the active one, and never touches the named one either", async () => {
      const idx = session.clientContents.length;
      const bystander = svc.createExchange({
        projectId: "rcj-proj-a", paneId: "rcj-j6-other", operatorUtterance: "please lint", distilledInstruction: "run the linter",
      });
      const bystanderId = bystander.exchangeId;
      const bystanderRowBefore = store().getExchange(bystanderId);
      const bystanderEventsBefore = store().listExchangeEvents(bystanderId);

      // Mid-run pass: a 'failed' report naming the bystander, arriving on the WRONG pane.
      running.manager.onOutput!(j6Pane, JSON.stringify({ exchange_id: bystanderId, status: "failed", summary: "failed elsewhere" }));
      assert.strictEqual(svc.get(j6ActiveId)!.state, "running", "the active exchange is untouched by a report naming someone else");
      assert.deepStrictEqual(store().getExchange(bystanderId), bystanderRowBefore, "the named exchange's row is byte-identical — never touched");
      assert.deepStrictEqual(store().listExchangeEvents(bystanderId), bystanderEventsBefore, "no event was appended to the named exchange either");

      // Idle-time pass: same story, via the accumulated-output scan. The active exchange still
      // settles to terminal_idle via the NORMAL idle edge — never via the forged envelope.
      seedHistory(j6Pane, "run the tests", JSON.stringify({ exchange_id: bystanderId, status: "complete", summary: "not for you" }), "continuing other work");
      await running.manager.onIdle!(j6Pane);
      assert.strictEqual(svc.get(j6ActiveId)!.state, "terminal_idle", "settled to idle via the genuine idle edge, NOT agent_complete via the forged report");
      assert.deepStrictEqual(store().getExchange(bystanderId), bystanderRowBefore, "still byte-identical after the idle-time pass too");
      assert.deepStrictEqual(store().listExchangeEvents(bystanderId), bystanderEventsBefore);

      // No exchange-aware narration was produced by the forged content itself.
      assert.deepStrictEqual(exchangeNarrationsSince(session, idx), [], "the wrong-id envelope produces zero exchange-aware announcements");
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  describe("journey 8: repeated idle after needs_input -> sticky, ONE narration total", () => {
    it("multiple idle edges after needs_input never flap back and never re-narrate", async () => {
      const idx = session.clientContents.length;
      (running.manager.terminals as any)[j8Pane].status = "Idle";
      (running.manager.terminals as any)[j8Pane].runtimeType = "shell";
      running.manager.onOutput!(j8Pane, "continue? y/n $ ");
      assert.strictEqual(svc.get(j8Id)!.state, "needs_input");

      seedHistory(j8Pane, "run the migration", "still waiting on the operator\n", "still waiting for your answer");
      await running.manager.onIdle!(j8Pane);
      await running.manager.onIdle!(j8Pane);
      await running.manager.onIdle!(j8Pane);
      assert.strictEqual(svc.get(j8Id)!.state, "needs_input", "sticky across repeated idle edges — never flaps to terminal_idle");

      // FIXED (step 4.5): exactly ONE narration total — the needs_input question narrates once at
      // the prompt edge (settle now precedes the publish), and the repeated idle edges never add a
      // second one (the ExchangeNarrationGate's anchor is the exchange's unchanged updated_at, and
      // the sticky needs_input state never re-transitions under ambient idles).
      const narrations = exchangeNarrationsSince(session, idx);
      assert.strictEqual(narrations.length, 1, `expected EXACTLY one narration total (never re-narrated by the repeats), got: ${JSON.stringify(narrations)}`);
      assert.strictEqual(narrations[0], `Pane '${j8Pane}' needs your input: "continue? y/n $"`);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  describe("journey 9: background-project question -> named exception, no focus steal, other project untouched", () => {
    it("a pane in a backgrounded project asks a question -> the foreground session hears it named explicitly, focus never moves, the foreground project's own state is untouched", async () => {
      const paneB = "rcj-j9-b";
      makePane(running, paneB, "rcj-proj-b");

      // Establish A as foreground, then switch away to B (the ONLY trigger that demotes A to
      // "handle" in the session pool — src/voice/index.ts's backgroundProjectForSignal doc).
      let out = await callTool("switch_context", { project_id: "rcj-proj-a" });
      assert.ok(!/error/i.test(out), out);
      out = await callTool("switch_context", { project_id: "rcj-proj-b" });
      assert.ok(!/error/i.test(out), out);
      out = await callTool("switch_active_pane", { pane_id: paneB });
      assert.ok(!/error/i.test(out), out);

      const idx = session.clientContents.length;
      const switchFramesBefore = wsFrames.filter((f) => f?.type === "switch_active_pane").length;
      const bStatusBefore = (running.manager.terminals as any)[paneB].status;

      (running.manager.terminals as any)[j9PaneA].status = "Idle";
      (running.manager.terminals as any)[j9PaneA].runtimeType = "shell";
      running.manager.onOutput!(j9PaneA, "overwrite existing file? $ ");
      assert.strictEqual(svc.get(j9Id)!.state, "needs_input");

      // FIXED (step 4.5): settlement precedes the 'prompt' publish, so the background-project
      // EXCEPTION narration now reaches the foreground session exactly once — named explicitly
      // ("In project 'X', ..."; the ledger's project NAME defaults to its id under addProject),
      // and never via a focus change (asserted below).
      assert.deepStrictEqual(
        exchangeNarrationsSince(session, idx),
        [`In project 'rcj-proj-a', pane '${j9PaneA}' needs your input: "overwrite existing file? $"`],
        "the background-project exception is narrated once, named explicitly",
      );

      // No focus change: no NEW switch_active_pane broadcast was fired as a side effect of the
      // exception narration (the code path never calls setActivePane — src/voice/index.ts's
      // buildExchangeAwareSignalText / composeNarrationText doc); and B's own pane state is untouched.
      const switchFramesAfter = wsFrames.filter((f) => f?.type === "switch_active_pane").length;
      assert.strictEqual(switchFramesAfter, switchFramesBefore, "the exception narration never triggers a focus change");
      assert.strictEqual((running.manager.terminals as any)[paneB].status, bStatusBefore, "B's own pane state is untouched");
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  describe("journey 10: pane exit mid-exchange -> agent_failed, durable event", () => {
    it("a live PTY death (onExit) settles agent_failed exactly once — 'exited' bypasses the cross-kind cooldown by design, so no extra wait is needed here", () => {
      const pane = "rcj-j10";
      makePane(running, pane, "rcj-proj-a");
      const id = deliverExchange(pane, "rcj-proj-a");
      running.manager.onRunning!(pane);

      const idx = session.clientContents.length;
      (running.manager.terminals as any)[pane].status = "Exited";
      running.manager.onExit!(pane);

      assert.strictEqual(svc.get(id)!.state, "agent_failed");
      assert.strictEqual(store().listExchangeEvents(id).at(-1)!.event_type, "agent_failure_reported");

      // FIXED (step 4.5): settleExchangeSignal now runs BEFORE emitHighSeverityTransition's
      // 'exited' publish, so the enriched failure line fires exactly once. NOTE the project prefix:
      // journey 9 (which runs before this one in declaration order) switched the foreground to
      // rcj-proj-b, so rcj-proj-a is a genuinely backgrounded project here — agent_failed is an
      // EXCEPTION class and still crosses over, named explicitly, with no focus change.
      assert.deepStrictEqual(
        exchangeNarrationsSince(session, idx),
        [`In project 'rcj-proj-a', pane '${pane}' failed.`],
        "exactly ONE enriched failure narration for the pane death",
      );
      const plainExited = clientTextsSince(session, idx).filter((t) => t.startsWith("PANE STATUS UPDATE"));
      assert.strictEqual(plainExited.length, 0, "the enriched line REPLACES the plain fallback — never a double delivery");
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  describe("journey 11: browser reconnect — no delivery interruption, no duplicate narration, draft still present", () => {
    it("a needs_input question narrates once; a SECOND browser session connecting afterward never gets a duplicate narration for the same unchanged exchange; an open instruction draft survives untouched", async () => {
      // Draft rehydration angle (4.3): a reconnect never touches server memory at all, so an open
      // draft is trivially still present — assert the concrete round-trip anyway.
      const draft = createDraft({ target: { projectId: "rcj-proj-a", paneId: j11Pane }, envelope: buildEnvelope({ objective: "fix the retry bug" }) });
      setOpenDraft("rcj-proj-a", j11Pane, draft);

      const idx = session.clientContents.length;
      (running.manager.terminals as any)[j11Pane].status = "Idle";
      (running.manager.terminals as any)[j11Pane].runtimeType = "shell";
      running.manager.onOutput!(j11Pane, "continue? y/n $ ");
      assert.strictEqual(svc.get(j11Id)!.state, "needs_input");
      // FIXED (step 4.5): exactly ONE enriched narration on the first session. The project prefix
      // is present for the same reason as journey 10's: journey 9 backgrounded rcj-proj-a, and
      // needs_input is an exception class that crosses over named explicitly.
      const first = exchangeNarrationsSince(session, idx);
      assert.deepStrictEqual(
        first,
        [`In project 'rcj-proj-a', pane '${j11Pane}' needs your input: "continue? y/n $"`],
        "exactly one narration on the first session",
      );
      // Anchor the "no re-narration" checks below at the CURRENT stream position (not idx +
      // first.length — clientContents may interleave non-narration pushes).
      const idxAfterFirst = session.clientContents.length;

      // "Reconnect": a SECOND, independent WS client connects (a fresh browser tab / the operator's
      // reconnect) — the exchange spine's own delivery is completely unaffected by this (spec §4.3
      // table: browser_ws_reconnect -> no_op_delivery_unaffected, pinned in test_exchange_recovery.ts;
      // here we prove the OPERATOR-FACING consequence: no duplicate narration to the new session).
      assert.strictEqual(interruptionDispositionFor("browser_ws_reconnect"), "no_op_delivery_unaffected");
      const client2 = new WebSocket(`ws://127.0.0.1:${running.port}/live`, { headers: { Cookie: `auth_token=${apiToken}` } });
      await new Promise<void>((resolve, reject) => { client2.on("open", () => resolve()); client2.on("error", reject); });
      const session2 = await waitFor(() => mock.sessions.find((s) => s !== session && !s.closed));
      try {
        const idx2 = session2.clientContents.length;
        // The SAME unchanged question, re-observed (a duplicate report / re-detected prompt) — the
        // exchange doesn't change state (still needs_input, same anchor), so neither the narration
        // gate nor the bus's own debounce lets this reach ANY session as an exchange-aware line.
        running.manager.onOutput!(j11Pane, "continue? y/n $ ");
        assert.strictEqual(svc.get(j11Id)!.state, "needs_input", "unchanged — a genuine repeat, not a new transition");
        assert.deepStrictEqual(exchangeNarrationsSince(session2, idx2), [], "the NEW session never receives a duplicate narration for the unchanged exchange");
        assert.deepStrictEqual(exchangeNarrationsSince(session, idxAfterFirst), [], "nor does the original session re-narrate");
      } finally {
        await new Promise<void>((resolve) => { client2.once("close", () => resolve()); try { client2.terminate(); } catch { resolve(); } });
      }

      assert.ok(getOpenDraft("rcj-proj-a", j11Pane), "the open draft is still present after the reconnect");
      assert.strictEqual(getOpenDraft("rcj-proj-a", j11Pane)!.envelope.objective, "fix the retry bug");
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  // Phase 5.5 (release review): the z5c routing contract for a BACKGROUNDED project's non-exception
  // outcome is now a REAL suppression (src/voice/index.ts ExchangeSignalNarration) — the module doc
  // always claimed "a plain 'complete' for a backgrounded project is deferred to that project's own
  // catch-up", but the old null-means-fallback plumbing leaked it into the foreground session as a
  // plain "PANE STATUS UPDATE" context line anyway. This journey pins the fixed behavior end to
  // end: nothing (enriched OR plain) reaches the live session; the completion is durably settled
  // and surfaces on catch_me_up.
  describe("journey 13: a BACKGROUNDED project's completion is silent in the foreground session — and surfaces on catch-up", () => {
    it("agent_complete on backgrounded rcj-proj-a -> no narration, no plain PANE STATUS UPDATE leak; catch_me_up still reports it", async () => {
      const pane = "rcj-j13";
      makePane(running, pane, "rcj-proj-a"); // journey 9 backgrounded rcj-proj-a (foreground is rcj-proj-b)
      const id = deliverExchange(pane, "rcj-proj-a", "roll the archive logs");
      running.manager.onRunning!(pane);
      assert.strictEqual(svc.get(id)!.state, "running");
      await sleep(PAST_COOLDOWN_MS); // past the bus's cross-kind cooldown so the idle publish genuinely reaches pushSignal

      const idx = session.clientContents.length;
      (running.manager.terminals as any)[pane].status = "Idle";
      seedHistory(pane, "roll the archive logs", JSON.stringify({
        exchange_id: id, status: "complete", summary: "archives rolled, 2 files pruned",
      }), "rolled");
      await running.manager.onIdle!(pane);

      assert.strictEqual(store().getExchange(id)!.state, "agent_complete", "the completion settled durably");
      // The foreground session hears NOTHING about it — neither the enriched line nor the plain
      // context fallback (the pre-fix leak this journey exists to pin).
      assert.deepStrictEqual(exchangeNarrationsSince(session, idx), [], "no enriched completion narration crosses over from a backgrounded project");
      const plainLeak = clientTextsSince(session, idx).filter((t) => t.startsWith("PANE STATUS UPDATE") && t.includes(pane));
      assert.deepStrictEqual(plainLeak, [], "the suppression is real — no plain PANE STATUS UPDATE leak about the backgrounded pane");

      // Deferred, not lost: the operator's own pull-based catch-up reports the result.
      const digest = await callTool("catch_me_up", { window_minutes: 30 });
      assert.ok(digest.includes("archives rolled, 2 files pruned"), `catch_me_up must surface the backgrounded completion: ${digest}`);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  // Journey 7 runs LAST in this shared-server battery: it exercises the exchange-agnostic scenario
  // of "an exchange got interrupted, a follow-up was minted, a stale report for the ORIGINAL
  // arrives late" purely against the store/service (no timing dependency), but to keep every OTHER
  // journey's own store rows untouched by anything global, it is sequenced after all of the above
  // have already made their assertions (node:test runs `it`s within a describe in declaration
  // order) — see the file-header note repeated here for the next reader.
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  describe("journey 7: stale result after retry — the interrupted original's late report is ignored; the follow-up is unaffected", () => {
    it("exchange A interrupted -> follow-up exchange B minted and delivered -> a late envelope naming A arrives on the pane -> ignored; A stays interrupted; B is untouched by it", async () => {
      const pane = "rcj-j7";
      makePane(running, pane, "rcj-proj-a");
      const a = deliverExchange(pane, "rcj-proj-a", "run the deploy");
      running.manager.onRunning!(pane);
      assert.strictEqual(svc.get(a)!.state, "running");

      // Simulate a single-exchange quarantine (the shape recovery.ts's quarantineOne applies to
      // every uncertain in-flight row on a real restart) — scoped to just this ONE exchange so no
      // other journey's still-open exchange in this shared store is disturbed.
      const casRes = store().updateExchange(a, { state: "interrupted" }, { state: "running" });
      assert.ok(casRes.changed);
      store().appendExchangeEvent({ exchange_id: a, event_type: "exchange_recovered", pane_id: pane, project_id: "rcj-proj-a", payload_redacted_json: JSON.stringify({ disposition: "interrupted", reason: "boot_quarantine", from_state: "running" }) });

      // A follow-up exchange B is minted (never a same-exchange resume for `interrupted` — spec §4
      // hard rule, pinned in tests/test_exchange_recovery_actions.ts) and delivered on the SAME pane.
      const retryOutcome = retryExchange(store(), svc, a, undefined);
      assert.strictEqual(retryOutcome.kind, "new_exchange");
      const b = retryOutcome.exchangeId!;
      assert.notStrictEqual(b, a);
      assert.strictEqual(store().getExchange(b)!.state, "draft");
      // recoveryActions.ts operates DIRECTLY on the store (never svc.createExchange — see that
      // module's own doc), so the in-memory ExchangeMachine has no record of B yet; adopt the
      // durable row first (the exact seam retryExchange's own same-exchange leg uses internally)
      // so the normal svc.* calls below can legally transition it.
      svc.adoptExchangeSnapshot(store().getExchange(b)!);
      // Deliver B for real so it becomes this pane's ACTIVE exchange (a fresh dispatch).
      assert.ok(svc.stageForDelivery(b).ok);
      assert.ok(svc.recordDelivery(b).ok);
      assert.strictEqual(svc.activeExchangeForPane(pane), b, "B is now the pane's active exchange");
      running.manager.onRunning!(pane);
      assert.strictEqual(svc.get(b)!.state, "running");

      const idx = session.clientContents.length;
      // The STALE envelope, naming the now-interrupted A, arrives late on the pane (a straggling
      // report from the process that was interrupted before it could report).
      running.manager.onOutput!(pane, JSON.stringify({ exchange_id: a, status: "complete", summary: "actually I finished after all" }));

      assert.strictEqual(store().getExchange(a)!.state, "interrupted", "A stays interrupted — the stale report can never reach back and settle it");
      assert.strictEqual(svc.get(b)!.state, "running", "B is entirely unaffected by the stale report naming A");
      assert.deepStrictEqual(exchangeNarrationsSince(session, idx), [], "no announcement is produced for a stale, uncorrelated report");
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  // FIXED (step 4.5) — was the battery's pinned BUG: the exchange-aware voice narration enrichment
  // (src/voice/index.ts's pushSignal -> buildExchangeAwareSignalText) could never fire for the
  // 'prompt'/'error'/'exited' paneSignalBus kinds because their publishes happened BEFORE the
  // exchange machine's own transition settled within the same synchronous onOutput call. The fix
  // (src/observe/index.ts) mirrors onIdle's settle-then-publish ordering everywhere:
  //   - runObservationSteps now runs the mid-run envelope settle + detectAndTriggerTransitions
  //     (which owns settleExchangeSignal) BEFORE classifyPaneOutput's 'error'/'prompt' publish;
  //   - detectAndTriggerTransitions calls settleExchangeSignal BEFORE emitHighSeverityTransition's
  //     'exited' publish.
  // This block is the isolated fix-pin the old `it.todo` demanded: the same scenario that used to
  // pin ZERO exchange-aware narrations now produces exactly ONE enriched line, replacing (never
  // duplicating) the plain fallback. Journeys 3/8/9/10/11 above carry the tightened exactly-once
  // assertions in their full end-to-end contexts.
  describe("FIXED: exchange-aware narration for 'prompt'/'exited' pane-signal kinds reads POST-transition state", () => {
    it("a needs_input-shaped prompt chunk transitions the exchange AND produces exactly ONE enriched narration (plain fallback replaced)", async () => {
      const pane = "rcj-bug-prompt";
      makePane(running, pane, "rcj-proj-a");
      const id = deliverExchange(pane, "rcj-proj-a");
      running.manager.onRunning!(pane);
      (running.manager.terminals as any)[pane].status = "Idle";
      (running.manager.terminals as any)[pane].runtimeType = "shell";
      await sleep(PAST_COOLDOWN_MS); // past the bus's own cross-kind cooldown — isolates the assertion from that separate, expected timing behavior.

      const idx = session.clientContents.length;
      running.manager.onOutput!(pane, "continue? y/n $ ");

      // The MACHINE settled (as it always did)...
      assert.strictEqual(svc.get(id)!.state, "needs_input");
      // ...AND the operator now hears exactly one enriched line for it ("In project" prefix:
      // journey 9 backgrounded rcj-proj-a earlier in this battery; needs_input is an exception
      // class, so it crosses over named explicitly).
      assert.deepStrictEqual(
        exchangeNarrationsSince(session, idx),
        [`In project 'rcj-proj-a', pane '${pane}' needs your input: "continue? y/n $"`],
      );
      // Exactly-once means REPLACING the plain fallback, not adding to it.
      const plain = clientTextsSince(session, idx).filter((t) => t.startsWith("PANE STATUS UPDATE") && t.includes("waiting at a prompt"));
      assert.strictEqual(plain.length, 0);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Journey 12 — python daemon death mid-journey: communication continues (the fixed TS floor takes
// over), and the exchange spine (entirely independent of the memory/cortex synthesis leg — see
// docs/design/2026-06-19-python-ts-seam.md) suffers no corruption. A fresh WS session (its own
// `testCortexClientOverride` for THIS boot's live-connector snapshot — server.ts pins
// `boundLiveConnector`/cortex config per `startServer()` call even though the underlying store is
// the one process-wide singleton the main battery already booted — see the file-header note: every
// `startServer()` call in this ONE test-file process shares that SAME module-level SQLite store,
// so this journey's exchange rows simply live alongside the main battery's under distinct,
// never-colliding pane/exchange ids; its own cross-kind-cooldown wait still applies to ITS pane.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("journey 12: python daemon death mid-journey — communication continues, no exchange corruption", () => {
  let mock: MockLiveHandle;
  let running: RunningServer;
  let session: MockLiveSession;
  let client: WebSocket;
  let tmpDir: string;
  let prevCwd: string;
  const store = () => running._testStore!()!;

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";
    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-rcj-daemon-"));
    process.chdir(tmpDir);
    // Cached from the main battery's earlier dynamic import — re-importing here is a no-op re-read
    // of the module cache (does NOT re-run server.ts's module-level store boot), matching the exact
    // per-describe idiom every real-server test file in this suite uses.
    ({ installMockLive, waitFor } = await import("./helpers/mockLive"));
    ({ startServer } = await import("../server"));

    mock = installMockLive();
    // A cortex client that is ALREADY dead from the very first call — mirrors tests/
    // test_cortex_cutover_journeys.ts's makeFakeCortex().kill(), but killed from the start.
    const deadCortex = { available: () => true, decide: async () => { throw new Error("mock cortex daemon dead"); } };
    running = await startServer({ port: 0, enableVite: false, testCortexClientOverride: deadCortex as any });
    setCortexPrimary(true);

    client = new WebSocket(`ws://127.0.0.1:${running.port}/live`, { headers: { Cookie: `auth_token=${apiToken}` } });
    await new Promise<void>((resolve, reject) => { client.on("open", () => resolve()); client.on("error", reject); });
    session = await waitFor(() => mock.latest());
  });

  after(async () => {
    setCortexPrimary(false);
    resetCortexFallbackStats();
    if (client && client.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => { client.once("close", () => resolve()); try { client.terminate(); } catch { resolve(); } });
    }
    await teardownServerSuite(running);
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("a full delivered->running->envelope->agent_complete journey settles correctly, narrates once, and the SITREP tools still answer — all while the memory daemon is dead", async () => {
    const pane = "rcj-j12";
    const t = new StubTerminal(pane, "rcj-proj-daemon");
    (running.manager.terminals as any)[pane] = t;
    running.manager.ledger.addProject("rcj-proj-daemon", tmpDir, "Daemon-death project");
    const id = deliverExchange(pane, "rcj-proj-daemon");
    running.manager.onRunning!(pane);
    await sleep(PAST_COOLDOWN_MS);

    const idx = session.clientContents.length;
    seedHistory(pane, "run the tests", JSON.stringify({ exchange_id: id, status: "complete", summary: "all green" }), "42 tests ran");
    await running.manager.onIdle!(pane);

    const row = store().getExchange(id)!;
    assert.strictEqual(row.state, "agent_complete", "the exchange settles correctly regardless of cortex health");
    assert.strictEqual(row.result_summary, "all green");
    assert.deepStrictEqual(store().listExchangeEvents(id).map((e: any) => e.event_type), [
      "exchange_created", "target_resolved", "delivery_attempted", "delivery_succeeded", "terminal_running", "terminal_idle", "agent_completion_reported",
    ], "no corruption of the durable event chain from the dead daemon");

    const narrations = exchangeNarrationsSince(session, idx);
    assert.deepStrictEqual(narrations, [`Pane '${pane}' finished: all green`], "communication continues — narrated exactly once");

    // The SITREP/catch-up tools still answer sanely (never throw, never hang) despite the daemon.
    const summaryCallId = session.emitToolCall("get_status_summary");
    const summaryOut = String(await waitFor(() => mock.responseFor(summaryCallId)));
    assert.ok(summaryOut.length > 0);
    const catchupCallId = session.emitToolCall("catch_me_up", { window_minutes: 5 });
    const catchupOut = String(await waitFor(() => mock.responseFor(catchupCallId)));
    assert.ok(catchupOut.length > 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Journey 13 — restart after delivery: a REAL file-based store close + reopen, the durable
// quarantine + exchange_recovered event, and the operator-facing recovery actions driven through
// the REAL REGISTRY/runAction seam (not hand-called module functions) — the REST-lane surface a
// browser client actually calls.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("journey 13: restart after delivery -> quarantine + exchange_recovered + recovery actions via runAction", () => {
  function tempDbPath(label: string): string {
    return path.join(os.tmpdir(), `rcj-restart-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  }
  function cleanupDbFile(p: string): void {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) { try { fs.unlinkSync(p + suffix); } catch { /* best-effort */ } }
  }
  function makeActionCtx(storeHandle: any, terminals: Record<string, any> = {}): any {
    return {
      manager: { terminals },
      session: null,
      redact: (s: string) => s,
      store: storeHandle,
      broadcast: () => {},
      broadcastLedgerUpdate: () => {},
      // Mirrors the REAL gateOrDefer contract (src/gating): on the "run" (Auto) disposition it
      // returns WITHOUT invoking `run` — the ActionDef itself calls its own retry-effect closure
      // again on the ok path (src/actions/defs/lifecycle_rest.ts retryExchangeAction.handler).
      // Calling `run` here too would double-execute the retry (a real, easy-to-make test-double bug
      // — test_exchange_recovery_actions.ts's own makeActionCtx documents the same trap).
      gateOrDefer: (_capability: string, _paneId: string | null, _summary: string, run: () => string) => { void run; return { disposition: "run" as const }; },
    };
  }

  // The "retry_exchange" / "cancel_exchange" ActionDefs (src/actions/defs/lifecycle_rest.ts) are
  // hard-wired to the PROCESS-WIDE ExchangeService singleton (getExchangeService(), src/exchanges/
  // spine.ts) for their in-memory correlation adoption — exactly like a real boot's
  // initExchangeSpineOnBoot attaches the real store to that SAME singleton. To exercise the REAL
  // ActionDef through runAction against this journey's OWN isolated file-based store, we attach it
  // to that singleton for the duration of the test (mirroring real boot wiring) and detach after —
  // never leaving a closed/deleted store attached for anything that runs later in this process.
  async function withStoreAttached<T>(storeHandle: InstanceType<typeof JanusStore>, fn: () => Promise<T>): Promise<T> {
    svc.attachStore(storeHandle);
    try {
      return await fn();
    } finally {
      svc.attachStore(undefined);
    }
  }

  it("a mid-flight exchange is quarantined on restart (exchange_recovered event); resume_inspect_exchange returns its timeline; retry_exchange REFUSES a same-exchange resume (always a new follow-up) via the real ActionDef", async () => {
    const dbPath = tempDbPath("midflight");
    try {
      let store = new JanusStore(dbPath); store.init();
      const localSvc = new ExchangeService({ store });
      const id = localSvc.createExchange({ projectId: "p1", paneId: "pane-1", operatorUtterance: "please deploy", distilledInstruction: "run scripts/deploy.sh" }).exchangeId;
      assert.ok(localSvc.stageForDelivery(id).ok);
      assert.ok(localSvc.recordDelivery(id).ok);
      localSvc.onPaneSignal({ paneId: "pane-1", kind: "running" });
      assert.strictEqual(store.getExchange(id)!.state, "running");
      store.close(); // simulate the crash — no clean shutdown hook fires

      store = new JanusStore(dbPath); store.init(); // "restart": a FRESH store handle, SAME on-disk file
      assert.strictEqual(store.getExchange(id)!.state, "running", "the pre-crash state really did persist to disk");
      const report = recoverExchangesOnBoot(store);
      assert.ok(report.interrupted.includes(id));
      assert.strictEqual(store.getExchange(id)!.state, "interrupted");
      assert.strictEqual(store.listExchangeEvents(id).at(-1)!.event_type, "exchange_recovered");

      const inspectResult = await runAction(REGISTRY, "resume_inspect_exchange", { exchange_id: id }, makeActionCtx(store));
      assert.strictEqual(inspectResult.kind, "ok");
      const view = (inspectResult as any).output;
      assert.strictEqual(view.exchange.exchange_id, id);
      assert.strictEqual(view.exchange.state, "interrupted");
      assert.ok(view.recentEvents.some((e: any) => e.event_type === "exchange_recovered"), "the timeline includes the recovery event");

      // Retry policy for `interrupted`: ALWAYS a new follow-up, never a same-exchange resume.
      const retryResult = await withStoreAttached(store, () =>
        runAction(REGISTRY, "retry_exchange", { exchange_id: id }, makeActionCtx(store, { "pane-1": { writeInput: () => {}, status: "Running" } })),
      );
      assert.strictEqual(retryResult.kind, "ok");
      const followUp = (retryResult as any).output as string;
      assert.match(followUp, /new follow-up draft/);
      assert.strictEqual(store.getExchange(id)!.state, "interrupted", "the ORIGINAL stays interrupted, never resumed in place");

      store.close();
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  it("a provably-failed draft (delivery_failed as its last event before the crash) IS eligible to retry on the SAME exchange via the real ActionDef, and re-delivers", async () => {
    const dbPath = tempDbPath("provably-failed");
    try {
      let store = new JanusStore(dbPath); store.init();
      const row = store.insertExchange({ project_id: "p1", pane_id: "pane-2", state: "draft", distilled_instruction: "run it", delivery_attempt: 1 });
      store.appendExchangeEvent({ exchange_id: row.exchange_id, event_type: "delivery_failed" });
      store.close();

      store = new JanusStore(dbPath); store.init();
      const report = recoverExchangesOnBoot(store);
      assert.ok(report.kept.includes(row.exchange_id), "a pure durable 'draft' row is kept, not quarantined");
      assert.strictEqual(store.getExchange(row.exchange_id)!.state, "draft");

      const writes: string[] = [];
      const retryResult = await withStoreAttached(store, () =>
        runAction(REGISTRY, "retry_exchange", { exchange_id: row.exchange_id }, makeActionCtx(store, { "pane-2": { writeInput: (s: string) => writes.push(s), status: "Running" } })),
      );
      assert.strictEqual(retryResult.kind, "ok");
      assert.deepStrictEqual(writes, ["run it"]);
      assert.strictEqual(store.getExchange(row.exchange_id)!.state, "delivered");
      assert.strictEqual(store.getExchange(row.exchange_id)!.delivery_attempt, 2);

      store.close();
    } finally {
      cleanupDbFile(dbPath);
    }
  });
});
