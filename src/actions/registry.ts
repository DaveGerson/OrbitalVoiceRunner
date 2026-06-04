/**
 * src/actions/registry.ts — the canonical ActionDef[] (REG1 PHASE A: a SMALL PROOF registry).
 *
 * This phase proves the SHAPE, not the full migration. Only four tools are migrated, chosen to
 * exercise every limb of the runAction wrapper:
 *   - stop_all / confirm_stop_all / release_stop_all — the emergency brake. capability ALWAYS_ALLOWED
 *     (bypasses the gate, even while frozen), empty params, surfaces voice+rest+ws (the one group
 *     wired identically across all three surfaces today — §4.2 Group 8, the template the registry
 *     generalizes).
 *   - list_panes — a READ. capability read_pane (default Auto), readOnly:true (so its output is
 *     redacted on the way out), empty params, surfaces voice+rest (voice tool + GET /api/terminals).
 *
 * Handlers here are THIN: they call ctx.manager / ctx.broadcast and return an ActionResult. The
 * heavy brake logic (stopAll/releaseStopAll, the `frozen` flag) lives in server.ts closures that are
 * NOT yet on ActionContext; this phase does not swap the dispatch (that is Phase C), so the brake
 * handlers here return a proof ok-result and broadcast the same frames the real handlers do. The
 * other 37 tools — and the full brake wiring — land in Phase B.
 */

import { z } from "zod";
import type { ActionDef, ActionResult } from "./types";
import type { ApprovalKind } from "../pendingApprovals";
import { ALWAYS_ALLOWED } from "./types";
// Phase-B grouped ActionDefs (one file per capability domain, src/actions/defs/*).
import { READS_ACTIONS } from "./defs/reads";
import { NOTES_ACTIONS } from "./defs/notes";
import { PANES_WRITE_ACTIONS } from "./defs/panes_write";
import { ORIENT_ACTIONS } from "./defs/orient";
import { LOCKS_ACTIONS } from "./defs/locks";
import { ORCH_ACTIONS } from "./defs/orchestration";
import { HANDOFF_ACTIONS } from "./defs/handoff";

/** Empty-params schema shared by the brake trio + list_panes (pins §8.2 #8 -> properties {}). */
const NoParams = z.object({});

export const stopAll: ActionDef<typeof NoParams> = {
  name: "stop_all",
  description:
    "EMERGENCY BRAKE Stage 1 (always allowed): freeze Janus (every capability becomes Off) and cancel everything in flight. Panes KEEP RUNNING. Call IMMEDIATELY on 'stop', 'halt', 'abort', 'freeze', or 'stop everything'.",
  params: NoParams,
  capability: ALWAYS_ALLOWED,
  readOnly: false,
  surfaces: new Set(["voice", "rest", "ws"]),
  rest: { method: "post", path: "/api/stop-all" },
  handler: (_args, ctx): ActionResult => {
    // PROOF handler: the real stopAll(false) closure lives in server.ts and is wired on ctx in
    // Phase C. Here we broadcast the same `frozen` frame the operator sees and report ok.
    ctx.broadcast({ type: "frozen", frozen: true });
    return { kind: "ok", output: "Frozen and cancelled everything in flight; panes keep running." };
  },
};

export const confirmStopAll: ActionDef<typeof NoParams> = {
  name: "confirm_stop_all",
  description:
    "EMERGENCY BRAKE Stage 2 (always allowed): the deliberate, irreversible kill of running panes. Only valid while frozen-awaiting-confirm. Call on a spoken 'kill them' / 'yes' after stop_all.",
  params: NoParams,
  capability: ALWAYS_ALLOWED,
  readOnly: false,
  surfaces: new Set(["voice", "rest", "ws"]),
  rest: { method: "post", path: "/api/stop-all/confirm" },
  handler: (_args, ctx): ActionResult => {
    ctx.broadcast({ type: "stop_all" });
    return { kind: "ok", output: "Killed running panes; they stay killed. Still frozen — say 'release' to resume." };
  },
};

export const releaseStopAll: ActionDef<typeof NoParams> = {
  name: "release_stop_all",
  description:
    "Clear the freeze (always allowed): un-freeze Janus; safety gates restore exactly as they were. Does NOT auto-restart any killed panes. Call on 'release' / 'resume'.",
  params: NoParams,
  capability: ALWAYS_ALLOWED,
  readOnly: false,
  surfaces: new Set(["voice", "rest", "ws"]),
  rest: { method: "post", path: "/api/stop-all/release" },
  handler: (_args, ctx): ActionResult => {
    ctx.broadcast({ type: "frozen", frozen: false });
    return { kind: "ok", output: "Released — un-frozen; your safety gates are back exactly as they were." };
  },
};

export const listPanes: ActionDef<typeof NoParams> = {
  name: "list_panes",
  description:
    "List all projects and their panes with runtime_type, is_busy, alive, a one-line state, and live timing. The authoritative source of current pane status — always call it before reporting whether something is busy or done. Cheap orientation call.",
  params: NoParams,
  capability: "read_pane",
  readOnly: true, // result is redacted on the way out (§5.6) — readOnly binds only read capabilities (§8.1 #5)
  surfaces: new Set(["voice", "rest"]), // voice tool + GET /api/terminals (§4.2 Group 1)
  rest: { method: "get", path: "/api/terminals" },
  handler: (_args, ctx): ActionResult => {
    // THIN: the genuine domain call. listPanes() syncs the ledger and returns the project/pane tree.
    return { kind: "ok", output: ctx.manager.listPanes() };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// PROOF-OF-CONTRACT tools (REG1 Phase B): two OPPOSITE gating styles, faithfully
// ported, to validate that the handler-owned ActionContext supports BOTH:
//   propose_command — the dispatchProposal (pane-WRITE HiTL) path.
//   amend_note      — the gateOrDefer (durable Ask-defer) path.
// Each handler references ONLY ctx.* injected closures — no server.ts state.
// ─────────────────────────────────────────────────────────────────────────────

/** propose_command params (server.ts:3540). `command` is a legacy alias for `instruction` (coerced). */
const ProposeCommandParams = z.object({
  pane_id: z.string(),
  instruction: z.string(),
  kind: z.enum(["agent_instruction", "shell"]).optional(),
});

/**
 * propose_command — FAITHFUL PORT of server.ts:2589-2612 (the dispatchProposal path). Routes through
 * the pane-WRITE choke-point ctx.dispatchProposal, which owns its own gate + HiTL staging, and maps
 * DispatchOutcome.kind → ActionResult EXACTLY as the legacy three-branch mapping (pending/clarify/else).
 * The capability declared here is `write_to_pane` (the matrix row); the gate is applied INSIDE
 * dispatchProposal (default capability "write_to_pane"), not by runAction.
 */
export const proposeCommand: ActionDef<typeof ProposeCommandParams> = {
  name: "propose_command",
  description:
    "Direct work to the pane the operator currently has OPEN (the active pane). You can ONLY propose to that pane, so the operator can see and refine the command before it runs; to act on a different pane, call switch_active_pane first (with the operator's go-ahead). Does NOT execute directly — it passes the effective permission gate (auto-runs in Full Auto, becomes a spoken pending approval in Human-in-the-Loop, blocked in Read-Only). PREFER kind='agent_instruction' (the default): relay a SHORT, FOCUSED, DISTILLED instruction to the Claude Code / Codex / Antigravity agent in that pane and let the AGENT do the heavy lifting (write code, run builds/tests). Do NOT relay the operator's dictation verbatim — compress it to a targeted instruction first and confirm it by voice. kind='shell' is ONLY for your OWN small read-only/observe needs (status checks like git status, ls, cat, pwd); never author or run heavy/mutating shell yourself — delegate that to an agent pane via kind='agent_instruction'. A non-allowlisted shell command returns a clarification so you can re-route it to the agent.",
  params: ProposeCommandParams,
  capability: "write_to_pane",
  readOnly: false,
  surfaces: new Set(["voice"]),
  // R2 back-compat: accept the legacy `command` arg as an alias for `instruction` (server.ts:2592).
  coerceArgs: (raw) => {
    const out = { ...raw };
    if (out.instruction == null && out.command != null) out.instruction = out.command;
    delete out.command;
    return out;
  },
  handler: (args, ctx): ActionResult => {
    const targetId = args.pane_id;
    const instruction = args.instruction ?? "";
    const explicitKind: ApprovalKind | undefined =
      args.kind === "shell" || args.kind === "agent_instruction" ? args.kind : undefined;
    const trigger = ctx.userUtterance || "Spoken execute command";

    const outcome = ctx.dispatchProposal({
      sess: ctx.session,
      callId: ctx.callId ?? "",
      targetId,
      instruction,
      explicitKind,
      trigger,
    });
    // EXACT legacy mapping (server.ts:2600-2611). pending -> structured pending_approval (with
    // pane_id + prompt); clarify -> { status:"clarify", output }; everything else -> { output }.
    if (outcome.kind === "pending") {
      return {
        kind: "pending",
        messageId: ctx.callId ?? "",
        summary: outcome.text,
        extra: { pane_id: targetId, prompt: outcome.text },
      };
    }
    if (outcome.kind === "clarify") {
      return { kind: "clarify", text: outcome.text };
    }
    return { kind: "ok", output: outcome.text };
  },
};

/** amend_note params (server.ts:3676). */
const AmendNoteParams = z.object({
  note_id: z.string(),
  text: z.string(),
});

/**
 * amend_note — FAITHFUL PORT of server.ts:2714-2733 (the gateOrDefer durable Ask-defer path). The
 * handler builds the REAL amend effect closure, then calls ctx.gateOrDefer with that closure AND the
 * serializable intent params { op:"amend", noteId, text } — the SAME params buildActionRun
 * (src/actionEffects.ts) re-derives on restart, in LOCKSTEP (kzt invariant). Off->blocked,
 * Ask->pending (effect staged, NOT run), Auto->run-now. The enqueue-bound `text` is what a deferred
 * confirm applies, not whatever the model says next (#27 MUST-FIX #3).
 */
export const amendNote: ActionDef<typeof AmendNoteParams> = {
  name: "amend_note",
  description:
    "Edit the text of an existing note by its id (get the id from get_project_notes or search_notes). Gated by the 'update notes & metadata' permission: auto-applies in Auto, asks for operator confirmation in Ask, refused when Off.",
  params: AmendNoteParams,
  capability: "update_metadata",
  readOnly: false,
  surfaces: new Set(["voice"]),
  handler: (args, ctx): ActionResult => {
    const noteId = String(args.note_id ?? "");
    const newText = String(args.text ?? "");
    const amendEffect = (): string => {
      ctx.manager.ledger.amendNote(noteId, newText);
      ctx.broadcastLedgerUpdate();
      return `Note ${noteId} updated.`;
    };
    // kzt: persist the amend INTENT (op + noteId + ENQUEUE-BOUND text) so a deferred amend survives a
    // restart and applies EXACTLY this text on confirm. Keys in lockstep with src/actionEffects.ts.
    const g = ctx.gateOrDefer("update_metadata", null, `Amend note ${noteId}`, amendEffect, {
      op: "amend",
      noteId,
      text: newText,
    });
    if (g.disposition === "forbidden") {
      return {
        kind: "ok",
        output: `Error: the 'update_metadata' capability is gated Off; amending notes is forbidden by policy.`,
      };
    }
    if (g.disposition === "deferred") {
      return {
        kind: "ok",
        output: `'${g.summary}' needs operator confirmation (gated Ask). I've queued it — confirm to apply the amendment.`,
      };
    }
    return { kind: "ok", output: amendEffect() };
  },
};

/**
 * The canonical registry — the SINGLE export everything derives from (Gemini declarations, REST mount,
 * capability matrix, coverage). The 6 inline defs above are the phase-A proof (brake trio + list_panes)
 * and the phase-B contract proof (propose_command = dispatchProposal style, amend_note = gateOrDefer
 * durable Ask-defer style). The remaining 35 tools live in src/actions/defs/* (one file per capability
 * domain), faithfully ported from their legacy server.ts branches. Phase C swaps server.ts to dispatch
 * through runAction(REGISTRY, ...). Total = 41 voice tools (parity with the legacy dispatch chain).
 */
export const REGISTRY: readonly ActionDef[] = [
  // ── phase-A + contract-proof inline defs (6) ──
  stopAll,
  confirmStopAll,
  releaseStopAll,
  listPanes,
  proposeCommand,
  amendNote,
  // ── phase-B grouped defs (35) ──
  ...READS_ACTIONS,
  ...NOTES_ACTIONS,
  ...PANES_WRITE_ACTIONS,
  ...ORIENT_ACTIONS,
  ...LOCKS_ACTIONS,
  ...ORCH_ACTIONS,
  ...HANDOFF_ACTIONS,
];
