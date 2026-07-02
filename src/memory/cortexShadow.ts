// src/memory/cortexShadow.ts — the FLIP seam for cortex context-curation (seam Inc 4, task B-1).
//
// Structural mirror of src/approvalShadow.ts's FLIP. Default OFF: while the flag is off, the cortex
// branch in MemoryService.synthesizeAsync is NEVER taken, so the injected brief is BYTE-IDENTICAL to
// today (the parity guarantee — proven by tests/test_cortex_flip.ts test (a)). The server flips this
// from JANUS_CORTEX_PRIMARY at boot.
//
// While ON, the cortex is the PRIMARY curation authority: synthesizeAsync asks the cortex which tiers
// survive (decide → decision.keep), filters the tiers to that set, and renders ONLY the kept tiers.
// The full-tier synth/assembler path is the fail-closed FLOOR: any miss — timeout, ok:false, the
// daemon unavailable, an exception — yields `null` here, and the caller falls through to the existing
// full-tier path UNCHANGED. The cortex can never break, delay, or expand the brief: it can only
// (when it lands in time) NARROW it. Reversible at runtime by design.
//
// No module-level install seam (unlike approvalShadow): the cortex client is already threaded through
// MemoryService as a constructor field, so synthesizeAsync passes it in. This module owns only the
// flag, the race helper, the keep-list filter, and the B-4 fallback-rate counter.
import type { CortexCtx, MemoryTiers } from "./types";
import type { PythonCortexClient, CortexResult } from "./cortexClient";

// ── the FLIP flag (off by default = SHADOW; the brief path is byte-identical to today) ───────────────
const DEFAULT_CORTEX_PRIMARY_TIMEOUT_MS = 300; // plan B-1 default: 300ms (vs approval's 600ms)
let cortexPrimary = false;
let primaryTimeoutMs = DEFAULT_CORTEX_PRIMARY_TIMEOUT_MS;

/** Server boot: enable/disable cortex-primary and (optionally) override the fail-closed budget (ms).
 *  Always (re)resolves the budget: disabling — or enabling without an override — returns it to the
 *  default rather than retaining a prior call's value (no cross-call / cross-test state bleed). */
export function setCortexPrimary(enabled: boolean, timeoutMs?: number): void {
  cortexPrimary = enabled;
  primaryTimeoutMs = (typeof timeoutMs === "number" && timeoutMs > 0) ? timeoutMs : DEFAULT_CORTEX_PRIMARY_TIMEOUT_MS;
}

/** Is the cortex the PRIMARY curation authority right now (i.e. is the flip live)? synthesizeAsync
 *  reads this to choose the full-tier floor (OFF) vs the cortex-curated path (ON). */
export function isCortexPrimary(): boolean { return cortexPrimary; }

/** The current cortex-primary budget (ms). MemoryService threads this into resolveWithCortex. */
export function cortexPrimaryTimeoutMs(): number { return primaryTimeoutMs; }

/** Resolve to the promise's value, or `null` if it has not settled within `ms` (or it rejects). The
 *  underlying promise keeps running — we just stop WAITING for it. Deliberately NOT unref'd (verbatim
 *  from approvalShadow.ts): this short-lived timer is the ONLY thing that resolves the race when the
 *  cortex hangs, so it must keep the loop alive until it fires. Unref'ing it let `--test-force-exit`
 *  beat it in an otherwise-idle test loop; in production the loop is always live and a ≤300ms
 *  fires-or-clears timer can never pin it. */
function withTimeout<T>(p: Promise<T | null>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: T | null) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, ms);
    p.then(finish, () => finish(null));
  });
}

// ── B-4 sub-task: the cortexFallbackRate counter (process-wide singleton) ────────────────────────────
// Warm-up-immune, mirroring daemonStateTracker.firstUp: a fall-to-floor BEFORE the cortex's first
// successful curation is cold-start warm-up, NOT a regression, so it does not count. After the first
// ok:true, every fall-to-floor (miss/timeout/ok:false/throw) increments fallbackCount, and every call
// increments totalCount. fallbackRate = fallbackCount / totalCount (0 when no post-up calls yet).
// Surfaced on get_health at health.memory.daemon.cortexFallbackRate (the RETIRE-gate metric).
let firstUp = false;
let fallbackCount = 0;
let totalCount = 0;

export interface CortexFallbackStats { fallbackRate: number }

/** Snapshot the cortex fall-to-floor rate (the RETIRE-gate metric). 0 before any post-first-up call. */
export function getCortexFallbackStats(): CortexFallbackStats {
  return { fallbackRate: totalCount ? fallbackCount / totalCount : 0 };
}

/** Reset the counter (tests; never called in production). */
export function resetCortexFallbackStats(): void {
  firstUp = false; fallbackCount = 0; totalCount = 0;
}

/** Build the cortex's keep-list-filtered MemoryTiers. Each tier NOT in `keep` is nulled / zeroed to its
 *  floor value (assembleBrief already renders null project/pane and empty board/breadcrumbs as absent
 *  blocks). `frame` is STRUCTURAL — frameBlock has no null guard and renders unconditionally — so it is
 *  ALWAYS kept regardless of the keep list. An unknown key in `keep` (not one of the five tier names)
 *  is silently ignored: only the five canonical fields are ever populated. */
function filterTiersToKeep(tiers: MemoryTiers, keep: string[]): MemoryTiers {
  const set = new Set(keep);
  return {
    project: set.has("project") ? tiers.project : null,
    pane: set.has("pane") ? tiers.pane : null,
    board: set.has("board") ? tiers.board : [],
    frame: tiers.frame, // structural — always kept (frameBlock has no null guard)
    breadcrumbs: set.has("breadcrumbs") ? tiers.breadcrumbs : [],
  };
}

/**
 * The FLIP entry point. Races the cortex's `decide` against the budget; on a clean ok:true within the
 * budget, returns the keep-list-filtered MemoryTiers (the caller renders ONLY those tiers and stamps
 * `source: "cortex-primary"`). On ANY miss — timeout, ok:false, the facade rejecting, an exception —
 * returns `null`, and the caller falls through to the full-tier FLOOR. NEVER throws, NEVER fails open
 * (a miss can only NARROW nothing — it widens back to the full floor). The B-4 counter accrues here:
 * warm-up-immune (firstUp), fallbackCount++ on a post-up miss, totalCount++ on every post-up call.
 */
export async function resolveWithCortex(
  tiers: MemoryTiers,
  ctx: CortexCtx,
  now: number,
  client: PythonCortexClient,
  timeoutMs: number,
  onHit?: (res: Extract<CortexResult, { ok: true }>) => void,
): Promise<MemoryTiers | null> {
  try {
    const res = await withTimeout(client.decide(tiers, ctx, now), timeoutMs);
    if (res && res.ok) {
      firstUp = true;
      totalCount++; // a clean curation — counted, not a fallback
      if (onHit) onHit(res);
      return filterTiersToKeep(tiers, res.decision.keep);
    }
    // miss (null / timeout / ok:false): count it ONLY once the cortex has come up at least once.
    if (firstUp) { totalCount++; fallbackCount++; }
    return null;
  } catch {
    if (firstUp) { totalCount++; fallbackCount++; }
    return null; // belt-and-suspenders fail-closed
  }
}
