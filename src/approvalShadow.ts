// src/approvalShadow.ts — the SHADOW seam for approval parsing (seam Inc 1, task 1.6).
//
// SHADOW posture (the whole point of Increment 1): the TypeScript parser stays AUTHORITATIVE — its
// result is the one the operator's approval acts on, computed synchronously, never touching Python.
// In parallel, fire-and-forget, we ask the Python port to parse the SAME utterance and COUNT whether
// it agrees. Python being slow, unavailable, or wrong is invisible AND harmless here: nothing the
// operator sees depends on it. This is the live confirmer for the seam's parity (the offline proof is
// the golden-master sweep). The flip to Python-primary is a LATER increment (gated on a clean window).
//
// Why a module-level install seam (not a dep threaded through the routers): the SINGLE production entry
// to approval parsing — the hands-free ASR handler in src/voice/index.ts (handleOperatorUtterance) —
// calls parseApprovalIntentShadowed in place of parseApprovalIntent. That one call observes EVERY routed
// utterance EXACTLY ONCE (including "none"/ambient speech) before routeApprovalIntent dispatches to the
// pure routers (which re-parse with the un-shadowed parser — an internal detail, deliberately NOT
// shadowed to avoid double-counting). With no recorder installed (every test, and any build with the
// daemon off), parseApprovalIntentShadowed is a pure passthrough — byte-identical behavior, zero churn.
// The server installs ONE recorder at boot, backed by the shared-daemon approval facade.
import { parseApprovalIntent, type ParsedApproval } from "./approvalIntent";
import type { WireParsedApproval } from "./memory/types";

export interface ShadowStats {
  /** TS and Python both produced a result that was compared (match + mismatch). */
  compared: number;
  /** Python agreed with the authoritative TS result. */
  match: number;
  /** Python produced a DIFFERENT result than TS (logged, structured). */
  mismatch: number;
  /** Python returned nothing to compare (daemon unavailable / expiry / error / schema reject). */
  missing: number;
}

export interface ApprovalShadowRecorder {
  /** Observe one parse: TS result is authoritative; Python is queried fire-and-forget and counted. */
  record(utterance: string, tsResult: ParsedApproval): void;
  /** Snapshot of the diff counters (the fallback/parity signal Increment 2 gates the flip on). */
  stats(): ShadowStats;
}

export interface ApprovalShadowOpts {
  /** The Python approval facade's parse(); resolves the parsed result or null on any miss. */
  parse: (transcript: string) => Promise<WireParsedApproval | null>;
  /** Structured log sink (server injects console.error / the interaction log). */
  log?: (line: string) => void;
  /** Redact secrets from anything logged (server injects redactSecrets). */
  redact?: (s: string) => string;
}

/** Stable, undefined-dropping serialization so {ordinal,fragment} key-ORDER never causes a false
 *  mismatch (TS sets ordinal-then-fragment; zod validates fragment-then-ordinal). */
function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) {
      if (src[k] !== undefined) out[k] = sortDeep(src[k]);
    }
    return out;
  }
  return v;
}

function canonical(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

/**
 * Build a shadow recorder. `record()` schedules the Python parse on a microtask and compares when it
 * settles — it returns immediately and NEVER throws into the caller. Any miss/error counts as
 * `missing` (the daemon being down is data, not a failure).
 */
export function createApprovalShadowRecorder(opts: ApprovalShadowOpts): ApprovalShadowRecorder {
  const log = opts.log ?? (() => {});
  const redact = opts.redact ?? ((s: string) => s);
  const stats: ShadowStats = { compared: 0, match: 0, mismatch: 0, missing: 0 };

  return {
    record(utterance, tsResult) {
      Promise.resolve()
        .then(() => opts.parse(utterance))
        .then((py) => {
          if (py === null) { stats.missing++; return; }
          stats.compared++;
          if (canonical(tsResult) === canonical(py)) {
            stats.match++;
            return;
          }
          stats.mismatch++;
          log(`[approval-shadow] MISMATCH ${redact(JSON.stringify({ ts: tsResult, py, utterance }))}`);
        })
        .catch((e: unknown) => {
          stats.missing++;
          log(`[approval-shadow] error ${e instanceof Error ? e.message : String(e)}`);
        });
    },
    stats() { return { ...stats }; },
  };
}

// ── the install seam ──────────────────────────────────────────────────────────────────────────────
let installed: ApprovalShadowRecorder | null = null;

/** Install (or clear, with null) the process-wide shadow recorder. Server calls this once at boot. */
export function installApprovalShadow(recorder: ApprovalShadowRecorder | null): void {
  installed = recorder;
}

/** The currently-installed recorder (for observability read-back / tests). */
export function getApprovalShadow(): ApprovalShadowRecorder | null {
  return installed;
}

/**
 * Authoritative parse + fire-and-forget shadow. Drop-in for parseApprovalIntent at the voice routers:
 * computes the TS result synchronously (the answer), feeds the installed recorder (if any), and
 * returns the TS result. The shadow can NEVER change, delay, or break the returned value.
 */
export function parseApprovalIntentShadowed(utterance: string): ParsedApproval {
  const result = parseApprovalIntent(utterance);
  if (installed) {
    // Belt-and-suspenders: a recorder bug must never reach the hot path. record() is itself
    // fire-and-forget; this guards only its synchronous scheduling.
    try { installed.record(utterance, result); } catch { /* shadow must never throw into approvals */ }
  }
  return result;
}
