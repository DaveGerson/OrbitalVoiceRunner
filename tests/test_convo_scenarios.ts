// tests/test_convo_scenarios.ts — bead wsm-e2e-pinned-x58c: multi-turn conversation golden-scripts
// over the DSL in tests/helpers/convoScript.ts.
//
// This generalizes tests/test_voice_thought_buffer.ts (which pins ONE mechanism — modelThinking
// fragment coalescing — with hand-rolled emit() calls) into a durable safety net: each scenario
// below is a declarative timeline of operator/model turns (DATA — an ordered ConvoStep[]) plus an
// expected-outcome block, executed against the REAL server via tests/helpers/mockLive.ts (no
// Gemini key, no mic) exactly like the sibling suites, and asserted with assertConvoOutcome. The
// approval-vote scenario additionally normalizes + compares its capture against a committed golden
// fixture, REG1-style (tests/test_voice_tool_goldens.ts), because a generated messageId is a
// volatile substring in that scenario's frames.
//
// Runner: npx tsx --test --test-force-exit tests/test_convo_scenarios.ts
// Golden rewrite (deliberate only): JANUS_GOLDEN_REWRITE=1 npx tsx --test --test-force-exit tests/test_convo_scenarios.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocket } from "ws";
import type { MockLiveHandle, MockLiveSession } from "./helpers/mockLive";
import { teardownServerSuite } from "./helpers/teardown";
import type { RunningServer } from "../server";
import { recentTurns } from "../src/voice/recentTurns";
import {
  type ConvoEnv,
  type ConvoScenario,
  operatorSay,
  modelThinks,
  turnComplete,
  interrupted,
  toolCall,
  agenticThoughtBullet,
  userDictationBullet,
  runConvoScenario,
  assertConvoOutcome,
  normalizeConvo,
  loadGoldenFixture,
  writeGoldenFixture,
  assertGoldenLabel,
} from "./helpers/convoScript";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(HERE, "fixtures", "convo-scenario-goldens.json");
const REWRITE = process.env.JANUS_GOLDEN_REWRITE === "1";

// ── Scenario 1 — chunked-thought coalesce: the REAL 10 forensics fragments (verbatim from
// tests/test_voice_thought_buffer.ts, ixn_mro7cpfy_9 2026-07-16 incident) must coalesce into ONE
// Janus frame + ONE Agentic Thought bullet, not 10. ──────────────────────────────────────────────
const FRAGMENTS_COALESCE = [
  "My apologies", " again.", " The draft", " is ready", " for test-2",
  " now.", " Say", " 'send", " it' to", " submit.",
];
const JOINED_COALESCE = "My apologies again. The draft is ready for test-2 now. Say 'send it' to submit.";

const scenarioCoalesce: ConvoScenario = {
  name: "chunked-thought coalesce",
  steps: [modelThinks(...FRAGMENTS_COALESCE), turnComplete()],
  expect: {
    frames: [{ sender: "Janus", text: JOINED_COALESCE }],
    draftText: agenticThoughtBullet(JOINED_COALESCE),
    recentTurns: { size: 1, latestJanus: JOINED_COALESCE },
    logKinds: { gemini_thinking: FRAGMENTS_COALESCE.length, gemini_text: 1 },
  },
};

// ── Scenario 2 — barge-in partial flush: fragments then `interrupted` (no turnComplete) must flush
// the PARTIAL thought exactly once — nothing lost (the spoken words survive), nothing doubled. ────
const FRAGMENTS_BARGE_IN = ["Wait", " I need", " to stop."];
const JOINED_BARGE_IN = "Wait I need to stop.";

const scenarioBargeIn: ConvoScenario = {
  name: "barge-in partial flush",
  steps: [modelThinks(...FRAGMENTS_BARGE_IN), interrupted()],
  expect: {
    frames: [{ sender: "Janus", text: JOINED_BARGE_IN }],
    draftText: agenticThoughtBullet(JOINED_BARGE_IN),
    recentTurns: { size: 1, latestJanus: JOINED_BARGE_IN },
  },
};

// ── Scenario 4 — multi-turn bleed: two independent model-thought turns with an operator dictation
// IN BETWEEN. Each thought flush must stay uncontaminated by the other turn's fragments, the
// dictation must land as exactly one User Dictation bullet, and draft ordering must match arrival
// order (thought1, dictation, thought2) — no cross-turn bleed either direction. ───────────────────
const BLEED_TURN1 = ["First", " thought", " here."];
const BLEED_JOINED1 = "First thought here.";
const BLEED_DICTATION = "Please continue the deployment.";
const BLEED_TURN2 = ["Second", " thought", " arrives."];
const BLEED_JOINED2 = "Second thought arrives.";

const scenarioMultiTurnBleed: ConvoScenario = {
  name: "multi-turn bleed (two thought turns + a dictation between)",
  steps: [
    modelThinks(...BLEED_TURN1), turnComplete(),
    operatorSay(BLEED_DICTATION),
    modelThinks(...BLEED_TURN2), turnComplete(),
  ],
  expect: {
    frames: [
      { sender: "Janus", text: BLEED_JOINED1 },
      { sender: "User", text: BLEED_DICTATION },
      { sender: "Janus", text: BLEED_JOINED2 },
    ],
    draftText: [
      agenticThoughtBullet(BLEED_JOINED1),
      userDictationBullet(BLEED_DICTATION),
      agenticThoughtBullet(BLEED_JOINED2),
    ].join("\n"),
    recentTurns: { size: 3, latestJanus: BLEED_JOINED2, latestUser: BLEED_DICTATION },
  },
};

// ── Scenario 5 — dictation/turn interplay: operator dictation THEN a model thought turn. One User
// Dictation bullet followed by one Agentic Thought bullet, in that order; one transcript_text frame
// per side. ─────────────────────────────────────────────────────────────────────────────────────
const INTERPLAY_DICTATION = "Kick off the build when ready.";
const INTERPLAY_FRAGMENTS = ["Starting", " the build", " now."];
const INTERPLAY_JOINED = "Starting the build now.";

const scenarioDictationThenThought: ConvoScenario = {
  name: "dictation then model thought turn",
  steps: [
    operatorSay(INTERPLAY_DICTATION),
    modelThinks(...INTERPLAY_FRAGMENTS), turnComplete(),
  ],
  expect: {
    frames: [
      { sender: "User", text: INTERPLAY_DICTATION },
      { sender: "Janus", text: INTERPLAY_JOINED },
    ],
    draftText: [userDictationBullet(INTERPLAY_DICTATION), agenticThoughtBullet(INTERPLAY_JOINED)].join("\n"),
    recentTurns: { size: 2, latestUser: INTERPLAY_DICTATION, latestJanus: INTERPLAY_JOINED },
  },
};

// Scenarios 1/2/4/5 run through the plain data-driven harness below. Scenario 3 (approval-vote
// sequencing) needs a gated pane wired up first (see "Scenario 3" section further down) — its
// step timeline is still DATA, but it carries its own `it()` because of that extra rigging.
const DATA_DRIVEN_SCENARIOS: ConvoScenario[] = [
  scenarioCoalesce,
  scenarioBargeIn,
  scenarioMultiTurnBleed,
  scenarioDictationThenThought,
];

describe("conversation golden-scripts (DSL over the REG1 oracle)", () => {
  let startServer: (opts?: any) => Promise<RunningServer>;
  let apiToken: string;
  let installMockLive: () => MockLiveHandle;
  let waitFor: <T>(p: () => T | undefined | false, t?: number, i?: number) => Promise<T>;

  let mock: MockLiveHandle;
  let running: RunningServer;
  let client: WebSocket;
  let clientMessages: any[];
  let tmpDir: string;
  let prevCwd: string;

  const live = (): MockLiveSession => running._testActiveLiveSession!() as MockLiveSession;

  // ── interaction-log JSONL: byte-offset reads (mirrors test_voice_thought_buffer.ts) ─────────────
  function logFilePath(): string {
    return path.join(tmpDir, ".janus_interaction_log.jsonl");
  }
  function logSize(): number {
    try { return fs.statSync(logFilePath()).size; } catch { return 0; }
  }
  function readLogSince(offset: number): any[] {
    let raw = "";
    try { raw = fs.readFileSync(logFilePath(), "utf8"); } catch { return []; }
    return raw
      .slice(offset)
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((r): r is any => r != null);
  }

  // ── ledger pane/project registration + activation (mirrors test_voice_thought_buffer.ts) ────────
  function registerActivePane(projectId: string, paneId: string): void {
    running.manager.ledger.activeProjectId = projectId;
    if (!running.manager.ledger.getProject(projectId)) {
      running.manager.ledger.addProject(projectId, "/stub/cwd", `${projectId} fixture project`);
    }
    running.manager.ledger.updatePane(projectId, {
      pane_id: paneId, name: paneId, runtime_type: "interactive_cli",
      last_known_state: "Running active command", is_busy: true, alive: true,
      notes: [], permissions_mode: "Human-in-the-Loop", session_id: "stub-session",
      tool_preset: "Claude Code", context_size: 0,
    } as any, true);
    running._testSetActivePane!(paneId);
  }
  function draftText(projectId: string, paneId: string): string | undefined {
    return running.manager.ledger.getDraft(projectId, paneId)?.text;
  }

  // ── Minimal stub pane for the approval scenario (mirrors StubTerminal in
  // tests/test_voice_tool_goldens.ts — we never spawn a real ConPTY; same Windows node-pty
  // instability rationale as every sibling suite). Only the surface dispatchProposal touches. ──────
  class StubTerminal {
    lastCommand = "";
    // Fable wave-1 review: a bare lastCommand overwrite can't detect a DOUBLED writeInput of the
    // same instruction — count calls so exactly-once is pinned directly, not inferred.
    writeInputCalls = 0;
    permissionsMode: "Full Auto" | "Human-in-the-Loop" | "Read-Only" = "Human-in-the-Loop";
    status: "Running" | "Exited" | "Idle" = "Running";
    projectId = "convo_approval_proj";
    cwd = "/stub/cwd";
    runtimeType: "interactive_cli" | "shell" = "interactive_cli";
    toolPreset = "Claude Code";
    sessionId = "stub-session";
    contextSize = 0;
    lastStatusChangeAt = 1_700_000_000_000;
    constructor(public terminalId: string) {}
    writeInput(command: string) { this.lastCommand = command; this.writeInputCalls += 1; this.status = "Running"; }
    getRecentOutput(_lines = 10): string { return ""; }
    consumeDelta(): { lines: string; dropped: number } { return { lines: "", dropped: 0 }; }
    setPermissionsMode(mode: "Full Auto" | "Human-in-the-Loop" | "Read-Only") { this.permissionsMode = mode; }
    async stop() { this.status = "Exited"; }
  }

  function makeEnv(): ConvoEnv {
    return {
      session: live,
      mock,
      waitFor,
      clientMessages,
      getDraftText: () => draftText(currentProject, currentPane),
      recentTurnsSize: () => recentTurns.size(),
      recentTurnsLatest: (author) => recentTurns.latest(author)?.text,
      logSize,
      logSince: readLogSince,
    };
  }

  // Scenario-local project/pane, set immediately before each data-driven scenario runs.
  let currentProject = "";
  let currentPane = "";

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";

    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-convo-"));
    process.chdir(tmpDir);

    ({ installMockLive, waitFor } = await import("./helpers/mockLive"));
    const serverMod = await import("../server");
    startServer = serverMod.startServer;
    apiToken = serverMod.API_AUTH_TOKEN;

    mock = installMockLive();
    running = await startServer({ port: 0, enableVite: false });

    clientMessages = [];
    client = new WebSocket(`ws://127.0.0.1:${running.port}/live`, {
      headers: { Cookie: `auth_token=${apiToken}` },
    });
    client.on("message", (data) => {
      try { clientMessages.push(JSON.parse(data.toString())); } catch { /* non-JSON */ }
    });
    await new Promise<void>((resolve, reject) => {
      client.on("open", () => resolve());
      client.on("error", reject);
    });
    await waitFor(() => mock.latest() && running._testActiveLiveSession?.());
  });

  after(async () => {
    if (client && client.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        client.once("close", () => resolve());
        try { client.terminate(); } catch { resolve(); }
      });
    }
    await teardownServerSuite(running);
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  // ── Scenarios 1, 2, 4, 5 — pure data-driven: register a fresh pane, run the step timeline, assert
  // the outcome. Each scenario owns an isolated project/pane so draft/recentTurns counts stay exact. ─
  let scenarioIdx = 0;
  for (const scenario of DATA_DRIVEN_SCENARIOS) {
    it(scenario.name, async () => {
      scenarioIdx += 1;
      currentProject = `convo_s${scenarioIdx}_proj`;
      currentPane = `convo-s${scenarioIdx}-pane`;
      registerActivePane(currentProject, currentPane);
      recentTurns.clear();

      const outcome = await runConvoScenario(makeEnv(), scenario.steps);
      assertConvoOutcome(outcome, scenario.expect, scenario.name);
    });
  }

  // ── Scenario 3 — approval-vote sequencing ─────────────────────────────────────────────────────
  // Stage a real gated action (propose_command under an explicit per-pane write_to_pane=Ask
  // override, the same persisted-override pattern test_voice_tool_goldens.ts uses for
  // propose_command.Ask), then an operator utterance ("approve") resolves it. Asserts the full
  // approval lifecycle (approval_pending -> approval_resolved -> command_auto_executed) fires
  // exactly once and the staged command actually reaches the pane, plus the ordinary DSL
  // expectation (the "approve" transcript frame + recentTurns push). The rich lifecycle capture is
  // normalized (the messageId is a generated id) and compared against a committed golden fixture,
  // REG1-style, since this is the one scenario whose output is rich enough to need it.
  it("approval-vote sequencing: gated propose_command -> spoken 'approve' resolves it exactly once", async () => {
    const PROJECT = "convo_approval_proj";
    const PANE = "convo-approval-pane";
    currentProject = PROJECT;
    currentPane = PANE;

    const stub = new StubTerminal(PANE);
    (running.manager.terminals as any)[PANE] = stub;
    running.manager.ledger.activeProjectId = PROJECT;
    if (!running.manager.ledger.getProject(PROJECT)) {
      running.manager.ledger.addProject(PROJECT, "/stub/cwd", `${PROJECT} fixture project`);
    }
    running.manager.ledger.updatePane(PROJECT, {
      pane_id: PANE, name: PANE, runtime_type: "interactive_cli",
      last_known_state: "Running active command", is_busy: true, alive: true,
      notes: [], permissions_mode: "Human-in-the-Loop", session_id: "stub-session",
      tool_preset: "Claude Code", context_size: 0,
    } as any, true);
    running._testSetActivePane!(PANE);
    recentTurns.clear();

    // Persist an explicit per-pane write_to_pane=Ask override via the voice tool (rule 1 beats the
    // active-pane spotlight) — same mechanism test_voice_tool_goldens.ts uses for propose_command.Ask.
    const tighten = live().emitToolCall("set_capability_gate", { pane_id: PANE, capability: "write_to_pane", gate: "Ask" });
    await waitFor(() => mock.responseFor(tighten));

    const instruction = "echo approval-vote-test";
    const scenario: ConvoScenario = {
      name: "approval-vote sequencing",
      steps: [
        toolCall("propose_command", { pane_id: PANE, instruction, kind: "shell" }, { capture: "propose" }),
        operatorSay("approve"),
      ],
      expect: {
        frames: [{ sender: "User", text: "approve" }],
        recentTurns: { size: 1, latestUser: "approve" },
      },
    };

    const outcome = await runConvoScenario(makeEnv(), scenario.steps);
    assertConvoOutcome(outcome, scenario.expect, scenario.name);

    const proposeResp = outcome.toolResponses.propose?.response;
    assert.strictEqual(proposeResp?.status, "pending_approval", `HiTL/Ask stages, never runs: ${JSON.stringify(proposeResp)}`);
    const callId = outcome.toolResponses.propose!.callId;
    assert.strictEqual(proposeResp.messageId, callId, "pending entry is keyed by the functionCall id");

    // The full lifecycle, in order: staged -> pending -> resolved (exactly once) -> executed.
    const pendingFrame = outcome.rawMessages.find((m) => m.type === "approval_pending" && m.messageId === callId);
    assert.ok(pendingFrame, "approval_pending frame reached the operator's socket");
    assert.strictEqual(pendingFrame.terminalId, PANE);

    const resolvedFrames = outcome.rawMessages.filter((m) => m.type === "approval_resolved" && m.messageId === callId);
    assert.strictEqual(resolvedFrames.length, 1, `approval_resolved must fire EXACTLY ONCE, got ${resolvedFrames.length}: ${JSON.stringify(resolvedFrames)}`);
    assert.strictEqual(resolvedFrames[0].outcome, "approved");

    const executedFrames = outcome.rawMessages.filter((m) => m.type === "command_auto_executed" && m.terminalId === PANE);
    assert.strictEqual(executedFrames.length, 1, `command_auto_executed must fire EXACTLY ONCE, got ${executedFrames.length}`);
    const executedFrame = executedFrames[0];
    assert.strictEqual(executedFrame.approved, true, "flagged operator-approved, not an auto-run");
    assert.strictEqual(executedFrame.vocal, true, "flagged as a VOICE approval");
    assert.strictEqual(executedFrame.cmd, instruction);

    // The staged command actually reached the (stub) pane, exactly once, and the approval store
    // consumed the record exactly once — the resolution cannot double-fire or replay.
    assert.strictEqual(stub.lastCommand, instruction, "the approved instruction landed on the pane");
    assert.strictEqual(stub.writeInputCalls, 1, "the pane received exactly ONE write — no replayed/doubled dispatch");
    assert.strictEqual(running._testPendingApprovals!().has(callId), false, "the approval was consumed exactly once");

    // ── REG1-style golden: normalize the volatile messageId, compare the rich capture ─────────────
    const richCapture = normalizeConvo({
      pending: { type: pendingFrame.type, terminalId: pendingFrame.terminalId, messageId: pendingFrame.messageId },
      resolvedCount: resolvedFrames.length,
      resolved: { type: resolvedFrames[0].type, terminalId: resolvedFrames[0].terminalId, outcome: resolvedFrames[0].outcome, messageId: resolvedFrames[0].messageId },
      executed: { type: executedFrame.type, terminalId: executedFrame.terminalId, approved: executedFrame.approved, vocal: executedFrame.vocal, cmd: executedFrame.cmd },
      voteFrame: outcome.frames[0],
    });
    const fixture = loadGoldenFixture(FIXTURE_PATH);
    assertGoldenLabel("approval_vote_sequencing", richCapture, fixture, REWRITE);
    if (REWRITE) {
      writeGoldenFixture(FIXTURE_PATH, { ...loadGoldenFixture(FIXTURE_PATH), approval_vote_sequencing: richCapture });
    }
  });
});
