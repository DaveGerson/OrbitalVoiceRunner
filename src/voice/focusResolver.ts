// src/voice/focusResolver.ts — focus_pane (voice-UX wave 3, spec D1 + D4 + decision record #2).
// Sole owner: fz1.
//
// Pipeline: collectFocusCandidates -> (ctx.policies?.resolveFocus ?? literalResolve) -> bind policy
// (voiceUx.focusBindPolicy) -> ONE bind path (bindFocus), which mirrors switch_active_pane exactly
// (Off-veto via ctx.effectiveCapabilityGateFor, existence via findPaneOwningProject, then
// ctx.setActivePane + ctx.broadcast). NO per-session focusedPaneId shadow state (D1) — every
// wrong-pane write guard stays the enforcement layer that already exists.
//
// FALLBACK CONTRACT (D2): a dead/timed-out/rejecting policies daemon degrades to literalResolve,
// which is fail-closed and NEVER fuzzy (exact name/id match, then unique-prefix, then exact ordinal
// word/digit) — a dead daemon must never widen matching.
import type { ActionContext, ActionResult } from "../actions/types";
import type { FocusCandidate, FocusResolution } from "./policyClient";
import { DEFAULT_VOICE_UX, type VoiceUxSettings } from "../types";
import { findPaneOwningProject } from "../paneOwnership";

// ── candidate collection ────────────────────────────────────────────────────────────────────────

/**
 * Gather every pane the operator might mean, in ctx.manager.listPanes() display order (the ordinal
 * the operator hears when panes are announced). Defensive against panes with no LIVE terminal
 * (archived/ledger-only records): falls back to the persisted PaneMeta fields.
 */
export function collectFocusCandidates(ctx: ActionContext): FocusCandidate[] {
  const activePaneId = ctx.getActivePaneId();
  const candidates: FocusCandidate[] = [];
  let ordinal = 0;
  for (const group of ctx.manager.listPanes() as Array<{ project_id: string; panes: Array<Record<string, unknown>> }>) {
    const projectId = group.project_id;
    const projectName = ctx.manager.ledger.workspaces?.[projectId]?.name ?? projectId;
    for (const pane of group.panes ?? []) {
      ordinal += 1;
      candidates.push(buildCandidate(ctx, pane, projectId, projectName, ordinal, activePaneId));
    }
  }
  return candidates;
}

type LiveTerm = { toolPreset: string; status: string; lastStatusChangeAt: number } | undefined;

function candidatePresetLabel(term: LiveTerm, pane: Record<string, unknown>): string | null {
  if (term) return term.toolPreset;
  return typeof pane.tool_preset === "string" ? pane.tool_preset : null;
}

function candidateState(term: LiveTerm, pane: Record<string, unknown>): string {
  if (term) return term.status;
  return typeof pane.last_known_state === "string" ? pane.last_known_state : "Unknown";
}

function candidateIsBusy(term: LiveTerm, pane: Record<string, unknown>): boolean {
  return term ? term.status === "Running" : !!pane.is_busy;
}

function candidateLastActiveAt(term: LiveTerm, pane: Record<string, unknown>): number {
  if (term) return term.lastStatusChangeAt;
  const iso = typeof pane.last_status_change_at === "string" ? pane.last_status_change_at : null;
  return iso ? Date.parse(iso) : 0;
}

function buildCandidate(
  ctx: ActionContext,
  pane: Record<string, unknown>,
  projectId: string,
  projectName: string,
  ordinal: number,
  activePaneId: string | null,
): FocusCandidate {
  const paneId = String(pane.pane_id);
  const term = ctx.manager.terminals[paneId] as LiveTerm;
  return {
    paneId,
    paneName: (typeof pane.name === "string" && pane.name) || paneId,
    projectId,
    projectName,
    presetLabel: candidatePresetLabel(term, pane),
    ordinal,
    state: candidateState(term, pane),
    isBusy: candidateIsBusy(term, pane),
    lastActiveAt: candidateLastActiveAt(term, pane),
    isActive: paneId === activePaneId,
  };
}

// ── literal (fail-closed) TS floor ──────────────────────────────────────────────────────────────

const ORDINAL_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

/** Parse an EXACT ordinal ("two", "2", "pane two", "pane number 2") — never fuzzy, structural only. */
function ordinalFromReference(reference: string): number | null {
  const trimmed = reference.trim().toLowerCase();
  const direct = parseOrdinalToken(trimmed);
  if (direct !== null) return direct;
  const m = trimmed.match(/^pane(?:\s+number)?\s+(\S+)$/);
  return m ? parseOrdinalToken(m[1]) : null;
}

function parseOrdinalToken(token: string): number | null {
  if (/^\d+$/.test(token)) {
    const n = parseInt(token, 10);
    return n > 0 ? n : null;
  }
  const idx = ORDINAL_WORDS.indexOf(token);
  return idx > 0 ? idx : null;
}

/**
 * The fail-closed literal TS floor (D2): case-insensitive EXACT name/id match, then UNIQUE-PREFIX on
 * pane name, then an exact ordinal word/digit. Anything else -> no match, confidence 0, alternatives
 * = the top name-prefix hits (or the tied exact matches, if the ambiguity came from a name collision).
 * NEVER fuzzy — a dead daemon must not widen matching beyond this.
 */
export function literalResolve(reference: string, candidates: FocusCandidate[]): FocusResolution {
  const lower = reference.trim().toLowerCase();
  if (!lower) return { paneId: null, confidence: 0, alternatives: [] };

  const exact = candidates.filter((c) => c.paneName.toLowerCase() === lower || c.paneId.toLowerCase() === lower);
  if (exact.length === 1) return resolvedExact(exact[0].paneId);

  const prefix = candidates.filter((c) => c.paneName.toLowerCase().startsWith(lower));
  if (exact.length === 0 && prefix.length === 1) return resolvedExact(prefix[0].paneId);

  if (exact.length === 0 && prefix.length === 0) {
    const ordinal = ordinalFromReference(reference);
    if (ordinal !== null) {
      const match = candidates.find((c) => c.ordinal === ordinal);
      if (match) return resolvedExact(match.paneId);
    }
  }

  const ambiguous = exact.length > 1 ? exact : prefix;
  return {
    paneId: null,
    confidence: 0,
    alternatives: ambiguous.slice(0, 5).map((c) => ({ paneId: c.paneId, score: 0 })),
  };
}

function resolvedExact(paneId: string): FocusResolution {
  return { paneId, confidence: 1, alternatives: [] };
}

// ── the ONE bind path (D1) — mirrors switch_active_pane exactly ────────────────────────────────

type BindOutcome = { ok: true } | { ok: false; reason: "gated" | "missing" };

/**
 * bindFocus — the ONE path that mutates the active-pane source of truth (D1: no shadow focus
 * state). FAITHFUL mirror of switchActivePane's handler (src/actions/defs/panes_write.ts):
 * Off-veto via ctx.effectiveCapabilityGateFor, existence via findPaneOwningProject, then
 * ctx.setActivePane + ctx.broadcast({type:'switch_active_pane'}).
 */
export function bindFocus(ctx: ActionContext, paneId: string): BindOutcome {
  if (ctx.effectiveCapabilityGateFor(paneId, "focus_pane") === "Off") {
    return { ok: false, reason: "gated" };
  }
  const term = ctx.manager.terminals[paneId];
  const paneExists = !!term || !!findPaneOwningProject(ctx.manager, paneId);
  if (!paneExists) {
    return { ok: false, reason: "missing" };
  }
  ctx.setActivePane(paneId);
  ctx.broadcast({ type: "switch_active_pane", paneId });
  return { ok: true };
}

// ── resolution classification + bind-policy application ────────────────────────────────────────

type Classification =
  | { kind: "none" }
  | { kind: "multiple"; ids: string[] }
  | { kind: "fuzzy" }
  | { kind: "exact" };

/**
 * Classify a FocusResolution into the four spec buckets. confidence===1 is treated as an
 * unconditional exact/unique match (silent-bind eligible) regardless of any alternatives the
 * (possibly fuzzy) policy scorer also reported. Otherwise: any alternative within the 0.15 margin
 * of the top confidence makes the pick ambiguous ("multiple"); zero close alternatives is "fuzzy".
 */
function classifyResolution(resolution: FocusResolution): Classification {
  if (!resolution.paneId || resolution.confidence <= 0) return { kind: "none" };
  if (resolution.confidence >= 1) return { kind: "exact" };
  const close = resolution.alternatives.filter(
    (a) => a.paneId !== resolution.paneId && resolution.confidence - a.score <= 0.15,
  );
  if (close.length > 0) {
    return { kind: "multiple", ids: [resolution.paneId, ...close.map((a) => a.paneId)] };
  }
  return { kind: "fuzzy" };
}

function candidateName(candidates: FocusCandidate[], paneId: string): string {
  return candidates.find((c) => c.paneId === paneId)?.paneName ?? paneId;
}

function formatNameList(names: string[]): string {
  const quoted = names.map((n) => `'${n}'`);
  if (quoted.length === 0) return "";
  if (quoted.length === 1) return quoted[0];
  if (quoted.length === 2) return `${quoted[0]} or ${quoted[1]}`;
  return `${quoted.slice(0, -1).join(", ")}, or ${quoted[quoted.length - 1]}`;
}

function bindAndNarrate(ctx: ActionContext, paneId: string, candidates: FocusCandidate[], echo: boolean): ActionResult {
  const bind = bindFocus(ctx, paneId);
  // NOTE: `bind.ok === false` (not `!bind.ok`) — TS's narrowing on a negated boolean-discriminant
  // property does not always exclude the `{ ok: true }` union member here; the explicit comparison
  // narrows reliably.
  if (bind.ok === false) {
    if (bind.reason === "gated") {
      return { kind: "ok", output: "Error: the 'focus_pane' capability is gated Off; switching the open pane is forbidden by policy." };
    }
    return { kind: "ok", output: `Cannot switch: pane '${paneId}' does not exist.` };
  }
  const text = echo ? `Focusing '${candidateName(candidates, paneId)}'.` : `Focused pane '${paneId}'.`;
  return { kind: "ok", output: text };
}

function clarifyFuzzy(paneId: string, candidates: FocusCandidate[]): ActionResult {
  return {
    kind: "clarify",
    text: `Did you mean ${formatNameList([candidateName(candidates, paneId)])}? Say yes and I'll focus it, or name another pane.`,
  };
}

function clarifyMultiple(ids: string[], candidates: FocusCandidate[]): ActionResult {
  const names = ids.slice(0, 3).map((id) => candidateName(candidates, id));
  return { kind: "clarify", text: `Which pane did you mean — ${formatNameList(names)}?` };
}

function clarifyNoMatch(candidates: FocusCandidate[]): ActionResult {
  if (candidates.length === 0) {
    return { kind: "clarify", text: "I don't see any panes open right now." };
  }
  const names = candidates.slice(0, 5).map((c) => c.paneName);
  return { kind: "clarify", text: `I didn't catch which pane you meant. Panes I see: ${formatNameList(names)}.` };
}

/** Apply voiceUx.focusBindPolicy to a fuzzy-unique resolution ("confirm" default | "echo" | "tiered"). */
function applyFuzzyPolicy(
  resolution: FocusResolution,
  candidates: FocusCandidate[],
  ctx: ActionContext,
  policy: VoiceUxSettings["focusBindPolicy"],
): ActionResult {
  const paneId = resolution.paneId as string; // classifyResolution guarantees non-null for "fuzzy"
  if (policy === "echo") return bindAndNarrate(ctx, paneId, candidates, true);
  if (policy === "tiered") {
    return resolution.confidence >= 0.8
      ? bindAndNarrate(ctx, paneId, candidates, true)
      : clarifyFuzzy(paneId, candidates);
  }
  return clarifyFuzzy(paneId, candidates); // "confirm" (default)
}

function applyResolution(
  resolution: FocusResolution,
  candidates: FocusCandidate[],
  ctx: ActionContext,
  policy: VoiceUxSettings["focusBindPolicy"],
): ActionResult {
  const cls = classifyResolution(resolution);
  switch (cls.kind) {
    case "none":
      return clarifyNoMatch(candidates);
    case "multiple":
      return clarifyMultiple(cls.ids, candidates);
    case "exact":
      return bindAndNarrate(ctx, resolution.paneId as string, candidates, false);
    case "fuzzy":
    default:
      return applyFuzzyPolicy(resolution, candidates, ctx, policy);
  }
}

// ── entry point ──────────────────────────────────────────────────────────────────────────────────

export async function runFocusPane(reference: string, ctx: ActionContext): Promise<ActionResult> {
  try {
    const candidates = collectFocusCandidates(ctx);
    const policyResolution = await ctx.policies?.resolveFocus(reference, candidates);
    const resolution = policyResolution ?? literalResolve(reference, candidates);
    const policy = (ctx.manager.settings.voiceUx ?? DEFAULT_VOICE_UX).focusBindPolicy;
    return applyResolution(resolution, candidates, ctx, policy);
  } catch {
    // Never throw (mirrors runStatusSummary's doctrine) — degrade to a safe clarify.
    return { kind: "clarify", text: "I couldn't resolve that pane reference — try naming it more specifically." };
  }
}
