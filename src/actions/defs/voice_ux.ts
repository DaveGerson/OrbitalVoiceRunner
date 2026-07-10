/**
 * src/actions/defs/voice_ux.ts — voice-UX trio (wave 3): get_status_summary + focus_pane.
 *
 * SCAFFOLD-OWNED, NEVER edited by implementers — this file holds BOTH new tool defs with FINAL
 * metadata (names, params, descriptions, capability rows). Handlers are one-line delegations to
 * feature-owned modules; implementers change behavior only inside their own delegate module
 * (src/voice/sitrep.ts — hwu1, src/voice/focusResolver.ts — fz1), so registry/catalog/coverage/
 * gemini-declarations output is frozen at scaffold time and `npm run catalog` is already final.
 */

import { z } from "zod";
import type { ActionDef, ActionContext, ActionResult } from "../types";
import { ALWAYS_ALLOWED } from "../types";
import { runStatusSummary } from "../../voice/sitrep";
import { runFocusPane, collectFocusCandidates } from "../../voice/focusResolver";
import { resolveTarget, type TargetResolverInput } from "../../voice/targetResolver";
import { normalizePreset } from "../../terminal";
import {
  buildEnvelope,
  createDraft,
  reviseDraft,
  recordSend,
  renderEnvelope,
  renderedOverflow,
  assessReadiness,
  RENDER_PROFILES,
  type EnvelopeDraft,
  type ReviseDraftPatch,
  type RenderProfile,
} from "../../exchanges/instructionEnvelope";
import {
  getOpenDraft,
  setOpenDraft,
  clearOpenDraft,
  hasProseOverride,
  clearProseOverride,
  recordRecentReferent,
  getRecentReferent,
  bindApprovalToDraft,
  getApprovalBinding,
  clearApprovalBinding,
  invalidateOutstandingApproval,
} from "../../exchanges/draftRegistry";
import type { DispatchOutcome } from "../types";

const NoParams = z.object({});

export const getStatusSummary: ActionDef<typeof NoParams> = {
  name: "get_status_summary",
  description:
    "Speak a prioritized situation report (SITREP): what needs your action first (pending approvals), then what's busy or running a plan, then alerts, then idle panes. Honors the operator's sitrepShape preference (brief/walk/full). Cheap orientation call — the conversational sibling of list_panes + get_attention_digest.",
  params: NoParams,
  // rm4: ALWAYS_ALLOWED — this composes ONLY already-ungated orientation/alert surfaces (pane
  // existence/status metadata, the attention queue, pending-approval summaries, plan status). read_pane/
  // read_notes gate CONTENT recall, not orientation (docs/design/capability-gate-worksheet.md); same
  // rationale row as get_attention_digest. It adds no capability row and can never leak gated content
  // because the composer only touches the surfaces listed above (all pre-redacted via ctx.redact).
  capability: ALWAYS_ALLOWED,
  // readOnly:false — NOT because the output skips redaction (composeSitrep pre-redacts every field
  // it touches via ctx.redact before this handler ever sees it), but because the §8.1 invariant
  // (tests/test_action_registry.ts) binds readOnly:true ONLY to the read_pane/read_notes capabilities;
  // an ALWAYS_ALLOWED action must be readOnly:false to satisfy it. Same resolution as
  // get_stop_all_status (src/actions/defs/reads.ts) for the identical ALWAYS_ALLOWED-vs-readOnly conflict.
  readOnly: false,
  surfaces: new Set(["voice"]),
  handler: (_args, ctx) => runStatusSummary(ctx),
};

const FocusPaneParams = z.object({ reference: z.string() });

export const focusPane: ActionDef<typeof FocusPaneParams> = {
  name: "focus_pane",
  description:
    "Resolve a spoken reference to a pane ('the build pane', 'the stuck one', 'pane two', 'that one') and make it the active pane. Use when the operator names a pane conversationally; use switch_active_pane only when you already hold an exact pane id. Changes focus only; never runs a command.",
  params: FocusPaneParams,
  capability: "focus_pane", // the EXISTING promoted row (Auto default, veto enforcement) — NO new capabilities.ts row (D4)
  readOnly: false,
  surfaces: new Set(["voice"]),
  handler: (args, ctx) => runFocusPane(args.reference, ctx),
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Exchange-aware instruction-envelope voice verbs (Phase 3, Step 3.3; spec
// docs/superpowers/specs/2026-07-09-instruction-routing.md §3-§5). NEW section, NOT part of the
// wave-3 scaffold above — owned by this step. Six verbs operate on the per-pane InstructionEnvelope
// draft (src/exchanges/instructionEnvelope.ts), converged onto the EXISTING panes.draft ledger
// column (spec §5.2) so the Workbench UI needs zero client change: every render mirrors into
// ctx.manager.ledger.setDraft(...) + ctx.broadcastDraft(...), exactly like update_draft_prompt.
//
// Discovery (b) from the spec: update_draft_prompt is active-pane-only (no pane_id param) — so
// draft_instruction/revise_instruction/cancel_instruction/send_instruction all inherit the
// PANE-SCOPED draft off ctx.activeDraftTarget() rather than adding a targeted-compose verb.
// retarget_instruction is the ONE verb that calls the target resolver (src/voice/targetResolver.ts)
// to MOVE an existing draft to a different pane; confirm_instruction finalizes a retarget whose
// resolution needed a spoken confirm (fuzzy / multiple / cross-project — spec §3.2/§4) by naming
// the exact pane id the operator picked.
//
// Gating: draft/revise/retarget/cancel/confirm are ungated (compose_draft, Off-veto only — mirrors
// update_draft_prompt exactly); send_instruction rides the EXISTING dispatchProposal HiTL
// choke-point (write_to_pane), unchanged from propose_command's own gating — the envelope layer
// never gates and never bypasses the capability matrix (spec §2.2, §8 non-goal #3).

function composeDraftOffText(): ActionResult {
  return {
    kind: "ok",
    output: "Error: the 'compose_draft' capability is gated Off; composing drafts is forbidden by policy.",
  };
}

function noPaneOpenText(verb: string): ActionResult {
  return { kind: "ok", output: `No pane is open, so there is no instruction draft to ${verb}.` };
}

function noOpenDraftText(paneId: string): ActionResult {
  return {
    kind: "ok",
    output: `There is no open instruction draft for pane '${paneId}' yet — use draft_instruction first.`,
  };
}

/** The EXISTING focus.resolve ranking seam (src/voice/policyClient.ts), injected null-chained per
 *  D2 — an absent/dead daemon falls to the target resolver's own deterministic floor. */
function rankerFor(ctx: ActionContext): TargetResolverInput["rank"] {
  if (!ctx.policies) return undefined;
  const policies = ctx.policies;
  return (reference, candidates) => policies.resolveFocus(reference, candidates);
}

async function resolveInstructionTarget(reference: string, ctx: ActionContext) {
  return resolveTarget({
    reference,
    candidates: collectFocusCandidates(ctx),
    activeProjectId: ctx.manager.ledger.activeProjectId ?? null,
    explicitProject: null,
    recentReferent: getRecentReferent(),
    rank: rankerFor(ctx),
  });
}

function renderProfileForPane(paneId: string, ctx: ActionContext): RenderProfile {
  const candidate = collectFocusCandidates(ctx).find((c) => c.paneId === paneId);
  const preset = normalizePreset(candidate?.presetLabel ?? undefined);
  return RENDER_PROFILES[preset] ?? RENDER_PROFILES.Custom;
}

/** Render -> mirror bridge (spec §5.2): every envelope render is mirrored into the ledger draft
 *  UNLESS the operator's typed hand-edit currently overrides the prose (prose-authoritative mode —
 *  a subsequent voice field revision clears the override BEFORE this runs, see reviseInstruction). */
function mirrorDraftToLedger(projectId: string, paneId: string, draft: EnvelopeDraft, ctx: ActionContext): void {
  if (hasProseOverride(projectId, paneId)) return;
  const rendered = renderEnvelope(draft.envelope, renderProfileForPane(paneId, ctx));
  ctx.manager.ledger.setDraft(projectId, paneId, rendered, "janus");
  ctx.broadcastDraft(projectId, paneId);
}

/** Every draft-version-bumping voice path routes through here (spec §4: "the old approval can
 *  never fire against new text") — a revision/retarget with a pending approval outstanding
 *  invalidates that approval through the one resolve choke-point (ctx.applyResolution). */
function invalidateApprovalForVoiceRevise(projectId: string, paneId: string, ctx: ActionContext): void {
  invalidateOutstandingApproval(projectId, paneId, (messageId, mode) => ctx.applyResolution(messageId, mode));
}

function draftPatchFromArgs(args: {
  objective?: string;
  relevant_context?: string[];
  constraints?: string[];
  requested_output?: string | null;
  completion_signal?: string | null;
}): ReviseDraftPatch {
  return {
    objective: args.objective,
    relevantContext: args.relevant_context,
    constraints: args.constraints,
    requestedOutput: args.requested_output === undefined ? undefined : args.requested_output,
    completionSignal: args.completion_signal === undefined ? undefined : args.completion_signal,
  };
}

const InstructionFieldsParams = z.object({
  objective: z.string().optional(),
  relevant_context: z.array(z.string()).optional(),
  constraints: z.array(z.string()).optional(),
  requested_output: z.string().nullable().optional(),
  completion_signal: z.string().nullable().optional(),
});

const DraftInstructionParams = InstructionFieldsParams.extend({ objective: z.string() });

export const draftInstruction: ActionDef<typeof DraftInstructionParams> = {
  name: "draft_instruction",
  description:
    "Compose (or revise) the structured instruction envelope for the pane the operator currently has open — objective plus, only when the operator said them, context/constraints/requested response shape/completion signal. This distills the conversation into a communication contract for the agent; it never invents technical steps. Writes the pane's WIP draft (review/edit like any draft) but never sends. Use send_instruction to send once ready.",
  params: DraftInstructionParams,
  capability: "compose_draft",
  readOnly: false,
  surfaces: new Set(["voice"]),
  handler: (args, ctx): ActionResult => {
    if (ctx.effectiveCapabilityGateFor(null, "compose_draft") === "Off") return composeDraftOffText();
    const target = ctx.activeDraftTarget();
    if (!target) return noPaneOpenText("draft");
    const existing = getOpenDraft(target.projectId, target.paneId);
    const patch = draftPatchFromArgs(args);
    const draft = existing ? reviseDraft(existing, patch) : createDraft({ target, envelope: buildEnvelope(patch) });
    // A version bump supersedes any approval staged from the prior version (spec §4).
    if (existing) invalidateApprovalForVoiceRevise(target.projectId, target.paneId, ctx);
    setOpenDraft(target.projectId, target.paneId, draft);
    clearProseOverride(target.projectId, target.paneId);
    recordRecentReferent(target.paneId, target.projectId);
    mirrorDraftToLedger(target.projectId, target.paneId, draft, ctx);
    return {
      kind: "ok",
      output: `Drafted for pane '${target.paneId}': ${draft.envelope.objective}. Say 'send it' when ready.`,
    };
  },
};

export const reviseInstruction: ActionDef<typeof InstructionFieldsParams> = {
  name: "revise_instruction",
  description:
    "Revise the instruction envelope currently drafted for the operator's open pane — change the objective and/or add/replace operator-stated context, constraints, requested response shape, or completion signal. Only touches the fields you pass. Re-renders and re-mirrors the draft (unless the operator hand-edited the draft text directly, which this leaves alone until the next voice revision).",
  params: InstructionFieldsParams,
  capability: "compose_draft",
  readOnly: false,
  surfaces: new Set(["voice"]),
  handler: (args, ctx): ActionResult => {
    if (ctx.effectiveCapabilityGateFor(null, "compose_draft") === "Off") return composeDraftOffText();
    const target = ctx.activeDraftTarget();
    if (!target) return noPaneOpenText("revise");
    const existing = getOpenDraft(target.projectId, target.paneId);
    if (!existing) return noOpenDraftText(target.paneId);
    const draft = reviseDraft(existing, draftPatchFromArgs(args));
    // BUG-B (step 3.5): the version bump invalidates any approval staged from the prior version —
    // the stale approval is rejected through the resolve choke-point and can never deliver.
    invalidateApprovalForVoiceRevise(target.projectId, target.paneId, ctx);
    setOpenDraft(target.projectId, target.paneId, draft);
    // A voice field revision always wins over a stale typed hand-edit override (spec §5.2).
    clearProseOverride(target.projectId, target.paneId);
    mirrorDraftToLedger(target.projectId, target.paneId, draft, ctx);
    return { kind: "ok", output: `Updated the instruction draft for pane '${target.paneId}'.` };
  },
};

/**
 * BUG-A (step 3.5): a CONFIRMED cross-project retarget moves the operator's ACTIVE PROJECT through
 * the SAME authoritative switch path switch_context uses (orient.ts — ledger.switchContext + the
 * paired settings writes + broadcastLedgerUpdate + the memory-brief freshness trigger), never a
 * shadow copy. performRetarget already moves the active PANE (ctx.setActivePane); without this
 * paired advance, activeDraftTarget() (server.ts — projectId comes SOLELY from
 * manager.ledger.activeProjectId) reported the OLD project with the NEW pane id, orphaning the
 * just-confirmed draft for every subsequent verb. This also delivers spec §5.3's "project context
 * is re-evaluated": the switch re-briefs the model on the NEW project (injectMemoryBrief), and the
 * safety posture is re-read naturally at send time against the new pane/project.
 *
 * ASYMMETRY-HAZARD NOTE (orient.ts:118-123): switch_context writes settings even when
 * ledger.switchContext no-ops on an unknown id. Here dest.projectId always names a project the
 * resolver/confirm verified against the live candidate set, and we guard anyway — an unknown
 * project is a no-op (the hazard is deliberately NOT replicated onto a second call site).
 */
function advanceActiveProjectForRetarget(destProjectId: string, ctx: ActionContext): void {
  if (ctx.manager.ledger.activeProjectId === destProjectId) return;
  if (!ctx.manager.ledger.getProject(destProjectId)) return;
  ctx.manager.ledger.switchContext(destProjectId);
  ctx.manager.settings.projects.activeContext = destProjectId;
  const wsPath = ctx.manager.ledger.workspaces[destProjectId]?.directory || process.cwd();
  ctx.manager.settings.projects.localWorkspacePath = wsPath;
  ctx.manager.saveSettings();
  ctx.broadcastLedgerUpdate();
  ctx.injectMemoryBrief?.("project_switch");
}

/** Shared move logic for both retarget_instruction (bind from a fresh reference) and
 *  confirm_instruction (bind from an operator-picked candidate id) — spec §5.3: pane_id updates +
 *  version++, the old pane's ledger draft is cleared, the new pane's is written, and the operator's
 *  view follows the move (mirrors create_pane's post-creation setActivePane, panes_write.ts). */
function performRetarget(
  source: { projectId: string; paneId: string },
  dest: { projectId: string; paneId: string },
  existing: EnvelopeDraft,
  ctx: ActionContext,
): ActionResult {
  if (dest.paneId === source.paneId && dest.projectId === source.projectId) {
    return { kind: "ok", output: `The instruction draft is already targeting pane '${dest.paneId}'.` };
  }
  if (getOpenDraft(dest.projectId, dest.paneId)) {
    return {
      kind: "clarify",
      text: `Pane '${dest.paneId}' already has its own open instruction draft — cancel one before retargeting.`,
    };
  }
  // A cross-project retarget IS a context switch — it must honor the same Off veto switch_context
  // enforces (gates only ever tighten; retarget must not become a bypass of that veto).
  if (
    dest.projectId !== ctx.manager.ledger.activeProjectId &&
    ctx.effectiveCapabilityGateFor(null, "switch_context") === "Off"
  ) {
    return {
      kind: "ok",
      output:
        "Error: the 'switch_context' capability is gated Off; retargeting the draft to a pane in a different project is forbidden by policy.",
    };
  }
  const draft = reviseDraft(existing, { target: dest });
  // BUG-B (step 3.5): a retarget is a revision — any approval staged from the old version/target
  // is invalidated before the move (spec §5.3: retarget re-evaluates posture; §4: no stale fire).
  invalidateApprovalForVoiceRevise(source.projectId, source.paneId, ctx);
  clearOpenDraft(source.projectId, source.paneId);
  ctx.manager.ledger.setDraft(source.projectId, source.paneId, "", "janus");
  ctx.broadcastDraft(source.projectId, source.paneId);
  setOpenDraft(dest.projectId, dest.paneId, draft);
  clearProseOverride(dest.projectId, dest.paneId);
  recordRecentReferent(dest.paneId, dest.projectId);
  // BUG-A (step 3.5): advance the active PROJECT through the authoritative switch path BEFORE the
  // pane move so activeDraftTarget() = (new project, new pane) — one consistent focus, no shadow.
  advanceActiveProjectForRetarget(dest.projectId, ctx);
  mirrorDraftToLedger(dest.projectId, dest.paneId, draft, ctx);
  ctx.setActivePane(dest.paneId);
  ctx.broadcast({ type: "switch_active_pane", paneId: dest.paneId });
  return { kind: "ok", output: `Retargeted the instruction draft to pane '${dest.paneId}'.` };
}

const RetargetInstructionParams = z.object({ reference: z.string() });

export const retargetInstruction: ActionDef<typeof RetargetInstructionParams> = {
  name: "retarget_instruction",
  description:
    "Move the instruction draft for the operator's open pane to a DIFFERENT pane the operator names ('send this to the codex pane instead'). Re-resolves the reference exactly like focus_pane; an ambiguous or cross-project reference asks one confirming question first (use confirm_instruction with the exact pane id once the operator answers) rather than guessing.",
  params: RetargetInstructionParams,
  capability: "compose_draft",
  readOnly: false,
  surfaces: new Set(["voice"]),
  handler: async (args, ctx): Promise<ActionResult> => {
    if (ctx.effectiveCapabilityGateFor(null, "compose_draft") === "Off") return composeDraftOffText();
    const source = ctx.activeDraftTarget();
    if (!source) return noPaneOpenText("retarget");
    const existing = getOpenDraft(source.projectId, source.paneId);
    if (!existing) return noOpenDraftText(source.paneId);
    const decision = await resolveInstructionTarget(args.reference, ctx);
    if (decision.kind !== "bind") {
      return { kind: "clarify", text: decision.prompt };
    }
    return performRetarget(source, { projectId: decision.projectId, paneId: decision.paneId }, existing, ctx);
  },
};

const ConfirmInstructionParams = z.object({ pane_id: z.string() });

export const confirmInstruction: ActionDef<typeof ConfirmInstructionParams> = {
  name: "confirm_instruction",
  description:
    "Finalize a pending 'which pane did you mean' / 'did you mean X' / cross-project confirmation for the instruction draft (from retarget_instruction) by naming the EXACT pane id the operator picked. Do not guess — only call this once the operator has answered.",
  params: ConfirmInstructionParams,
  capability: "compose_draft",
  readOnly: false,
  surfaces: new Set(["voice"]),
  handler: (args, ctx): ActionResult => {
    if (ctx.effectiveCapabilityGateFor(null, "compose_draft") === "Off") return composeDraftOffText();
    const source = ctx.activeDraftTarget();
    if (!source) return noPaneOpenText("confirm");
    const existing = getOpenDraft(source.projectId, source.paneId);
    if (!existing) return noOpenDraftText(source.paneId);
    const candidate = collectFocusCandidates(ctx).find((c) => c.paneId === args.pane_id);
    if (!candidate) return { kind: "ok", output: `Cannot confirm: pane '${args.pane_id}' does not exist.` };
    return performRetarget(source, { projectId: candidate.projectId, paneId: candidate.paneId }, existing, ctx);
  },
};

export const cancelInstruction: ActionDef<typeof NoParams> = {
  name: "cancel_instruction",
  description:
    "Cancel the instruction draft for the operator's open pane and clear its WIP draft text. Use when the operator changes their mind before sending.",
  params: NoParams,
  capability: "compose_draft",
  readOnly: false,
  surfaces: new Set(["voice"]),
  handler: (_args, ctx): ActionResult => {
    if (ctx.effectiveCapabilityGateFor(null, "compose_draft") === "Off") return composeDraftOffText();
    const target = ctx.activeDraftTarget();
    if (!target) return noPaneOpenText("cancel");
    if (!getOpenDraft(target.projectId, target.paneId)) return noOpenDraftText(target.paneId);
    // A cancelled draft's staged approval must never deliver (spec §4) — withdraw it too.
    invalidateApprovalForVoiceRevise(target.projectId, target.paneId, ctx);
    clearOpenDraft(target.projectId, target.paneId);
    clearProseOverride(target.projectId, target.paneId);
    ctx.manager.ledger.setDraft(target.projectId, target.paneId, "", "janus");
    ctx.broadcastDraft(target.projectId, target.paneId);
    return { kind: "ok", output: `Cancelled the instruction draft for pane '${target.paneId}'.` };
  },
};

export const sendInstruction: ActionDef<typeof NoParams> = {
  name: "send_instruction",
  description:
    "Send the finished instruction draft for the operator's open pane to its agent. Requires a bound target and a non-empty objective (readiness, not permission — the pane's own capability gate still applies exactly like propose_command: auto-runs in Full Auto, becomes a spoken pending approval in Human-in-the-Loop, blocked in Read-Only). Refuses (with a clarifying question) if the draft is not ready, and refuses a repeat send of an already-sent version.",
  params: NoParams,
  capability: "write_to_pane",
  readOnly: false,
  surfaces: new Set(["voice"]),
  handler: (_args, ctx): ActionResult => {
    const target = ctx.activeDraftTarget();
    if (!target) return noPaneOpenText("send");
    const existing = getOpenDraft(target.projectId, target.paneId);
    if (!existing) return noOpenDraftText(target.paneId);
    const readiness = assessReadiness(existing);
    // NOTE: `readiness.ready === false` (not `!readiness.ready`) — TS's narrowing on a negated
    // boolean-discriminant does not reliably exclude the `{ ready: true }` union member (mirrors
    // focusResolver.ts's bindAndNarrate note on the exact same pattern).
    if (readiness.ready === false) return { kind: "clarify", text: readiness.clarification };
    const sent = recordSend(existing);
    if (sent.ok === false) return duplicateOrUnreadyText(sent.reason, target);
    const profile = renderProfileForPane(target.paneId, ctx);
    const rendered = deliverableTextFor(target, sent.draft, profile, ctx);
    // BUG-D (spec §6.2): an over-limit instruction REFUSES at send — never silent truncation. The
    // draft stays open and UNMARKED (nothing was sent), so the operator shortens it and retries.
    const overflow = renderedOverflow(rendered, profile);
    if (overflow > 0) {
      return {
        kind: "clarify",
        text: `The drafted instruction is ${overflow} characters over pane '${target.paneId}'s ${profile.maxChars}-character limit — shorten it before sending.`,
      };
    }
    const outcome = ctx.dispatchProposal({
      sess: ctx.session,
      callId: ctx.callId ?? "",
      targetId: target.paneId,
      instruction: rendered,
      trigger: ctx.userUtterance || "Instruction envelope send",
    });
    applySendOutcome(target, sent.draft, outcome, ctx);
    return { kind: "ok", output: outcome.text };
  },
};

/** The refusal prose for a send that recordSend rejected. A duplicate version with a LIVE pending
 *  approval names the real remedy (resolve or revise) instead of the generic "already sent". */
function duplicateOrUnreadyText(
  reason: "duplicate_version" | "not_ready",
  target: { projectId: string; paneId: string },
): ActionResult {
  if (reason !== "duplicate_version") {
    return { kind: "ok", output: "The instruction draft is not ready to send yet." };
  }
  const pending = getApprovalBinding(target.projectId, target.paneId);
  return {
    kind: "ok",
    output: pending
      ? "This instruction is already awaiting operator approval — approve or reject it, or revise the draft to send a new version."
      : "This instruction was already sent — revise it before sending again.",
  };
}

/** What actually goes to the pane: the deterministic envelope render — UNLESS the operator
 *  hand-edited the prose (prose-override, spec §5.2 "last writer wins the prose"), in which case
 *  the ledger draft text IS the instruction. Pre-fix, a voice send after a typed edit silently
 *  delivered the STALE envelope render, dropping the operator's edit (step 3.5 finding F2). */
function deliverableTextFor(
  target: { projectId: string; paneId: string },
  draft: EnvelopeDraft,
  profile: RenderProfile,
  ctx: ActionContext,
): string {
  if (hasProseOverride(target.projectId, target.paneId)) {
    const proseText = ctx.manager.ledger.getDraft(target.projectId, target.paneId)?.text ?? "";
    if (proseText.trim().length > 0) return proseText;
  }
  return renderEnvelope(draft.envelope, profile);
}

/**
 * BUG-B + BUG-C (step 3.5): settle the registry AFTER the dispatch outcome is known.
 *  - executed  → delivered: the draft (and any binding) closes, the mirrored ledger draft clears.
 *  - pending   → delivery is IN MOTION but not landed: the version is marked sent (idempotency)
 *                and the draft STAYS OPEN so the operator can still revise the in-flight
 *                instruction — the approval is CAS-bound to this exact version, and a revise
 *                invalidates it (spec §4).
 *  - blocked / clarify / error → nothing left the process: the draft stays open and UNMARKED, so
 *                a retry of the same never-delivered version after fixing the blocker is allowed.
 */
function applySendOutcome(
  target: { projectId: string; paneId: string },
  sentDraft: EnvelopeDraft,
  outcome: DispatchOutcome,
  ctx: ActionContext,
): void {
  if (outcome.kind === "executed") {
    clearOpenDraft(target.projectId, target.paneId);
    clearProseOverride(target.projectId, target.paneId);
    clearApprovalBinding(target.projectId, target.paneId);
    ctx.manager.ledger.setDraft(target.projectId, target.paneId, "", "janus");
    ctx.broadcastDraft(target.projectId, target.paneId);
    return;
  }
  if (outcome.kind === "pending") {
    setOpenDraft(target.projectId, target.paneId, sentDraft);
    bindApprovalToDraft(target.projectId, target.paneId, {
      messageId: ctx.callId ?? "",
      draftVersion: sentDraft.draftVersion,
    });
    // Repaint the Workbench: sentVersions + pendingApprovalVersion changed for this pane.
    ctx.broadcastDraft(target.projectId, target.paneId);
  }
  // blocked / clarify / error: deliberately no registry write — see the doc comment.
}

/** The voice-UX trio's canonical defs (aggregated into REGISTRY). */
export const VOICE_UX_ACTIONS: ActionDef[] = [
  getStatusSummary,
  focusPane,
  draftInstruction,
  reviseInstruction,
  retargetInstruction,
  confirmInstruction,
  cancelInstruction,
  sendInstruction,
];
