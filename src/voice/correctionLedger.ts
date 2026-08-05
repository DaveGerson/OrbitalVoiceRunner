// src/voice/correctionLedger.ts -- vc-D corrections as arbiter class 0 (Wave 2).
//
// Spec: docs/superpowers/specs/2026-07-29-turn-arbiter-design.md section 3.3 row "vc-D corrections",
// section 4-W2; co-design spec section D (docs/superpowers/specs/2026-07-28-voice-coherence-codesign.md,
// branch docs/voice-coherence-codesign). The ledger holds NO private pending-queue: every elected
// correction is submitted directly into the injected turn arbiter as a class-0 item -- the arbiter's
// drainPending machinery IS the correction queue (D3 "force the turn, steer the words": the facts
// below are structured retraction FACTS for the digest, not a scripted sentence -- the model phrases
// the retraction, the arbiter only guarantees the turn happens).
//
// Skip rules (return { corrected: false }, submit NOTHING): the claim was never spoken, or the ref
// names no known claim. r25i: BOTH terminal states are now ABSENCE, not flags -- record() EVICTS the
// prior same-(pane,kind) claim it supersedes, and invalidate() EVICTS the claim it corrects (facts
// are built and submitted first). A superseded claim was never correctable (the operator's operative
// belief is the newer claim -- correcting the stale one would confuse rather than inform) and a
// corrected claim was never re-correctable, so deleting them changes no OUTCOME: re-invalidating an
// evicted ref returns the unknown-ref result instead of the old "already corrected"/"superseded"
// reasons -- still corrected:false, still no double-speak, still no false correction. Storm control
// moved from flag-check to absence. There is NO staleness clock (co-design section D revision): a
// correction pending for hours still drains spoken, and the arbiter's D4 floor guarantees class 0
// can never be configured passive-context.
//
// Bound (r25i): because every terminal claim is evicted at its terminal transition, the live set
// caps at ~(panes x 4 kinds) -- at most the newest claim per (paneId, kind), including never-spoken
// claims awaiting supersession -- instead of growing ~0.5-1KB per claim for process lifetime.
// Future (out of scope, noted): claims for ARCHIVED panes linger until process end -- one small
// object per (pane, kind), bounded.

import type { SubmitItem } from "./turnArbiter";

export interface CorrectionClaim {
  claimId: string;
  paneId: string;
  kind: "dispatch" | "restart" | "completion" | "readiness";
  assertedText: string;
  assertedAt: number;
  /** false == the claim never reached the operator (a suppressed ack) -- nothing to retract. */
  spoken: boolean;
  /** OPTIONAL + additive (final-review fix 2, completion claims): did the claim assert a CLEAN
   *  success? A completion_failed digest records `false` -- it still shadows older success claims
   *  in latestSpokenByPane, but the contradiction guard must never "retract" truthful bad news.
   *  Absent on producers that predate the field (dispatch/restart/readiness claims). */
  assertedSuccess?: boolean;
}

export interface InvalidateResult {
  corrected: boolean;
  reason?: string;
}

/** Wave-2: an `exception` correction headlines over an `info` one even when invalidated later --
 *  lower rank speaks first within class 0 (co-design section D: "ordered severity-first, exceptions
 *  before successes"). No severity given -> undefined, so the arbiter's own FIFO default applies. */
function severityRankOf(severity: "exception" | "info" | undefined): number | undefined {
  if (severity === "exception") return 0;
  if (severity === "info") return 1;
  return undefined;
}

/** Structured retraction facts (D3): pane + ground truth + a correction marker + a reference to what
 *  was asserted. Deliberately NOT a scripted sentence -- the model steers the words spoken. */
function buildCorrectionFacts(claim: CorrectionClaim, groundTruth: string): string {
  return `correction: pane ${claim.paneId} -- retracting the ${claim.kind} claim `
    + `("${claim.assertedText}"); ground truth: ${groundTruth}`;
}

/**
 * createCorrectionLedger -- the Wave-2 vc-D surface. Pure bookkeeping over an injected arbiter: no
 * timers, no I/O, no wall-clock reads of its own (record/invalidate carry no `now` because there is
 * no staleness path left to measure against).
 */
export function createCorrectionLedger(deps: { arbiter: { submit(item: SubmitItem): void } }) {
  const claims = new Map<string, CorrectionClaim>();
  /** Latest claim per (paneId, kind) -- lets a fresh claim supersede its predecessor on record(). */
  const latestByPaneKind = new Map<string, string>();
  /** Latest SPOKEN claim per paneId -- the target `invalidate(paneId, ...)` resolves. */
  const latestSpokenByPane = new Map<string, string>();

  /** r25i: remove a terminal (superseded or corrected) claim from the live set AND from every
   *  index that points at it. latestSpokenByPane tracks SPOKEN claims only, so when a spoken
   *  claim is evicted (e.g. superseded by an UNSPOKEN successor) the pane entry must be deleted,
   *  not left dangling -- latestSpokenClaim then returns undefined (a gap, never a stale
   *  projection). The latestByPaneKind entry is likewise cleaned when it points at the evictee
   *  (correct-eviction; on supersede record() overwrites it immediately after). */
  function evict(claim: CorrectionClaim): void {
    claims.delete(claim.claimId);
    const paneKindKey = `${claim.paneId}:${claim.kind}`;
    if (latestByPaneKind.get(paneKindKey) === claim.claimId) latestByPaneKind.delete(paneKindKey);
    if (latestSpokenByPane.get(claim.paneId) === claim.claimId) latestSpokenByPane.delete(claim.paneId);
  }

  function record(claim: CorrectionClaim): void {
    const paneKindKey = `${claim.paneId}:${claim.kind}`;
    const prior = latestByPaneKind.get(paneKindKey);
    if (prior) {
      // r25i: supersession is terminal (a superseded claim could never be corrected), so the
      // prior claim is EVICTED, not flagged -- invalidating its ref now reports "unknown ref".
      const priorClaim = claims.get(prior);
      if (priorClaim) evict(priorClaim);
    }
    latestByPaneKind.set(paneKindKey, claim.claimId);
    if (claim.spoken) latestSpokenByPane.set(claim.paneId, claim.claimId);
    claims.set(claim.claimId, { ...claim });
  }

  /** claimId is tried first (the direct ref); a miss falls back to "the latest spoken claim on this
   *  pane" -- the paneId-ref convenience the corrections journey (voice hears "pane X", not a claimId). */
  function resolveClaim(claimIdOrPaneId: string): CorrectionClaim | undefined {
    const byId = claims.get(claimIdOrPaneId);
    if (byId) return byId;
    const byPane = latestSpokenByPane.get(claimIdOrPaneId);
    return byPane ? claims.get(byPane) : undefined;
  }

  function invalidate(
    claimIdOrPaneId: string,
    groundTruth: string,
    opts?: { severity?: "exception" | "info" },
  ): InvalidateResult {
    const claim = resolveClaim(claimIdOrPaneId);
    // r25i: an evicted (previously "already corrected"/"superseded") ref lands here -- identical
    // outcome (corrected:false, nothing submitted), the dedup/storm-control now lives in absence.
    if (!claim) return { corrected: false, reason: "unknown ref" };
    if (!claim.spoken) return { corrected: false, reason: "never spoken" };

    // r25i ordering: build the facts FIRST (buildCorrectionFacts reads assertedText), submit to
    // the arbiter exactly as before, THEN evict -- correction is terminal, so the claim leaves
    // the live set the moment its retraction is queued.
    deps.arbiter.submit({
      facts: buildCorrectionFacts(claim, groundTruth),
      cls: 0,
      paneId: claim.paneId,
      severityRank: severityRankOf(opts?.severity),
    });
    evict(claim);
    return { corrected: true };
  }

  /** fikj.11 (additive): the producer-side read behind contradiction guards. Returns the newest
   *  SPOKEN claim on a pane so a producer can check KIND and RECENCY before electing an
   *  invalidation (e.g. an `exited` signal only contradicts a *completion* claim, and only a
   *  recent one). Policy stays in the producer — this module remains clock-free, and there is
   *  still no staleness path inside the ledger. */
  function latestSpokenClaim(
    paneId: string,
  ): { claimId: string; kind: CorrectionClaim["kind"]; assertedAt: number; assertedSuccess?: boolean } | undefined {
    const id = latestSpokenByPane.get(paneId);
    const claim = id ? claims.get(id) : undefined;
    if (!claim) return undefined;
    return {
      claimId: claim.claimId,
      kind: claim.kind,
      assertedAt: claim.assertedAt,
      // Conditional (fix 2): claims recorded without the flag keep their exact pre-fix projection
      // shape (pinned by tests/test_correction_ledger_query.ts's deepStrictEqual).
      ...(claim.assertedSuccess !== undefined ? { assertedSuccess: claim.assertedSuccess } : {}),
    };
  }

  return { record, invalidate, latestSpokenClaim };
}
