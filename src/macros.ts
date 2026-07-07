// src/macros.ts — VOICE MACROS (8fz.6): a persisted, user-named phrase that fans out to an ORDERED
// group of per-pane instructions, FIRED by a routed utterance and expanded through the EXISTING
// dispatch_group staging kernel — every step forceStaged, one approval batch, never auto-executed.
//
// SEAM (per the python/ts ADR): phrase CLASSIFICATION (pure, per-utterance, non-hot) is Python's job
// via the "policies" daemon (macro.match) with a fail-closed SYNCHRONOUS TS exact-match fallback —
// the resolve_focus precedent. STORAGE (SQLite), STAGING (forceStage through the gate choke-point),
// and TRANSPORT stay TypeScript. This module owns the pure pieces: the type, the fallback matcher,
// the creation-time phrase validator, the match orchestration, and the fire→stage expansion helper.
//
// SAFETY (the load-bearing invariant): a macro can NEVER silently execute N writes. fireMacro routes
// EVERY step through the shared stageDispatchGroup kernel with forceStage:true and a DISTINCT
// per-step synthetic pendingId, joined by ONE dispatch group — identical semantics to
// dispatch_to_panes. A step whose pane cannot be resolved lands as a REFUSED entry in the group
// narration (never a guess). Firing is reached ONLY when approval-intent routing has declined
// (parsed.intent === "none"), AFTER the spoken destructive-confirm interceptor — so a macro phrase
// can never shadow "approve"/"yes" during a pending confirm. Authoring is REST/UI-only (operator
// decision 2026-07-06); voice can FIRE a macro but can never DEFINE or MODIFY one.

import { normalizeUtterance, parseApprovalIntent } from "./approvalIntent";
import { CONFIRM_PHRASES } from "./voice/spokenConfirm";
import { stageDispatchGroup, narrateDispatch, type StageTarget } from "./actions/defs/dispatch_group";
import { collectFocusCandidates, literalResolve } from "./voice/focusResolver";
import type { ActionContext } from "./actions/types";
import type { PythonPolicyClient } from "./voice/policyClient";

/** One ordered step of a macro: a pane referenced BY NAME (resolved at fire time) + its instruction. */
export interface MacroStep {
  /** The target pane, stored by NAME and resolved at fire time via the shipped focus resolver. */
  paneName: string;
  /** The instruction text staged toward that pane (a pending approval — never auto-run). */
  instruction: string;
}

/** A persisted voice macro: a user-named phrase mapping to an ordered group of per-pane steps. */
export interface Macro {
  id: string;
  /** The spoken trigger phrase, matched (normalized exact + bounded fuzzy) against routed utterances. */
  phrase: string;
  /** A human label (the join group is named after it; spoken back on fire). */
  name: string;
  steps: MacroStep[];
  created_at: number;
  updated_at: number;
}

// ── reserved-vocabulary phrase validation (creation-time, fail-closed) ────────────────────────────

/**
 * Voice command vocabulary a macro phrase may NOT collide with (normalized): the emergency brake, the
 * wake words, and the spoken destructive-confirm / window-cancel words. A macro named "yes"/"go ahead"
 * is separately rejected by the parseApprovalIntent guard below. Explicitly enumerated + extensible.
 */
const RESERVED_PHRASE_LITERALS: readonly string[] = [
  // Emergency brake (registry.ts stop_all / confirm_stop_all / release_stop_all trigger words).
  "stop", "halt", "abort", "freeze", "stop everything", "kill them", "kill", "release", "resume",
  // Wake words.
  "janus", "hey janus", "ok janus",
  // Spoken destructive-confirm window-cancel words (spokenConfirm WINDOW_CANCEL_WORDS mirror).
  "cancel", "never mind", "nevermind",
  // Affirmation-adjacent phrases the approval parser DELIBERATELY treats as ambient (bare verb+pronoun
  // "go ahead"/"send it"/… never resolve a vote), but which a human hears as a confirm — a macro must
  // not be named one (the operator explicitly named "go ahead" as must-be-uncreatable).
  "go ahead", "send it", "run it", "do it", "go for it", "lets go", "make it so", "proceed",
];

/** The reserved set, NORMALIZED once at load so comparison is normalization-stable (mirrors the
 *  approval parser's normalizeUtterance so "Stop!" / "stop." / "STOP" all collapse to "stop"). */
const RESERVED_MACRO_PHRASES: ReadonlySet<string> = new Set([
  ...RESERVED_PHRASE_LITERALS.map(normalizeUtterance),
  // The spoken-confirm action-echo phrases ("confirm delete" / "confirm clear").
  ...Object.values(CONFIRM_PHRASES).map(normalizeUtterance),
]);

export type PhraseValidation = { ok: true } | { ok: false; reason: string };

/**
 * Validate a macro phrase at CREATION. Rejects (fail-closed): an empty phrase; any phrase that parses
 * as an approval / reject / defer intent (so it can never shadow a voice approval vote); and any
 * reserved wake / emergency-brake / spoken-confirm phrase. This is the PRIMARY defense — a macro
 * named "yes" or "go ahead" is uncreatable, so it can never reach the firing path at all.
 */
export function validateMacroPhrase(phrase: string): PhraseValidation {
  const normalized = normalizeUtterance(phrase);
  if (!normalized) return { ok: false, reason: "A macro phrase cannot be empty." };
  if (parseApprovalIntent(phrase).intent !== "none") {
    return {
      ok: false,
      reason: `'${phrase}' parses as an approve/reject/defer command and would shadow voice approvals — choose a distinct phrase.`,
    };
  }
  if (RESERVED_MACRO_PHRASES.has(normalized)) {
    return {
      ok: false,
      reason: `'${phrase}' is a reserved voice command (wake word, emergency brake, or confirm vocabulary) and cannot be a macro phrase.`,
    };
  }
  return { ok: true };
}

// ── matching (Python primary + synchronous TS exact-match fallback) ───────────────────────────────

/**
 * The SYNCHRONOUS, fail-closed TS floor: a NORMALIZED EXACT phrase match, never fuzzy. Used when the
 * policies daemon is absent / timed out / rejected — a dead daemon must never widen matching beyond
 * this exact floor (the resolve_focus fallback contract). Deterministic: first phrase (insertion
 * order) whose normalized form equals the normalized utterance.
 */
export function matchMacroLocal(utterance: string, macros: readonly Macro[]): Macro | null {
  const norm = normalizeUtterance(utterance);
  if (!norm) return null;
  return macros.find((m) => normalizeUtterance(m.phrase) === norm) ?? null;
}

/** The macro-match gate: firing is attempted ONLY when approval-intent routing declined. Exported so
 *  the invariant "an approval/defer utterance NEVER reaches macro matching" is unit-lockable. */
export function macroMatchAllowed(parsedIntent: string): boolean {
  return parsedIntent === "none";
}

/**
 * Match a routed utterance against the stored phrases: Python (macro.match — normalized exact +
 * bounded fuzzy) is PRIMARY; the synchronous TS exact matcher is the fail-closed floor when the
 * daemon is unavailable. NEVER throws into the voice loop and NEVER fails open (a daemon error is a
 * facade null → TS floor, not a match). Returns the matched Macro or null.
 */
export async function matchMacroUtterance(
  utterance: string,
  macros: readonly Macro[],
  policies: Pick<PythonPolicyClient, "matchMacro"> | undefined | null,
): Promise<Macro | null> {
  if (!macros.length) return null;
  const entries = macros.map((m) => ({ id: m.id, phrase: m.phrase }));
  // policies?.matchMacro resolves null on ANY daemon miss (down/timeout/schema/ok:false) → TS floor.
  // A RAN daemon returns { id } (id may be null = definitive no-match, broader than TS exact). An
  // absent method (a test double / pre-macro facade) is treated exactly like a miss → TS floor.
  const py = policies?.matchMacro ? await policies.matchMacro(utterance, entries) : null;
  const id = py ? py.id : matchMacroLocal(utterance, macros)?.id ?? null;
  return id ? macros.find((m) => m.id === id) ?? null : null;
}

// ── fire → stage (expansion reuses the dispatch_group forceStage kernel EXACTLY) ──────────────────

export interface MacroFireResult {
  groupId: string;
  staged: string[];
  refused: string[];
  /** The spoken read-back (narrateDispatch shape). */
  output: string;
}

/**
 * Resolve one step's pane NAME to a live pane id via the shipped focus resolver (Python primary, the
 * literal TS floor as fallback), accepting ONLY a confident EXACT match (confidence >= 1). A fuzzy /
 * low-confidence resolution is a GUESS — refused, never bound (a macro must never write to a pane the
 * operator did not name). Returns null when the name resolves to nothing confident.
 */
async function resolveStepPane(
  ctx: ActionContext,
  paneName: string,
  candidates: ReturnType<typeof collectFocusCandidates>,
): Promise<string | null> {
  const resolution = (await ctx.policies?.resolveFocus(paneName, candidates)) ?? literalResolve(paneName, candidates);
  return resolution.paneId && resolution.confidence >= 1 ? resolution.paneId : null;
}

/**
 * Expand a matched macro: resolve each step's pane, stage EVERY resolved step through the shared
 * stageDispatchGroup kernel (forceStage:true, one join group named after the macro, distinct per-step
 * pendingIds), and fold unresolvable steps in as REFUSED entries. Returns the group id + staged/refused
 * tallies + the spoken narration. NEVER auto-executes (the kernel's forceStage invariant).
 */
export async function fireMacro(ctx: ActionContext, macro: Macro): Promise<MacroFireResult> {
  const candidates = collectFocusCandidates(ctx);
  const targets: StageTarget[] = [];
  const unresolved: string[] = [];
  for (let i = 0; i < macro.steps.length; i++) {
    const step = macro.steps[i];
    const paneId = await resolveStepPane(ctx, step.paneName, candidates);
    if (paneId) targets.push({ key: `step${i}__${paneId}`, paneId, instruction: step.instruction });
    else unresolved.push(step.paneName);
  }
  const unresolvedRefusals = unresolved.map((n) => `${n} (no such pane)`);
  // Empty-group guard: if EVERY step failed pane resolution, staging would create a members:[] join
  // group that can never complete (DispatchJoinTracker.noteTransition only settles via members) and
  // would broadcast a phantom dispatch_updated to the board. Skip the kernel entirely; narrate the
  // refusals only. (A partial resolution still stages the resolved steps below.)
  if (targets.length === 0) {
    return { groupId: "", staged: [], refused: unresolvedRefusals, output: narrateDispatch(macro.name, "", [], unresolvedRefusals) };
  }
  const trigger = `Macro '${macro.name}'`;
  const { groupId, staged, refused } = stageDispatchGroup(ctx, macro.name, `Macro '${macro.name}'`, targets, trigger);
  const allRefused = [...refused, ...unresolvedRefusals];
  return { groupId, staged, refused: allRefused, output: narrateDispatch(macro.name, groupId, staged, allRefused) };
}

/** Mint a stable macro id (the promptTemplates precedent: tpl_ / here mac_). */
export function newMacroId(now: number = Date.now()): string {
  return "mac_" + now.toString(36) + Math.random().toString(36).slice(2, 7);
}
