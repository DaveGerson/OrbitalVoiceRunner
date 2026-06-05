// Issue E (round3c live-session triage): a voice/REST approval must dismiss the ApprovalDialog in
// REAL TIME. The PTY-approval choke-point applyResolution previously broadcast only
// command_auto_executed (no messageId), so a VOICE approval resolved the command server-side
// (PTY write fired, pendingApprovals entry deleted) while the browser's pendingCommands entry
// survived until the ~20s safety-net poll — the operator saw the confirm modal "stuck" for up to
// 20s ("still showing the confirm pane" + "recurring UI delay after approvals").
//
// This pins a messageId-keyed `approval_resolved` broadcast on EVERY non-lost_race resolve
// (approve / reject / expire / dead_pane), mirroring the proven `action_resolved` pattern that
// already dismisses ActionConfirmDialog in real time. It drives the REAL server (startServer +
// installMockLive) and the REAL applyResolution via the REST approve route, capturing broadcasts
// over a live WS client — not a re-implementation.
//
// Runner: npx tsx --test --test-force-exit tests/test_approval_resolved_broadcast.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";
import type { MockLiveHandle, MockLiveSession } from "./helpers/mockLive";
import { teardownServerSuite } from "./helpers/teardown";
import type { RunningServer } from "../server";

class StubTerminal {
  status: "Running" | "Exited" | "Idle" = "Running";
  permissionsMode: "Full Auto" | "Human-in-the-Loop" | "Read-Only" = "Human-in-the-Loop";
  toolPreset = "Custom";
  sessionId = "";
  contextSize = 0;
  cwd = ".";
  shellCmd = "bash";
  public writes: string[] = [];
  constructor(public terminalId: string) {}
  getRawBackfill() { return ""; }
  getRecentOutput() { return ""; }
  writeInput(s: string) { this.writes.push(s); }
  async stop() { this.status = "Exited"; }
}

describe("Issue E — approval_resolved broadcast dismisses the modal in real time", () => {
  let startServer: (opts?: any) => Promise<RunningServer>;
  let apiToken: string;
  let installMockLive: () => MockLiveHandle;
  let waitFor: <T>(p: () => T | undefined | false, t?: number, i?: number) => Promise<T>;

  let mock: MockLiveHandle;
  let running: RunningServer;
  let session: MockLiveSession;
  let client: WebSocket;
  let base: string;
  let tmpDir: string;
  let prevCwd: string;

  // pushApprovalNarration calls session.sendClientContent (wrapped in try/catch). Give it a no-op
  // so the resolve path narrates cleanly without a console.error and without a real Gemini session.
  const fakeSession = { sendClientContent() {} };

  const api = (pathname: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${base}${pathname}`, {
      ...init,
      headers: { "x-api-token": apiToken, "content-type": "application/json", ...(init.headers || {}) },
    });

  function addPane(paneId: string): StubTerminal {
    const t = new StubTerminal(paneId);
    (running.manager.terminals as any)[paneId] = t;
    return t;
  }
  function injectPending(messageId: string, terminalId: string, instruction: string) {
    running._testPendingApprovals!().add(
      { messageId, instruction, kind: "agent_instruction", terminalId, callId: messageId, timestamp: Date.now() } as any,
      fakeSession as any,
    );
  }

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";
    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-approval-resolved-"));
    process.chdir(tmpDir);

    ({ installMockLive, waitFor } = await import("./helpers/mockLive"));
    const serverMod = await import("../server");
    startServer = serverMod.startServer;
    apiToken = serverMod.API_AUTH_TOKEN;

    mock = installMockLive();
    running = await startServer({ port: 0, enableVite: false });
    base = `http://127.0.0.1:${running.port}`;
    client = new WebSocket(`ws://127.0.0.1:${running.port}/live`, { headers: { Cookie: `auth_token=${apiToken}` } });
    await new Promise<void>((resolve, reject) => { client.on("open", () => resolve()); client.on("error", reject); });
    session = await waitFor(() => mock.latest());
  });

  after(async () => {
    if (client && client.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => { client.once("close", () => resolve()); try { client.terminate(); } catch { resolve(); } });
    }
    await teardownServerSuite(running);
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("an approve broadcasts approval_resolved keyed by messageId + outcome 'approved' (and writes the command)", async () => {
    const t = addPane("pane_e1");
    injectPending("msg_e1", "pane_e1", "echo hello");
    const messages: any[] = [];
    const onMsg = (data: any) => { try { messages.push(JSON.parse(data.toString())); } catch {} };
    client.on("message", onMsg);
    await api("/api/commands/approve", { method: "POST", body: JSON.stringify({ messageId: "msg_e1", approved: true }) });
    const evt = await waitFor(() => messages.find((m) => m.type === "approval_resolved" && m.messageId === "msg_e1"));
    client.off("message", onMsg);
    assert.strictEqual(evt.messageId, "msg_e1", "broadcast carries the resolved messageId so the client can filter pendingCommands");
    assert.strictEqual(evt.outcome, "approved");
    assert.deepStrictEqual(t.writes, ["echo hello"], "the approved instruction was written to the pane");
  });

  it("a reject also broadcasts approval_resolved (outcome 'rejected') and writes nothing", async () => {
    const t = addPane("pane_e2");
    injectPending("msg_e2", "pane_e2", "rm -rf build");
    const messages: any[] = [];
    const onMsg = (data: any) => { try { messages.push(JSON.parse(data.toString())); } catch {} };
    client.on("message", onMsg);
    await api("/api/commands/approve", { method: "POST", body: JSON.stringify({ messageId: "msg_e2", approved: false }) });
    const evt = await waitFor(() => messages.find((m) => m.type === "approval_resolved" && m.messageId === "msg_e2"));
    client.off("message", onMsg);
    assert.strictEqual(evt.outcome, "rejected");
    assert.strictEqual(t.writes.length, 0, "reject writes nothing");
  });
});
