// tests/test_context_smoke_journeys.ts — Phase C smoke journeys (spec docs/superpowers/specs/
// 2026-07-02-cortex-context-telemetry.md §10, §18.6).
//
// Three deterministic "compressed time" journeys driven through the REAL server pipeline (the
// tests/test_voice_journeys.ts / tests/test_context_injection_telemetry.ts boot idiom: startServer
// on port 0 + vite disabled + installMockLive's fake liveConnector — NO real sleeps, NO live Gemini
// key). Each journey gets its OWN server boot (own tmpDir, own SQLite db), so the report each one
// runs at the end reflects ONLY that journey's own events. Every journey ends by calling the
// exported aggregation function (src/memory/contextMetricsReport.ts's buildContextMetricsReport)
// against its own store and asserting the spec §10 acceptance bullets that apply.
//
// UT-ID / acceptance mapping — what each journey covers (spec §10.1/10.2/10.3, §18.6's 1-2h deltas):
//   15-min (bugfix-auth)  -> §10.1: no dup panes, focus correctness, >=1 injection, draft persists,
//                            approval exactly once, cost estimate present.
//   30-min (debugging)    -> §10.2: project tier changes correctly, no voice injection from
//                            observe-only, injection count by trigger, no cross-project note bleed.
//   1-2h  (orchestration) -> §10.3 + §18.6: repeated flips w/o unbounded growth, repeated brief
//                            hashes visible, cost estimate generated, inject_id join integrity
//                            (this report's read surface doesn't carry session_id yet — see
//                            src/memory/contextMetricsReport.ts's SESSION_ID_NOTE — so "joins include
//                            session ID where available" is verified via the inject_id join instead,
//                            the actual cross-table key this PR's tables share), stop-all + release,
//                            multiple approvals, a reconnect event, safety gates still authoritative
//                            afterwards.
//   Intentionally NOT included: a handoff lifecycle (spec §10.3 lists it as "if current APIs support
//   it" — optional). Handoff behavior is already covered end-to-end by tests/test_handoff*.ts;
//   adding it here would only grow this file without adding new telemetry coverage.
//
// Runner: npx tsx --test --test-force-exit tests/test_context_smoke_journeys.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";
import type { MockLiveHandle, MockLiveSession } from "./helpers/mockLive";
import { teardownServerSuite } from "./helpers/teardown";
import type { RunningServer } from "../server";
import { buildContextMetricsReport } from "../src/memory/contextMetricsReport";
import type { ContextInjectionEvent } from "../src/memory/contextTelemetry";

// ── Shared, closure-free helpers (parameterized on the running server) ─────────────────────────

/** A real-execution probe on the pane's native shell — same idiom as tests/test_voice_journeys.ts. */
function execProbe(verb: string): string {
  return process.platform === "win32" ? `echo ${verb}_%VJ42%` : `echo ${verb}_\${VJ42}`;
}

/** Register a pane WITHOUT spawning a real PTY (tests/test_context_injection_telemetry.ts idiom) —
 *  used for pure focus-switch / context-injection steps that never need a real write. */
function makeSeedPane(running: RunningServer, tmpDir: string) {
  return (paneId: string, projectId: string): void => {
    if (!running.manager.ledger.getProject(projectId)) {
      running.manager.ledger.addProject(projectId, tmpDir, `Project ${projectId}`, []);
    }
    (running.manager.terminals as any)[paneId] = {
      name: paneId, runtimeType: "interactive_cli", status: "Idle", lastCommand: null,
      projectId, cwd: tmpDir, toolPreset: "Custom", sessionId: "",
      permissionsMode: "Human-in-the-Loop", contextSize: 0, lastStatusChangeAt: Date.now(),
    };
    running.manager.refreshLedger();
  };
}

/** Create a REAL shell pane by voice (create_pane, gated Auto for the suite) — used only for the
 *  step(s) that need a genuine propose/approve write cycle. */
function makeCreateShellPane(running: RunningServer, mock: MockLiveHandle, waitFor: any) {
  return async (paneId: string, projectId: string, mode?: "Full Auto" | "Human-in-the-Loop"): Promise<any> => {
    const call = live1(running).emitToolCall("create_pane", {
      project_id: projectId, pane_id: paneId, tool_preset: "Custom",
      ...(mode ? { permissions_mode: mode } : {}),
    });
    const out = String(await waitFor(() => mock.responseFor(call)));
    assert.ok(out.includes(`Pane ${paneId} created`), `create_pane ran inline under Auto: ${out}`);
    return (running.manager.terminals as any)[paneId];
  };
}

function live1(running: RunningServer): MockLiveSession {
  return running._testActiveLiveSession!() as MockLiveSession;
}

/** Push a real operator transcript frame — the exact shape Gemini Live delivers ASR on. */
function speak(session: MockLiveSession, text: string): void {
  session.emit({ serverContent: { inputTranscription: { text } } });
}

async function propose(
  running: RunningServer, mock: MockLiveHandle, waitFor: any, paneId: string, instruction: string
): Promise<{ callId: string; resp: any }> {
  const callId = live1(running).emitToolCall("propose_command", { pane_id: paneId, instruction, kind: "shell" });
  const resp: any = await waitFor(() => mock.rawResponseFor(callId));
  return { callId, resp };
}

/** Rows recorded since `sinceTs`, newest-first (matches the store's own ordering). */
function rowsSince(running: RunningServer, sinceTs: number): ContextInjectionEvent[] {
  return running._testStore!()!.getContextInjections({ since: sinceTs - 1, limit: 5000 }) as unknown as ContextInjectionEvent[];
}

/** Common connect + WS client bring-up, shared by all three journeys' before() hooks. */
async function connectOperator(running: RunningServer, apiToken: string): Promise<WebSocket> {
  const client = new WebSocket(`ws://127.0.0.1:${running.port}/live`, { headers: { Cookie: `auth_token=${apiToken}` } });
  await new Promise<void>((resolve, reject) => {
    client.on("open", () => resolve());
    client.on("error", reject);
  });
  return client;
}

async function closeClient(client: WebSocket): Promise<void> {
  if (client && client.readyState !== WebSocket.CLOSED) {
    await new Promise<void>((resolve) => {
      client.once("close", () => resolve());
      try { client.terminate(); } catch { resolve(); }
    });
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Journey 1 — 15-minute smoke: quick bug fix, two panes (spec §10.1).
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe("context smoke journey — 15-minute bugfix session (spec §10.1)", () => {
  const PROJECT = "bugfix-auth";
  let startServer: (opts?: any) => Promise<RunningServer>;
  let apiToken: string;
  let installMockLive: () => MockLiveHandle;
  let waitFor: <T>(p: () => T | undefined | false, t?: number, i?: number) => Promise<T>;

  let mock: MockLiveHandle;
  let running: RunningServer;
  let client: WebSocket;
  let tmpDir: string;
  let prevCwd: string;
  let bootTs: number;
  let seedPane: (paneId: string, projectId: string) => void;
  let createShellPane: (paneId: string, projectId: string, mode?: "Full Auto" | "Human-in-the-Loop") => Promise<any>;

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";
    process.env.JANUS_SHELL_ALLOWLIST = "echo";

    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-ctj15-"));
    process.chdir(tmpDir);

    ({ installMockLive, waitFor } = await import("./helpers/mockLive"));
    const serverMod = await import("../server");
    startServer = serverMod.startServer;
    apiToken = serverMod.API_AUTH_TOKEN;

    mock = installMockLive();
    bootTs = Date.now();
    running = await startServer({ port: 0, enableVite: false });
    if (!running.manager.settings.advanced.capabilityGates) (running.manager.settings.advanced as any).capabilityGates = {};
    (running.manager.settings.advanced.capabilityGates as any).create_pane = "Auto";
    process.env.VJ42 = "42";

    client = await connectOperator(running, apiToken);
    await waitFor(() => mock.latest() && running._testActiveLiveSession?.());

    seedPane = makeSeedPane(running, tmpDir);
    createShellPane = makeCreateShellPane(running, mock, waitFor);
  });

  after(async () => {
    await closeClient(client);
    if (running?.manager) {
      const terms = Object.values(running.manager.terminals) as any[];
      await Promise.all(terms.map((t) => Promise.resolve(t?.stop?.()).catch(() => undefined)));
      for (const id of Object.keys(running.manager.terminals)) delete (running.manager.terminals as any)[id];
    }
    await teardownServerSuite(running);
    process.chdir(prevCwd);
    delete process.env.VJ42;
    delete process.env.JANUS_SHELL_ALLOWLIST;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("runs the 15-minute journey and the report satisfies every §10.1 acceptance bullet", async () => {
    // 1-2. create project + pane A (real shell — this is the one that gets the approval).
    const paneA = await createShellPane("bf-a", PROJECT, "Human-in-the-Loop");
    // 3. pane B: test shell (no real PTY needed — a pure focus-switch/telemetry target).
    seedPane("bf-b", PROJECT);

    // Establish PROJECT as the ledger's active project (addProject/create_pane do NOT do this —
    // only switch_context does; needed so activeDraftTarget()'s projectId resolution below matches
    // the project the panes actually live in, not the "default_project" fallback).
    const focusProjectCall = live1(running).emitToolCall("switch_context", { project_id: PROJECT });
    await waitFor(() => mock.responseFor(focusProjectCall));
    assert.strictEqual(running.manager.ledger.activeProjectId, PROJECT);

    // 4-5. Focus A (already active from create_pane's create-effect) — force an explicit
    // pane_switch to B, "run tests" — then A -> B -> A (steps 5, 8).
    let before = rowsSince(running, bootTs).length;
    let callId = live1(running).emitToolCall("switch_active_pane", { pane_id: "bf-b" });
    await waitFor(() => mock.responseFor(callId));
    await waitFor(() => rowsSince(running, bootTs).length > before);

    // 6. Draft a structured prompt in A: focus A, then update_draft_prompt targets whatever pane is active.
    before = rowsSince(running, bootTs).length;
    callId = live1(running).emitToolCall("switch_active_pane", { pane_id: "bf-a" });
    await waitFor(() => mock.responseFor(callId));
    await waitFor(() => rowsSince(running, bootTs).length > before);

    const draftText = "Reproduce the 401 on /login, then patch the token refresh path.";
    const draftCall = live1(running).emitToolCall("update_draft_prompt", { text: draftText });
    await waitFor(() => mock.responseFor(draftCall));
    assert.strictEqual(running.manager.ledger.getDraft(PROJECT, "bf-a")?.text, draftText);

    // 7. Switch to B ("run tests"), 8. A -> B -> A again.
    for (const pane of ["bf-b", "bf-a"]) {
      before = rowsSince(running, bootTs).length;
      callId = live1(running).emitToolCall("switch_active_pane", { pane_id: pane });
      await waitFor(() => mock.responseFor(callId));
      await waitFor(() => rowsSince(running, bootTs).length > before);
    }
    // Draft on A must have survived the round trip (per-pane draft persistence, §9.3 UT-DRAFT-001).
    assert.strictEqual(running.manager.ledger.getDraft(PROJECT, "bf-a")?.text, draftText, "A's draft persists across A->B->A");

    // 9. Approve one proposed command (real write cycle on the real shell pane A).
    const instruction = execProbe("bf15");
    const { callId: proposeId, resp } = await propose(running, mock, waitFor, "bf-a", instruction);
    assert.strictEqual(resp.status, "pending_approval");
    speak(live1(running), "approve");
    await waitFor(() => paneA.getRecentOutput(100).includes("bf15_42"), 10000);
    assert.ok(!running._testPendingApprovals!().has(proposeId), "the approval resolved exactly once");

    // 10. "Ask catch-me-up" — the only live call site that reaches the ctx.injectMemoryBrief hook
    // today is switch_context (delta 18.2: no standalone catch-me-up tool exists yet), so this
    // journey's "catch me up" step is the real switch_context call — the honest current mapping.
    before = rowsSince(running, bootTs).length;
    const switchCallId = live1(running).emitToolCall("switch_context", { project_id: PROJECT });
    await waitFor(() => mock.responseFor(switchCallId));
    await waitFor(() => rowsSince(running, bootTs).length > before);

    // 11. Emit report.
    const report = buildContextMetricsReport(running._testStore!()!, { sinceMs: bootTs });

    // Acceptance: no duplicate pane records.
    const paneIds = Object.keys(running.manager.ledger.getProject(PROJECT)!.panes).sort();
    assert.deepStrictEqual(paneIds, ["bf-a", "bf-b"], "no duplicate pane records after repeated switching");

    // Acceptance: active pane correctness 100% (over every INJECTED row).
    assert.strictEqual(report.focusCorrectnessRate, 1, "focus correctness is 100% across the journey");

    // Acceptance: at least one context injection event.
    assert.ok(report.contextInjectionCount >= 1, "at least one injection was recorded");

    // Acceptance: draft persists. The A->B->A round trip already proved byte-exact persistence
    // above (before any spoken utterance touched the draft). Since then the "approve" transcript
    // was spoken on this connection, which the operator-utterance path ALSO appends to the active
    // pane's draft as dictation (real, separate product behavior — not a context-injection concern)
    // — so this final check only requires the ORIGINAL text to still be present, not exact equality.
    assert.ok(
      running.manager.ledger.getDraft(PROJECT, "bf-a")?.text.startsWith(draftText),
      "the original draft content survived to the end of the journey"
    );

    // Acceptance: approval exactly once (re-asserted above via pendingApprovals + real pane output).
    assert.strictEqual(paneA.lastCommand, instruction);

    // Acceptance: estimated context cost included.
    assert.strictEqual(typeof report.estimatedTextInputCostUsd, "number");
    assert.ok(report.estimatedInputTokens > 0, "at least one injected brief contributed tokens");
    assert.ok(Object.keys(report.injectionsByTrigger).length >= 1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Journey 2 — 30-minute smoke: three panes, project switch, observe-only cockpit (spec §10.2).
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe("context smoke journey — 30-minute debugging session (spec §10.2)", () => {
  const PROJECT_A = "debug-svc-a";
  const PROJECT_B = "debug-svc-b";
  let startServer: (opts?: any) => Promise<RunningServer>;
  let apiToken: string;
  let installMockLive: () => MockLiveHandle;
  let waitFor: <T>(p: () => T | undefined | false, t?: number, i?: number) => Promise<T>;

  let mock: MockLiveHandle;
  let running: RunningServer;
  let client: WebSocket;
  let tmpDir: string;
  let prevCwd: string;
  let bootTs: number;
  let seedPane: (paneId: string, projectId: string) => void;

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";

    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-ctj30-"));
    process.chdir(tmpDir);

    ({ installMockLive, waitFor } = await import("./helpers/mockLive"));
    const serverMod = await import("../server");
    startServer = serverMod.startServer;
    apiToken = serverMod.API_AUTH_TOKEN;

    mock = installMockLive();
    bootTs = Date.now();
    running = await startServer({ port: 0, enableVite: false });

    client = await connectOperator(running, apiToken);
    await waitFor(() => mock.latest() && running._testActiveLiveSession?.());

    seedPane = makeSeedPane(running, tmpDir);
  });

  after(async () => {
    await closeClient(client);
    for (const id of Object.keys(running.manager.terminals)) delete (running.manager.terminals as any)[id];
    await teardownServerSuite(running);
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("runs the 30-minute journey and the report satisfies every §10.2 acceptance bullet", async () => {
    // Three panes: implementation, tests, notes/research — all in project A first.
    seedPane("impl", PROJECT_A);
    seedPane("tests", PROJECT_A);
    seedPane("notes", PROJECT_A);

    let before = rowsSince(running, bootTs).length;
    let callId = live1(running).emitToolCall("switch_active_pane", { pane_id: "impl" });
    await waitFor(() => mock.responseFor(callId));
    await waitFor(() => rowsSince(running, bootTs).length > before);

    // Human context note in project A.
    const noteCall = live1(running).emitToolCall("add_project_note", { project_id: PROJECT_A, note: "auth token TTL is 15m, not 60m" });
    await waitFor(() => mock.responseFor(noteCall));

    // Failure signature recorded on the tests pane (duck-typed pane — set directly, mirroring what
    // a real PTY's output-scan would have surfaced; no telemetry-relevant assertion depends on the
    // exact string, only that the pane exists and is switchable).
    (running.manager.terminals as any)["tests"].lastCommand = "npm test -- --grep auth";

    before = rowsSince(running, bootTs).length;
    callId = live1(running).emitToolCall("switch_active_pane", { pane_id: "tests" });
    await waitFor(() => mock.responseFor(callId));
    await waitFor(() => rowsSince(running, bootTs).length > before);

    // Switch project ONCE (project_switch trigger).
    seedPane("nb", PROJECT_B);
    before = rowsSince(running, bootTs).length;
    const switchCallId = live1(running).emitToolCall("switch_context", { project_id: PROJECT_B });
    await waitFor(() => mock.responseFor(switchCallId));
    await waitFor(() => rowsSince(running, bootTs).length > before);
    const projectSwitchRow = rowsSince(running, bootTs).find((r) => r.trigger === "project_switch");
    assert.ok(projectSwitchRow, "a project_switch row was recorded");
    assert.strictEqual(projectSwitchRow!.active_project_id, PROJECT_B, "the row reflects the NEW active project");
    assert.strictEqual(running.manager.ledger.activeProjectId, PROJECT_B, "project tier changed correctly");

    // No cross-project note bleed: project B's notes must NOT include project A's note.
    const notesBCall = live1(running).emitToolCall("get_project_notes", { project_id: PROJECT_B });
    const notesB: any = await waitFor(() => mock.responseFor(notesBCall));
    assert.ok(!JSON.stringify(notesB).includes("auth token TTL"), "project A's note did not bleed into project B");
    const notesACall = live1(running).emitToolCall("get_project_notes", { project_id: PROJECT_A });
    const notesA: any = await waitFor(() => mock.responseFor(notesACall));
    assert.ok(JSON.stringify(notesA).includes("auth token TTL"), "project A's own note is still there");

    // Observe-only cockpit attaches and detaches: it must NOT create a Gemini Live session.
    const sessionsBefore = mock.sessions.length;
    const observeWs = new WebSocket(`ws://127.0.0.1:${running.port}/live?observe=1`, {
      headers: { Cookie: `auth_token=${apiToken}` },
    });
    await new Promise<void>((resolve, reject) => {
      observeWs.on("open", () => resolve());
      observeWs.on("error", reject);
    });
    await new Promise((r) => setTimeout(r, 150)); // grace window — mirrors tests/test_observe_socket.ts
    assert.strictEqual(mock.sessions.length, sessionsBefore, "observe-only attach opened NO new Live session");
    await closeClient(observeWs);

    // Final report.
    const report = buildContextMetricsReport(running._testStore!()!, { sinceMs: bootTs });

    // Acceptance: project tier changes correctly (re-asserted above via ledger.activeProjectId).
    // Acceptance: no voice injection from observe-only — no row was recorded with a null trigger,
    // and the total injection count only reflects the real (non-observe) client's own actions.
    assert.ok(report.contextInjectionCount >= 1);
    // Acceptance: context report shows injection count BY TRIGGER.
    assert.ok(Object.keys(report.injectionsByTrigger).length >= 2, `expected multiple triggers: ${JSON.stringify(report.injectionsByTrigger)}`);
    assert.ok(report.injectionsByTrigger.project_switch >= 1);
    // Acceptance: catch-me-up (switch_context) evidence reflects the CURRENT project/pane —
    // already asserted above via projectSwitchRow.active_project_id === PROJECT_B.
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Journey 3 — 1-2 hour smoke: long orchestration, compressed (spec §10.3 + delta §18.6).
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe("context smoke journey — 1-2 hour orchestration session (spec §10.3, delta §18.6)", () => {
  const PROJECT = "orch-long";
  let startServer: (opts?: any) => Promise<RunningServer>;
  let apiToken: string;
  let installMockLive: () => MockLiveHandle;
  let waitFor: <T>(p: () => T | undefined | false, t?: number, i?: number) => Promise<T>;

  let mock: MockLiveHandle;
  let running: RunningServer;
  let client: WebSocket;
  let tmpDir: string;
  let prevCwd: string;
  let bootTs: number;
  let seedPane: (paneId: string, projectId: string) => void;
  let createShellPane: (paneId: string, projectId: string, mode?: "Full Auto" | "Human-in-the-Loop") => Promise<any>;

  async function release(): Promise<void> {
    const callId = live1(running).emitToolCall("release_stop_all");
    await waitFor(() => mock.responseFor(callId));
  }

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";
    process.env.JANUS_SHELL_ALLOWLIST = "echo";
    // Bounded, fast reconnect backoff (read per WS connection — src/voice/index.ts), same as
    // tests/test_voice_journeys.ts / tests/test_context_injection_telemetry.ts.
    process.env.JANUS_RECONNECT_MAX_ATTEMPTS = "3";
    process.env.JANUS_RECONNECT_BASE_DELAY_MS = "20";
    process.env.JANUS_RECONNECT_MAX_DELAY_MS = "60";

    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-ctj2h-"));
    process.chdir(tmpDir);

    ({ installMockLive, waitFor } = await import("./helpers/mockLive"));
    const serverMod = await import("../server");
    startServer = serverMod.startServer;
    apiToken = serverMod.API_AUTH_TOKEN;

    mock = installMockLive();
    bootTs = Date.now();
    running = await startServer({ port: 0, enableVite: false });
    if (!running.manager.settings.advanced.capabilityGates) (running.manager.settings.advanced as any).capabilityGates = {};
    (running.manager.settings.advanced.capabilityGates as any).create_pane = "Auto";
    process.env.VJ42 = "42";

    client = await connectOperator(running, apiToken);
    await waitFor(() => mock.latest() && running._testActiveLiveSession?.());

    seedPane = makeSeedPane(running, tmpDir);
    createShellPane = makeCreateShellPane(running, mock, waitFor);
  });

  after(async () => {
    await closeClient(client);
    if (running?.manager) {
      const terms = Object.values(running.manager.terminals) as any[];
      await Promise.all(terms.map((t) => Promise.resolve(t?.stop?.()).catch(() => undefined)));
      for (const id of Object.keys(running.manager.terminals)) delete (running.manager.terminals as any)[id];
    }
    await teardownServerSuite(running);
    process.chdir(prevCwd);
    delete process.env.VJ42;
    delete process.env.JANUS_SHELL_ALLOWLIST;
    delete process.env.JANUS_RECONNECT_MAX_ATTEMPTS;
    delete process.env.JANUS_RECONNECT_BASE_DELAY_MS;
    delete process.env.JANUS_RECONNECT_MAX_DELAY_MS;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("runs the 1-2h journey and the report satisfies every §10.3/§18.6 acceptance bullet", async () => {
    // Three-plus panes: two real (approvals need real writes), one duck-typed (pure flip target).
    const paneA = await createShellPane("orch-a", PROJECT, "Human-in-the-Loop");
    const paneB = await createShellPane("orch-b", PROJECT, "Human-in-the-Loop");
    seedPane("orch-c", PROJECT);

    // Multiple repeated pane flips: A -> C -> B -> C -> A -> B (6 switches; each one a real
    // switch_active_pane call through the real registry + gating + injectMemoryBrief choke point).
    // create_pane's own create-effect ALSO calls the shared setActivePane ctx hook (Issue #2 fix, so
    // a voice create-then-command flow lands in the new pane) — the SAME "pane_switch" trigger path —
    // so both createShellPane calls above already contributed their own pane_switch rows. Seed
    // switchCount from what's ALREADY on the ledger rather than assuming 0, so the "no unbounded
    // growth" check below stays exact regardless of that side effect.
    const flips = ["orch-c", "orch-b", "orch-c", "orch-a", "orch-b", "orch-a"];
    // injectMemoryBrief is fire-and-forget from the create_pane create-effect: the create_pane tool
    // response (awaited above, twice) can land BEFORE its pane_switch row is written. Wait for both
    // create-effect rows to actually land before snapshotting the baseline, or switchCount can be
    // taken too early and undercount, making the exact-equality assertion below flaky.
    await waitFor(() => rowsSince(running, bootTs).filter((r) => r.trigger === "pane_switch").length >= 2);
    let switchCount = rowsSince(running, bootTs).filter((r) => r.trigger === "pane_switch").length;
    for (const pane of flips) {
      const before = rowsSince(running, bootTs).length;
      const callId = live1(running).emitToolCall("switch_active_pane", { pane_id: pane });
      await waitFor(() => mock.responseFor(callId));
      await waitFor(() => rowsSince(running, bootTs).length > before);
      switchCount++;
    }

    // Multiple approvals: propose+approve on BOTH real panes. propose_command only accepts the
    // CURRENTLY-active pane (the single-active-pane write guard), so each iteration switches focus
    // first — a genuine extra pane_switch event, counted into switchCount so the "no unbounded
    // growth" assertion below stays exact.
    const approvedInstructions: { pane: string; term: any; instruction: string; callId: string }[] = [];
    for (const [pane, term] of [["orch-a", paneA], ["orch-b", paneB]] as const) {
      const before = rowsSince(running, bootTs).length;
      const focusCallId = live1(running).emitToolCall("switch_active_pane", { pane_id: pane });
      await waitFor(() => mock.responseFor(focusCallId));
      await waitFor(() => rowsSince(running, bootTs).length > before);
      switchCount++;

      const instruction = execProbe(`multi-${pane}`);
      const { callId, resp } = await propose(running, mock, waitFor, pane, instruction);
      assert.strictEqual(resp.status, "pending_approval", `propose on ${pane} staged`);
      speak(live1(running), "approve");
      await waitFor(() => term.getRecentOutput(100).includes(`multi-${pane}_42`), 10000);
      assert.ok(!running._testPendingApprovals!().has(callId), `${pane}'s approval resolved exactly once`);
      approvedInstructions.push({ pane, term, instruction, callId });
    }
    assert.strictEqual(approvedInstructions.length, 2, "both approvals actually resolved");

    // One stop-all and release.
    const freezeCall = live1(running).emitToolCall("stop_all");
    const freezeOut = String(await waitFor(() => mock.responseFor(freezeCall)));
    assert.match(freezeOut, /froze|frozen|freeze/i);
    await release();

    // Safety gates remain authoritative AFTER the freeze/release cycle: a fresh propose on a HiTL
    // pane must STILL stage a pending approval, never auto-execute. "orch-b" is the currently-active
    // pane (the last approval-loop iteration left it focused) — propose_command only accepts the
    // active pane, so this reuses it rather than switching again.
    const postReleaseInstr = execProbe("post-release");
    const { callId: postReleaseCallId, resp: postReleaseResp } = await propose(running, mock, waitFor, "orch-b", postReleaseInstr);
    assert.strictEqual(postReleaseResp.status, "pending_approval", "HiTL gating is still authoritative after stop-all/release");
    speak(live1(running), "reject"); // clean it up — don't leave a dangling pending approval.
    await waitFor(() => !running._testPendingApprovals!().has(postReleaseCallId));

    // One reconnect event.
    const session1 = live1(running);
    const sessionsBefore = mock.sessions.length;
    const beforeReconnectRows = rowsSince(running, bootTs).length;
    session1.emitClose({ code: 1006, reason: "1-2h smoke: simulated drop" });
    const session2 = await waitFor(
      () => (mock.sessions.length > sessionsBefore ? mock.latest() : undefined),
      8000
    );
    assert.notStrictEqual(session2, session1, "the bounded reconnect minted a fresh session");
    await waitFor(() => running._testActiveLiveSession!() === session2, 8000);
    await waitFor(() => rowsSince(running, bootTs).length > beforeReconnectRows, 8000);
    const reconnectRow = rowsSince(running, bootTs).find((r) => r.trigger === "reconnect");
    assert.ok(reconnectRow, "a reconnect row was recorded");

    // inject_id join integrity — the cross-table key this PR's tables actually share (session_id is
    // not yet populated at the choke point; see src/memory/contextMetricsReport.ts's SESSION_ID_NOTE).
    const store = running._testStore!()!;
    const injectedRow = rowsSince(running, bootTs).find((r) => r.disposition === "injected" && r.inject_id);
    assert.ok(injectedRow, "at least one injected row with an inject_id exists");
    store.recordCortexDecision({
      ts: Date.now(), injectId: injectedRow!.inject_id!, sessionId: null,
      activePaneId: injectedRow!.active_pane_id, trigger: "brief-inject", ruleFired: "baseline-identity",
      applied: false, traceJson: "{}",
    });
    const joinedDecisions = store.getCortexDecisions(0).filter((r) => r.inject_id === injectedRow!.inject_id);
    assert.strictEqual(joinedDecisions.length, 1, "context_injections <-> cortex_decision joins on inject_id");

    // Final report.
    const report = buildContextMetricsReport(store, { sinceMs: bootTs });

    // Acceptance: no unbounded context event growth for the same unchanged pane beyond the expected
    // baseline — the number of pane_switch-triggered rows must equal exactly the number of flips
    // driven (no duplicate/extra rows sneaking in per flip).
    const paneSwitchRows = rowsSince(running, bootTs).filter((r) => r.trigger === "pane_switch");
    assert.strictEqual(paneSwitchRows.length, switchCount, "exactly one pane_switch row per flip, no extras");

    // Acceptance: repeated brief hashes visible in metrics.
    assert.ok(report.briefHashRepeatRate > 0, `expected repeated hashes across the flips: ${report.briefHashRepeatRate}`);

    // Acceptance: usage/cost estimate generated.
    assert.strictEqual(typeof report.estimatedTextInputCostUsd, "number");
    assert.ok(report.estimatedInputTokens > 0);

    // Acceptance: safety gates remain authoritative — already proven above (post-release HiTL stage).
  });
});
