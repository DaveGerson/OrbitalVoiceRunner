// tests/helpers/traceReplay.ts — BEAD wsm-e2e-pinned-arkr deliverable 2: replay driver for raw
// Gemini Live capture traces (the `{ts, seq, message}` lines src/voice/liveTraceCapture.ts writes).
//
// Composes with the mockLive harness the SAME way tests/helpers/convoScript.ts does: it drives a
// MockLiveSession's real `.emit()` (tests/helpers/mockLive.ts), which pushes each message through
// the server's REAL onmessage dispatcher — no synthetic reinterpretation, just replaying exactly
// what a raw capture recorded. Unlike convoScript (a hand-authored step DSL), a trace's steps are
// data already — so this module is a thin loader + a driver, not a builder.

import fs from "fs";
import type { MockLiveSession } from "./mockLive";

export interface TraceEntry {
  ts: number;
  seq: number;
  message: unknown;
}

export interface ReplayOptions {
  /** When true, delay between successive emits to mirror the ORIGINAL inter-message timing (the
   *  deltas between consecutive `ts` values). Default false: replay as fast as possible (the
   *  overwhelmingly common case — tests assert on outcome, not wall-clock cadence). */
  honorTiming?: boolean;
  /** Divides the honored delay (>1 replays faster than real time, <1 slower). Ignored when
   *  honorTiming is false. Default 1 (real-time cadence). */
  speed?: number;
}

/**
 * Parse a trace `.jsonl` file's raw text into ordered entries. Pure; throws on a genuinely
 * malformed file (a trace fixture is committed data — a parse failure there is a real bug, not
 * something to silently paper over the way the capture tap's fail-soft writes are).
 */
export function parseTraceText(rawText: string): TraceEntry[] {
  return rawText
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as TraceEntry);
}

/** Load + parse a trace `.jsonl` file from disk. */
export function loadTrace(filePath: string): TraceEntry[] {
  return parseTraceText(fs.readFileSync(filePath, "utf8"));
}

/**
 * Replay `entries` through `session.emit()`, in order. Each entry's `message` is the RAW envelope
 * exactly as captured — emitted unmodified, so the server's real onmessage dispatcher sees exactly
 * what production saw. `session.emit()` runs the dispatcher synchronously up to its first await
 * (see the comment on runConvoScenario in convoScript.ts), so by default this drains the whole
 * trace with no artificial delay between messages.
 */
export async function replayTrace(
  session: MockLiveSession,
  entries: TraceEntry[],
  opts: ReplayOptions = {}
): Promise<void> {
  const { honorTiming = false, speed = 1 } = opts;
  let prevTs: number | null = null;
  for (const entry of entries) {
    if (honorTiming && prevTs !== null) {
      const deltaMs = Math.max(0, entry.ts - prevTs) / speed;
      if (deltaMs > 0) await new Promise((resolve) => setTimeout(resolve, deltaMs));
    }
    session.emit(entry.message);
    prevTs = entry.ts;
  }
}

/** Convenience one-shot: load a trace file from disk, then replay it through `session`. */
export async function replayTraceFile(
  session: MockLiveSession,
  filePath: string,
  opts?: ReplayOptions
): Promise<void> {
  await replayTrace(session, loadTrace(filePath), opts);
}
