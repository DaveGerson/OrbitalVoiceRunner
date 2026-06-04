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

import { setLiveConnector } from "../../server";

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
  close: () => void;
}

export interface MockLiveHandle {
  sessions: MockLiveSession[];
  latest: () => MockLiveSession | undefined;
  /** Find the most recent tool response the server emitted for a given call id. */
  responseFor: (callId: string) => any | undefined;
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
