// Mock Gemini Live harness.
//
// The real server creates its voice session via the injectable `liveConnector`
// seam in server.ts. This helper swaps in a fake session that records everything
// the server sends it (tool responses, realtime audio) and lets a caller *push*
// synthetic server->client messages (transcripts, audio, tool calls) back into
// the server's real `onmessage` handler.
//
// Net effect: the entire voice -> tool-dispatch -> approval pipeline runs with no
// Gemini API key and no microphone, exercising the genuine server code paths.
//
// bead c1ky/1p84 — loadMockLive(): this file used to STATICALLY value-import ../../server, which
// made it the sole ~40-file drag root for server.ts's (formerly eager) module-scope boot: every
// test that imported this helper evaluated server.ts at MODULE LOAD time, before any hook could
// set JANUS_NO_AUTOSTART or chdir into a tmpdir (bxpk). It is now a DEFERRED, memoized loader:
//   - JANUS_NO_AUTOSTART=1 is set at module top (cheap, has no import-order dependency).
//   - JANUS_DB, if not already set by the caller, is pointed at a STABLE scratch root — a single
//     mkdtemp'd directory OUTSIDE the repo checkout AND outside any per-suite tmpdir. Without this,
//     the process-wide JanusStore singleton (opened once, at the FIRST post-chdir dynamic import)
//     roots itself inside whichever suite's tmpdir happened to import first; that suite's
//     afterEach then rmSync's the directory out from under the still-open sqlite handle — on
//     Windows this fails silently and leaks a tmpdir every run (1p84).
//   - THEN server.ts is imported, via top-level await, so existing call sites
//     (`await import("./helpers/mockLive")`) and the synchronous `installMockLive()` keep working
//     unchanged.
// An explicit JANUS_DB set by the caller BEFORE the first load (e.g. tests/test_boot_quarantine.ts
// pointing at its own seeded db) is NEVER overwritten.

import path from "node:path";
import fs from "node:fs";
import os from "node:os";

process.env.JANUS_NO_AUTOSTART = "1";
if (!process.env.JANUS_DB) {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-mocklive-store-"));
  process.env.JANUS_DB = path.join(scratchDir, ".janus.db");
}

const { setLiveConnector } = await import("../../server");

/**
 * Preferred entry point (bead c1ky insight b): await this before using installMockLive()/
 * setLiveConnector to make the deferred-load + env-guard contract explicit at the call site,
 * rather than relying on side effects of this module merely being imported. Memoized — the
 * module-top env guard above only ever runs once per process regardless of how many times this
 * (or a plain `import`) is used.
 */
export async function loadMockLive(): Promise<{
  installMockLive: typeof installMockLive;
  waitFor: typeof waitFor;
  setLiveConnector: typeof setLiveConnector;
}> {
  return { installMockLive, waitFor, setLiveConnector };
}

export interface MockLiveSession {
  /** The exact params object the server passed to live.connect (model, config, callbacks). */
  params: any;
  /** Tool responses the server sent back to the model, in order. */
  responses: any[];
  /** Realtime inputs (mic audio frames) the server forwarded to the model. */
  realtimeInputs: any[];
  closed: boolean;
  /** Push a synthetic server->client message into the server's real onmessage handler. */
  emit: (message: any) => void;
  /** Convenience: emit a single tool call and return the messageId/callId used. */
  emitToolCall: (name: string, args?: Record<string, any>, id?: string) => string;
  /** QW3: simulate the Gemini Live socket erroring out (invokes params.callbacks.onerror). */
  emitError: (err?: any) => void;
  /** QW3: simulate the Gemini Live socket closing from the server side (invokes onclose). */
  emitClose: (info?: any) => void;
  sendToolResponse: (r: any) => void;
  sendRealtimeInput: (i: any) => void;
  /** Client-content pushes the server sent (approval narration, B1 spawn acks, pane signals), in order. */
  clientContents: any[];
  sendClientContent: (c: any) => void;
  close: () => void;
}

export interface MockLiveHandle {
  sessions: MockLiveSession[];
  latest: () => MockLiveSession | undefined;
  /** Find the most recent tool response the server emitted for a given call id. */
  responseFor: (callId: string) => any | undefined;
  /**
   * Like responseFor, but returns the FULL `response` object instead of `.output`. Needed for
   * structured non-ok responses that carry no `output` key — e.g. propose_command's HiTL answer
   * `{ status: "pending_approval", messageId, pane_id, prompt }` (src/actions/gemini.ts voiceResponse).
   */
  rawResponseFor: (callId: string) => any | undefined;
  reset: () => void;
}

let counter = 0;

export function installMockLive(): MockLiveHandle {
  const sessions: MockLiveSession[] = [];

  setLiveConnector(async (_ai, params) => {
    const session: MockLiveSession = {
      params,
      responses: [],
      realtimeInputs: [],
      closed: false,
      emit(message: any) {
        params?.callbacks?.onmessage?.(message);
      },
      emitToolCall(name: string, args: Record<string, any> = {}, id?: string) {
        const callId = id ?? `mock-call-${++counter}`;
        this.emit({ toolCall: { functionCalls: [{ name, id: callId, args }] } });
        return callId;
      },
      emitError(err: any = new Error("mock live socket error")) {
        params?.callbacks?.onerror?.(err);
      },
      emitClose(info: any = { code: 1006, reason: "mock live socket closed" }) {
        params?.callbacks?.onclose?.(info);
      },
      sendToolResponse(r: any) {
        this.responses.push(r);
      },
      sendRealtimeInput(i: any) {
        this.realtimeInputs.push(i);
      },
      clientContents: [],
      // The real Gemini Live session exposes sendClientContent (user-role pushes the model speaks then
      // stops): approval narration, B1 two-phase spawn acks, and pane-status signals all route through
      // it. Capturing it (a) keeps the test console clean (no caught "is not a function" noise) and (b)
      // lets a test assert the pushed ack text.
      sendClientContent(c: any) {
        this.clientContents.push(c);
      },
      close() {
        this.closed = true;
      },
    };
    sessions.push(session);
    return session;
  });

  return {
    sessions,
    latest: () => sessions[sessions.length - 1],
    responseFor(callId: string) {
      for (let s = sessions.length - 1; s >= 0; s--) {
        for (let r = sessions[s].responses.length - 1; r >= 0; r--) {
          const fr = sessions[s].responses[r]?.functionResponses?.[0];
          if (fr?.id === callId) return fr.response?.output;
        }
      }
      return undefined;
    },
    rawResponseFor(callId: string) {
      for (let s = sessions.length - 1; s >= 0; s--) {
        for (let r = sessions[s].responses.length - 1; r >= 0; r--) {
          const fr = sessions[s].responses[r]?.functionResponses?.[0];
          if (fr?.id === callId) return fr.response;
        }
      }
      return undefined;
    },
    reset() {
      sessions.length = 0;
    },
  };
}

/** Poll `predicate` until it returns truthy or `timeoutMs` elapses. */
export async function waitFor<T>(
  predicate: () => T | undefined | false,
  timeoutMs = 2000,
  intervalMs = 20
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = predicate();
    if (v) return v;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
