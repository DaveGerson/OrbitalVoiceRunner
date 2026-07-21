// tests/test_voice_dictation_votes.ts — bead wsm-e2e-pinned-pvwg
// Asserts that operator utterances parsing as approval votes ("approve", "yes", "no", etc.)
// do NOT land as "* **User Dictation**: ..." bullets in the active pane's WIP draft,
// whether or not an approval is currently pending. Genuine non-vote speech continues to append.

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";
import type { MockLiveHandle, MockLiveSession } from "./helpers/mockLive";
import { teardownServerSuite } from "./helpers/teardown";
import type { RunningServer } from "../server";
import { recentTurns } from "../src/voice/recentTurns";
import {
  type ConvoEnv,
  operatorSay,
  toolCall,
  runConvoScenario,
} from "./helpers/convoScript";

describe("voice dictation vote filtering (bare votes do not contaminate WIP draft)", () => {
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

  class StubTerminal {
    lastCommand = "";
    writeInputCalls = 0;
    permissionsMode: "Full Auto" | "Human-in-the-Loop" | "Read-Only" = "Human-in-the-Loop";
    status: "Running" | "Exited" | "Idle" = "Running";
    projectId = "dict_vote_proj";
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

  let currentProject = "";
  let currentPane = "";

  function makeEnv(): ConvoEnv {
    return {
      session: live,
      mock,
      waitFor,
      clientMessages,
      getDraftText: () => draftText(currentProject, currentPane),
      recentTurnsSize: () => recentTurns.size(),
      recentTurnsLatest: (author) => recentTurns.latest(author)?.text,
      logSize: () => 0,
      logSince: () => [],
    };
  }

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";

    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-dict-votes-"));
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

  it("(i) 'approve' while an approval is pending -> draft gains NO dictation bullet AND the approval still resolves", async () => {
    const PROJECT = "dict_proj_1";
    const PANE = "dict-pane-1";
    currentProject = PROJECT;
    currentPane = PANE;

    const stub = new StubTerminal(PANE);
    (running.manager.terminals as any)[PANE] = stub;
    registerActivePane(PROJECT, PANE);
    recentTurns.clear();

    const tighten = live().emitToolCall("set_capability_gate", { pane_id: PANE, capability: "write_to_pane", gate: "Ask" });
    await waitFor(() => mock.responseFor(tighten));

    const instruction = "echo test-pending-approval";
    const steps = [
      toolCall("propose_command", { pane_id: PANE, instruction, kind: "shell" }, { capture: "propose" }),
      operatorSay("approve"),
    ];

    const outcome = await runConvoScenario(makeEnv(), steps);

    const proposeResp = outcome.toolResponses.propose?.response;
    assert.strictEqual(proposeResp?.status, "pending_approval");
    const callId = outcome.toolResponses.propose!.callId;

    const resolvedFrames = outcome.rawMessages.filter((m) => m.type === "approval_resolved" && m.messageId === callId);
    assert.strictEqual(resolvedFrames.length, 1, "approval resolved");
    assert.strictEqual(resolvedFrames[0].outcome, "approved");
    assert.strictEqual(stub.lastCommand, instruction, "approved instruction ran on terminal");

    const draft = draftText(PROJECT, PANE);
    assert.strictEqual(Boolean(draft?.includes("* **User Dictation**: approve")), false, "draft must NOT contain dictation bullet for approval vote");
  });

  it("(ii) 'approve' with nothing pending -> no bullet", async () => {
    const PROJECT = "dict_proj_2";
    const PANE = "dict-pane-2";
    currentProject = PROJECT;
    currentPane = PANE;

    registerActivePane(PROJECT, PANE);
    recentTurns.clear();

    const steps = [
      operatorSay("approve"),
    ];

    await runConvoScenario(makeEnv(), steps);

    const draft = draftText(PROJECT, PANE);
    assert.strictEqual(Boolean(draft?.includes("* **User Dictation**: approve")), false, "draft must NOT contain dictation bullet when nothing pending");
  });

  it("(iii) a normal utterance -> bullet appended", async () => {
    const PROJECT = "dict_proj_3";
    const PANE = "dict-pane-3";
    currentProject = PROJECT;
    currentPane = PANE;

    registerActivePane(PROJECT, PANE);
    recentTurns.clear();

    const normalText = "please check the status of the build";
    const steps = [
      operatorSay(normalText),
    ];

    await runConvoScenario(makeEnv(), steps);

    const draft = draftText(PROJECT, PANE);
    assert.ok(draft?.includes(`* **User Dictation**: ${normalText}`), `draft must contain dictation bullet for normal speech, got: ${draft}`);
  });
});
