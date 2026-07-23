// tests/test_draft_prompt_sole_writer.ts — focused server-level test proving update_draft_prompt
// is the sole writer of the pane draft column (beads wsm-e2e-pinned-j07x + att6).

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";
import type { MockLiveHandle, MockLiveSession } from "./helpers/mockLive";
import { teardownServerSuite } from "./helpers/teardown";
import type { RunningServer } from "../server";

describe("update_draft_prompt sole writer of draft column", () => {
  let startServer: (opts?: any) => Promise<RunningServer>;
  let apiToken: string;
  let installMockLive: () => MockLiveHandle;
  let waitFor: <T>(p: () => T | undefined | false, t?: number, i?: number) => Promise<T>;

  let mock: MockLiveHandle;
  let running: RunningServer;
  let client: WebSocket;
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

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";

    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-dpsw-"));
    process.chdir(tmpDir);

    ({ installMockLive, waitFor } = await import("./helpers/mockLive"));
    const serverMod = await import("../server");
    startServer = serverMod.startServer;
    apiToken = serverMod.API_AUTH_TOKEN;

    mock = installMockLive();
    running = await startServer({ port: 0, enableVite: false });

    client = new WebSocket(`ws://127.0.0.1:${running.port}/live`, {
      headers: { Cookie: `auth_token=${apiToken}` },
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

  it("update_draft_prompt sets draft; thinking fragments and dictation do NOT pollute it", async () => {
    const PROJECT = "dpsw_proj";
    const PANE = "dpsw-pane";
    registerActivePane(PROJECT, PANE);

    // 1. Call update_draft_prompt
    const call = live().emitToolCall("update_draft_prompt", {
      pane_id: PANE,
      text: "Check and see what's going on.",
      mode: "replace",
    });
    await waitFor(() => mock.responseFor(call));
    assert.strictEqual(draftText(PROJECT, PANE), "Check and see what's going on.");

    // 2. Emit model thinking fragments + turnComplete
    live().emit({ serverContent: { outputTranscription: { text: "I am thinking about something else." } } });
    live().emit({ serverContent: { turnComplete: true } });
    await new Promise((r) => setTimeout(r, 100));

    assert.strictEqual(
      draftText(PROJECT, PANE),
      "Check and see what's going on.",
      "Model thinking fragments did NOT alter or pollute the draft"
    );

    // 3. Emit operator dictation utterance
    live().emit({ clientContent: { turns: [{ role: "user", parts: [{ text: "Now listen to my dictation." }] }] } } as any);
    await new Promise((r) => setTimeout(r, 100));

    assert.strictEqual(
      draftText(PROJECT, PANE),
      "Check and see what's going on.",
      "Operator dictation utterance did NOT alter or pollute the draft"
    );
  });
});
