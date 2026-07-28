// tests/test_exchange_benchmarks.ts
//
// AgentExchange spine — Phase 5, Step 5.3: the RELEASE BENCHMARK HARNESS.
//
// Three scripted operator-communication journeys, driven end to end against the REAL production
// seams (the mockLive server harness, the real voice-verb ActionDefs via runAction/dispatchProposal,
// a real on-disk-capable JanusStore, the real observation entry points — manager.onRunning!/onOutput!/
// onIdle!/onExit!). The journey NAMES ("15-minute" / "30-minute" / "60-minute" session) denote
// SCENARIO SCALE (one pane vs. two projects vs. a small fleet), NOT real wall-clock duration — the
// whole battery is deterministic and completes in a few seconds of REAL time, modulo the one
// unavoidable real-clock cost documented below.
//
// ── Journey -> scenario mapping ─────────────────────────────────────────────────────────────────
//   FOCUSED     ("15-min"): one project, one pane. dictate (draft_instruction) -> distill
//               (buildEnvelope normalization) -> revise (revise_instruction) -> send
//               (send_instruction, Full Auto) -> running (onRunning!) -> a result envelope at idle
//               -> agent_complete -> the operator is notified EXACTLY once.
//   TWO_PROJECT ("30-min"): projects A and B, one pane each. A is delivered and made foreground,
//               then B becomes foreground (an explicit switch_context/switch_active_pane pair —
//               the catch-up-delta trigger: B's own context brief is freshly (re)injected). A's
//               agent asks a question WHILE BACKGROUNDED -> the operator hears it as a named
//               exception exactly once, with NO focus theft (no switch_active_pane side effect).
//               The operator "answers in place" (the pane resumes -> running, no explicit
//               voice/REST round trip needed to represent this — a genuine `running` signal IS the
//               answer landing, mirroring test_return_channel_journeys.ts journey 3). Both
//               exchanges settle to agent_complete, correlated to their OWN project, never mixed.
//               A planted malformed-envelope-near-a-valid-sentinel candidate on B is proven ignored
//               (an uncorrelated_events entry).
//   FLEET       ("60-min"): four panes across two projects. An ambiguous voice reference
//               (two panes sharing a name prefix) is clarified BEFORE any delivery for that
//               instruction (the clarify-then-deliver hard invariant). Two approvals: one
//               confirmed at the exact staged draft version, one invalidated by a revise (CAS
//               version mismatch) and re-approved at its NEW version — proving no double-delivery.
//               One interruption (a restart-quarantine CAS + `exchange_recovered` event, the exact
//               shape src/exchanges/recovery.ts's quarantineOne applies on a real reboot) followed
//               by a retry via the REAL recovery REST action (`POST /api/exchanges/:id/retry`) —
//               the original stays `interrupted` (explicit, never silently resumed); a follow-up
//               draft is minted instead. A planted wrong-exchange-id ("bystander") envelope on a
//               live pane is proven ignored on BOTH sides. One browser reconnect proves no
//               duplicate narration for an unchanged exchange. Finally, all four panes are driven
//               into DISTINCT board tiers (needs_input/failed-interrupted/complete/running) and
//               `get_status_summary`'s real composeExchangeBoard/rankExchangeBoard priority order
//               (tier 1 < 2 < 3 < 4) is asserted against the rendered text.
//
// ── Report schema (BenchmarkReport, see the interface below) ───────────────────────────────────
// Written to REPORT_PATH (see "CLI / dual invocation" below) and asserted against IN-TEST (the
// final `it` re-reads the file from disk and checks the hard-failure gates against that copy, not
// just the in-memory object):
//   wrong_target_deliveries      — harness-recorded INTENT (which pane an instruction was meant
//                                  for) vs. the ACTUAL delivered pane, read back from durable
//                                  agent_exchanges rows. Independent of metrics.ts's own
//                                  wrongTargetDeliveries (which derives from the currently-UNWIRED
//                                  `target_resolved` event — see the BUG note below).
//   duplicate_deliveries         — TWO independent measurements (belt and suspenders):
//                                  .fromEvents  = buildExchangeMetricsReport's own adjacency scan
//                                                 over exchange_events (the SAME algorithm 5.2 uses).
//                                  .fromPtyWrites = harness-expected write count per pane (one per
//                                                 planned delivery) vs. the StubTerminal's own
//                                                 writeInputCount — a bug in EITHER direction
//                                                 (missing OR extra writes) shows up here.
//   clarification_counts         — cause -> count, from the harness's OWN recorded clarifications
//                                  (never from metrics.ts's clarificationCauses, which reads {}
//                                  against real traffic today — see the BUG note).
//   context_versions             — per project: { minted, acknowledged } context_deliveries rows.
//   notification_latency         — [{ exchangeId, eventType, eventTs, narrationTs, latencyMs }],
//                                  timed by the harness itself around each onOutput!/onIdle! call.
//   uncorrelated_events          — planted "this must settle nothing" cases + whether the harness
//                                  verified that (resolved: true for every one the battery plants).
//   recovery_outcomes            — [{ exchangeId, disposition, explicitState, explicit }] for every
//                                  interruption the battery drives.
//   metrics_5_2                  — the RAW output of buildExchangeMetricsReport(store()) over the
//                                  same DB, for cross-checking against the harness's own numbers.
//   hard_failures                — the five pinned boolean gates (see HARD FAILURES below).
//
// ── HARD FAILURES pinned in-test (final `it`) ──────────────────────────────────────────────────
//   1. wrong_target_deliveries === 0
//   2. duplicate_deliveries.fromEvents === 0 AND duplicate_deliveries.fromPtyWrites === 0
//   3. every planted ambiguous reference was clarified strictly before its eventual delivery
//   4. every planted uncorrelated-event case resolved exactly as expected (zero unexplained)
//   5. every interruption ended in an explicit state (interrupted/cancelled/agent_complete/
//      agent_failed/draft — never left ambiguous)
//
// ── BUG NOTE (residual, annotated gap — NOT introduced by this harness) ────────────────────────
// src/exchanges/metrics.ts's own `wrongTargetDeliveries` and `clarificationCauses` derive from the
// `target_resolved` / `clarification_requested` ExchangeEventType union members (src/exchanges/
// types.ts). Both ARE wired as of Phase 5.4 (this note used to say "no producer in this codebase
// today"; that was stale): every `createExchange` appends `target_resolved` (persistCreate) and the
// dispatch clarify seam appends `clarification_requested` (recordClarificationRequested, called from
// src/voice/index.ts settleExchangeForDispatch) — see tests/test_exchange_metrics_live.ts for the
// live producer-chain proof. `metrics_5_2.clarificationCauses` still reads `{}` for THIS harness
// specifically, though, because the FLEET journey's clarify is a PRE-EXCHANGE targetResolver clarify
// (retarget_instruction) — it fires before any exchange exists, and exchange_events.exchange_id is
// NOT NULL, so that turn structurally cannot carry an exchange event (see
// `CLARIFICATION_PRE_EXCHANGE_NOTE`, src/exchanges/metrics.ts). This is why the task brief requires
// the harness to measure wrong-target/clarification independently (see above) — the divergence
// between this file's own `metrics_5_2.clarificationCauses` (`{}`) and `clarification_counts` (the
// harness's own measurement, non-empty) IS the residual, annotated gap, preserved in the emitted
// report for a reader to see directly.
//
// ── Real waits (unavoidable) ────────────────────────────────────────────────────────────────────
// The REAL PaneSignalBus (src/paneSignalBus.ts) enforces a 5000ms cross-kind cooldown per pane
// (real Date.now(), not fake-clock-injectable — see test_return_channel_journeys.ts's own file-header
// note, reproduced here). Every journey below that needs a clean narration assertion after a pane's
// `running` edge waits ONE real ~5.3s gap (PAST_COOLDOWN_MS) before firing the next distinct signal
// kind on that same pane. This battery pays that cost 4 times (once per journey's first running-edge
// batch, plus once more inside TWO_PROJECT for the "operator answers in place" resume-then-idle
// sequence) — a few seconds of unavoidable real time, not a design flaw.
//
// ── CLI / dual invocation (no separate scripts/ entry — this file already satisfies both) ─────
// Node's test runner (`node:test`) executes `describe`/`it` bodies IMMEDIATELY when the file is
// loaded directly (verified: `node plain.mjs` runs and TAP-reports the tests with no `--test` flag
// at all) — so this ONE file is already both the node:test suite AND a plain CLI entry point:
//   npx tsx --test --test-force-exit tests/test_exchange_benchmarks.ts     (standard suite mode)
//   npx tsx tests/test_exchange_benchmarks.ts                              (plain CLI invocation)
// Both write the SAME JSON report (path below) and both exit non-zero on any failed assertion.
// Report path: `--report <path>` (argv) or `EXCHANGE_BENCHMARK_REPORT` (env), else
// `<original cwd>/benchmark-report.json` — resolved ONCE at module load, before this file's own
// `chdir()` into a scratch tmpdir, so the artifact survives the suite's own directory churn and
// lands where the caller actually expects it.
//
// Sibling suites this battery builds on WITHOUT duplicating (see their own file headers):
//   tests/test_return_channel_journeys.ts, tests/test_instruction_routing_journeys.ts,
//   tests/test_cortex_cutover_journeys.ts, tests/helpers/mockLive.ts.

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";
import type { MockLiveHandle, MockLiveSession } from "./helpers/mockLive";
import { teardownServerSuite } from "./helpers/teardown";
import type { RunningServer } from "../server";
import type { ExchangeMetricsReport } from "../src/exchanges/metrics";

// ── report path (resolved BEFORE this file's own chdir) ────────────────────────────────────────
const ORIGINAL_CWD = process.cwd();
function resolveReportPath(): string {
  const argIdx = process.argv.indexOf("--report");
  const fromArg = argIdx !== -1 ? process.argv[argIdx + 1] : undefined;
  const fromEnv = process.env.EXCHANGE_BENCHMARK_REPORT;
  const raw = fromArg || fromEnv || "benchmark-report.json";
  return path.isAbsolute(raw) ? raw : path.join(ORIGINAL_CWD, raw);
}
const REPORT_PATH = resolveReportPath();

// JANUS_EXCHANGE_SPINE must be set BEFORE the first import of anything touching src/exchanges/
// flag.ts (or a module that transitively imports it) in THIS process (the documented idiom in
// every sibling journey suite — it caches its mode at module load, and `node --test`/plain `node`
// runs this file as its own process, so this can never leak elsewhere).
//
// FLAG COLLAPSE (2026-07): this suite used to ALSO set JANUS_INSTRUCTION_ENVELOPE=primary (the
// FOCUSED journey's distill assertions need the rendered envelope to BE the delivered instruction)
// and JANUS_AGENT_RESULT_ENVELOPE=accept. Both are retired: instruction-envelope mode is now 1:1
// derived from the spine's own mode, so "primary"-equivalent behavior now requires
// JANUS_EXCHANGE_SPINE="authoritative" (not just "record" — record only gets the old
// shadow-equivalent, envelopes built/stored but NOT yet the delivered instruction); the old
// "accept" rung is automatic whenever the spine is non-off, so no separate var is needed for it.
process.env.JANUS_EXCHANGE_SPINE = "authoritative";

// Pure modules, safe to import at top level (none transitively import `../server` — same
// verification every sibling suite documents for its own top-level dynamic imports).
const { getExchangeService } = await import("../src/exchanges/spine");
const { getOpenDraft, resetDraftRegistryForTests } = await import("../src/exchanges/draftRegistry");
const { buildExchangeMetricsReport } = await import("../src/exchanges/metrics");
const { DEFAULT_VOICE_UX } = await import("../src/types");

const svc = getExchangeService();

// ── report data model ──────────────────────────────────────────────────────────────────────────

interface DeliveryRecord { exchangeId: string; intendedProjectId: string; intendedPaneId: string }
interface NotificationRecord { exchangeId: string; eventType: string; eventTs: number; narrationTs: number; latencyMs: number }
interface ClarificationRecord { cause: string; ts: number }
interface ClarifyBeforeDeliveryRecord { label: string; clarifyTs: number; deliveryTs: number; ok: boolean }
interface UncorrelatedRecord { description: string; resolved: boolean }
interface RecoveryRecord { exchangeId: string; disposition: string; explicitState: string; explicit: boolean }

/** States a reader can trust as a genuine, non-ambiguous resting point for an exchange that was
 *  ever interrupted — never "whatever it happened to be when we stopped looking". */
const EXPLICIT_STATES: ReadonlySet<string> = new Set([
  "interrupted", "cancelled", "agent_complete", "agent_failed", "draft",
]);

/** The harness's own ground-truth recorder — everything a durable AgentExchange row or a
 *  production metric CANNOT tell you on its own (what was INTENDED, when a clarify happened
 *  relative to a delivery, which events were deliberately planted to settle nothing). */
class BenchmarkGroundTruth {
  deliveries: DeliveryRecord[] = [];
  notifications: NotificationRecord[] = [];
  clarifications: ClarificationRecord[] = [];
  clarifyBeforeDelivery: ClarifyBeforeDeliveryRecord[] = [];
  uncorrelated: UncorrelatedRecord[] = [];
  recoveries: RecoveryRecord[] = [];
  expectedWrites = new Map<string, number>();

  recordDelivery(exchangeId: string, intendedProjectId: string, intendedPaneId: string): void {
    this.deliveries.push({ exchangeId, intendedProjectId, intendedPaneId });
  }
  expectWrite(paneId: string): void {
    this.expectedWrites.set(paneId, (this.expectedWrites.get(paneId) ?? 0) + 1);
  }
  recordNotification(exchangeId: string, eventType: string, eventTs: number, narrationTs: number): void {
    this.notifications.push({ exchangeId, eventType, eventTs, narrationTs, latencyMs: Math.max(0, narrationTs - eventTs) });
  }
  recordClarification(cause: string, ts: number): void {
    this.clarifications.push({ cause, ts });
  }
  recordClarifyBeforeDelivery(label: string, clarifyTs: number, deliveryTs: number): void {
    this.clarifyBeforeDelivery.push({ label, clarifyTs, deliveryTs, ok: clarifyTs <= deliveryTs });
  }
  recordUncorrelated(description: string, resolved: boolean): void {
    this.uncorrelated.push({ description, resolved });
  }
  recordRecovery(exchangeId: string, disposition: string, explicitState: string): void {
    this.recoveries.push({ exchangeId, disposition, explicitState, explicit: EXPLICIT_STATES.has(explicitState) });
  }
}

interface BenchmarkReport {
  generatedAt: string;
  journeys: string[];
  wrong_target_deliveries: number;
  duplicate_deliveries: { fromEvents: number; fromPtyWrites: number; ptyMismatches: Array<{ paneId: string; expected: number; actual: number }> };
  clarification_counts: Record<string, number>;
  context_versions: Record<string, { minted: number; acknowledged: number }>;
  notification_latency: NotificationRecord[];
  uncorrelated_events: UncorrelatedRecord[];
  recovery_outcomes: RecoveryRecord[];
  metrics_5_2: ExchangeMetricsReport;
  hard_failures: {
    wrong_target_deliveries_zero: boolean;
    duplicate_deliveries_zero: boolean;
    all_ambiguous_clarified_before_delivery: boolean;
    zero_unexplained_uncorrelated_events: boolean;
    all_interruptions_explicit_state: boolean;
  };
}

const groundTruth = new BenchmarkGroundTruth();

// ── shared test-harness plumbing (verbatim idioms from the sibling journey suites) ─────────────

/** Merged StubTerminal — the union of fields test_instruction_routing_journeys.ts's dispatch-side
 *  stub (writeInputCount, permissionsMode, toolPreset, …) and test_return_channel_journeys.ts's
 *  observation-side stub (getRawBackfill, mutable runtimeType/status) both need. No real PTY ever
 *  spawns; every "delivery" is this class's own writeInput counter. */
class StubTerminal {
  status: "Running" | "Idle" | "Exited" = "Running";
  lastCommand = "";
  writeInputCount = 0;
  stopCount = 0;
  projectId: string;
  cwd = "/stub/cwd";
  runtimeType: "interactive_cli" | "shell" = "interactive_cli";
  permissionsMode: "Full Auto" | "Human-in-the-Loop" | "Read-Only" = "Human-in-the-Loop";
  toolPreset = "Custom";
  sessionId = "stub-session";
  contextSize = 0;
  lastStatusChangeAt = Date.now();
  constructor(public terminalId: string, projectId: string) { this.projectId = projectId; }
  writeInput(command: string): void {
    this.lastCommand = command;
    this.writeInputCount++;
    this.status = "Running";
  }
  getRecentOutput(_lines = 10): string { return "stub output line A\nstub output line B"; }
  getRawBackfill(): string { return ""; }
  private deltaConsumed = false;
  consumeDelta(): { lines: string; dropped: number } {
    if (this.deltaConsumed) return { lines: "", dropped: 0 };
    this.deltaConsumed = true;
    return { lines: "stub delta line 1\nstub delta line 2", dropped: 0 };
  }
  setPermissionsMode(mode: "Full Auto" | "Human-in-the-Loop" | "Read-Only"): void { this.permissionsMode = mode; }
  async stop(): Promise<void> { this.stopCount++; this.status = "Exited"; }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
/** Just past PaneSignalBus's production 5000ms cross-kind cooldown default — see the file-header note. */
const PAST_COOLDOWN_MS = 5300;

describe("exchange release benchmark (real server, real voice verbs, real observation pipeline, real JanusStore)", () => {
  let mock: MockLiveHandle;
  let running: RunningServer;
  let session: MockLiveSession;
  let client: WebSocket;
  let wsFrames: any[];
  let tmpDir: string;
  let prevCwd: string;
  let startServer: (opts?: any) => Promise<RunningServer>;
  let apiToken: string;
  let installMockLive: () => MockLiveHandle;
  let waitFor: <T>(p: () => T | undefined | false, t?: number, i?: number) => Promise<T>;
  let HistoryManagerRef: { getInstance(): { saveHistory(id: string, h: any[]): void } };

  const store = () => running._testStore!()!;

  const api = (pathname: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`http://127.0.0.1:${running.port}${pathname}`, {
      ...init,
      headers: { "x-api-token": apiToken, "content-type": "application/json", ...(init.headers || {}) },
    });

  async function callTool(name: string, args: Record<string, any> = {}): Promise<{ callId: string; output: string; status?: string; raw: any }> {
    const callId = session.emitToolCall(name, args);
    const raw = await waitFor(() => mock.rawResponseFor(callId));
    return { callId, output: String(raw?.output ?? ""), status: raw?.status, raw };
  }

  async function setActivePane(paneId: string): Promise<void> {
    const call = session.emitToolCall("switch_active_pane", { pane_id: paneId });
    await waitFor(() => mock.responseFor(call));
  }

  /** Register a pane both in the ledger (so target resolution / gates / display names all read
   *  real state) AND as a live StubTerminal — verbatim idiom from
   *  tests/test_instruction_routing_journeys.ts's registerPane. */
  function registerPane(
    projectId: string,
    paneId: string,
    name: string,
    preset: string,
    permissionsMode: "Full Auto" | "Human-in-the-Loop" | "Read-Only" = "Human-in-the-Loop",
  ): StubTerminal {
    if (!running.manager.ledger.getProject(projectId)) {
      running.manager.ledger.addProject(projectId, tmpDir, `${projectId} fixture project`);
    }
    running.manager.ledger.updatePane(projectId, {
      pane_id: paneId, name, runtime_type: "interactive_cli",
      last_known_state: "Idle", is_busy: false, alive: true,
      notes: [], permissions_mode: permissionsMode, session_id: `${paneId}-session`,
      tool_preset: preset, context_size: 0,
    } as any, true);
    const t = new StubTerminal(paneId, projectId);
    t.permissionsMode = permissionsMode;
    t.toolPreset = preset;
    (running.manager.terminals as any)[paneId] = t;
    return t;
  }

  function seedHistory(paneId: string, command: string, output: string, finalResponse: string): void {
    HistoryManagerRef.getInstance().saveHistory(paneId, [
      { command, timestamp: new Date().toISOString(), output, finalResponse },
    ]);
  }

  function clientTextsSince(sess: MockLiveSession, fromIdx: number): string[] {
    return sess.clientContents
      .slice(fromIdx)
      .map((c: any) => c?.turns?.[0]?.parts?.[0]?.text)
      .filter((t: unknown): t is string => typeof t === "string");
  }
  function isExchangeNarration(text: string): boolean {
    return text.startsWith("Pane '") || text.startsWith("In project '");
  }
  function exchangeNarrationsSince(sess: MockLiveSession, fromIdx: number): string[] {
    return clientTextsSince(sess, fromIdx).filter(isExchangeNarration);
  }

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";
    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-exbench-"));
    process.chdir(tmpDir);

    ({ installMockLive, waitFor } = await import("./helpers/mockLive"));
    const serverMod = await import("../server");
    startServer = serverMod.startServer;
    apiToken = serverMod.API_AUTH_TOKEN;
    HistoryManagerRef = serverMod.HistoryManager;

    mock = installMockLive();
    running = await startServer({ port: 0, enableVite: false });
    // Never let the context-inject debounce swallow a switch's own brief (cortex-cutover's own
    // idiom) — the TWO_PROJECT journey's "catch-up delta" assertion needs a genuine fresh delivery.
    running.manager.settings.voiceUx = { ...(running.manager.settings.voiceUx ?? DEFAULT_VOICE_UX), contextInjectDebounceMs: 0 };

    wsFrames = [];
    client = new WebSocket(`ws://127.0.0.1:${running.port}/live`, { headers: { Cookie: `auth_token=${apiToken}` } });
    client.on("message", (data) => { try { wsFrames.push(JSON.parse(data.toString())); } catch { /* non-JSON */ } });
    await new Promise<void>((resolve, reject) => { client.on("open", () => resolve()); client.on("error", reject); });
    session = await waitFor(() => mock.latest());

    resetDraftRegistryForTests();
  });

  after(async () => {
    if (running?.manager) {
      const terms = Object.values(running.manager.terminals) as any[];
      await Promise.all(terms.map((t) => Promise.resolve(t.stop?.()).catch(() => { /* already gone */ })));
    }
    if (client && client.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => { client.once("close", () => resolve()); try { client.terminate(); } catch { resolve(); } });
    }
    await teardownServerSuite(running);
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // FOCUSED ("15-min"): one project, one pane.
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  describe("FOCUSED (\"15-min\" scale): dictate -> distill -> revise -> send -> running -> result envelope -> notified once", () => {
    it("a single Full-Auto pane carries one instruction end to end with exactly one notification", async () => {
      const PJ = "bench-focused";
      const PANE = "focused-pane";
      registerPane(PJ, PANE, "focused-pane", "Custom", "Full Auto");
      await callTool("switch_context", { project_id: PJ });
      await setActivePane(PANE);

      // dictate -> distill: the raw dictation carries filler whitespace and an empty aside;
      // buildEnvelope's normalizeList/trim is the REAL distillation step (no fabrication, spec §1).
      const rawObjective = "  investigate the memory leak in the exporter  ";
      const rawContext = ["  it started after the last deploy  ", "", "   "];
      const draft = await callTool("draft_instruction", { objective: rawObjective, relevant_context: rawContext });
      assert.strictEqual(draft.status, undefined);
      const distilled = getOpenDraft(PJ, PANE)!;
      assert.strictEqual(distilled.envelope.objective, "investigate the memory leak in the exporter", "distill: trims the operator's raw dictation");
      assert.deepStrictEqual(distilled.envelope.relevant_context, ["it started after the last deploy"], "distill: drops empty/whitespace-only lines, never fabricates");

      // revise
      const revise = await callTool("revise_instruction", { constraints: ["do not restart the exporter process"] });
      assert.strictEqual(revise.status, undefined);
      assert.strictEqual(getOpenDraft(PJ, PANE)!.draftVersion, 2);

      // send
      const send = await callTool("send_instruction", {});
      assert.match(send.output, /Command executed automatically on pane focused-pane/);
      groundTruth.expectWrite(PANE);
      const term = running.manager.terminals[PANE] as unknown as StubTerminal;
      assert.strictEqual(term.writeInputCount, 1);

      const exchangeId = svc.activeExchangeForPane(PANE)!;
      assert.ok(exchangeId, "a real AgentExchange row now backs this delivery");
      groundTruth.recordDelivery(exchangeId, PJ, PANE);

      // running
      running.manager.onRunning!(PANE);
      await sleep(PAST_COOLDOWN_MS);

      // result envelope -> agent_complete -> notified exactly once
      const idx = session.clientContents.length;
      const eventTs = Date.now();
      seedHistory(PANE, "investigate the memory leak", JSON.stringify({
        exchange_id: exchangeId, status: "complete", summary: "leak traced to an unclosed listener",
      }), "found it");
      await running.manager.onIdle!(PANE);
      const narrationTs = Date.now();
      groundTruth.recordNotification(exchangeId, "agent_completion_reported", eventTs, narrationTs);

      const row = store().getExchange(exchangeId)!;
      assert.strictEqual(row.state, "agent_complete");
      const narrations = exchangeNarrationsSince(session, idx);
      assert.deepStrictEqual(narrations, [`Pane '${PANE}' finished: leak traced to an unclosed listener`], "operator notified EXACTLY once");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // TWO_PROJECT ("30-min"): A/B switch, catch-up delta, background exception, answer in place.
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  describe("TWO_PROJECT (\"30-min\" scale): A/B switch + catch-up delta, background exception (no focus theft), answer in place, per-project correlation", () => {
    it("A is delivered and backgrounded; B becomes foreground with a fresh catch-up delta; A's question crosses over once with no focus theft; both settle correlated to their own project", async () => {
      const PA = "bench-2p-a";
      const PB = "bench-2p-b";
      const PANE_A = "tp-a-pane";
      const PANE_B = "tp-b-pane";
      registerPane(PA, PANE_A, "tp-a-pane", "Custom", "Full Auto");
      registerPane(PB, PANE_B, "tp-b-pane", "Custom", "Full Auto");

      // A becomes the pool-tracked foreground project (an explicit switch_context — the ONLY
      // trigger that registers pool foreground/backgrounded state, per src/voice/index.ts's
      // backgroundProjectForSignal doc, mirrored from test_return_channel_journeys.ts journey 9).
      await callTool("switch_context", { project_id: PA });
      await setActivePane(PANE_A);
      await callTool("draft_instruction", { objective: "roll the deployment logs" });
      const sendA = await callTool("send_instruction", {});
      assert.match(sendA.output, /Command executed automatically on pane tp-a-pane/);
      groundTruth.expectWrite(PANE_A);
      const exchangeA = svc.activeExchangeForPane(PANE_A)!;
      groundTruth.recordDelivery(exchangeA, PA, PANE_A);
      running.manager.onRunning!(PANE_A);

      const deliveriesBeforeB = store().getContextDeliveries({ limit: 1_000_000 }).length;

      // Switch to B — backgrounds A. This is the "catch-up delta" trigger: B's own context brief
      // is freshly (re)injected (a NEW context_deliveries row), never A's stale content.
      await callTool("switch_context", { project_id: PB });
      await setActivePane(PANE_B);
      await waitFor(() => store().getContextDeliveries({ limit: 1_000_000 }).length > deliveriesBeforeB);

      await callTool("draft_instruction", { objective: "tail the ingest worker" });
      const sendB = await callTool("send_instruction", {});
      assert.match(sendB.output, /Command executed automatically on pane tp-b-pane/);
      groundTruth.expectWrite(PANE_B);
      const exchangeB = svc.activeExchangeForPane(PANE_B)!;
      groundTruth.recordDelivery(exchangeB, PB, PANE_B);
      running.manager.onRunning!(PANE_B);

      await sleep(PAST_COOLDOWN_MS); // covers BOTH running edges above.

      // Planted uncorrelated case: a malformed candidate near a valid-looking sentinel on B —
      // must be scanned, found invalid, and silently skipped (mirrors return-channel journey 5).
      const garbage = `Attempting to report: {"exchange_id":"${exchangeB}","status":"complete",summary:UNQUOTED_AND_BROKEN}\n`;
      running.manager.onOutput!(PANE_B, garbage);
      const stillRunning = svc.get(exchangeB)!.state === "running";
      groundTruth.recordUncorrelated("malformed envelope near a valid-looking sentinel on tp-b-pane never settles anything", stillRunning);
      assert.strictEqual(svc.get(exchangeB)!.state, "running", "a malformed candidate must never settle anything");

      // Background exception: A's agent asks a question while B is foreground.
      const idxException = session.clientContents.length;
      const switchFramesBefore = wsFrames.filter((f) => f?.type === "switch_active_pane").length;
      const exceptionEventTs = Date.now();
      (running.manager.terminals as any)[PANE_A].status = "Idle";
      (running.manager.terminals as any)[PANE_A].runtimeType = "shell";
      running.manager.onOutput!(PANE_A, "overwrite the staging config? $ ");
      assert.strictEqual(svc.get(exchangeA)!.state, "needs_input");
      const exceptionNarrationTs = Date.now();
      const exceptionNarrations = exchangeNarrationsSince(session, idxException);
      assert.deepStrictEqual(
        exceptionNarrations,
        [`In project '${PA}', pane '${PANE_A}' needs your input: "overwrite the staging config? $"`],
        "the backgrounded project's exception is announced exactly once, named explicitly",
      );
      groundTruth.recordNotification(exchangeA, "needs_input_detected", exceptionEventTs, exceptionNarrationTs);
      const switchFramesAfter = wsFrames.filter((f) => f?.type === "switch_active_pane").length;
      assert.strictEqual(switchFramesAfter, switchFramesBefore, "the exception narration never steals focus (no switch_active_pane side effect)");

      // Operator "answers in place": the pane resumes — a genuine `running` signal IS the answer
      // landing (mirrors test_return_channel_journeys.ts journey 3's exact idiom).
      (running.manager.terminals as any)[PANE_A].status = "Running";
      running.manager.onRunning!(PANE_A);
      assert.strictEqual(svc.get(exchangeA)!.state, "running");
      await sleep(PAST_COOLDOWN_MS); // past the cooldown from the running edge just fired, before idling either pane.

      // B completes FIRST, while it is still the FOREGROUND project — narrates normally.
      // (A completion narration would be SUPPRESSED right now: buildExchangeAwareSignalText only
      // crosses a BACKGROUNDED project's narration over for the "exception" classes
      // (needs_input/failed/interrupted) — a plain "complete" for a backgrounded project is
      // deliberately deferred to that project's own next promotion/catch-up, src/voice/index.ts's
      // documented contract, exercised directly by test_cortex_cutover_journeys.ts's "background
      // command-outcome dropped" journey. So A is completed AFTER switching back to it below.)
      const idxB = session.clientContents.length;
      const bEventTs = Date.now();
      seedHistory(PANE_B, "tail the ingest worker", JSON.stringify({
        exchange_id: exchangeB, status: "complete", summary: "worker caught up, no errors",
      }), "caught up");
      await running.manager.onIdle!(PANE_B);
      groundTruth.recordNotification(exchangeB, "agent_completion_reported", bEventTs, Date.now());
      assert.deepStrictEqual(exchangeNarrationsSince(session, idxB), [`Pane '${PANE_B}' finished: worker caught up, no errors`]);

      // The operator returns to A (a real catch-up moment) — NOW its completion narrates normally.
      await callTool("switch_context", { project_id: PA });
      await setActivePane(PANE_A);

      const idxA = session.clientContents.length;
      const aEventTs = Date.now();
      seedHistory(PANE_A, "roll the deployment logs", JSON.stringify({
        exchange_id: exchangeA, status: "complete", summary: "logs rolled, 3 files archived",
      }), "rolled");
      await running.manager.onIdle!(PANE_A);
      groundTruth.recordNotification(exchangeA, "agent_completion_reported", aEventTs, Date.now());
      assert.deepStrictEqual(exchangeNarrationsSince(session, idxA), [`Pane '${PANE_A}' finished: logs rolled, 3 files archived`]);

      // Results correlated per project — never mixed.
      const rowA = store().getExchange(exchangeA)!;
      const rowB = store().getExchange(exchangeB)!;
      assert.strictEqual(rowA.state, "agent_complete");
      assert.strictEqual(rowB.state, "agent_complete");
      assert.strictEqual(rowA.project_id, PA);
      assert.strictEqual(rowB.project_id, PB);
      assert.notStrictEqual(rowA.exchange_id, rowB.exchange_id);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // FLEET ("60-min"): four panes, two projects, clarify-before-deliver, two approvals,
  // interruption + retry, wrong-exchange-id bystander, reconnect, catch-up priority order.
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  describe("FLEET (\"60-min\" scale): clarify-before-deliver, two approvals (exact-version + revised-then-reapproved), interruption+retry, reconnect, catch-up priority order", () => {
    it("drives four panes across two projects through the full fleet-management surface", async () => {
      const FA = "bench-fleet-a";
      const FB = "bench-fleet-b";
      const A1 = "fleet-a1"; // display name "worker-alpha"
      const A2 = "fleet-a2"; // display name "worker-beta"
      const B1 = "fleet-b1";
      const B2 = "fleet-b2";
      registerPane(FA, A1, "worker-alpha", "Custom", "Full Auto");
      registerPane(FA, A2, "worker-beta", "Custom", "Full Auto");
      registerPane(FB, B1, "fleet-b1", "Custom", "Human-in-the-Loop");
      registerPane(FB, B2, "fleet-b2", "Custom", "Human-in-the-Loop");

      // ── clarify BEFORE delivery: two panes share the "worker" name prefix ──────────────────
      await callTool("switch_context", { project_id: FA });
      await setActivePane(A1);
      await callTool("draft_instruction", { objective: "investigate the queue backlog" });
      const clarifyTs = Date.now();
      const retarget = await callTool("retarget_instruction", { reference: "worker" });
      assert.strictEqual(retarget.status, "clarify", "two panes share the 'worker' prefix -> confirm, never a guess");
      assert.match(retarget.output, /worker-alpha/);
      assert.match(retarget.output, /worker-beta/);
      groundTruth.recordClarification("ambiguous_reference", clarifyTs);
      const confirm = await callTool("confirm_instruction", { pane_id: A1 });
      assert.strictEqual(confirm.status, undefined, "answering the clarification resolves without a second clarify");

      const sendA1 = await callTool("send_instruction", {});
      const a1DeliveryTs = Date.now();
      assert.match(sendA1.output, /Command executed automatically on pane fleet-a1/);
      groundTruth.expectWrite(A1);
      const exchangeA1 = svc.activeExchangeForPane(A1)!;
      groundTruth.recordDelivery(exchangeA1, FA, A1);
      groundTruth.recordClarifyBeforeDelivery("fleet-ambiguous-worker-reference", clarifyTs, a1DeliveryTs);
      running.manager.onRunning!(A1);

      await setActivePane(A2);
      await callTool("draft_instruction", { objective: "clean the temp cache on worker beta" });
      const sendA2 = await callTool("send_instruction", {});
      assert.match(sendA2.output, /Command executed automatically on pane fleet-a2/);
      groundTruth.expectWrite(A2);
      const exchangeA2 = svc.activeExchangeForPane(A2)!;
      groundTruth.recordDelivery(exchangeA2, FA, A2);
      running.manager.onRunning!(A2);

      await sleep(PAST_COOLDOWN_MS); // covers A1 and A2's running edges.

      // ── planted uncorrelated case: a wrong-exchange-id ("bystander") envelope on A2 ────────
      const bystander = svc.createExchange({
        projectId: FA, paneId: "fleet-bystander-pane", operatorUtterance: "please lint", distilledInstruction: "run the linter",
      });
      const idxBystander = session.clientContents.length;
      running.manager.onOutput!(A2, JSON.stringify({ exchange_id: bystander.exchangeId, status: "complete", summary: "not for you" }));
      const a2Untouched = svc.get(exchangeA2)!.state === "running";
      const bystanderUntouched = store().getExchange(bystander.exchangeId)!.state === "draft";
      const noNarration = exchangeNarrationsSince(session, idxBystander).length === 0;
      groundTruth.recordUncorrelated(
        "a wrong-exchange-id envelope naming a bystander exchange settles NEITHER the active exchange NOR the named bystander",
        a2Untouched && bystanderUntouched && noNarration,
      );
      assert.strictEqual(svc.get(exchangeA2)!.state, "running", "the active exchange is untouched by a report naming someone else");
      assert.strictEqual(store().getExchange(bystander.exchangeId)!.state, "draft", "the named bystander is never touched either");

      // ── interruption (restart quarantine) + retry via the REAL recovery REST action ────────
      // The exact CAS + event shape src/exchanges/recovery.ts's quarantineOne applies on a real
      // reboot — simulated inline (mirrors test_return_channel_journeys.ts journey 7) rather than
      // restarting the whole process, since the correlation invariant under test is the CAS +
      // durable event, not the boot sequence itself.
      const casRes = store().updateExchange(exchangeA1, { state: "interrupted" }, { state: "running" });
      assert.ok(casRes.changed);
      store().appendExchangeEvent({
        exchange_id: exchangeA1, event_type: "exchange_recovered", pane_id: A1, project_id: FA,
        payload_redacted_json: JSON.stringify({ disposition: "interrupted", reason: "boot_quarantine", from_state: "running" }),
      });
      // A real operator recovering an attention item navigates to its pane first (the
      // open_exchange_pane action's own documented workflow) — that also happens to be what makes
      // write_to_pane resolve Auto here: the capability gate's "spotlight" (trust follows focus,
      // src/gating/index.ts effectiveCapabilityGateFor) only widens for the ACTIVE pane, and A1 lost
      // focus when A2 became active above. Re-focusing A1 mirrors the real recovery workflow, not a
      // test-only shortcut.
      await setActivePane(A1);
      const retryRes = await api(`/api/exchanges/${exchangeA1}/retry`, { method: "POST" });
      assert.strictEqual(retryRes.status, 200);
      const retryBody = await retryRes.json();
      assert.match(String(retryBody.output), /new follow-up draft/, "an interrupted exchange never resumes in place — a follow-up draft is minted instead");
      const a1After = store().getExchange(exchangeA1)!;
      assert.strictEqual(a1After.state, "interrupted", "the ORIGINAL stays interrupted — never silently resumed");
      groundTruth.recordRecovery(exchangeA1, "interrupted_new_follow_up_draft", a1After.state);

      // ── two approvals: one confirmed exact-version, one invalidated by an edit then re-approved ─
      await callTool("switch_context", { project_id: FB });
      await setActivePane(B1);
      await callTool("draft_instruction", { objective: "rotate the service credentials" });
      const send1 = await callTool("send_instruction", {});
      assert.match(send1.output, /Pending approval/);
      const approve1 = await api("/api/commands/approve", { method: "POST", body: JSON.stringify({ messageId: send1.callId, approved: true }) });
      assert.strictEqual(approve1.status, 200);
      const termB1 = running.manager.terminals[B1] as unknown as StubTerminal;
      await waitFor(() => termB1.writeInputCount > 0);
      groundTruth.expectWrite(B1);
      assert.strictEqual(termB1.writeInputCount, 1, "the exact-version approval delivered exactly once");
      const exchangeB1 = svc.activeExchangeForPane(B1)!;
      groundTruth.recordDelivery(exchangeB1, FB, B1);
      running.manager.onRunning!(B1);

      await setActivePane(B2);
      await callTool("draft_instruction", { objective: "restart the ingestion worker" });
      const send2 = await callTool("send_instruction", {});
      assert.match(send2.output, /Pending approval/);
      const revise = await callTool("revise_instruction", { objective: "restart the ingestion worker and archive its logs" });
      assert.strictEqual(revise.status, undefined, "the operator can amend the in-flight instruction while an approval is outstanding");
      const send3 = await callTool("send_instruction", {});
      assert.match(send3.output, /Pending approval/, "the revised draft stages its OWN new-version approval");

      // Duplicate-guard: approving the now-STALE send2 must never deliver (CAS version mismatch).
      const staleApprove = await api("/api/commands/approve", { method: "POST", body: JSON.stringify({ messageId: send2.callId, approved: true }) });
      const staleBody = await staleApprove.json().catch(() => ({}));
      assert.notStrictEqual(staleBody?.success, true, "the CAS-invalidated stale approval fails to deliver");
      const termB2 = running.manager.terminals[B2] as unknown as StubTerminal;
      assert.strictEqual(termB2.writeInputCount, 0, "nothing has landed yet — the stale approval never wrote");

      const approve3 = await api("/api/commands/approve", { method: "POST", body: JSON.stringify({ messageId: send3.callId, approved: true }) });
      assert.strictEqual(approve3.status, 200);
      await waitFor(() => termB2.writeInputCount > 0);
      groundTruth.expectWrite(B2);
      assert.strictEqual(termB2.writeInputCount, 1, "exactly ONE delivery despite two send attempts — the invalidated approval never fires");
      assert.match(termB2.lastCommand, /archive its logs/, "the delivered text is the REVISED instruction");
      const exchangeB2 = svc.activeExchangeForPane(B2)!;
      groundTruth.recordDelivery(exchangeB2, FB, B2);
      running.manager.onRunning!(B2);

      await sleep(PAST_COOLDOWN_MS); // covers B1 and B2's running edges.

      // ── drive the four panes into DISTINCT board tiers (needs_input/failed/complete/running) ─
      const idxNeedsInput = session.clientContents.length;
      const needsInputEventTs = Date.now();
      (running.manager.terminals as any)[A2].status = "Idle";
      (running.manager.terminals as any)[A2].runtimeType = "shell";
      running.manager.onOutput!(A2, "confirm deletion of the temp cache? $ ");
      assert.strictEqual(svc.get(exchangeA2)!.state, "needs_input");
      const needsInputNarrations = exchangeNarrationsSince(session, idxNeedsInput);
      assert.strictEqual(needsInputNarrations.length, 1);
      groundTruth.recordNotification(exchangeA2, "needs_input_detected", needsInputEventTs, Date.now());

      const idxComplete = session.clientContents.length;
      const completeEventTs = Date.now();
      seedHistory(B1, "rotate the service credentials", JSON.stringify({
        exchange_id: exchangeB1, status: "complete", summary: "credentials rotated",
      }), "done");
      await running.manager.onIdle!(B1);
      const completeNarrations = exchangeNarrationsSince(session, idxComplete);
      assert.strictEqual(completeNarrations.length, 1);
      groundTruth.recordNotification(exchangeB1, "agent_completion_reported", completeEventTs, Date.now());
      // B2 is left running (tier 4); A1 is left interrupted (tier 2, "failed") from the recovery step above.

      // ── browser reconnect: no duplicate narration for the UNCHANGED needs_input exchange ────
      const idxBeforeReconnect = session.clientContents.length;
      const client2 = new WebSocket(`ws://127.0.0.1:${running.port}/live`, { headers: { Cookie: `auth_token=${apiToken}` } });
      await new Promise<void>((resolve, reject) => { client2.on("open", () => resolve()); client2.on("error", reject); });
      const session2 = await waitFor(() => mock.sessions.find((s) => s !== session && !s.closed));
      try {
        const idx2 = session2.clientContents.length;
        running.manager.onOutput!(A2, "confirm deletion of the temp cache? $ "); // the SAME unchanged question, re-observed
        assert.strictEqual(svc.get(exchangeA2)!.state, "needs_input", "unchanged — a genuine repeat, not a new transition");
        assert.deepStrictEqual(exchangeNarrationsSince(session2, idx2), [], "the NEW session never receives a duplicate narration");
        assert.deepStrictEqual(exchangeNarrationsSince(session, idxBeforeReconnect), [], "nor does the original session re-narrate");
      } finally {
        await new Promise<void>((resolve) => { client2.once("close", () => resolve()); try { client2.terminate(); } catch { resolve(); } });
      }

      // ── catch-up: get_status_summary's real board must read tier 1 < 2 < 3 < 4 ──────────────
      const summary = await callTool("get_status_summary");
      const idxNeeds = summary.output.indexOf("worker-beta"); // A2, tier 1 (needs_input)
      const idxFailed = summary.output.indexOf("worker-alpha"); // A1, tier 2 (interrupted)
      const idxDone = summary.output.indexOf("fleet-b1"); // B1, tier 3 (complete)
      const idxRunning = summary.output.indexOf("fleet-b2"); // B2, tier 4 (running)
      assert.ok(idxNeeds >= 0 && idxFailed >= 0 && idxDone >= 0 && idxRunning >= 0, `all four panes must appear on the board: ${summary.output}`);
      assert.ok(idxNeeds < idxFailed, "tier 1 (needs_input) precedes tier 2 (failed/interrupted)");
      assert.ok(idxFailed < idxDone, "tier 2 (failed/interrupted) precedes tier 3 (complete)");
      assert.ok(idxDone < idxRunning, "tier 3 (complete) precedes tier 4 (running)");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // The report itself — assembled from the harness's own ground truth + a live cross-check
  // against buildExchangeMetricsReport over the SAME durable store.
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  describe("benchmark report", () => {
    it("emits a machine-readable JSON report to REPORT_PATH and every hard-failure gate passes against the re-read copy", async () => {
      const metricsReport = buildExchangeMetricsReport(store(), { sinceMs: 0 });

      let wrongTarget = 0;
      for (const d of groundTruth.deliveries) {
        const row = store().getExchange(d.exchangeId);
        if (!row || row.project_id !== d.intendedProjectId || row.pane_id !== d.intendedPaneId) wrongTarget++;
      }

      let duplicateFromPty = 0;
      const ptyMismatches: Array<{ paneId: string; expected: number; actual: number }> = [];
      for (const [paneId, expected] of groundTruth.expectedWrites) {
        const term = running.manager.terminals[paneId] as unknown as StubTerminal | undefined;
        const actual = term?.writeInputCount ?? -1;
        if (actual !== expected) { duplicateFromPty++; ptyMismatches.push({ paneId, expected, actual }); }
      }

      const contextVersions: Record<string, { minted: number; acknowledged: number }> = {};
      for (const row of store().getContextDeliveries({ limit: 1_000_000 })) {
        const key = row.project_id ?? "(none)";
        contextVersions[key] ??= { minted: 0, acknowledged: 0 };
        contextVersions[key].minted++;
        if (row.acknowledged_at != null) contextVersions[key].acknowledged++;
      }

      const clarificationCounts: Record<string, number> = {};
      for (const c of groundTruth.clarifications) clarificationCounts[c.cause] = (clarificationCounts[c.cause] ?? 0) + 1;

      const allClarifiedBeforeDelivery = groundTruth.clarifyBeforeDelivery.every((c) => c.ok);
      const allUncorrelatedResolved = groundTruth.uncorrelated.every((u) => u.resolved);
      const allInterruptionsExplicit = groundTruth.recoveries.every((r) => r.explicit);

      const report: BenchmarkReport = {
        generatedAt: new Date().toISOString(),
        journeys: ["FOCUSED", "TWO_PROJECT", "FLEET"],
        wrong_target_deliveries: wrongTarget,
        duplicate_deliveries: { fromEvents: metricsReport.duplicateDeliveries, fromPtyWrites: duplicateFromPty, ptyMismatches },
        clarification_counts: clarificationCounts,
        context_versions: contextVersions,
        notification_latency: groundTruth.notifications,
        uncorrelated_events: groundTruth.uncorrelated,
        recovery_outcomes: groundTruth.recoveries,
        metrics_5_2: metricsReport,
        hard_failures: {
          wrong_target_deliveries_zero: wrongTarget === 0,
          duplicate_deliveries_zero: metricsReport.duplicateDeliveries === 0 && duplicateFromPty === 0,
          all_ambiguous_clarified_before_delivery: allClarifiedBeforeDelivery,
          zero_unexplained_uncorrelated_events: allUncorrelatedResolved,
          all_interruptions_explicit_state: allInterruptionsExplicit,
        },
      };

      fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
      fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + "\n", "utf8");

      // Re-read from disk — the hard-failure gates are asserted against the ARTIFACT, not just
      // the in-memory object, so a serialization bug can never hide a real regression.
      const reRead: BenchmarkReport = JSON.parse(fs.readFileSync(REPORT_PATH, "utf8"));

      assert.strictEqual(reRead.wrong_target_deliveries, 0, "HARD FAILURE: a wrong-target delivery was detected");
      assert.strictEqual(reRead.duplicate_deliveries.fromEvents, 0, "HARD FAILURE: duplicate delivery detected (event-derived measurement)");
      assert.strictEqual(reRead.duplicate_deliveries.fromPtyWrites, 0, "HARD FAILURE: duplicate delivery detected (PTY-write-derived measurement)");
      assert.strictEqual(reRead.hard_failures.all_ambiguous_clarified_before_delivery, true, "HARD FAILURE: an ambiguous reference delivered before being clarified");
      assert.strictEqual(reRead.hard_failures.zero_unexplained_uncorrelated_events, true, "HARD FAILURE: an uncorrelated event was not accounted for");
      assert.strictEqual(reRead.hard_failures.all_interruptions_explicit_state, true, "HARD FAILURE: an interruption did not end in an explicit state");
      assert.ok(Object.keys(reRead.clarification_counts).length > 0, "at least one clarification cause was recorded (the FLEET ambiguous-reference case)");
      assert.ok(reRead.notification_latency.length > 0, "at least one notification-latency sample was recorded");
      assert.ok(reRead.recovery_outcomes.length > 0, "at least one recovery outcome was recorded (the FLEET interruption+retry case)");
      assert.ok(reRead.uncorrelated_events.length > 0, "at least one planted uncorrelated-event case was recorded");

      // Cross-check note (see the file-header BUG NOTE): the production metric's OWN clarification
      // measurement is unwired against real traffic, even though this harness's own measurement
      // (above) proves a real clarification happened. Both facts are preserved in the report.
      console.log(
        `[exchange-benchmark] wrote ${REPORT_PATH} — metrics_5_2.clarificationCauses=${JSON.stringify(metricsReport.clarificationCauses)} ` +
        `vs. harness clarification_counts=${JSON.stringify(clarificationCounts)} (see file-header BUG NOTE)`,
      );
    });
  });
});
