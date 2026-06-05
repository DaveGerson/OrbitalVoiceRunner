// Track 0 — DUP-SEND BUG. When an approval is dispatched (operator approves a pending command),
// applyResolution writes the instruction to the pane (server.ts:594) but does NOT clear the pane's
// WIP draft. Dictation auto-populates that active draft (appendActiveDraft), so the very same text
// can survive in the draft after the approval fires. A later draft "Send" (server.ts draft/send
// route) then re-emits the identical instruction — a silent DUPLICATE send.
//
// The fix: in applyResolution's "approved" branch, AFTER the writeInput, clear the pane's draft
// when it matches the dispatched instruction (mirroring the draft/send clear at server.ts:1326-1327),
// then re-broadcast draft_updated. An UNRELATED in-progress draft for that pane must be left intact.
//
// This drives the REAL server (startServer + installMockLive) and the REAL applyResolution via the
// REST approve route — modeled byte-for-byte on tests/test_approval_resolved_broadcast.ts's harness,
// plus a ledger seed (project + pane + draft == instruction) so the clear has something to clear.
//
// Runner: npx tsx --test --test-force-exit tests/test_approval_dupsend.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";
import type { MockLiveHandle, MockLiveSession } from "./helpers/mockLive";
import { teardownServerSuite } from "./helpers/teardown";
import type { RunningServer } from "../server";
import type { PaneMeta } from "../src/types";

// The fix resolves the pane's project via manager.terminals[id].projectId, so the StubTerminal
// MUST carry projectId matching the seeded ledger project — otherwise getDraft(undefined, paneId)
// misses and the draft never clears (RED for the WRONG reason).
class StubTerminal {
  status: "Running" | "Exited" | "Idle" = "Running";
  permissionsMode: "Full Auto" | "Human-in-the-Loop" | "Read-Only" = "Human-in-the-Loop";
  toolPreset = "Custom";
  sessionId = "";
  contextSize = 0;
  cwd = ".";
  shellCmd = "bash";
  projectId = "default_project";
  public writes: string[] = [];
  constructor(public terminalId: string) {}
  getRawBackfill() { return ""; }
  getRecentOutput() { return ""; }
  writeInput(s: string) { this.writes.push(s); }
  async stop() { this.status = "Exited"; }
}

describe("Track 0 — an approval dispatch clears the matching WIP draft (no later dup-send)", () => {
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
  // Seed the ledger so the pane row exists (setDraft returns false if the row is missing).
  function seedLedgerPane(projectId: string, paneId: string) {
    if (!running.manager.ledger.workspaces[projectId]) {
      running.manager.ledger.addProject(projectId, tmpDir);
    }
    const pane: PaneMeta = {
      pane_id: paneId, name: paneId, runtime_type: "shell", last_known_state: "Idle",
      is_busy: false, alive: true, notes: [], permissions_mode: "Human-in-the-Loop",
      session_id: "", tool_preset: "Claude Code", context_size: 0,
    };
    running.manager.ledger.updatePane(projectId, pane);
  }

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";
    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-approval-dupsend-"));
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

  it("approving a command clears a matching WIP draft (and writes the command exactly once)", async () => {
    const instruction = "echo hello";
    const paneId = "pane_d1";
    const t = addPane(paneId);
    seedLedgerPane("default_project", paneId);
    // Seed step the broadcast test lacks: a draft whose text == the approved instruction.
    assert.strictEqual(
      running.manager.ledger.setDraft("default_project", paneId, instruction, "operator"),
      true,
      "seed landed — setDraft returns false if the pane row is missing",
    );

    injectPending("msg_d1", paneId, instruction);
    const messages: any[] = [];
    const onMsg = (data: any) => { try { messages.push(JSON.parse(data.toString())); } catch {} };
    client.on("message", onMsg);
    await api("/api/commands/approve", { method: "POST", body: JSON.stringify({ messageId: "msg_d1", approved: true }) });
    await waitFor(() => messages.find((m) => m.type === "approval_resolved" && m.messageId === "msg_d1"));
    client.off("message", onMsg);

    // Positive control: the write still happens EXACTLY once (the fix must not suppress the write).
    assert.deepStrictEqual(t.writes, [instruction], "the approved instruction was written to the pane exactly once");
    // THE BUG: today the draft survives the approve -> a later Send re-emits 'echo hello'.
    assert.strictEqual(
      running.manager.ledger.getDraft("default_project", paneId)?.text ?? "",
      "",
      "the matching WIP draft is cleared so a later Send cannot re-emit the same text",
    );
  });

  it("approving a command leaves an UNRELATED in-progress draft intact", async () => {
    const instruction = "echo hello";
    const unrelated = "half-written different thought";
    const paneId = "pane_d2";
    const t = addPane(paneId);
    seedLedgerPane("default_project", paneId);
    assert.strictEqual(
      running.manager.ledger.setDraft("default_project", paneId, unrelated, "operator"),
      true,
      "seed landed",
    );

    injectPending("msg_d2", paneId, instruction);
    const messages: any[] = [];
    const onMsg = (data: any) => { try { messages.push(JSON.parse(data.toString())); } catch {} };
    client.on("message", onMsg);
    await api("/api/commands/approve", { method: "POST", body: JSON.stringify({ messageId: "msg_d2", approved: true }) });
    await waitFor(() => messages.find((m) => m.type === "approval_resolved" && m.messageId === "msg_d2"));
    client.off("message", onMsg);

    assert.deepStrictEqual(t.writes, [instruction], "the approved instruction was still written exactly once");
    // The match-or-contains guard must NOT destroy an unrelated WIP draft for the same pane.
    assert.strictEqual(
      running.manager.ledger.getDraft("default_project", paneId)?.text ?? "",
      unrelated,
      "an unrelated in-progress draft for the pane is preserved",
    );
  });
});
