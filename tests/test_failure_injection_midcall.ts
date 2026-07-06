// tests/test_failure_injection_midcall.ts — bead res5, injection family (a): kill the mock Gemini
// Live session WHILE a tool-call is in flight (as distinct from between turns / mid-connection,
// which PLM4/QW3 already cover — see tests/test_session_reconnect.ts, tests/test_session_drop_minimal.ts).
//
// THE GENUINE GAP (recon): no existing suite drops the session BETWEEN a tool call's synchronous
// handler side effect and the async continuation that answers it (audit write, sendToolResponse).
// runToolCall's chain (onmessage -> handleToolCalls -> runToolCall -> runAction -> invokeHandler ->
// raceDeadline) invokes `def.handler(args, ctx)` SYNCHRONOUSLY inside the FIRST `new Promise` — so by
// the time `session.emitToolCall(...)` returns to test code, the durable side effect (the ledger note)
// has ALREADY landed, but the emitAudit() action_log write and session.sendToolResponse() are still
// queued as suspended continuations. Calling `session.emitClose(...)` in the SAME synchronous tick (no
// `await` in between) drops the session in that exact window — before the model was ever told the call
// succeeded.
//
// This proves three things, end to end, against the REAL production seams (no mocks below the
// FakeSession/live-connector boundary):
//   1. The handler's side effect lands EXACTLY ONCE (the kill does not re-run or lose it).
//   2. `handleSessionLost` (src/voice/index.ts) recovers cleanly — no throw, no unhandled rejection,
//      voice_channel_lost is broadcast, and the bounded reconnect hoists a fresh session.
//   3. If Gemini re-delivers the SAME call.id on the reconnected session (a plausible resume replay
//      of an unacknowledged call), the PLM4(3)/wsm-e2e-pinned-smz replay guard suppresses it — the
//      action does NOT double-fire (no second ledger note, no second "ok" action_log row).
//
// Idiom: in-proc startServer({port:0}) + setLiveConnector (mirrors tests/test_session_reconnect.ts).
// No sleeps on the pass path; every wait is a waitFor poll.

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";
import { JanusStore } from "../src/store/sqliteStore";
import { teardownServerSuite } from "./helpers/teardown";
import type { RunningServer } from "../server";

interface FakeSession {
  params: any;
  responses: any[];
  closed: boolean;
  emit: (m: any) => void;
  emitToolCall: (name: string, args?: Record<string, any>, id?: string) => string;
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
    closed: false,
    emit(m: any) { params?.callbacks?.onmessage?.(m); },
    emitToolCall(name: string, args: Record<string, any> = {}, id?: string) {
      const callId = id ?? `midcall-${++counter}`;
      this.emit({ toolCall: { functionCalls: [{ name, id: callId, args }] } });
      return callId;
    },
    emitClose(info: any = { code: 1006, reason: "fake live socket closed" }) { params?.callbacks?.onclose?.(info); },
    sendToolResponse(r: any) { this.responses.push(r); },
    sendRealtimeInput() {},
    sendClientContent() {},
    close() { this.closed = true; },
  };
  return s;
}

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
let dbPath: string;

before(async () => {
  process.env.NODE_ENV = "test";
  process.env.JANUS_NO_AUTOSTART = "1";
  process.env.JANUS_RECONNECT_MAX_ATTEMPTS = "3";
  process.env.JANUS_RECONNECT_BASE_DELAY_MS = "20";
  process.env.JANUS_RECONNECT_MAX_DELAY_MS = "60";

  prevCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-midcall-"));
  dbPath = path.join(tmpDir, "midcall.db");
  process.env.JANUS_DB = dbPath;
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

describe("res5(a): killing the mock live session MID-TOOL-CALL recovers cleanly and never double-fires", () => {
  let running: RunningServer;
  let client: WebSocket;
  let messages: any[];
  let scripted: ReturnType<typeof makeScriptedConnector>;
  let seedStore: JanusStore;
  const unhandled: any[] = [];
  const onUnhandled = (e: any) => unhandled.push(e);

  before(async () => {
    process.on("unhandledRejection", onUnhandled);
    scripted = makeScriptedConnector(0); // initial connect succeeds.
    serverMod.setLiveConnector(scripted.connector);
    running = await serverMod.startServer({ port: 0, enableVite: false });
    messages = [];
    client = await openClient(running, messages);
    await waitFor(() => scripted.sessions.length >= 1 && running._testActiveLiveSession?.());
    seedStore = new JanusStore(dbPath);
    seedStore.init();
  });

  after(async () => {
    process.off("unhandledRejection", onUnhandled);
    try { seedStore.close(); } catch { /* best-effort */ }
    await closeClient(client);
    await teardownServerSuite(running);
  });

  function rowsForKey(key: string): { kind: string }[] {
    return seedStore.getActionLog({ limit: 1000 }).filter((r) => r.idempotency_key === key).map((r) => ({ kind: r.result_kind }));
  }

  it("the handler's side effect lands exactly once and the session-lost path recovers without throwing", async () => {
    const session0 = scripted.sessions[scripted.sessions.length - 1]!;
    const key = "midcall-note-1";
    scripted.state.failuresRemaining = 0; // the reconnect must succeed immediately.
    const sessionsBefore = scripted.sessions.length;

    // Fire the tool call and drop the session in the SAME synchronous tick (no await between them) —
    // the handler's synchronous side effect has already run (see file header), but the audit write and
    // sendToolResponse are still suspended continuations when handleSessionLost fires inline.
    session0.emitToolCall("add_project_note", { project_id: "default_project", note: "mid-call note" }, key);
    session0.emitClose({ code: 1006, reason: "res5(a): kill mid-tool-call" });

    // (1) The note landed exactly once — the kill did not lose or duplicate the side effect.
    await waitFor(() => seedStore.getNotes({ projectId: "default_project" }).some((n) => n.text === "mid-call note"));
    const notes = seedStore.getNotes({ projectId: "default_project" }).filter((n) => n.text === "mid-call note");
    assert.strictEqual(notes.length, 1, "the ledger note was written exactly once despite the mid-flight kill");

    // (2) Exactly one succeeded action_log row for this call — no duplicate "ok".
    await waitFor(() => rowsForKey(key).length >= 1);
    assert.deepStrictEqual(rowsForKey(key).map((r) => r.kind), ["ok"], "exactly one succeeded audit row for the in-flight call");

    // (3) The session-lost path recovered: a fresh session was hoisted (bounded reconnect fired).
    const session1 = await waitFor(() => {
      const s = scripted.sessions[scripted.sessions.length - 1];
      return scripted.sessions.length > sessionsBefore && s !== session0 ? s : undefined;
    });
    await waitFor(() => running._testActiveLiveSession!() === session1);
    assert.notStrictEqual(session1, session0, "the reconnect minted a fresh session");

    // (4) No unhandled rejection escaped handleSessionLost while the in-flight continuation was
    // still suspended — the try/catch wrapper around doHandleSessionLost held.
    await new Promise((r) => setTimeout(r, 100));
    assert.deepStrictEqual(unhandled, [], "handleSessionLost did not raise an unhandled rejection mid-tool-call");

    // (5) The frontend was told the channel dropped (the operator-visible half of the recovery).
    assert.ok(messages.some((m) => m.type === "voice_channel_lost"), "voice_channel_lost was broadcast to the operator");
  });

  it("a re-delivered SAME call.id on the reconnected session does NOT double-fire the action", async () => {
    const session1 = running._testActiveLiveSession!() as unknown as FakeSession;
    const key = "midcall-note-1"; // the SAME key the prior test's in-flight call used.

    const notesBefore = seedStore.getNotes({ projectId: "default_project" }).filter((n) => n.text === "mid-call note").length;
    assert.strictEqual(notesBefore, 1, "sanity: exactly one note exists before the replay");

    // Gemini resumes and re-delivers the call it never got acknowledged for.
    session1.emitToolCall("add_project_note", { project_id: "default_project", note: "mid-call note" }, key);

    const resp = await waitFor(() => {
      const fr = session1.responses.flatMap((r) => r.functionResponses ?? []).find((f) => f.id === key);
      return fr ? fr.response?.output : undefined;
    });
    assert.match(String(resp), /already handled/i, "the replayed call is short-circuited, not re-run");

    // A second row appears (the replay_suppressed audit marker), but NOT a second "ok" — and the
    // ledger note count is UNCHANGED — the action truly did not double-fire.
    await waitFor(() => rowsForKey(key).length >= 2);
    assert.deepStrictEqual(
      rowsForKey(key).map((r) => r.kind).sort(),
      ["ok", "replay_suppressed"],
      "the pre-existing 'ok' row is untouched; only a suppression marker was added",
    );
    const notesAfter = seedStore.getNotes({ projectId: "default_project" }).filter((n) => n.text === "mid-call note").length;
    assert.strictEqual(notesAfter, 1, "the ledger note count is unchanged — the replay never re-ran the handler");
  });
});
