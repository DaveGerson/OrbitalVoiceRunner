// QW3 — Gemini Live session onerror/onclose, minimal (bead qw3).
//
// The callbacks object the server passed to the live connector used to contain ONLY
// onmessage — there was NO onerror/onclose. If the Gemini socket died WITHOUT the
// client WS closing, nothing fired: activeLiveSession kept a dead handle and the
// frontend was never told. This suite proves the new onerror/onclose siblings:
//   - null activeLiveSession (identity-guarded so a stale callback can't null a newer session),
//   - detach (NOT purge) pending approvals — survivors are kept for re-announce,
//   - broadcast a NEW frame {type:"voice_channel_lost", reason}.
// No reconnect logic (that is PLM4, out of scope).
//
// We trigger the dead socket via the mockLive harness extension emitError()/emitClose(),
// which invokes params.callbacks.onerror/onclose — exactly the callbacks the server registers.

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";
import type { MockLiveHandle, MockLiveSession } from "./helpers/mockLive";
import { teardownServerSuite } from "./helpers/teardown";
import type { RunningServer } from "../server";

describe("QW3 session drop -> voice channel lost (headless)", () => {
  let startServer: (opts?: any) => Promise<RunningServer>;
  let apiToken: string;
  let installMockLive: () => MockLiveHandle;
  let waitFor: <T>(p: () => T | undefined | false, t?: number, i?: number) => Promise<T>;

  let mock: MockLiveHandle;
  let running: RunningServer;
  let session: MockLiveSession;
  let client: WebSocket;
  let clientMessages: any[];
  let tmpDir: string;
  let prevCwd: string;

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";

    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-sessdrop-"));
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

    session = await waitFor(() => mock.latest());
    // Sanity: the server hoisted THIS session as the active voice channel.
    await waitFor(() => running._testActiveLiveSession?.() === session);
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
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("a session error nulls activeLiveSession and detaches approvals", async () => {
    const approvals = running._testPendingApprovals!();
    // Stage a pending approval bound to THIS live session, exactly as dispatchProposal does.
    const messageId = "qw3-survivor-1";
    approvals.add(
      { messageId, instruction: "git status", kind: "shell", terminalId: "qw3-pane", callId: messageId, timestamp: Date.now() } as any,
      session,
    );
    assert.strictEqual(approvals.sessionFor(messageId), session, "approval is bound to the live session before the drop");
    assert.strictEqual(running._testActiveLiveSession!(), session, "activeLiveSession points at the live session before the drop");

    // The Gemini socket dies WITHOUT the client WS closing.
    session.emitError(new Error("gemini socket reset"));

    // activeLiveSession is nulled (identity-guarded): the dead handle is dropped.
    assert.strictEqual(running._testActiveLiveSession!(), null, "activeLiveSession is nulled after the session error");
    // The approval is DETACHED, not purged: the record survives (re-announce on reconnect) but its
    // live-session handle is gone.
    assert.strictEqual(approvals.sessionFor(messageId), undefined, "the approval was DETACHED from the dead session");
    assert.ok(approvals.all().some((p) => p.messageId === messageId), "the detached approval is KEPT as a survivor (not purged)");

    // cleanup the staged survivor so it doesn't leak into the next test.
    approvals.delete(messageId);
  });

  it("a session error notifies the frontend voice lost", async () => {
    // Re-establish a fresh session for this independent case (a 2nd WS connection mints one).
    const seen = clientMessages.length;
    const client2 = new WebSocket(`ws://127.0.0.1:${running.port}/live`, {
      headers: { Cookie: `auth_token=${apiToken}` },
    });
    client2.on("message", (data) => {
      try { clientMessages.push(JSON.parse(data.toString())); } catch { /* non-JSON */ }
    });
    await new Promise<void>((resolve, reject) => {
      client2.on("open", () => resolve());
      client2.on("error", reject);
    });
    const session2 = await waitFor(() => {
      const s = mock.latest();
      return s && s !== session ? s : undefined;
    });

    // Trigger the dead socket; the server must announce the loss to every WS client.
    session2.emitClose({ code: 1006, reason: "socket gone" });

    const evt = await waitFor(() =>
      clientMessages.slice(seen).find((m) => m.type === "voice_channel_lost"),
    );
    assert.strictEqual(evt.type, "voice_channel_lost", "a voice_channel_lost frame is broadcast to the frontend");

    await new Promise<void>((resolve) => {
      client2.once("close", () => resolve());
      try { client2.terminate(); } catch { resolve(); }
    });
  });
});
