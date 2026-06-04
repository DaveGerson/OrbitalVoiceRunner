// src/interactionLog.ts — correlated interaction log.
//
// PURPOSE: comprehensively capture and ASSOCIATE one operator interaction's legs under a single
// interaction_id so voice transcription, Gemini's thinking/narration, the actions taken, and the
// resulting system/PTY output can be analyzed TOGETHER (see scripts/analyze-interactions.ts). This
// is also the instrumentation for Issue #1 (the approve→dispatch lag): every leg carries a `ts`, so
// the timeline of a turn shows exactly where latency lives.
//
// Each leg is ONE line of JSON (JSONL): greppable, tailable, append-only. Secrets are redacted per
// field BEFORE serialization (so a redaction replacement can never corrupt the JSON). The writer is
// sink-injected so the hot logic is unit-tested without disk; createFileInteractionSink() is the
// production sink (synchronous append — durable across a crash; the legs are low-frequency).

import fs from "node:fs";

export type InteractionLegKind =
  | "voice_in" // operator speech (ASR / input transcription)
  | "gemini_text" // model spoken text (modelTurn parts)
  | "gemini_thinking" // model output transcription / narration channel
  | "tool_call" // a Gemini functionCall the model emitted
  | "action_result" // the runAction result (kind + latency)
  | "approval" // an approval / rejection decision
  | "pty" // terminal output attributed to (or co-temporal with) the turn
  | "system"; // server lifecycle / error breadcrumb

export interface InteractionLeg {
  interactionId: string;
  kind: InteractionLegKind;
  paneId?: string | null;
  text?: string;
  /** Structured payload (redacted recursively). Keep it small; this is a log, not a store. */
  data?: Record<string, unknown>;
}

export interface InteractionLoggerOptions {
  /** Where one JSON line goes (file append in prod; array push in tests). */
  sink: (line: string) => void;
  /** Applied to `text` and every string leaf in `data` before serialization. Identity if omitted. */
  redact?: (s: string) => string;
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
}

/** Recursively apply `redact` to every string leaf of a JSON-ish value; non-strings pass through. */
export function redactDeep(value: unknown, redact: (s: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v, redact);
    return out;
  }
  return value;
}

export class InteractionLogger {
  private seq = 0;
  private readonly sink: (line: string) => void;
  private readonly redact: (s: string) => string;
  private readonly now: () => number;

  constructor(opts: InteractionLoggerOptions) {
    this.sink = opts.sink;
    this.redact = opts.redact ?? ((s) => s);
    this.now = opts.now ?? (() => Date.now());
  }

  /** Mint a fresh, process-unique interaction id (one per operator turn). */
  mint(): string {
    return `ixn_${this.now().toString(36)}_${(this.seq++).toString(36)}`;
  }

  /** Append one redacted JSON line for a leg. Best-effort: a sink fault never throws to the caller. */
  log(leg: InteractionLeg): void {
    const record: Record<string, unknown> = {
      ts: this.now(),
      interaction_id: leg.interactionId,
      kind: leg.kind,
    };
    if (leg.paneId != null) record.pane_id = leg.paneId;
    if (leg.text != null) record.text = this.redact(leg.text);
    if (leg.data && Object.keys(leg.data).length > 0) {
      record.data = redactDeep(leg.data, this.redact) as Record<string, unknown>;
    }
    try {
      this.sink(JSON.stringify(record));
    } catch {
      /* observability must never break the caller */
    }
  }
}

/** Production sink: synchronous append to a JSONL file. Append failures are swallowed (best-effort). */
export function createFileInteractionSink(filePath: string): (line: string) => void {
  return (line: string) => {
    try {
      fs.appendFileSync(filePath, line + "\n");
    } catch {
      /* best-effort */
    }
  };
}

/** A no-op sink — used when the interaction log is disabled (JANUS_INTERACTION_LOG=off). */
export const NOOP_SINK: (line: string) => void = () => {};

/**
 * Parse a list of JSONL lines and group them by interaction_id, preserving insertion order both of
 * the groups and of the legs within each group. Blank/garbage lines are skipped. This is what the
 * analyzer uses to reconstruct a turn's timeline.
 */
export function groupByInteraction(lines: string[]): Map<string, any[]> {
  const groups = new Map<string, any[]>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: any;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const id = rec?.interaction_id;
    if (typeof id !== "string") continue;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id)!.push(rec);
  }
  return groups;
}
