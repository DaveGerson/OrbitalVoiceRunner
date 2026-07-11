// src/voice/targetResolver.ts — instruction target resolution (Phase 3, Step 3.2/3.3; spec
// docs/superpowers/specs/2026-07-09-instruction-routing.md §3-§4).
//
// EXTENDS focusResolver, never duplicates it: tiers 1-3 (exact name/id, unique name-prefix, exact
// ordinal) are literalResolve VERBATIM (../voice/focusResolver.ts); this module adds a fourth
// deterministic floor tier (exact role/preset-token uniqueness), anaphora + cross-project
// classification, and — critically — returns a DECISION instead of binding. It never mutates
// focus, never mutates its input, and never consults the ranker before the deterministic floor
// has had a chance to resolve (exact beats the ranker, spec §3.1's hard rule).
//
// FALLBACK CONTRACT (mirrors policyClient.ts's binding contract): `rank` resolves null on ANY
// miss — down, timeout, schema reject, or a thrown rejection (this module never lets a rejecting
// ranker escape; it is caught and treated as null). A dead/absent/null-returning ranker leaves
// ONLY the deterministic floor (tiers 1-4) — the floor never widens; fuzzy matching is
// Python-ranking-only.
//
// focusBindPolicy (echo/tiered) does NOT apply here (spec §3.2) — a wrong instruction target
// delivers work to the wrong agent, so fuzzy/multiple/cross-project references always confirm,
// regardless of the operator's focus-bind preference.

import { literalResolve, formatNameList, candidateName, closeAlternatives } from "./focusResolver";
import type { FocusCandidate, FocusResolution } from "./policyClient";

export interface TargetResolverInput {
  /** null/"" = the utterance carried no referent. */
  reference: string | null;
  /** collectFocusCandidates display-order shape. */
  candidates: FocusCandidate[];
  /** The operator's current project. */
  activeProjectId: string | null;
  /** A project the operator NAMED, if any (cross-project confirm fires regardless — spec §3.2). */
  explicitProject: string | null;
  /** The anaphora register: the last successfully bound instruction target, if still live. */
  recentReferent: { paneId: string; projectId: string } | null;
  /** The EXISTING focus.resolve ranking seam (src/voice/policyClient.ts), injected so this module
   *  never spawns or knows about the daemon transport. Ranking-only: it can add recall for fuzzy
   *  references but can never override or widen an exact floor match. */
  rank?: (reference: string, candidates: FocusCandidate[]) => Promise<FocusResolution | null>;
}

export type TargetDecision =
  | { kind: "bind"; paneId: string; projectId: string }
  | {
      kind: "confirm";
      reason: "fuzzy" | "cross_project" | "multiple";
      candidates: Array<{ paneId: string; projectId: string }>;
      prompt: string;
    }
  | { kind: "clarify"; prompt: string };

// ── tier 4: exact role/preset-token equality (the one NEW deterministic tier) ──────────────────

/** Role-token vocabulary (spec §3.1): the reference's role token matched against the accepted
 *  spellings normalizePreset() enumerates (src/actions/defs/panes_write.ts), over candidates'
 *  presetLabel. Word-boundary matching — no substring scoring, no fuzziness. Order matters only
 *  in that "claude code" and "claude" both resolve to the same preset, so a single ordered scan
 *  is sufficient (no ambiguity between entries). */
const ROLE_TOKEN_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bclaude\s*code\b/i, "Claude Code"],
  [/\bclaude\b/i, "Claude Code"],
  [/\bcodex\b/i, "Codex"],
  [/\bantigravity\b/i, "Antigravity"],
  [/\bcustom\b/i, "Custom"],
];

function roleTokenFromReference(reference: string): string | null {
  for (const [pattern, preset] of ROLE_TOKEN_PATTERNS) {
    if (pattern.test(reference)) return preset;
  }
  return null;
}

type FloorResult =
  | { kind: "bind"; paneId: string }
  | { kind: "multiple"; paneIds: string[] }
  | { kind: "none" }
  /** A deterministic category (role/preset token) was recognized but matched no candidate — the
   *  decision table's "clarify" cell for that row; the ranker is never consulted for it (a role
   *  reference is a structural claim, not a fuzzy guess). */
  | { kind: "clarify_deterministic" };

/**
 * Tiers 1-3 verbatim via literalResolve (case-insensitive exact name/id -> unique name-prefix ->
 * exact ordinal word/digit); tier 4 (exact role/preset-token uniqueness) is new. literalResolve's
 * own return shape already distinguishes "exact single match" (paneId set, confidence 1) from
 * "tied collision" (paneId null, non-empty alternatives) from "nothing at all" (paneId null, empty
 * alternatives) — reused directly rather than re-deriving the same classification.
 */
function resolveFloor(reference: string, candidates: FocusCandidate[]): FloorResult {
  const lit = literalResolve(reference, candidates);
  if (lit.paneId !== null && lit.confidence >= 1) {
    return { kind: "bind", paneId: lit.paneId };
  }
  if (lit.alternatives.length > 0) {
    return { kind: "multiple", paneIds: lit.alternatives.map((a) => a.paneId) };
  }

  const roleToken = roleTokenFromReference(reference);
  if (roleToken === null) return { kind: "none" };
  const matches = candidates.filter((c) => c.presetLabel === roleToken);
  if (matches.length === 1) return { kind: "bind", paneId: matches[0].paneId };
  if (matches.length > 1) return { kind: "multiple", paneIds: matches.map((c) => c.paneId) };
  return { kind: "clarify_deterministic" };
}

// ── anaphora ("that", "that one", "it") ─────────────────────────────────────────────────────────

const ANAPHORA_RE = /^(that(\s+(pane|one))?|it)$/i;

function isAnaphora(reference: string): boolean {
  return ANAPHORA_RE.test(reference.trim());
}

// ── prose helpers — formatNameList/candidateName are shared with focusResolver.ts (imported above)
//    rather than mirrored by hand. ────────────────────────────────────────────────────────────────

function candidateProjectId(candidates: FocusCandidate[], paneId: string, fallback: string): string {
  return candidates.find((c) => c.paneId === paneId)?.projectId ?? fallback;
}

function clarifyNoMatch(candidates: FocusCandidate[]): TargetDecision {
  if (candidates.length === 0) {
    return { kind: "clarify", prompt: "I don't see any panes open right now." };
  }
  const names = candidates.slice(0, 5).map((c) => c.paneName);
  return { kind: "clarify", prompt: `I didn't catch which pane you meant. Panes I see: ${formatNameList(names)}.` };
}

function confirmMultiple(paneIds: string[], candidates: FocusCandidate[]): TargetDecision {
  const uniqueIds = Array.from(new Set(paneIds));
  const decisionCandidates = uniqueIds.map((id) => ({
    paneId: id,
    projectId: candidateProjectId(candidates, id, ""),
  }));
  const names = uniqueIds.slice(0, 3).map((id) => candidateName(candidates, id));
  return {
    kind: "confirm",
    reason: "multiple",
    candidates: decisionCandidates,
    prompt: `Which pane did you mean — ${formatNameList(names)}?`,
  };
}

function confirmFuzzy(paneId: string, candidates: FocusCandidate[]): TargetDecision {
  const projectId = candidateProjectId(candidates, paneId, "");
  return {
    kind: "confirm",
    reason: "fuzzy",
    candidates: [{ paneId, projectId }],
    prompt: `Did you mean '${candidateName(candidates, paneId)}'?`,
  };
}

/** Cross-project confirm applies to ANY bind-eligible resolution (floor or ranker) whose pane
 *  lives outside the operator's active project — spec §3.2/§4: "NEVER a silent bind, even for an
 *  exact name, and regardless of whether the operator named the project." */
function bindOrCrossProjectConfirm(
  paneId: string,
  candidates: FocusCandidate[],
  activeProjectId: string | null,
): TargetDecision {
  const cand = candidates.find((c) => c.paneId === paneId);
  const projectId = cand?.projectId ?? activeProjectId ?? "";
  if (activeProjectId !== null && projectId !== activeProjectId) {
    return {
      kind: "confirm",
      reason: "cross_project",
      candidates: [{ paneId, projectId }],
      prompt: `'${cand?.paneName ?? paneId}' is in a different project (${cand?.projectName ?? projectId}) — switch there and send it?`,
    };
  }
  return { kind: "bind", paneId, projectId };
}

/** Race the ranker; a rejection or thrown error degrades to null (never escapes to the caller) —
 *  the same "a dead daemon must never widen matching" contract every other ranking seam in this
 *  codebase honors (src/voice/policyClient.ts). */
async function safeRank(
  rank: TargetResolverInput["rank"],
  reference: string,
  candidates: FocusCandidate[],
): Promise<FocusResolution | null> {
  if (!rank) return null;
  try {
    return await rank(reference, candidates);
  } catch {
    return null;
  }
}

/** Classify a ranker resolution using the SAME close-margin rule focusResolver's
 *  classifyResolution applies (closeAlternatives, imported above — the resolver here returns a
 *  decision rather than an ActionResult, so the classification shape differs, but the margin filter
 *  itself is shared, not mirrored by hand): confidence >= 1 is exact; any alternative within
 *  CLOSE_MARGIN of the top confidence makes the pick ambiguous; otherwise it's a fuzzy single match. */
function resolveViaRanker(
  resolution: FocusResolution,
  candidates: FocusCandidate[],
  activeProjectId: string | null,
): TargetDecision {
  // Fail-closed candidate check (step 3.5 review): the ranker names panes, it does not create
  // them — a paneId outside the candidate set (a confused/stale daemon) must clarify, never bind
  // or confirm a ghost target ("a dead daemon must never widen matching", D2).
  if (!candidates.some((c) => c.paneId === resolution.paneId)) {
    return clarifyNoMatch(candidates);
  }
  const close = closeAlternatives(resolution);
  if (close.length > 0) {
    return confirmMultiple([resolution.paneId as string, ...close.map((a) => a.paneId)], candidates);
  }
  if (resolution.confidence >= 1) {
    return bindOrCrossProjectConfirm(resolution.paneId as string, candidates, activeProjectId);
  }
  return confirmFuzzy(resolution.paneId as string, candidates);
}

/** The anaphora row of the decision table (spec §3.2): a live recent referent binds silently (the
 *  operator is continuing the same thread); no referent -> clarify, never a guess at the active
 *  pane. Extracted so resolveTarget stays under the CC<=10 lint gate.
 *
 *  Two fail-closed tightenings (step 3.5 review):
 *   - a referent whose pane is NO LONGER in the candidate set (deleted/archived since it was
 *     recorded — the register is TTL-bounded, not liveness-bounded) clarifies instead of binding
 *     a ghost pane;
 *   - a referent that lives OUTSIDE the active project routes through the cross-project confirm
 *     like every other resolution (spec §3.2's hard rule: "NEVER a silent bind, even for an exact
 *     name" — continuing a thread does not waive the project boundary, because a retarget also
 *     moves the operator's active project/posture context). */
function resolveAnaphora(
  recentReferent: TargetResolverInput["recentReferent"],
  candidates: FocusCandidate[],
  activeProjectId: string | null,
): TargetDecision {
  if (!recentReferent) return clarifyNoMatch(candidates);
  if (!candidates.some((c) => c.paneId === recentReferent.paneId)) {
    return clarifyNoMatch(candidates);
  }
  return bindOrCrossProjectConfirm(recentReferent.paneId, candidates, activeProjectId);
}

/** True when the ranker was absent/dead/empty-handed — the caller falls to clarify (the floor
 *  already said "none"; a dead daemon must never widen matching). */
function rankerMissed(resolution: FocusResolution | null): resolution is null {
  return !resolution || resolution.paneId === null || resolution.confidence <= 0;
}

/**
 * Resolve a spoken instruction-target reference into a plain-data decision (spec §3). Pure
 * data-in/data-out over its inputs: never mutates candidates/input, never binds focus, never
 * throws (a rejecting ranker degrades to the deterministic floor). Exact beats the ranker: the
 * floor is always evaluated first, and the ranker is consulted ONLY when the floor finds nothing.
 */
export async function resolveTarget(input: TargetResolverInput): Promise<TargetDecision> {
  const candidates = input.candidates;
  const reference = (input.reference ?? "").trim();

  if (!reference) return clarifyNoMatch(candidates);
  if (isAnaphora(reference)) return resolveAnaphora(input.recentReferent, candidates, input.activeProjectId);

  const floor = resolveFloor(reference, candidates);
  if (floor.kind === "bind") return bindOrCrossProjectConfirm(floor.paneId, candidates, input.activeProjectId);
  if (floor.kind === "multiple") return confirmMultiple(floor.paneIds, candidates);
  if (floor.kind === "clarify_deterministic") return clarifyNoMatch(candidates);

  // floor.kind === "none": the deterministic tiers found nothing — ranking is additive recall for
  // fuzzy references only (never a silent bind below confidence 1).
  const rankResult = await safeRank(input.rank, reference, candidates);
  if (rankerMissed(rankResult)) return clarifyNoMatch(candidates);
  return resolveViaRanker(rankResult, candidates, input.activeProjectId);
}
