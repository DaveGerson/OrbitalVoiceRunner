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
// Skip rules (return { corrected: false }, submit NOTHING): the claim was never spoken; it was
// already corrected once (a correction is never re-corrected); it was superseded by a NEWER spoken
// claim on the same (paneId, kind) -- the operator's operative belief is the newer claim, correcting
// the stale one would confuse rather than inform; or the ref names no known claim. There is NO
// staleness clock (co-design section D revision): a correction pending for hours still drains spoken,
// and the arbiter's D4 floor guarantees class 0 can never be configured passive-context.

import type { SubmitItem } from "./turnArbiter";

export interface CorrectionClaim {
  claimId: string;
  paneId: string;
  kind: "dispatch" | "restart" | "completion" | "readiness";
  assertedText: string;
  assertedAt: number;
  /** false == the claim never reached the operator (a suppressed ack) -- nothing to retract. */
  spoken: boolean;
}

export interface InvalidateResult {
  corrected: boolean;
  reason?: string;
}

interface StoredClaim extends CorrectionClaim {
  corrected: boolean;
  superseded: boolean;
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
function buildCorrectionFacts(claim: StoredClaim, groundTruth: string): string {
  return `correction: pane ${claim.paneId} -- retracting the ${claim.kind} claim `
    + `("${claim.assertedText}"); ground truth: ${groundTruth}`;
}

/**
 * createCorrectionLedger -- the Wave-2 vc-D surface. Pure bookkeeping over an injected arbiter: no
 * timers, no I/O, no wall-clock reads of its own (record/invalidate carry no `now` because there is
 * no staleness path left to measure against).
 */
export function createCorrectionLedger(deps: { arbiter: { submit(item: SubmitItem): void } }) {
  const claims = new Map<string, StoredClaim>();
  /** Latest claim per (paneId, kind) -- lets a fresh claim supersede its predecessor on record(). */
  const latestByPaneKind = new Map<string, string>();
  /** Latest SPOKEN claim per paneId -- the target `invalidate(paneId, ...)` resolves. */
  const latestSpokenByPane = new Map<string, string>();

  function record(claim: CorrectionClaim): void {
    const paneKindKey = `${claim.paneId}:${claim.kind}`;
    const prior = latestByPaneKind.get(paneKindKey);
    if (prior) {
      const priorClaim = claims.get(prior);
      if (priorClaim) priorClaim.superseded = true;
    }
    latestByPaneKind.set(paneKindKey, claim.claimId);
    if (claim.spoken) latestSpokenByPane.set(claim.paneId, claim.claimId);
    claims.set(claim.claimId, { ...claim, corrected: false, superseded: false });
  }

  /** claimId is tried first (the direct ref); a miss falls back to "the latest spoken claim on this
   *  pane" -- the paneId-ref convenience the corrections journey (voice hears "pane X", not a claimId). */
  function resolveClaim(claimIdOrPaneId: string): StoredClaim | undefined {
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
    if (!claim) return { corrected: false, reason: "unknown ref" };
    if (!claim.spoken) return { corrected: false, reason: "never spoken" };
    if (claim.corrected) return { corrected: false, reason: "already corrected" };
    if (claim.superseded) return { corrected: false, reason: "superseded" };

    claim.corrected = true;
    deps.arbiter.submit({
      facts: buildCorrectionFacts(claim, groundTruth),
      cls: 0,
      paneId: claim.paneId,
      severityRank: severityRankOf(opts?.severity),
    });
    return { corrected: true };
  }

  /** fikj.11 (additive): the producer-side read behind contradiction guards. Returns the newest
   *  SPOKEN claim on a pane so a producer can check KIND and RECENCY before electing an
   *  invalidation (e.g. an `exited` signal only contradicts a *completion* claim, and only a
   *  recent one). Policy stays in the producer — this module remains clock-free, and there is
   *  still no staleness path inside the ledger. */
  function latestSpokenClaim(
    paneId: string,
  ): { claimId: string; kind: CorrectionClaim["kind"]; assertedAt: number } | undefined {
    const id = latestSpokenByPane.get(paneId);
    const claim = id ? claims.get(id) : undefined;
    return claim ? { claimId: claim.claimId, kind: claim.kind, assertedAt: claim.assertedAt } : undefined;
  }

  return { record, invalidate, latestSpokenClaim };
}
