// src/voice/liveTraceCapture.ts — BEAD wsm-e2e-pinned-arkr deliverable 1: the raw Gemini Live
// capture tap.
//
// WHY: today's interaction log (interactionLog.log) records only DERIVED legs (gemini_thinking,
// gemini_text, …) — the server's own interpretation of a message, AFTER extractTranscripts/
// appendThinkingFragment have already thrown away the raw envelope shape (fragment cadence,
// turnComplete vs generationComplete timing, the unused Transcription.finished flag, …). That makes
// production message-shape drift invisible to tests. This tap sits at the live-connector boundary —
// wrapping the `onmessage` callback passed to `boundLiveConnector` in src/voice/index.ts — and, ONLY
// when opted in, appends every raw inbound `LiveServerMessage` verbatim (as `{ts, seq, message}`)
// to a per-session `.jsonl` file BEFORE the message reaches normal processing.
//
// OFF BY DEFAULT: gated by `JANUS_CAPTURE_LIVE_TRACES=1`, resolved from `process.env` ONCE per
// connection (createLiveTraceWriter is called once per WS connect, not per message) — so the
// steady-state hot-path cost when disabled is a single already-paid env lookup, not a per-message
// branch into fs. Disabled callers get a true no-op capture() (a plain arrow that touches nothing).
//
// FAIL-SOFT: a write error (disk full, permissions, a torn-down process) must NEVER break the voice
// session — every fs call here is try/caught and swallowed. Capture is diagnostic infrastructure;
// it must never become a NEW way for voice to break.
//
// .janus_traces/ is UNREDACTED raw operator/model speech + tool args — see .gitignore (never
// committed directly) and scripts/redact-trace.mjs (the only sanctioned path to something safe to
// commit) + docs/process/LIVE_TRACE_CAPTURE.md (the operator workflow).

import fs from "fs";
import path from "path";

export interface LiveTraceWriter {
  /** Append one raw inbound message to the trace file (no-op, and free, when capture is disabled). */
  capture: (message: unknown) => void;
}

const CAPTURE_ENV_VAR = "JANUS_CAPTURE_LIVE_TRACES";
const DEFAULT_TRACE_DIR = ".janus_traces";

const NOOP_WRITER: LiveTraceWriter = { capture: () => {} };

/**
 * Resolve whether capture is enabled and, if so, mint a writer bound to one trace file for this
 * connection. Called ONCE per WS connection (src/voice/index.ts, alongside the rest of the
 * per-connection state) — NOT per message. `sessionId` should be the connection's stable
 * `state.voiceSessionId`; a falsy id falls back to a timestamp so the file always has a name.
 *
 * Fail-soft at mint time too: if the directory can't be created (permissions, read-only fs, …) this
 * degrades to the no-op writer rather than throwing out of a connection-setup path.
 */
export function createLiveTraceWriter(
  sessionId: string | null | undefined,
  opts?: { dir?: string; env?: NodeJS.ProcessEnv }
): LiveTraceWriter {
  const env = opts?.env ?? process.env;
  if (env[CAPTURE_ENV_VAR] !== "1") return NOOP_WRITER;

  const dir = opts?.dir ?? DEFAULT_TRACE_DIR;
  const fileName = `${sessionId || Date.now()}.jsonl`;
  let filePath: string;
  try {
    fs.mkdirSync(dir, { recursive: true });
    filePath = path.join(dir, fileName);
  } catch {
    return NOOP_WRITER; // fail-soft: never let a directory-create failure break connect.
  }

  let seq = 0;
  return {
    capture(message: unknown) {
      try {
        const line = JSON.stringify({ ts: Date.now(), seq: seq++, message }) + "\n";
        fs.appendFileSync(filePath, line);
      } catch {
        // fail-soft: a write error must never break the voice session.
      }
    },
  };
}

/**
 * Wrap an `onmessage` callback so the raw message is captured (via `writer`) BEFORE the real
 * handler runs. Composes at the live-connector boundary: `boundLiveConnector({ callbacks: {
 * onmessage: wrapOnMessageWithCapture(realOnMessage, writer) } })`. When `writer` is the disabled
 * no-op, this adds one extra (empty) function call per message — negligible, and still gated by the
 * single env check baked into `writer` at connect time.
 */
export function wrapOnMessageWithCapture<T, R>(
  onmessage: (message: T) => R,
  writer: LiveTraceWriter
): (message: T) => R {
  return (message: T) => {
    writer.capture(message);
    return onmessage(message);
  };
}
