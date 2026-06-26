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
  /**
   * FLIP path (Increment 2.1): resolve the parse with PYTHON AS PRIMARY and the TS twin as the
   * fail-closed floor. Queries Python (counting the diff exactly as `record` does) and returns
   * Python's result IFF it lands within `timeoutMs`; otherwise — null, timeout, or error — returns
   * `tsResult`, the conservative TS twin. Never throws, never returns a stale Python answer, never
   * fails open. A late Python answer (past the budget) still updates the counters but is never used.
   */
  resolve(utterance: string, tsResult: ParsedApproval, timeoutMs: number): Promise<ParsedApproval>;
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

/** Resolve to the promise's value, or `null` if it has not settled within `ms` (or it rejects). The
 *  underlying promise keeps running — its counters still update — we just stop WAITING for it. The
 *  timer is unref'd so it can never pin the event loop. */
function withTimeout<T>(p: Promise<T | null>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: T | null) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, ms);
    if (typeof (timer as unknown as { unref?: () => void }).unref === "function") (timer as unknown as { unref: () => void }).unref();
    p.then(finish, () => finish(null));
  });
}

/**
 * Build a shadow recorder. `record()` schedules the Python parse on a microtask and compares when it
 * settles — it returns immediately and NEVER throws into the caller. Any miss/error counts as
 * `missing` (the daemon being down is data, not a failure). `resolve()` is the FLIP variant: same
 * count, but awaited with a fail-closed budget so Python can be primary (TS twin as the floor).
 */
export function createApprovalShadowRecorder(opts: ApprovalShadowOpts): ApprovalShadowRecorder {
  const log = opts.log ?? (() => {});
  const redact = opts.redact ?? ((s: string) => s);
  const stats: ShadowStats = { compared: 0, match: 0, mismatch: 0, missing: 0 };

  // Query Python ONCE, update the diff counters, and hand back Python's parsed result (or null on any
  // miss). Shared by the fire-and-forget shadow `record` and the awaited flip `resolve`, so both count
  // identically. NEVER rejects — a miss/error is data (counted `missing`), returned as null.
  function compareAndCount(utterance: string, tsResult: ParsedApproval): Promise<WireParsedApproval | null> {
    return Promise.resolve()
      .then(() => opts.parse(utterance))
      .then((py) => {
        if (py === null) { stats.missing++; return null; }
        stats.compared++;
        if (canonical(tsResult) === canonical(py)) { stats.match++; return py; }
        stats.mismatch++;
        log(`[approval-shadow] MISMATCH ${redact(JSON.stringify({ ts: tsResult, py, utterance }))}`);
        return py;
      })
      .catch((e: unknown) => {
        stats.missing++;
        // Redact like the mismatch log above: a transport/parse error message could conceivably
        // echo the utterance, and the redactor is the single secrets choke-point for both paths.
        log(`[approval-shadow] error ${redact(e instanceof Error ? e.message : String(e))}`);
        return null;
      });
  }

  return {
    record(utterance, tsResult) { void compareAndCount(utterance, tsResult); },
    async resolve(utterance, tsResult, timeoutMs) {
      // FAIL-CLOSED: race Python against the budget; on null / timeout / error fall to the TS twin.
      // `?? tsResult` is the floor — Python's result is used ONLY when it lands in time and is non-null.
      const py = await withTimeout(compareAndCount(utterance, tsResult), timeoutMs);
      return py ?? tsResult;
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

// ── the FLIP (Increment 2.1): Python-primary toggle ─────────────────────────────────────────────────
// Default OFF = SHADOW (TS authoritative — every existing path unchanged). The server flips this from
// an env flag at boot. While OFF, resolveApprovalIntent is byte-identical to parseApprovalIntentShadowed.
// While ON, Python is PRIMARY with the TS twin as the fail-closed floor (recorder.resolve). The twin is
// NOT a separate shim — it IS the floor, so it can never drift. Reversible at runtime by design.
let pythonPrimary = false;
let primaryTimeoutMs = 600;

/** Server boot: enable/disable Python-primary and (optionally) override the fail-closed budget (ms). */
export function setApprovalPythonPrimary(enabled: boolean, timeoutMs?: number): void {
  pythonPrimary = enabled;
  if (typeof timeoutMs === "number" && timeoutMs > 0) primaryTimeoutMs = timeoutMs;
}

/** Is Python the PRIMARY approval parser right now (i.e. is the flip live)? The voice handler reads
 *  this to choose the synchronous shadow tap (OFF) vs the awaited Python-primary path (ON). */
export function isApprovalPythonPrimary(): boolean { return pythonPrimary; }

/**
 * The FLIP entry point. ALWAYS computes the TS twin first — the fail-closed floor. In SHADOW (default)
 * this is byte-identical to parseApprovalIntentShadowed: record fire-and-forget, return TS. In FLIP
 * mode, Python is primary — recorder.resolve() returns Python's answer iff it lands within the budget,
 * else the TS twin. NEVER throws, NEVER returns a stale Python answer, NEVER fails open: every escape
 * hatch (no recorder, recorder throw, Python null/timeout/error) yields the conservative TS twin.
 */
export async function resolveApprovalIntent(utterance: string): Promise<ParsedApproval> {
  const ts = parseApprovalIntent(utterance);
  const rec = installed;
  if (!rec) return ts;
  if (!pythonPrimary) {
    try { rec.record(utterance, ts); } catch { /* shadow must never throw into approvals */ }
    return ts;
  }
  try {
    return await rec.resolve(utterance, ts, primaryTimeoutMs);
  } catch {
    return ts; // belt-and-suspenders: any unexpected throw ⇒ the conservative floor (fail-closed)
  }
}
