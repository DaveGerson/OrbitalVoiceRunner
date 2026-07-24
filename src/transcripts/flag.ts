// src/transcripts/flag.ts
//
// JANUS_TRANSCRIPT_SINK feature flag (bead 98f2 — durable transcript sink). Read once at boot, the
// established env-flag idiom (mirrors src/exchanges/flag.ts's JANUS_EXCHANGE_SPINE): a plain
// module-level env read, no config framework.
//
//   off (default) — no transcript is EVER persisted. Zero behavior delta from before this sink
//                   existed; the migration (schema v13) still applies unconditionally, but nothing
//                   reads or writes the table unless an operator opts in.
//   on            — every live voice message's operator ASR + Janus narration (BOTH channels) is
//                   persisted, REDACTED at write, through src/transcripts/sink.ts.
//
// Exported as a function (not just the frozen module constant) so tests can pass an explicit env
// map without mutating process.env or relying on import order/caching.

const TRUE_VALUES = new Set(["1", "on", "true"]);

/** True only when `env.JANUS_TRANSCRIPT_SINK` is one of '1'/'on'/'true' (case-insensitive). Default
 *  OFF — no transcript is ever persisted unless the operator explicitly opts in. */
export function readTranscriptSinkEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.JANUS_TRANSCRIPT_SINK ?? "").trim().toLowerCase();
  return TRUE_VALUES.has(raw);
}

/** Cached at module load (the established env-flag idiom) — one process, one value. */
export const TRANSCRIPT_SINK_ENABLED: boolean = readTranscriptSinkEnabled();
