// tests/test_session_reconnect.ts
//
// PLM4 — the voice-session RESILIENCE layer. Four concerns, all driven through the SAME injectable
// live-session seam (setLiveConnector) the QW3 / resumption-digest suites use, with a FAKE connector
// scripted per scenario (FAIL k times, then SUCCEED). We assert:
//
//   (a) BOUNDED backoff — a connector that ALWAYS fails stops after a capped number of attempts
//       (no retry-forever / no storm) and broadcasts a final "could not reconnect" frame.
//   (b) EVENTUAL reconnect RE-ANNOUNCES survivors — a drop, then a reconnect that succeeds after k
//       failures, re-attaches the staged approval survivor and speaks the resumption digest.
//   (c) NO reconnect AFTER the operator's WS closes — a drop whose WS then closes must NOT reconnect.
//   (d) PER-DISPATCH IDEMPOTENCY — a re-delivered NON-readOnly tool call (same idempotency_key) is
//       short-circuited (NOT double-applied), while a re-delivered READ (readOnly) is allowed to run.
//
// Each describe gets its OWN server + OWN connector: setLiveConnector is a module global, but
// startServer() SNAPSHOTS it synchronously, so configuring the connector BEFORE startServer pins it
// to that server. Reconnect tunables are shrunk via the JANUS_RECONNECT_* env knobs so the bounded
// backoff runs deterministically fast.

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";
import { JanusStore } from "../src/store/sqliteStore";
import { teardownServerSuite } from "./helpers/teardown";
import type { RunningServer } from "../server";

// A minimal fake Gemini Live session, richer than mockLive's (captures sendClientContent so the
// resumption-digest narration is observable, and exposes emitError/emitClose to drop the socket).
interface FakeSession {
  params: any;
  responses: any[];
  clientContents: any[];
  /** 3V.1: every sendRealtimeInput payload (mic frames) — pins WHICH session the mic routes to. */
  realtimeInputs: any[];
  closed: boolean;
  emit: (m: any) => void;
  emitToolCall: (name: string, args?: Record<string, any>, id?: string) => string;
  emitError: (err?: any) => void;
  emitClose: (info?: any) => void;
  sendToolResponse: (r: any) => void;
  sendRealtimeInput: (i: any) => void;
  sendClientContent: (c: any) => void;
  close: () => void;
}

function makeFakeSession(params: any): FakeSession {
  let counter = 0;
  const s: FakeSession = {
    params,
    responses: [],
    clientContents: [],
    realtimeInputs: [],
    closed: false,
    emit(m: any) { params?.callbacks?.onmessage?.(m); },
    emitToolCall(name: string, args: Record<string, any> = {}, id?: string) {
      const callId = id ?? `recon-call-${++counter}`;
      this.emit({ toolCall: { functionCalls: [{ name, id: callId, args }] } });
      return callId;
    },
    emitError(err: any = new Error("fake live socket error")) { params?.callbacks?.onerror?.(err); },
    emitClose(info: any = { code: 1006, reason: "fake live socket closed" }) { params?.callbacks?.onclose?.(info); },
    sendToolResponse(r: any) { this.responses.push(r); },
    sendRealtimeInput(i: any) { this.realtimeInputs.push(i); },
    sendClientContent(c: any) { this.clientContents.push(c); },
    close() { this.closed = true; },
  };
  return s;
}

/**
 * 3V.1: a connector whose every connect attempt is a MANUALLY-RESOLVED promise, so a test can
 * interleave OVERLAPPING connects deterministically (resolve the newer attempt first, then the
 * older "slow" one last — the exact race the generation guard must win).
 */
function makeDeferredConnector() {
  const sessions: FakeSession[] = [];
  const pending: { params: any; resolve: (s: FakeSession) => void; reject: (e: any) => void }[] = [];
  const state = { connectCount: 0 };
  const connector = (_ai: any, params: any) =>
    new Promise<FakeSession>((resolve, reject) => {
      state.connectCount++;
      pending.push({ params, resolve, reject });
    });
  /** Resolve the (1-indexed) attempt with a fresh FakeSession and return it. */
  const resolveAttempt = (attempt: number): FakeSession => {
    const p = pending[attempt - 1];
    if (!p) throw new Error(`no pending connect attempt #${attempt}`);
    const s = makeFakeSession(p.params);
    sessions.push(s);
    p.resolve(s);
    return s;
  };
  return { connector, sessions, pending, state, resolveAttempt };
}

/** A scripted connector: fails `failuresRemaining` times (throwing), then returns a fresh FakeSession. */
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

/**
 * Like makeScriptedConnector, but ALSO records EVERY attempt's connect `params` (even failed ones) so
 * a test can inspect what `config.sessionResumption` was fed on each attempt (Finding B1 / B2). The
 * `failPredicate` decides, per attempt (1-indexed) and given the params, whether THIS attempt throws.
 */
function makeRecordingConnector(failPredicate: (attempt: number, params: any) => boolean) {
  const sessions: FakeSession[] = [];
  const attempts: any[] = []; // each attempt's params (resolved or rejected)
  const state = { connectCount: 0 };
  const connector = async (_ai: any, params: any) => {
    state.connectCount++;
    attempts.push(params);
    if (failPredicate(state.connectCount, params)) {
      throw new Error(`recording connect failure (#${state.connectCount})`);
    }
    const s = makeFakeSession(params);
    sessions.push(s);
    return s;
  };
  /** The sessionResumption object fed on a given (1-indexed) attempt. */
  const resumptionFor = (attempt: number): any => attempts[attempt - 1]?.config?.sessionResumption;
  return { connector, sessions, attempts, state, resumptionFor };
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

// Shared module bootstrap: one tmp cwd + DB, server module imported ONCE (it is a singleton store).
let serverMod: typeof import("../server");
let tmpDir: string;
let prevCwd: string;
let dbPath: string;

before(async () => {
  process.env.NODE_ENV = "test";
  process.env.JANUS_NO_AUTOSTART = "1";
  // Shrink the bounded-backoff so the "always fails" suite resolves in well under a second.
  process.env.JANUS_RECONNECT_MAX_ATTEMPTS = "3";
  process.env.JANUS_RECONNECT_BASE_DELAY_MS = "20";
  process.env.JANUS_RECONNECT_MAX_DELAY_MS = "60";

  prevCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-reconnect-"));
  dbPath = path.join(tmpDir, "reconnect.db");
  process.env.JANUS_DB = dbPath; // pin the durable store so we can pre-seed/read it from a 2nd handle.
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

// ───────────────────────────────────────────────────────────────────────────────────────────────
// (a) BOUNDED backoff — always-failing reconnect stops after the capped attempt count, no storm.
// ───────────────────────────────────────────────────────────────────────────────────────────────
describe("PLM4 (a): reconnect is BOUNDED — always-fail stops after the cap, broadcasts a final loss", () => {
  let running: RunningServer;
  let client: WebSocket;
  let messages: any[];
  let scripted: ReturnType<typeof makeScriptedConnector>;

  before(async () => {
    // Initial connect SUCCEEDS (failures=0), then we drop it; the reconnect connector then ALWAYS
    // fails. We arm "always fail" by re-arming failuresRemaining to a large number after the first
    // successful connect resolves (so reconnects never succeed). Simpler: start with 0 failures,
    // flip to a big number once the first session exists.
    scripted = makeScriptedConnector(0);
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

  it("stops reconnecting after MAX_ATTEMPTS and broadcasts a permanent voice_channel_lost", async () => {
    // From now on, every (re)connect FAILS. Drop the live socket to kick off the bounded retries.
    scripted.state.failuresRemaining = 1000;
    const connectsBefore = scripted.state.connectCount; // 1 (the initial success).
    scripted.sessions[0].emitClose({ code: 1006, reason: "drop to start bounded retries" });

    // The final, permanent loss frame is broadcast once the cap (3) is hit.
    const permanent = await waitFor(() => messages.find((m) => m.type === "voice_channel_lost" && m.permanent === true));
    assert.strictEqual(permanent.reason, "reconnect_failed", "the give-up frame names the reconnect failure");

    // BOUNDED: connectCount grew by EXACTLY MAX_ATTEMPTS (=3) reconnect attempts — never unbounded.
    const reconnectAttempts = scripted.state.connectCount - connectsBefore;
    assert.strictEqual(reconnectAttempts, 3, "exactly MAX_ATTEMPTS reconnect attempts were made (no storm)");

    // And it stays put — no further attempts after the give-up (let a couple backoff windows pass).
    const settled = scripted.state.connectCount;
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(scripted.state.connectCount, settled, "no reconnect attempts fire after giving up");
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// (b) EVENTUAL reconnect RE-ANNOUNCES survivors — fail k times, then succeed, then digest.
// ───────────────────────────────────────────────────────────────────────────────────────────────
describe("PLM4 (b): an eventual reconnect re-announces the surviving approvals", () => {
  let running: RunningServer;
  let client: WebSocket;
  let messages: any[];
  let scripted: ReturnType<typeof makeScriptedConnector>;

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

  it("re-attaches + speaks the resumption digest on the reconnect that finally succeeds", async () => {
    const approvals = running._testPendingApprovals!();
    const session0 = running._testActiveLiveSession!();

    // Stage a survivor approval bound to the FIRST live session (exactly as dispatchProposal does).
    const messageId = "recon-survivor-1";
    approvals.add(
      { messageId, instruction: "run the full test suite", kind: "shell", terminalId: "recon-pane", callId: messageId, timestamp: Date.now() } as any,
      session0,
    );
    assert.strictEqual(approvals.sessionFor(messageId), session0, "survivor bound to the first session");

    // Reconnect should FAIL once, then SUCCEED. Arm one failure, then drop the live socket.
    scripted.state.failuresRemaining = 1;
    const sessionsBefore = scripted.sessions.length;
    session0.emitClose({ code: 1006, reason: "drop -> reconnect-after-one-failure" });

    // A NEW session is eventually minted (the reconnect that succeeded after the single failure).
    const session1 = await waitFor(() => {
      const s = scripted.sessions[scripted.sessions.length - 1];
      return scripted.sessions.length > sessionsBefore && s !== session0 ? s : undefined;
    });

    // The hoisted live session is the reconnected one, and it is NOT the dead session0.
    await waitFor(() => running._testActiveLiveSession!() === session1);
    assert.notStrictEqual(session1, session0, "the reconnect minted a fresh session");

    // PLM4 (4): reannounceSurvivors ran on the reconnect — the survivor re-attached to session1...
    assert.strictEqual(approvals.sessionFor(messageId), session1, "survivor re-attached to the reconnected session");
    // ...and the resumption digest was SPOKEN into the new session (sendClientContent narration).
    const spokeDigest = session1.clientContents.some((c) =>
      JSON.stringify(c).includes("run the full test suite"));
    assert.ok(spokeDigest, "the reconnect spoke the resumption digest naming the survivor");

    approvals.delete(messageId);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// (c) NO reconnect after the operator's WS closes.
// ───────────────────────────────────────────────────────────────────────────────────────────────
describe("PLM4 (c): a reconnect does NOT fire after the operator's client WS closes", () => {
  let running: RunningServer;
  let client: WebSocket;
  let messages: any[];
  let scripted: ReturnType<typeof makeScriptedConnector>;

  before(async () => {
    scripted = makeScriptedConnector(0);
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

  it("closing the client WS cancels any reconnect (no new connect attempts)", async () => {
    const connectsBefore = scripted.state.connectCount; // 1 initial.
    // Arm reconnect failures so that, IF a reconnect were (wrongly) attempted, connectCount would grow.
    scripted.state.failuresRemaining = 1000;

    // The operator leaves: close the client WS. The server's clientWs.on("close") clears the timer.
    await closeClient(client);

    // Give the (now-cancelled) backoff windows ample time to NOT fire.
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(scripted.state.connectCount, connectsBefore, "no reconnect attempt after the WS closed");
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// (d) PER-DISPATCH IDEMPOTENCY — re-delivered non-readOnly is short-circuited; a read replays.
// ───────────────────────────────────────────────────────────────────────────────────────────────
describe("PLM4 (d): a re-delivered non-readOnly dispatch is NOT double-applied; a read replays", () => {
  let running: RunningServer;
  let client: WebSocket;
  let messages: any[];
  let scripted: ReturnType<typeof makeScriptedConnector>;
  let seedStore: JanusStore;

  before(async () => {
    scripted = makeScriptedConnector(0);
    serverMod.setLiveConnector(scripted.connector);
    running = await serverMod.startServer({ port: 0, enableVite: false });
    messages = [];
    client = await openClient(running, messages);
    await waitFor(() => scripted.sessions.length >= 1 && running._testActiveLiveSession?.());
    // A SECOND handle on the SAME durable DB lets us pre-seed + read action_log rows. WAL allows
    // concurrent readers/writers across connections.
    seedStore = new JanusStore(dbPath); seedStore.init();
  });

  after(async () => {
    try { seedStore.close(); } catch { /* best-effort */ }
    await closeClient(client);
    await teardownServerSuite(running);
  });

  function rowsForKey(key: string): number {
    return seedStore.getActionLog({ limit: 1000 }).filter((r) => r.idempotency_key === key).length;
  }

  it("short-circuits a re-delivered NON-readOnly tool call carrying an already-succeeded key", async () => {
    const session = scripted.sessions[scripted.sessions.length - 1]!;
    const key = "idem-nonreadonly-1";

    // Pre-seed a SUCCEEDED row (result_kind "ok") for a non-readOnly action under this key, as if the
    // first delivery already landed its side effect. (add_project_note is readOnly:false on voice.)
    seedStore.recordAction({ name: "add_project_note", capability: "update_metadata", result_kind: "ok", ms: 1, idempotency_key: key });
    assert.strictEqual(rowsForKey(key), 1, "exactly the pre-seeded succeeded row exists");

    // RE-DELIVER the same call.id. The replay guard must short-circuit BEFORE runAction, so the
    // side-effecting HANDLER never re-runs — but wsm-e2e-pinned-smz (3) now records a lightweight
    // 'replay_suppressed' audit row for the suppressed attempt itself, distinct from the handler's
    // own "ok" row.
    session.emitToolCall("add_project_note", { project_id: "default_project", note: "should not double-apply" }, key);

    const resp = await waitFor(() => {
      const fr = session.responses.flatMap((r) => r.functionResponses ?? []).find((f) => f.id === key);
      return fr ? fr.response?.output : undefined;
    });
    assert.match(String(resp), /already handled/i, "the model is told the call was already handled");
    // ONE new row (the 'replay_suppressed' audit), not a second "ok" — the handler itself did NOT re-run.
    await waitFor(() => rowsForKey(key) >= 2);
    assert.strictEqual(rowsForKey(key), 2, "exactly one new row (replay_suppressed) — the side-effecting handler did NOT re-run");
    const rows = seedStore.getActionLog({ limit: 1000 }).filter((r) => r.idempotency_key === key);
    assert.deepStrictEqual(rows.map((r) => r.result_kind).sort(), ["ok", "replay_suppressed"], "the pre-seeded 'ok' row is untouched; the new row is the suppression marker");
  });

  it("ALLOWS a re-delivered READ (readOnly) to run — replaying a read is harmless", async () => {
    const session = scripted.sessions[scripted.sessions.length - 1]!;
    const key = "idem-readonly-1";

    // Pre-seed a succeeded row for a READ-only action under this key.
    seedStore.recordAction({ name: "get_project_notes", capability: "read_notes", result_kind: "ok", ms: 1, idempotency_key: key });
    assert.strictEqual(rowsForKey(key), 1, "exactly the pre-seeded read row exists");

    // RE-DELIVER the same READ. readOnly is EXEMPT from the guard -> runAction runs -> its audit seam
    // writes ANOTHER row under the same key (count goes to 2), and the response is the read output,
    // NOT the "already handled" short-circuit.
    session.emitToolCall("get_project_notes", { project_id: "default_project" }, key);

    const resp = await waitFor(() => {
      const fr = session.responses.flatMap((r) => r.functionResponses ?? []).find((f) => f.id === key);
      return fr ? fr.response?.output : undefined;
    });
    assert.doesNotMatch(String(resp), /already handled/i, "a read is NOT short-circuited");
    await waitFor(() => rowsForKey(key) >= 2);
    assert.ok(rowsForKey(key) >= 2, "the read actually ran (its audit wrote a second row under the key)");
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// (e) Finding A — a PRE-TRY throw on the INITIAL connect does NOT become an unhandled rejection; the
//     client still gets the error frame AND the WS message/close listeners still register.
//     The pre-try setup (the GoogleGenAI client construction) is simulated via the setSessionAiFactory
//     seam throwing — that runs OUTSIDE connectLiveSession's own try, exactly like the real hole.
// ───────────────────────────────────────────────────────────────────────────────────────────────
describe("PLM4 (e) Finding A: a pre-try throw on the INITIAL connect is caught — error frame + listeners still register", () => {
  let running: RunningServer;
  let client: WebSocket;
  let messages: any[];
  let scripted: ReturnType<typeof makeScriptedConnector>;
  const unhandled: any[] = [];
  const onUnhandled = (e: any) => unhandled.push(e);

  before(async () => {
    process.on("unhandledRejection", onUnhandled);
    // The connector would succeed, but the PRE-TRY GoogleGenAI construction throws synchronously
    // (a malformed-but-present key in prod). This escapes connectLiveSession before its inner try.
    scripted = makeScriptedConnector(0);
    serverMod.setLiveConnector(scripted.connector);
    serverMod.setSessionAiFactory(() => { throw new Error("simulated GoogleGenAI construction failure (pre-try setup)"); });
    running = await serverMod.startServer({ port: 0, enableVite: false });
    messages = [];
    client = await openClient(running, messages);
  });

  after(async () => {
    serverMod.resetSessionAiFactory();
    process.off("unhandledRejection", onUnhandled);
    await closeClient(client);
    await teardownServerSuite(running);
  });

  it("sends the connection-failed error frame and does NOT raise an unhandled rejection", async () => {
    // The mirrored initial-failure error frame reaches the client (proof the outer wrap fired instead
    // of letting the rejection escape the async wss.on('connection') body).
    const errFrame = await waitFor(() => messages.find((m) => m.type === "error" && /Gemini Live Voice Connection Failed/i.test(m.message)));
    assert.ok(errFrame, "the client received the Gemini-Live connection-failed error frame");
    // The pre-try threw, so NO live session was ever connected (the connector was never reached past
    // the throw — sessionAi construction precedes the connect call).
    assert.strictEqual(scripted.sessions.length, 0, "no live session was minted (the throw preceded the connect)");
    // And crucially: no unhandled rejection escaped the async connection handler.
    await new Promise((r) => setTimeout(r, 100));
    assert.deepStrictEqual(unhandled, [], "the pre-try throw did NOT surface as an unhandled rejection");
  });

  it("still registered the WS message + close listeners (the handler fell through after catching)", async () => {
    // The connection-handler body continued past the failed connect. The SERVER-side socket was added
    // to the broadcast set (size 1 on this single-client server), and a malformed frame must be
    // swallowed by the live message listener (no crash). (NOTE: _testClients holds the SERVER-side
    // clientWs, not this client-side WebSocket — so we assert on SIZE, not identity.)
    client.send("not json — exercises the message listener's catch");
    assert.strictEqual(running._testClients!().size, 1, "the server-side socket is in the broadcast set (connection handler completed past the failed connect)");
    // Closing the client must drive the broadcast set back to empty — proof clientWs.on('close')
    // registered (the handler reached the listener-registration block after catching the pre-try throw).
    await closeClient(client);
    await waitFor(() => running._testClients!().size === 0);
    assert.strictEqual(running._testClients!().size, 0, "the close listener ran (server-side socket removed from the set)");
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// (f) Finding B1 — the REAL resume handle is fed under the SDK's actual key. After a session emits a
//     sessionResumptionUpdate (newHandle persisted), a reconnect's connect config carries
//     { handle: <that newHandle> } — NOT undefined, NOT under a `token` key.
// ───────────────────────────────────────────────────────────────────────────────────────────────
describe("PLM4 (f) Finding B1: the reconnect feeds sessionResumption.handle === the last newHandle", () => {
  let running: RunningServer;
  let client: WebSocket;
  let messages: any[];
  let recording: ReturnType<typeof makeRecordingConnector>;

  before(async () => {
    // Attempt 1 (initial) succeeds; attempt 2 (the reconnect) also succeeds. We inspect attempt 2's params.
    recording = makeRecordingConnector(() => false);
    serverMod.setLiveConnector(recording.connector);
    serverMod.resetSessionAiFactory(); // ensure a clean (non-throwing) factory for this suite.
    running = await serverMod.startServer({ port: 0, enableVite: false });
    messages = [];
    client = await openClient(running, messages);
    await waitFor(() => recording.sessions.length >= 1 && running._testActiveLiveSession?.());
  });

  after(async () => {
    await closeClient(client);
    await teardownServerSuite(running);
  });

  it("the reconnect's connect config carries { handle: <last newHandle> }", async () => {
    const HANDLE = "resume-handle-abc123";
    const session0 = recording.sessions[0]!;
    // The live session emits a resumption update; the server persists `newHandle` as the resume token.
    session0.emit({ sessionResumptionUpdate: { newHandle: HANDLE, resumable: true } });

    // Drop the socket -> bounded reconnect mints a fresh session (attempt 2).
    const before = recording.sessions.length;
    session0.emitClose({ code: 1006, reason: "drop -> reconnect with handle" });
    await waitFor(() => recording.sessions.length > before);

    // The reconnect attempt's config fed the REAL handle under the SDK's `handle` key (NOT `token`).
    const resume = recording.resumptionFor(2);
    assert.deepStrictEqual(resume, { handle: HANDLE }, "the reconnect fed sessionResumption.handle = the last newHandle");
    assert.strictEqual((resume as any).token, undefined, "the dead `token` key is NOT used");
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// (g) Finding B2 — STALE-HANDLE SELF-HEAL: a connect that FAILS while using a persisted handle clears
//     the poisoned handle, so the NEXT bounded attempt connects FRESH (sessionResumption === {}).
// ───────────────────────────────────────────────────────────────────────────────────────────────
describe("PLM4 (g) Finding B2: a connect that fails WHILE using a handle self-heals (next attempt goes fresh)", () => {
  let running: RunningServer;
  let client: WebSocket;
  let messages: any[];
  let recording: ReturnType<typeof makeRecordingConnector>;

  before(async () => {
    // Attempt 1 (initial) succeeds. Attempt 2 (the reconnect that USES the handle) FAILS. Attempt 3
    // must then connect FRESH (the poisoned handle was cleared by attempt 2's failure).
    recording = makeRecordingConnector((attempt) => attempt === 2);
    serverMod.setLiveConnector(recording.connector);
    serverMod.resetSessionAiFactory();
    running = await serverMod.startServer({ port: 0, enableVite: false });
    messages = [];
    client = await openClient(running, messages);
    await waitFor(() => recording.sessions.length >= 1 && running._testActiveLiveSession?.());
  });

  after(async () => {
    await closeClient(client);
    await teardownServerSuite(running);
  });

  it("clears the poisoned handle after a handle-using connect fails — attempt 3 connects fresh", async () => {
    const HANDLE = "stale-handle-xyz789";
    const session0 = recording.sessions[0]!;
    session0.emit({ sessionResumptionUpdate: { newHandle: HANDLE, resumable: true } });

    // Drop -> reconnect. Attempt 2 USES the handle and FAILS -> the handle is cleared -> attempt 3
    // connects FRESH and succeeds.
    session0.emitClose({ code: 1006, reason: "drop -> failing reconnect with stale handle" });

    // Wait until attempt 3 has actually been made (connectCount reaches 3).
    await waitFor(() => recording.state.connectCount >= 3);

    // Attempt 2 fed the (now-known-poisoned) handle...
    assert.deepStrictEqual(recording.resumptionFor(2), { handle: HANDLE }, "attempt 2 used the persisted handle");
    // ...and because it FAILED, attempt 3 connects FRESH (no handle) — the self-heal cleared it.
    assert.deepStrictEqual(recording.resumptionFor(3), {}, "attempt 3 connects fresh — the poisoned handle was cleared");
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// (h) Finding (flap) — a FLAPPING session (connect then immediate drop, repeatedly) is BOUNDED: the
//     retry budget is only refreshed after a minimum continuous uptime, so a session that never stays
//     up that long exhausts the cap and gives up (permanent loss) instead of reconnecting forever.
// ───────────────────────────────────────────────────────────────────────────────────────────────
describe("PLM4 (h) Finding flap: an immediately-dropping (flapping) session is bounded — it gives up at the cap", () => {
  let running: RunningServer;
  let client: WebSocket;
  let messages: any[];
  let scripted: ReturnType<typeof makeScriptedConnector>;
  let prevStable: string | undefined;

  before(async () => {
    // Make the stable-uptime threshold LARGE so a fast-flapping session never reaches it within the
    // test, proving the budget is NOT refreshed by a momentary connect. (The base suite's 30ms delay
    // keeps the flap loop fast.)
    prevStable = process.env.JANUS_RECONNECT_STABLE_UPTIME_MS;
    process.env.JANUS_RECONNECT_STABLE_UPTIME_MS = "100000";
    scripted = makeScriptedConnector(0); // every connect SUCCEEDS (so the session keeps re-minting)...
    serverMod.setLiveConnector(scripted.connector);
    serverMod.resetSessionAiFactory();
    running = await serverMod.startServer({ port: 0, enableVite: false });
    messages = [];
    client = await openClient(running, messages);
    await waitFor(() => scripted.sessions.length >= 1 && running._testActiveLiveSession?.());
  });

  after(async () => {
    if (prevStable === undefined) delete process.env.JANUS_RECONNECT_STABLE_UPTIME_MS;
    else process.env.JANUS_RECONNECT_STABLE_UPTIME_MS = prevStable;
    await closeClient(client);
    await teardownServerSuite(running);
  });

  it("a connect-then-immediately-drop loop exhausts the cap and broadcasts a permanent loss", async () => {
    // Each newly-minted session is dropped the instant it hoists. Because it never stays live for the
    // (huge) stable threshold, the budget is never refreshed -> after MAX_ATTEMPTS (=3) flaps it gives
    // up. We drive the flap by dropping every fresh session as it appears.
    let dropped = 0;
    const stop = { done: false };
    (async () => {
      let lastDroppedIndex = 0; // session0 is dropped to KICK OFF the first reconnect.
      while (!stop.done && dropped < 20) {
        const s = scripted.sessions[scripted.sessions.length - 1];
        if (s && !s.closed && scripted.sessions.length > lastDroppedIndex) {
          lastDroppedIndex = scripted.sessions.length;
          dropped++;
          try { s.emitClose({ code: 1006, reason: `flap drop #${dropped}` }); } catch { /* torn down */ }
        }
        await new Promise((r) => setTimeout(r, 5));
      }
    })();

    // BOUNDED: a permanent loss frame is eventually broadcast (the flap exhausted the retry budget),
    // proving the immediate-drop loop does NOT reconnect forever.
    const permanent = await waitFor(() => messages.find((m) => m.type === "voice_channel_lost" && m.permanent === true), 6000);
    stop.done = true;
    assert.strictEqual(permanent.reason, "reconnect_failed", "the flap gave up with the permanent reconnect-failed frame");
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// (i) Issue A — a 1007 "API key not valid" close is a CONFIG error, not a transient drop. Retrying
//     with the SAME unresolved key can only 1007 again, so it must NOT consume the bounded reconnect
//     budget (the boot-time 1007 cascade burned 3/6 attempts before recovering only on a reload).
//     It broadcasts a distinct key-problem loss and STOPS; recovery comes from the next client
//     connect after a valid key is configured.
// ───────────────────────────────────────────────────────────────────────────────────────────────
// ───────────────────────────────────────────────────────────────────────────────────────────────
// (j) 2S.5 — voice_channel_restored: a successful reconnect that FOLLOWS a broadcast loss announces
//     recovery with a `voice_channel_restored` frame. The FIRST connect (no prior loss on this client
//     connection) must NOT announce "restored" — the flag is armed only where voice_channel_lost is
//     broadcast, and disarmed on the restoring hoist.
// ───────────────────────────────────────────────────────────────────────────────────────────────
describe("2S.5: voice_channel_restored is broadcast on the reconnect that follows a loss", () => {
  let running: RunningServer;
  let client: WebSocket;
  let messages: any[];
  let scripted: ReturnType<typeof makeScriptedConnector>;

  before(async () => {
    scripted = makeScriptedConnector(0); // every connect succeeds.
    serverMod.setLiveConnector(scripted.connector);
    serverMod.resetSessionAiFactory();
    running = await serverMod.startServer({ port: 0, enableVite: false });
    messages = [];
    client = await openClient(running, messages);
    await waitFor(() => scripted.sessions.length >= 1 && running._testActiveLiveSession?.());
  });

  after(async () => {
    await closeClient(client);
    await teardownServerSuite(running);
  });

  it("the FIRST connect does NOT announce 'restored' (nothing was lost yet)", async () => {
    // The initial session is hoisted (awaited in before); give any (wrong) broadcast time to land.
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(
      messages.filter((m) => m.type === "voice_channel_restored").length,
      0,
      "no voice_channel_restored frame on the first connect",
    );
  });

  it("a drop followed by a successful reconnect broadcasts exactly one voice_channel_restored AFTER the loss", async () => {
    const session0 = scripted.sessions[scripted.sessions.length - 1]!;
    const sessionsBefore = scripted.sessions.length;
    session0.emitClose({ code: 1006, reason: "drop -> reconnect -> restored" });

    // The loss is announced, then the reconnect succeeds and announces the restoration.
    await waitFor(() => messages.find((m) => m.type === "voice_channel_lost"));
    await waitFor(() => scripted.sessions.length > sessionsBefore);
    const restored = await waitFor(() => messages.find((m) => m.type === "voice_channel_restored"));
    assert.ok(restored, "a voice_channel_restored frame was broadcast after the reconnect");

    // Ordering: the restored frame arrives AFTER the loss it answers.
    const lostIdx = messages.findIndex((m) => m.type === "voice_channel_lost");
    const restoredIdx = messages.findIndex((m) => m.type === "voice_channel_restored");
    assert.ok(restoredIdx > lostIdx, "voice_channel_restored follows voice_channel_lost");

    // Exactly ONE restored per loss — the flag disarms on the restoring hoist.
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(
      messages.filter((m) => m.type === "voice_channel_restored").length,
      1,
      "exactly one voice_channel_restored for one loss",
    );
  });

  it("a SECOND drop + reconnect announces a second restoration (the flag re-arms on each loss)", async () => {
    const session1 = scripted.sessions[scripted.sessions.length - 1]!;
    const sessionsBefore = scripted.sessions.length;
    session1.emitClose({ code: 1006, reason: "second drop -> second restored" });

    await waitFor(() => scripted.sessions.length > sessionsBefore);
    await waitFor(() => messages.filter((m) => m.type === "voice_channel_restored").length >= 2);
    assert.strictEqual(
      messages.filter((m) => m.type === "voice_channel_restored").length,
      2,
      "each loss earns exactly one restored announcement",
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// (k) 3V.1 — OVERLAPPING-CONNECT generation guards. Two connects can overlap (a bounded reconnect
//     attempt in flight + a settings-PUT reconnect nudge). The connection-scoped `state.session`
//     must only ever be assigned by the attempt that OWNS the current generation:
//     (i)  a SLOW stale connect resolving LAST must not capture mic routing — sendRealtimeInput
//          keeps targeting the FAST (live) session, and exactly one live session remains;
//     (ii) a STALE session's late onclose (handleSessionLost) must NOT detach the LIVE session's
//          approvals and must NOT schedule an extra reconnect (no third-session hoist).
// ───────────────────────────────────────────────────────────────────────────────────────────────
describe("3V.1 (i): the slow stale connect resolving LAST does not steal mic routing", () => {
  let running: RunningServer;
  let client: WebSocket;
  let messages: any[];
  let deferred: ReturnType<typeof makeDeferredConnector>;

  before(async () => {
    deferred = makeDeferredConnector();
    serverMod.setLiveConnector(deferred.connector);
    serverMod.resetSessionAiFactory();
    running = await serverMod.startServer({ port: 0, enableVite: false });
    messages = [];
    client = await openClient(running, messages);
    // Attempt 1 = the initial connect. Resolve it immediately so the nudge registers.
    await waitFor(() => deferred.state.connectCount >= 1);
    const session0 = deferred.resolveAttempt(1);
    await waitFor(() => running._testActiveLiveSession?.() === session0);
  });

  after(async () => {
    await closeClient(client);
    await teardownServerSuite(running);
  });

  it("mic frames route to the FAST/live session; the stale one is closed", async () => {
    const session0 = deferred.sessions[0];

    // Drop the live session -> the bounded reconnect schedules attempt 2 (left PENDING = "slow").
    session0.emitClose({ code: 1006, reason: "drop -> slow reconnect attempt" });
    await waitFor(() => deferred.state.connectCount >= 2);

    // While attempt 2 is still in flight, the settings-PUT reconnect nudge starts attempt 3
    // (activeLiveSession is null, the reconnect timer already fired -> a genuine overlap).
    serverMod.requestVoiceReconnect();
    await waitFor(() => deferred.state.connectCount >= 3);

    // The FAST attempt (3 — the newest generation) resolves FIRST and hoists.
    const fast = deferred.resolveAttempt(3);
    await waitFor(() => running._testActiveLiveSession?.() === fast);

    // The SLOW stale attempt (2) resolves LAST. The generation guard must close it WITHOUT
    // capturing the connection-scoped session the mic path writes to.
    const slow = deferred.resolveAttempt(2);
    await waitFor(() => slow.closed === true);

    // Exactly one live session remains: the fast one; the stale one is closed.
    assert.strictEqual(fast.closed, false, "the fast/live session stays open");
    assert.strictEqual(running._testActiveLiveSession?.(), fast, "the hoisted live session is the fast one");

    // MIC ROUTING: an operator audio frame must reach the FAST session, never the dead slow one.
    client.send(JSON.stringify({ type: "audio", audio: "QUJD" }));
    await waitFor(() => fast.realtimeInputs.length >= 1);
    assert.strictEqual(fast.realtimeInputs.length, 1, "mic frames reach the live (fast) session");
    assert.strictEqual(slow.realtimeInputs.length, 0, "NO mic frame is fed to the stale (closed) session");
  });
});

describe("3V.1 (ii): a STALE session's late onclose neither detaches live approvals nor reconnects", () => {
  let running: RunningServer;
  let client: WebSocket;
  let messages: any[];
  let deferred: ReturnType<typeof makeDeferredConnector>;

  before(async () => {
    deferred = makeDeferredConnector();
    serverMod.setLiveConnector(deferred.connector);
    serverMod.resetSessionAiFactory();
    running = await serverMod.startServer({ port: 0, enableVite: false });
    messages = [];
    client = await openClient(running, messages);
    await waitFor(() => deferred.state.connectCount >= 1);
    const session0 = deferred.resolveAttempt(1);
    await waitFor(() => running._testActiveLiveSession?.() === session0);
  });

  after(async () => {
    await closeClient(client);
    await teardownServerSuite(running);
  });

  it("the stale onclose is a no-op: approvals stay attached to the live session, no extra connect", async () => {
    const session0 = deferred.sessions[0];

    // Same overlap prelude as (i): drop -> slow attempt 2 pending -> nudge -> attempt 3 pending.
    session0.emitClose({ code: 1006, reason: "drop -> overlapping attempts" });
    await waitFor(() => deferred.state.connectCount >= 2);
    serverMod.requestVoiceReconnect();
    await waitFor(() => deferred.state.connectCount >= 3);

    // This time the STALE attempt (2) resolves FIRST — the generation guard closes it...
    const stale = deferred.resolveAttempt(2);
    await waitFor(() => stale.closed === true);
    // ...then the CURRENT attempt (3) resolves and hoists as the live session.
    const live = deferred.resolveAttempt(3);
    await waitFor(() => running._testActiveLiveSession?.() === live);

    // Stage an approval bound to the LIVE session.
    const approvals = running._testPendingApprovals!();
    const messageId = "stale-onclose-survivor";
    approvals.add(
      { messageId, instruction: "deploy to staging", kind: "shell", terminalId: "stale-pane", callId: messageId, timestamp: Date.now() } as any,
      live,
    );
    assert.strictEqual(approvals.sessionFor(messageId), live, "approval bound to the live session");

    // The SDK eventually fires onclose for the guard-closed stale session. That stale
    // handleSessionLost must be a NO-OP — not a detach of the live session's approvals, not a
    // voice_channel_lost, and not a scheduleReconnect hoisting a third session.
    const connectsBefore = deferred.state.connectCount; // 3
    const lostBefore = messages.filter((m) => m.type === "voice_channel_lost").length;
    stale.emitClose({ code: 1006, reason: "late stale onclose" });

    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(approvals.sessionFor(messageId), live, "the LIVE session's approval was NOT detached by the stale onclose");
    assert.strictEqual(running._testActiveLiveSession?.(), live, "the live hoist survives the stale onclose");
    assert.strictEqual(deferred.state.connectCount, connectsBefore, "no extra reconnect attempt was scheduled by the stale onclose");
    assert.strictEqual(
      messages.filter((m) => m.type === "voice_channel_lost").length,
      lostBefore,
      "no voice_channel_lost was broadcast for the stale session",
    );

    approvals.delete(messageId);
  });
});

describe("Issue A: a 1007 (invalid/missing API key) close does NOT consume the reconnect budget", () => {
  let running: RunningServer;
  let client: WebSocket;
  let messages: any[];
  let scripted: ReturnType<typeof makeScriptedConnector>;

  before(async () => {
    scripted = makeScriptedConnector(0); // initial connect succeeds.
    serverMod.setLiveConnector(scripted.connector);
    serverMod.resetSessionAiFactory();
    running = await serverMod.startServer({ port: 0, enableVite: false });
    messages = [];
    client = await openClient(running, messages);
    await waitFor(() => scripted.sessions.length >= 1 && running._testActiveLiveSession?.());
  });

  after(async () => {
    await closeClient(client);
    await teardownServerSuite(running);
  });

  it("closes with code=1007 -> broadcasts a key-problem loss and schedules NO reconnect", async () => {
    const connectsBefore = scripted.state.connectCount; // 1 (the initial success).
    // Arm failures so that IF a reconnect were (wrongly) attempted, connectCount would climb.
    scripted.state.failuresRemaining = 1000;

    scripted.sessions[0].emitClose({ code: 1007, reason: "API key not valid. Please pass a valid API key." });

    // The loss frame names the key problem (no key configured in this tmp cwd -> "no_api_key";
    // a configured-but-rejected key in prod -> "invalid_api_key"). It is NOT the permanent frame.
    const lost = await waitFor(() => messages.find(
      (m) => m.type === "voice_channel_lost" && (m.reason === "no_api_key" || m.reason === "invalid_api_key")));
    assert.ok(lost, "a voice_channel_lost frame naming the key problem was broadcast");
    assert.notStrictEqual(lost.permanent, true, "a 1007 is not the permanent reconnect-failed frame");

    // CRITICAL: no reconnect attempt fired — the bounded budget was NOT spent on an unfixable 1007.
    // (That a transient 1006 close DOES still reconnect is proven by suites (a)/(b)/(c)/(h) above —
    // the 1007 guard is narrow and does not over-broaden onto other close codes.)
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(scripted.state.connectCount, connectsBefore, "a 1007 close consumes NO reconnect attempt");
  });
});
