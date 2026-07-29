// src/voice/completionPolicy.ts -- vc-C deterministic completion narration, arbiter class 3 (Wave 3).
//
// Spec: docs/superpowers/specs/2026-07-29-turn-arbiter-design.md section 3.3 row "vc-C completions",
// section 4-W3; co-design spec section C (docs/superpowers/specs/2026-07-28-voice-coherence-codesign.md,
// branch docs/voice-coherence-codesign). LOCKED epic decision: `completionAnnounce` defaults to
// `dispatched` (hasExchange-keyed), FOCUS-INDEPENDENT -- the retired v1 `focused` tier (Sam's walk-away
// pane and Maya's kitchen pane are the SAME signal) is never resurrected by a stale settings value.
//
// Outcome facts key OFF the settled-outcome seam (src/observe/index.ts completionKindFor, the SAME
// verdict PR #152's completion_failed earcon uses) -- passed in here as `outcomeKind`. This module
// NEVER re-derives that verdict (no exchange-service reads of its own): PURE, synchronous, no I/O.

import type { SubmitItem } from "./turnArbiter";

export type CompletionAnnounce = "off" | "exceptions" | "dispatched" | "all";

/** LOCKED epic decision (co-design section C): dispatch-intent (hasExchange) keyed, never focus. */
export const DEFAULT_COMPLETION_ANNOUNCE: CompletionAnnounce = "dispatched";

const VALID_TIERS = new Set<CompletionAnnounce>(["off", "exceptions", "dispatched", "all"]);

/** Absent/invalid/retired (the v1 `focused` tier) all fall back to the default -- never a throw. */
export function normalizeCompletionAnnounce(raw: unknown): CompletionAnnounce {
  return typeof raw === "string" && VALID_TIERS.has(raw as CompletionAnnounce)
    ? (raw as CompletionAnnounce)
    : DEFAULT_COMPLETION_ANNOUNCE;
}

/** The pane-signal edge this decision is about -- deliberately a plain inline shape (not an import
 *  of src/paneSignals.ts's PaneSignal) so this module stays free of any production-object coupling. */
export interface CompletionSignal {
  paneId: string;
  kind: string;
  detail?: string;
}

export interface CompletionNarrationInput {
  sig: CompletionSignal;
  /** completionKindFor's verdict -- the REUSED settled-outcome seam value (never re-derived here). */
  outcomeKind: "completion" | "completion_failed";
  /** Dispatch-intent: was a live exchange bound to this pane (the caller's own exchange-service
   *  lookup)? The ONLY keying signal -- there is no focus/engagement input in this signature on
   *  purpose. */
  hasExchange: boolean;
  policy: CompletionAnnounce;
}

export type CompletionNarrationResult =
  | { speak: false; reason: string }
  | { speak: true; item: SubmitItem & { cls: 3 } };

/** Fleet-wide, inviolable exception: error/needs-input kinds OR a failed settled outcome -- speaks
 *  under ANY non-off policy, regardless of hasExchange (never miss eyes-off). */
function isException(sig: CompletionSignal, outcomeKind: CompletionNarrationInput["outcomeKind"]): boolean {
  return sig.kind === "error" || sig.kind === "prompt" || outcomeKind === "completion_failed";
}

function detailSuffix(sig: CompletionSignal): string {
  return sig.detail ? `: ${sig.detail}` : "";
}

/** The spoken facts (D3 -- structured, not a scripted sentence). Keyed OFF outcomeKind for the
 *  fail/clean split -- never off the pane-signal kind -- so a plain idle never reads as a failure
 *  and ambiguity fails toward plain completion (the seam's own contract). */
function factsFor(input: CompletionNarrationInput): string {
  const { sig, outcomeKind } = input;
  if (outcomeKind === "completion_failed") return `pane ${sig.paneId} completion FAILED${detailSuffix(sig)}`;
  if (sig.kind === "error") return `pane ${sig.paneId} reported an error${detailSuffix(sig)}`;
  if (sig.kind === "prompt") return `pane ${sig.paneId} is waiting at a prompt${detailSuffix(sig)}`;
  return `pane ${sig.paneId} finished${detailSuffix(sig)}`;
}

/** W1's canonical shared coalesce key -- every completion item (success or failure) carries it, so
 *  the D2 tail-group phrasing hook ("three panes finished") sees the successes share ONE group. */
const COALESCE_KEY = "pane-completion";

function buildItem(input: CompletionNarrationInput, exception: boolean): CompletionNarrationResult {
  return {
    speak: true,
    item: {
      facts: factsFor(input),
      cls: 3,
      paneId: input.sig.paneId,
      coalesceKey: COALESCE_KEY,
      // Exceptions headline over clean successes within class 3 even when submitted later (D2).
      severityRank: exception ? 0 : 1,
    },
  };
}

function silent(reason: string): CompletionNarrationResult {
  return { speak: false, reason };
}

/**
 * completionNarration -- the co-design section C decision table (final, dispatch-intent keyed):
 *   off                                        -> never speak (earcon-only tier; the earcon/toast/
 *                                                  visual stack live OUTSIDE this module, unchanged)
 *   exception (error/prompt kind, or a failed
 *   settled outcome), ANY pane, policy != off   -> speak, named-pane (fleet-wide, inviolable)
 *   success + hasExchange, policy in
 *   {dispatched, all}                           -> speak (the persona fix: focused OR background)
 *   success without hasExchange                 -> speak ONLY under `all` (false-done guard --
 *                                                  the default never amplifies an uncorroborated idle)
 * Every silent decision returns a machine-readable `reason` (auditable told-more trail).
 */
export function completionNarration(input: CompletionNarrationInput): CompletionNarrationResult {
  const { outcomeKind, hasExchange, policy } = input;
  if (policy === "off") {
    return silent("policy=off: earcon-only tier, no spoken completion narration");
  }
  const exception = isException(input.sig, outcomeKind);
  if (exception) return buildItem(input, true);
  if (!hasExchange) {
    return policy === "all"
      ? buildItem(input, false)
      : silent(`policy=${policy}: ambient success with no dispatched exchange stays silent (false-done guard)`);
  }
  if (policy === "exceptions") {
    return silent("policy=exceptions: a clean dispatched success stays silent (quiet tier)");
  }
  return buildItem(input, false);
}
