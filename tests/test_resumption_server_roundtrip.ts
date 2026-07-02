// tests/test_resumption_server_roundtrip.ts
//
// wsm-e2e-pinned-yfa — promotes the disconnect -> reconnect -> digest resumption pin from a
// RENDER-layer-only assertion (e2e/resumption.spec.ts, ?mock=1 harness, no real server WS) to a
// REAL server round-trip. Extends the same in-proc idiom as tests/test_session_reconnect.ts
// (startServer port 0 + a scripted fake Gemini connector + a REAL `ws` client on /live), but drives
// and asserts the two extra seams that suite exercises only indirectly:
//
//   1. `PendingApprovalStore.detachSession` — a dropped Gemini session must KEEP the survivor (not
//      purge it), verified over the REAL `GET /api/commands/pending` HTTP endpoint (a genuine
//      server round-trip), not just an in-process store-object assertion.
//   2. `reannounceSurvivors` — the reconnect that follows must (a) re-attach the orphan to the
//      fresh session, (b) speak the batched digest into it, AND (c) broadcast `terminals_updated`
//      to the OPERATOR's real WebSocket client so the UI's chips repopulate. (b) is already pinned
//      by test_session_reconnect.ts suite (b); (a) via REST and (c) are the NEW pins here.
//
// Deterministic: every wait is a `waitFor` poll on real (non-mocked) timers/state, no fixed sleeps
// for the pass path.

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";
import { teardownServerSuite } from "./helpers/teardown";
import type { RunningServer } from "../server";

interface FakeSession {
  params: any;
  clientContents: any[];
  closed: boolean;
  emit: (m: any) => void;
  emitClose: (info?: any) => void;
  sendToolResponse: (r: any) => void;
  sendRealtimeInput: (i: any) => void;
  sendClientContent: (c: any) => void;
  close: () => void;
}

function makeFakeSession(params: any): FakeSession {
  const s: FakeSession = {
    params,
    clientContents: [],
    closed: false,
    emit(m: any) { params?.callbacks?.onmessage?.(m); },
    emitClose(info: any = { code: 1006, reason: "fake live socket closed" }) { params?.callbacks?.onclose?.(info); },
    sendToolResponse() {},
    sendRealtimeInput() {},
    sendClientContent(c: any) { this.clientContents.push(c); },
    close() { this.closed = true; },
  };
  return s;
}

/** Fails `failuresRemaining` times (throwing), then returns a fresh FakeSession. Mirrors the
 *  identically-named helper in tests/test_session_reconnect.ts. */
function makeScriptedConnector(failuresRemaining: number) {
  const sessions: FakeSession[] = [];
  const state = { failuresRemaining, connectCount: 0 };
  const connector = async (_ai: any, params: any) => {
    state.connectCount++;
    if (state.failuresRemaining > 0) {
      state.failuresRemaining--;
      throw new Error(`scripted connect failure (#${state.connectCount})`);
    }
    const s = makeFakeSession(params);
    sessions.push(s);
    return s;
  };
  return { connector, sessions, state };
}

async function waitFor<T>(p: () => T | undefined | false | null, timeoutMs = 4000, intervalMs = 15): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = p();
    if (v) return v as T;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

let serverMod: typeof import("../server");
let tmpDir: string;
let prevCwd: string;

before(async () => {
  process.env.NODE_ENV = "test";
  process.env.JANUS_NO_AUTOSTART = "1";
  process.env.JANUS_RECONNECT_MAX_ATTEMPTS = "3";
  process.env.JANUS_RECONNECT_BASE_DELAY_MS = "20";
  process.env.JANUS_RECONNECT_MAX_DELAY_MS = "60";

  prevCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-resumption-roundtrip-"));
  process.env.JANUS_DB = path.join(tmpDir, "resumption.db");
  process.chdir(tmpDir);

  serverMod = await import("../server");
});

after(async () => {
  process.chdir(prevCwd);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

async function openClient(running: RunningServer, sink: any[]): Promise<WebSocket> {
  const client = new WebSocket(`ws://127.0.0.1:${running.port}/live`, {
    headers: { Cookie: `auth_token=${serverMod.API_AUTH_TOKEN}` },
  });
  client.on("message", (data) => { try { sink.push(JSON.parse(data.toString())); } catch { /* non-JSON */ } });
  await new Promise<void>((resolve, reject) => {
    client.on("open", () => resolve());
    client.on("error", reject);
  });
  return client;
}

async function closeClient(client: WebSocket): Promise<void> {
  if (client.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    client.once("close", () => resolve());
    try { client.close(); } catch { resolve(); }
  });
}

describe("wsm-e2e-pinned-yfa: detachSession -> reannounceSurvivors over a REAL server + WS client", () => {
  let running: RunningServer;
  let client: WebSocket;
  let messages: any[];
  let scripted: ReturnType<typeof makeScriptedConnector>;
  const apiHeaders = () => ({ "x-api-token": serverMod.API_AUTH_TOKEN, "content-type": "application/json" });

  before(async () => {
    scripted = makeScriptedConnector(0); // initial connect succeeds.
    serverMod.setLiveConnector(scripted.connector);
    running = await serverMod.startServer({ port: 0, enableVite: false });
    messages = [];
    client = await openClient(running, messages);
    await waitFor(() => scripted.sessions.length >= 1 && running._testActiveLiveSession?.());
  });

  after(async () => {
    await closeClient(client);
    await teardownServerSuite(running);
  });

  it("survives a real disconnect (detach, not purge) and re-attaches + broadcasts on the real reconnect", async () => {
    const approvals = running._testPendingApprovals!();
    const session0 = running._testActiveLiveSession!();
    const base = `http://127.0.0.1:${running.port}`;

    // Stage a survivor approval bound to the FIRST live session (as dispatchProposal does).
    const messageId = "yfa-survivor-1";
    approvals.add(
      {
        messageId,
        instruction: "npm run deploy",
        kind: "shell",
        terminalId: "yfa-pane",
        callId: messageId,
        timestamp: Date.now(),
      } as any,
      session0,
    );
    assert.strictEqual(approvals.sessionFor(messageId), session0, "survivor bound to the first (real) session");

    // Sanity: the REAL REST endpoint lists it while attached.
    const preDropRes = await fetch(`${base}/api/commands/pending`, { headers: apiHeaders() });
    const preDrop = await preDropRes.json();
    assert.ok(
      (preDrop.pending ?? preDrop).some((p: any) => p.messageId === messageId),
      "the staged survivor is listed over the real REST endpoint before the drop",
    );

    // --- Disconnect: a real Gemini-session close fires detachSession synchronously. --------------
    scripted.state.failuresRemaining = 0; // the reconnect must succeed immediately.
    const sessionsBefore = scripted.sessions.length;
    session0.emitClose({ code: 1006, reason: "yfa: drop to exercise detach -> reannounce" });

    // detachSession runs synchronously off the onclose callback: the survivor is immediately an
    // ORPHAN (session handle nulled) — NOT purged. Assert this over the REAL REST round-trip too:
    // the record is still fully durable/listed while detached (spec §6.1 "detach, not purge").
    assert.strictEqual(
      approvals.sessionFor(messageId),
      undefined,
      "the survivor is detached (orphaned), its live session handle nulled — not purged",
    );
    const midDropRes = await fetch(`${base}/api/commands/pending`, { headers: apiHeaders() });
    const midDrop = await midDropRes.json();
    assert.ok(
      (midDrop.pending ?? midDrop).some((p: any) => p.messageId === messageId),
      "the survivor is STILL listed over REST while detached (kept, not purged)",
    );

    // --- Reconnect: a NEW Gemini session is minted; reannounceSurvivors re-attaches + broadcasts. -
    const session1 = await waitFor(() => {
      const s = scripted.sessions[scripted.sessions.length - 1];
      return scripted.sessions.length > sessionsBefore && s !== session0 ? s : undefined;
    });
    await waitFor(() => running._testActiveLiveSession!() === session1);
    assert.notStrictEqual(session1, session0, "the reconnect minted a fresh, real session");

    // (a) Re-attached to the NEW session (the real sweep/reattach round-trip).
    await waitFor(() => approvals.sessionFor(messageId) === session1);
    assert.strictEqual(approvals.sessionFor(messageId), session1, "the survivor re-attached to the reconnected session");

    // (b) The batched digest was spoken into the new session, naming the survivor.
    const spokeDigest = await waitFor(() =>
      session1.clientContents.some((c) => JSON.stringify(c).includes("npm run deploy")));
    assert.ok(spokeDigest, "the reconnect spoke the resumption digest naming the survivor");

    // (c) The OPERATOR's real WebSocket client received the `terminals_updated` broadcast that
    // repopulates its chips — the outward half of the round-trip resumption.spec.ts's mock harness
    // cannot reach (no real server WS there). This is the NEW pin this test adds.
    await waitFor(() => messages.some((m) => m.type === "terminals_updated"));
    assert.ok(
      messages.some((m) => m.type === "terminals_updated"),
      "the real operator WS client received a terminals_updated broadcast on reannounce",
    );

    // Still listed (and still actionable) over REST after the full round-trip.
    const postRes = await fetch(`${base}/api/commands/pending`, { headers: apiHeaders() });
    const post = await postRes.json();
    assert.ok(
      (post.pending ?? post).some((p: any) => p.messageId === messageId),
      "the survivor is still listed over REST after the reconnect (available for the operator to resolve)",
    );

    approvals.delete(messageId);
  });
});
