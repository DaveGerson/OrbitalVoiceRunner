/**
 * src/actions/defs/promote.ts — promote_draft: give a dictated draft an exit into KNOWLEDGE, not the
 * filesystem (hwu.4). Two targets, and ONLY two (operator rescope 2026-07-06 removed the repo-file and
 * cargo/handoff targets):
 *   - target:"note" — persist the FULL, untruncated draft as a typed note (hwu.3 taxonomy).
 *   - target:"bead" — persist the same full note, MARK it bead-proposed, and stage a durable operator
 *     APPROVAL. The bead is composed + filed by the separate constrained promoter (src/beadPromoter.ts)
 *     ONLY on approval — never here.
 *
 * HARD INVARIANT (the item's whole point): the live tool-call path NEVER files a bead and NEVER writes
 * a file. This module imports NO filesystem or process-spawning modules (grep-provable, pinned by a
 * unit test). It only STAGES a proposal whose confirm closure reaches the promoter; the exec seam fires
 * strictly on operator approval, inside PendingActionStore.confirm — not on this dispatch.
 *
 * The bead proposal is ALWAYS a proposal: it is staged unconditionally (never routed through the
 * Auto/Ask/Off gate decision), so no gate configuration and no timer can make a live tool call auto-
 * file a bead. The NOTE write, by contrast, rides the same gateOrDefer("update_metadata") choke-point
 * add_project_note / save_transcript_note use — so it inherits their durable Ask-defer + idempotency.
 */

import { z } from "zod";
import type { ActionContext, ActionDef, ActionResult } from "../types";
import { redactSecrets } from "../../terminal";
import { classifyNoteType } from "./notes";
import type { NoteType } from "../../store/types";
import { composeBead, applyApprovedBead, resolveBeadExec, markNoteStatus, denyBeadProposal, type ComposedBead } from "../../beadPromoter";

/** promote_draft params — the closed target enum is the ONLY surface; an invalid target is rejected at
 *  the zod boundary (never reaches the handler). NO 'file'/'cargo' member (operator rescope removed them). */
const PromoteDraftParams = z.object({
  target: z.enum(["note", "bead"]),
});

/** The resolved draft basis shared by both targets. */
interface DraftBasis {
  projectId: string;
  text: string;
  noteType: NoteType;
}

/** Resolve the active pane's current dictation draft (redacted, full text). A missing pane or an
 *  empty/whitespace draft yields a graceful spoken refusal string instead of a basis. */
function resolveDraft(ctx: ActionContext): { projectId: string; text: string } | { refusal: string } {
  const target = ctx.activeDraftTarget();
  if (!target) return { refusal: "No pane is open, so there's no draft to promote. Open a pane and dictate first." };
  const raw = ctx.manager.ledger.getDraft(target.projectId, target.paneId)?.text ?? "";
  const text = redactSecrets(raw);
  if (!text.trim()) return { refusal: "There's nothing in the draft to promote yet — dictate something first." };
  return { projectId: target.projectId, text };
}

/** promote_draft(target:"note") — persist the FULL draft as a typed note through the shared
 *  gateOrDefer("update_metadata") path (parity with add_project_note / save_transcript_note). */
function promoteToNote(ctx: ActionContext, basis: DraftBasis): ActionResult {
  const addEffect = (): string => {
    const ok = ctx.manager.ledger.addNote(basis.projectId, basis.text, { type: basis.noteType });
    if (ok) ctx.broadcastLedgerUpdate();
    return ok
      ? `Promoted the draft to a ${basis.noteType} note.`
      : `Could not save the note: project ${basis.projectId} not found.`;
  };
  const g = ctx.gateOrDefer("update_metadata", null, `Promote draft to a ${basis.noteType} note`, addEffect, {
    ...(ctx.versionStamp ?? {}), op: "add", scope: "project", projectId: basis.projectId, note: basis.text,
  });
  if (g.disposition === "forbidden") {
    return { kind: "ok", output: `Error: the 'update_metadata' capability is gated Off; promoting drafts is forbidden by policy.` };
  }
  if (g.disposition === "deferred") {
    return { kind: "ok", output: `'${g.summary}' needs operator confirmation (gated Ask). I've queued it — confirm to save the note.` };
  }
  return { kind: "ok", output: addEffect() };
}

/** Stable pending-action id for a bead proposal: derived from the live callId so a REPLAYED functionCall
 *  reuses the SAME id (never a duplicate proposal); a fresh minted id off the voice path. */
function beadActionId(callId?: string): string {
  return callId ? `bead_${callId}` : `bead_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

/**
 * Stage the ALWAYS-a-proposal bead approval. Reuses the existing durable Ask-defer surface
 * (ctx.pendingActions) directly so the bead can NEVER auto-file: the confirm closure — the only place
 * the promoter's exec seam is reached — runs strictly on operator approval via PendingActionStore.
 * A replayed callId re-maps to the same id and short-circuits, so the proposal is not duplicated.
 */
function stageBeadProposal(ctx: ActionContext, args: { noteId: string; composed: ComposedBead; noteType: NoteType }): ActionResult {
  const actionId = beadActionId(ctx.callId);
  const summary = `File a bead from this ${args.noteType} note: "${args.composed.title}"`;
  if (ctx.pendingActions.has(actionId)) {
    return { kind: "pending", messageId: actionId, summary }; // idempotent: replay does not re-stage
  }
  const run = (): string => {
    const res = applyApprovedBead(args.composed, resolveBeadExec());
    if (res.ok) {
      markNoteStatus(ctx.manager.ledger, args.noteId, "created");
      ctx.broadcastLedgerUpdate();
      return `Filed the bead${res.id ? ` (${res.id})` : ""} from the note.`;
    }
    return `I couldn't file the bead: ${res.error ?? "bd create failed"}. The note is saved and still marked proposed.`;
  };
  // Stage into the existing durable Ask-defer surface. `params` carries the serializable INTENT
  // (noteId + a beadProposal discriminator + the version stamp) so the durable row is addressable.
  // The `onDiscard` hook marks the source note DENIED on any discard path (operator cancel via REST or
  // voice, or a TTL expiry — all route through PendingActionStore.cancel/expire, which fire onDiscard
  // exactly once). This wires hwu.4's "deny discards with a note-side marker so re-proposal is explicit,
  // not automatic" — the marker is no longer left to an integrator follow-up. (onDiscard is a
  // non-serializable closure, so a proposal that survives a process RESTART then gets denied leaves the
  // note at 'proposed'; the note is durable + visibly proposed, and a fresh proposal re-marks it — no
  // data loss. Cross-restart CONFIRM replay still needs a `promote_bead` builder in src/actionEffects.ts;
  // until then a confirm-after-restart fails SAFE to a no-op narration, never files a bead unattended.)
  ctx.pendingActions.add({
    id: actionId, capability: "promote_bead", summary, timestamp: Date.now(), run,
    params: { noteId: args.noteId, beadProposal: true, ...(ctx.versionStamp ?? {}) },
    onDiscard: () => denyBeadProposal(ctx.manager.ledger, args.noteId),
  });
  ctx.broadcast({ type: "action_pending", actionId, capability: "promote_bead", summary, pane_id: null });
  return { kind: "pending", messageId: actionId, summary };
}

/** promote_draft(target:"bead") — persist the full note, mark it bead-proposed, then stage the approval.
 *
 * BLOCKER FIX (Wave 6): the NOTE write now rides the SAME gateOrDefer("update_metadata") choke-point as
 * promoteToNote / add_project_note, closing the bypass where a bead-target promote persisted a durable
 * note (and marked it proposed + broadcast) with update_metadata dialed Off, or wrote immediately under
 * Ask. Off FORBIDS the write (no note, no proposal); Ask DEFERS it (the note is queued durably — NO bead
 * proposal is staged until the operator confirms the note, because the proposal references the persisted
 * note id). The bead itself is ALWAYS a staged proposal (never routed through the gate decision), but it
 * can only be staged once its source note actually exists — i.e. on the gate's "run" disposition. */
function promoteToBead(ctx: ActionContext, basis: DraftBasis): ActionResult {
  const addEffect = (): string => {
    const ok = ctx.manager.ledger.addNote(basis.projectId, basis.text, { type: basis.noteType });
    if (ok) ctx.broadcastLedgerUpdate();
    return ok
      ? `Promoted the draft to a ${basis.noteType} note.`
      : `Could not save the note: project ${basis.projectId} not found.`;
  };
  const g = ctx.gateOrDefer("update_metadata", null, `Promote draft to a ${basis.noteType} note`, addEffect, {
    ...(ctx.versionStamp ?? {}), op: "add", scope: "project", projectId: basis.projectId, note: basis.text,
  });
  if (g.disposition === "forbidden") {
    return { kind: "ok", output: `Error: the 'update_metadata' capability is gated Off; promoting drafts is forbidden by policy.` };
  }
  if (g.disposition === "deferred") {
    return { kind: "ok", output: `'${g.summary}' needs operator confirmation (gated Ask). I've queued the note — confirm it, then ask again to file the bead.` };
  }
  // "run": persist the note now (the SAME write addEffect makes), mark it bead-proposed, stage the approval.
  const note = ctx.manager.ledger.addNote(basis.projectId, basis.text, { type: basis.noteType }) as { id: string } | null;
  if (!note) return { kind: "ok", output: `Could not save the note: project ${basis.projectId} not found.` };
  markNoteStatus(ctx.manager.ledger, note.id, "proposed");
  ctx.broadcastLedgerUpdate();
  const composed = composeBead({ text: basis.text, type: basis.noteType });
  return stageBeadProposal(ctx, { noteId: note.id, composed, noteType: basis.noteType });
}

/**
 * promote_draft — "promote this to a note" / "turn this into a bead". Source is the active pane's
 * current dictation draft (full, untruncated). The note write reuses the gated update_metadata path;
 * the bead is only ever a staged proposal. readOnly:false so it inherits runAction's replay guard
 * (the same guard tests/test_session_reconnect.ts pins for add_project_note).
 */
export const promoteDraft: ActionDef<typeof PromoteDraftParams> = {
  name: "promote_draft",
  description:
    "Promote the active pane's current draft into project knowledge. target='note' saves the FULL draft as a durable, auto-classified note (decision/todo/warning/note/handoff). target='bead' saves the same note AND proposes it as a bead for you to approve — I never file the bead myself, you confirm it. Use for 'promote this to a note', 'turn this draft into a task/bead', 'save this draft as a decision'.",
  params: PromoteDraftParams,
  capability: "update_metadata",
  readOnly: false,
  surfaces: new Set(["voice"]),
  handler: async (args, ctx): Promise<ActionResult> => {
    const draft = resolveDraft(ctx);
    if ("refusal" in draft) return { kind: "ok", output: draft.refusal };
    const noteType = await classifyNoteType(ctx, draft.text);
    const basis: DraftBasis = { projectId: draft.projectId, text: draft.text, noteType };
    return args.target === "bead" ? promoteToBead(ctx, basis) : promoteToNote(ctx, basis);
  },
};
