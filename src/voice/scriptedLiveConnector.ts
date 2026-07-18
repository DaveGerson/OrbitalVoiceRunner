// src/voice/scriptedLiveConnector.ts — BEAD wsm-e2e-pinned-s1ap.
//
// Production-source twin of tests/helpers/mockLive.ts's installMockLive(): a real LiveConnector
// (see setLiveConnector in server.ts) that answers a live-voice connect in-process — no Gemini API
// key, no network socket to Google. Unlike the test helper, this one is reachable from a RUNNING
// server process: the Playwright "scripted" e2e lane (npm run test:e2e:scripted) drives the REAL
// browser -> /live WS -> this connector path end-to-end, feeding synthetic Gemini envelopes in via
// the server.ts control channel (registerScriptedLiveControlRoutes), which drives the current
// session through emitToScriptedSession/closeScriptedSession below. Net effect: the entire voice pipe — browser,
// real WS auth, real tool-dispatch/approval code — runs with no API key and no microphone.
//
// SECURITY — read before touching this file: installScriptedLiveConnector() must NEVER run outside
// the JANUS_MOCK_LIVE=1 dev/test gate (isScriptedLiveModeEnabled — server.ts's boot call site and
// the control-channel route registration BOTH re-derive this independently from process.env, so the
// two enforcement layers can never drift out of sync with each other). If this connector were ever
// wired up in a network-reachable production process, the control channel is a voice-injection
// backdoor: any peer that could reach it could feed arbitrary tool-call envelopes straight into the
// live approval pipeline. Treat every layer here as load-bearing, not decorative.
//
// DEPENDENCY DIRECTION: this module deliberately does NOT value-import anything from "../../server"
// (only `import type`, fully erased at compile time under isolatedModules) — src/voice/* never
// reaches back into server.ts by value, mirroring the dec-5 seam contract src/voice/index.ts already
// documents for its own deps bag ("Imported registry/dispatch surface (passed in, not imported...)").
// installScriptedLiveConnector takes the setter as a parameter; server.ts supplies its OWN
// setLiveConnector at the one call site inside startServer(), before that server's boundLiveConnector
// snapshot is taken (see the comment at that call site — ordering there is load-bearing).

import type { LiveConnector, LiveSession } from "../../server";
import { isLoopbackAddress } from "../security/perimeter";

/** A scripted session mirrors tests/helpers/mockLive.ts's MockLiveSession shape (params/emit/
 *  responses/...) so the same emit()-driven test idiom that already exercises the real onmessage
 *  handler in-process also works against a REAL running server over HTTP, not just headless unit
 *  tests. */
export interface ScriptedLiveSession extends LiveSession {
  /** The exact params object the server passed to live.connect (model, callbacks). */
  params: any;
  /** Tool responses the server sent back to the model, in order (recorded, not replayed). */
  responses: any[];
  /** Realtime inputs (mic audio frames) the server forwarded to the model (recorded, not replayed). */
  realtimeInputs: any[];
  /** sendClientContent pushes the server made (approval narration, spawn acks, ...), in order. */
  clientContents: any[];
  closed: boolean;
  /** Push a synthetic server->client message into the server's REAL onmessage handler. This is what
   *  the control channel's POST /__scripted_live__/emit calls. */
  emit: (message: unknown) => void;
}

/** Single source of truth for the gate: exact-string flag AND never in production. Both enforcement
 *  layers that consult the FLAG (server.ts's boot install call site and the control-channel route
 *  registration) call THIS — neither re-derives the condition inline — so they cannot silently drift
 *  apart. (The per-request check inside each route handler is the separate LOOPBACK fence, not a
 *  flag re-check: when the flag is off the routes are never registered at all.) */
export function isScriptedLiveModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.JANUS_MOCK_LIVE === "1" && env.NODE_ENV !== "production";
}

/** Pure re-check wrapper around isLoopbackAddress, named for this feature so the control channel's
 *  fence is directly unit-testable without booting a server or opening a socket (gating test (d)). */
export function isScriptedLiveRequestAllowed(remoteAddress: string | undefined | null): boolean {
  return isLoopbackAddress(remoteAddress);
}

let currentSession: ScriptedLiveSession | null = null;

function buildScriptedSession(params: any): ScriptedLiveSession {
  const session: ScriptedLiveSession = {
    params,
    responses: [],
    realtimeInputs: [],
    clientContents: [],
    closed: false,
    emit: (message: unknown) => {
      params?.callbacks?.onmessage?.(message);
    },
    sendToolResponse: (r: any) => {
      session.responses.push(r);
    },
    sendRealtimeInput: (i: any) => {
      session.realtimeInputs.push(i);
    },
    sendClientContent: (c: any) => {
      session.clientContents.push(c);
    },
    close: () => {
      session.closed = true;
    },
  };
  return session;
}

/** The connector itself: answers ai.live.connect(params) with an in-process ScriptedLiveSession,
 *  IGNORING the resolved key entirely (the LiveConnector 3rd arg) — this is HOW the scripted lane
 *  connects with zero Gemini API key, exactly like installMockLive()'s connector. */
const scriptedConnector: LiveConnector = async (_ai, params) => {
  const session = buildScriptedSession(params);
  currentSession = session;
  return session;
};

/** Install the scripted connector via the caller-supplied setter (see "DEPENDENCY DIRECTION" above).
 *  Callers MUST gate this call on isScriptedLiveModeEnabled() — this function does not re-check its
 *  own activation (server.ts's boot call site is the sole call site and already gates), but it DOES
 *  log the loud boot banner unconditionally on every call, so an ungated call would still announce
 *  itself rather than fail silently. */
export function installScriptedLiveConnector(setConnector: (fn: LiveConnector) => void): void {
  currentSession = null;
  setConnector(scriptedConnector);
  // Loud and unmistakable: anyone tailing or grepping boot logs sees this instantly.
  console.warn(
    "\n" +
      "############################################################\n" +
      "# JANUS_MOCK_LIVE=1 -- SCRIPTED GEMINI LIVE CONNECTOR ACTIVE #\n" +
      "# The real /live voice socket is answered by an in-process   #\n" +
      "# script, NOT Gemini. Control channel: POST                  #\n" +
      "# /__scripted_live__/emit and /__scripted_live__/close        #\n" +
      "# (loopback-only). NEVER run this with NODE_ENV=production    #\n" +
      "# or on a network-reachable bind host.                        #\n" +
      "############################################################\n"
  );
}

/** Shape both control-channel handlers return so server.ts's route wiring stays a thin translation
 *  to an HTTP status + JSON body, with the actual decision logic unit-testable in isolation here. */
export interface ScriptedControlResult {
  ok: boolean;
  status: number;
  error?: string;
}

/** POST /__scripted_live__/emit's business logic, decoupled from Express so it is directly testable
 *  (gating test (c)) without booting a real HTTP round-trip if that is ever preferred. */
export function emitToScriptedSession(message: unknown): ScriptedControlResult {
  const session = currentSession;
  if (!session) return { ok: false, status: 409, error: "no scripted live session is connected yet" };
  if (message === undefined || message === null || typeof message !== "object") {
    return { ok: false, status: 400, error: "expected { message: <LiveServerMessage envelope> } with an object message" };
  }
  session.emit(message);
  return { ok: true, status: 200 };
}

/** POST /__scripted_live__/close's business logic — simulates the Gemini socket dropping (fires the
 *  session's onclose) so channel-lost scenarios are drivable from the browser lane. */
export function closeScriptedSession(info: unknown): ScriptedControlResult {
  const session = currentSession;
  if (!session) return { ok: false, status: 409, error: "no scripted live session is connected yet" };
  session.params?.callbacks?.onclose?.(info ?? { code: 1006, reason: "scripted live socket closed" });
  session.closed = true;
  return { ok: true, status: 200 };
}
