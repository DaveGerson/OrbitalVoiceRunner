// BUG-004 (FIXED — this is a REGRESSION PIN, expected GREEN immediately).
//
// The REST approve/reject path routes through the SAME applyResolution choke-point the voice path
// uses (src/gating/index.ts:1188), so a UI approve/reject fans out the frontend broadcasts that drive
// earcons + badge repaints. Validation H recorded a TEST-ONLY gap: no test asserted these specific
// frames on the REST path. This pins them:
//   - POST /api/commands/approve {approved:true}  -> WS `command_auto_executed` {approved:true} + `terminals_updated`
//   - POST /api/commands/approve {approved:false} -> WS `command_blocked`
//
// Frame shapes (src/gating/index.ts):
//   command_auto_executed: { type, terminalId, cmd, approved:true }   (renderApproved, :1114)
//   command_blocked:       { type, terminalId, cmd, reason }          (renderRejected, :1125)
//   terminals_updated:     { type, postures }                         (broadcastTerminalsUpdated, :718)
//
// Drives the REAL server + REAL applyResolution over a live WS client (the
// tests/test_approval_resolved_broadcast.ts harness).
//
// Runner: npx tsx --test --test-force-exit tests/test_rest_approve_broadcasts.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";
import type { MockLiveHandle } from "./helpers/mockLive";
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

describe("BUG-004 — REST approve/reject emit the frontend broadcasts (regression pin)", () => {
  let startServer: (opts?: any) => Promise<RunningServer>;
  let apiToken: string;
  let installMockLive: () => MockLiveHandle;
  let waitFor: <T>(p: () => T | undefined | false, t?: number, i?: number) => Promise<T>;

  let running: RunningServer;
  let client: WebSocket;
  let base: string;
  let tmpDir: string;
  let prevCwd: string;

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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-rest-broadcast-"));
    process.chdir(tmpDir);

    ({ installMockLive, waitFor } = await import("./helpers/mockLive"));
    const serverMod = await import("../server");
    startServer = serverMod.startServer;
    apiToken = serverMod.API_AUTH_TOKEN;

    installMockLive();
    running = await startServer({ port: 0, enableVite: false });
    base = `http://127.0.0.1:${running.port}`;
    client = new WebSocket(`ws://127.0.0.1:${running.port}/live`, { headers: { Cookie: `auth_token=${apiToken}` } });
    await new Promise<void>((resolve, reject) => { client.on("open", () => resolve()); client.on("error", reject); });
  });

  after(async () => {
    if (client && client.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => { client.once("close", () => resolve()); try { client.terminate(); } catch { resolve(); } });
    }
    await teardownServerSuite(running);
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("REST approve broadcasts command_auto_executed {approved:true} + terminals_updated", async () => {
    addPane("pane_b1");
    injectPending("msg_b1", "pane_b1", "echo hi");
    const messages: any[] = [];
    const onMsg = (data: any) => { try { messages.push(JSON.parse(data.toString())); } catch {} };
    client.on("message", onMsg);

    await api("/api/commands/approve", { method: "POST", body: JSON.stringify({ messageId: "msg_b1", approved: true }) });

    const autoExec = await waitFor(() => messages.find((m) => m.type === "command_auto_executed" && m.terminalId === "pane_b1"));
    assert.strictEqual(autoExec.approved, true, "approved:true flags an operator approval (not a Full-Auto auto-exec)");
    await waitFor(() => messages.find((m) => m.type === "terminals_updated"));
    client.off("message", onMsg);
  });

  it("REST reject broadcasts command_blocked", async () => {
    addPane("pane_b2");
    injectPending("msg_b2", "pane_b2", "rm -rf build");
    const messages: any[] = [];
    const onMsg = (data: any) => { try { messages.push(JSON.parse(data.toString())); } catch {} };
    client.on("message", onMsg);

    await api("/api/commands/approve", { method: "POST", body: JSON.stringify({ messageId: "msg_b2", approved: false }) });

    const blocked = await waitFor(() => messages.find((m) => m.type === "command_blocked" && m.terminalId === "pane_b2"));
    assert.ok(blocked.reason, "command_blocked carries a reason string");
    client.off("message", onMsg);
  });
});
