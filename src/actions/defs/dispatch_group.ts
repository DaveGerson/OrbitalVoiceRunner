/**
 * src/actions/defs/dispatch_group.ts — MULTI-PANE DISPATCH + JOIN (journey-expansion fan-out kernel).
 *
 * The thin coordination layer of the template-centric orchestration model: the orchestrator BRIEFS
 * (template or raw instruction), CONNECTS (one instruction to N panes), and WATCHES (the join
 * tracker reports when the whole group settles) — the agents in the panes do the actual work.
 *
 * SAFETY MODEL (this is the load-bearing part):
 *  - Every per-pane write routes through ctx.dispatchProposal — the SAME single pane-write
 *    choke-point propose_command / execute_plan / deliver_handoff use. Per-pane effective mode and
 *    capability gates apply unchanged.
 *  - forceStage:true on every write: a Full-Auto decision is DOWNGRADED to pending_approval inside
 *    the shared engine (paneWrite.ts), so a fan-out can never silently land N writes — the operator
 *    confirms each one (or batch-resolves from the approval queue). This is also what makes
 *    off-focus targets legal on voice: the active-pane guard exists so the operator sees a write
 *    before it lands, and a staged approval is exactly that.
 *  - The join is BOOKKEEPING ONLY (src/dispatch/joinTracker.ts): observe feeds it pane edges and
 *    announces completion through the existing attention/announcement sinks. It never writes.
 *
 * get_dispatch_status is the read twin (status of one group or the recent groups).
 */

import { z } from "zod";
import type { ActionDef, ActionResult } from "../types";
import { dispatchJoinTracker } from "../../dispatch/joinTracker";
import { instantiateTemplate, valuesArrayToRecord } from "../../templates";

// ─────────────────────────────────────────────────────────────────────────────
// dispatch_to_panes — POST /api/dispatch (capability write_to_pane; per-target gating inside).
// ─────────────────────────────────────────────────────────────────────────────

const DispatchToPanesParams = z
  .object({
    pane_ids: z.array(z.string()).min(1),
    /** Raw instruction text — or use template_id (+ values) instead. */
    instruction: z.string().optional(),
    /** A saved prompt template id/name to instantiate as the instruction. */
    template_id: z.string().optional(),
    /** Slot fills for template_id: [{ name, value }, …]. */
    values: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
    /** Optional label for the group (spoken back on completion). */
    name: z.string().optional(),
  })
  .superRefine((a, zctx) => {
    if (!a.instruction && !a.template_id) {
      zctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "provide either instruction or template_id",
        path: ["instruction"],
      });
    }
  });

export const dispatchToPanes: ActionDef<typeof DispatchToPanesParams> = {
  name: "dispatch_to_panes",
  description:
    "Send one instruction (raw text or a prompt template with slot values) to SEVERAL panes at once. Every write is staged as a pending approval — nothing executes until the operator approves each one — and the group is tracked so completion is announced when all targets finish. Use get_dispatch_status to check progress.",
  params: DispatchToPanesParams,
  capability: "write_to_pane",
  readOnly: false,
  surfaces: new Set(["voice", "rest"]),
  rest: { method: "post", path: "/api/dispatch" },
  handler: (args, ctx): ActionResult => {
    // Resolve the instruction text (template instantiation clarifies on missing slots — never guesses).
    let text = args.instruction ?? "";
    let label = args.name ?? "";
    if (args.template_id) {
      const tpl = ctx.manager.ledger.promptTemplates.find(
        (t) => t.id === args.template_id || t.name === args.template_id
      );
      if (!tpl) {
        return { kind: "ok", output: `Template '${args.template_id}' not found. Use list_prompt_templates to see what is saved.` };
      }
      const inst = instantiateTemplate(tpl.body, valuesArrayToRecord(args.values));
      if (inst.missing.length) {
        return {
          kind: "clarify",
          text: `Template '${tpl.name}' needs values for: ${inst.missing.join(", ")}. Ask the operator, then dispatch again with the values filled in.`,
        };
      }
      text = inst.text;
      if (!label) label = tpl.name;
    }
    if (!label) label = text.slice(0, 40);

    const paneIds = [...new Set(args.pane_ids)];
    const group = dispatchJoinTracker.create(label, text, paneIds);

    const staged: string[] = [];
    const refused: string[] = [];
    for (const paneId of paneIds) {
      const outcome = ctx.dispatchProposal({
        sess: ctx.session,
        callId: ctx.callId ?? group.id,
        // Synthetic per-pane pending id (the execute_plan precedent) so N stagings never collide
        // on one functionCall id.
        pendingId: `${ctx.callId ?? group.id}__${group.id}__${paneId}`,
        targetId: paneId,
        instruction: text,
        trigger: ctx.userUtterance || `Dispatch group '${label}'`,
        capability: "write_to_pane",
        // The fan-out invariant: never auto-execute; every write parks as an approval the operator
        // resolves (individually or via batch voice verbs). See paneWrite.ts forceStage.
        forceStage: true,
      });
      if (outcome.kind === "pending") {
        dispatchJoinTracker.recordOutcome(group.id, paneId, "staged");
        staged.push(paneId);
      } else if (outcome.kind === "executed") {
        // Defensive: forceStage should make this unreachable, but record it honestly if the engine
        // ever executes (e.g. a future caller drops the flag).
        dispatchJoinTracker.recordOutcome(group.id, paneId, "running");
        staged.push(paneId);
      } else {
        dispatchJoinTracker.recordOutcome(
          group.id,
          paneId,
          outcome.kind === "blocked" ? "blocked" : "error",
          outcome.text
        );
        refused.push(`${paneId} (${outcome.kind})`);
      }
    }

    ctx.broadcast({ type: "dispatch_updated", dispatches: dispatchJoinTracker.list() });

    const parts: string[] = [];
    if (staged.length) {
      parts.push(
        `Dispatch '${label}' (${group.id}) staged ${staged.length} approval(s): ${staged.join(", ")}. Nothing runs until the operator approves each one; I'll be told when the whole group finishes.`
      );
    }
    if (refused.length) parts.push(`Not staged: ${refused.join("; ")}.`);
    if (!staged.length) parts.push("No writes were staged.");
    return { kind: "ok", output: parts.join(" ") };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// get_dispatch_status — GET /api/dispatch (READ).
// ─────────────────────────────────────────────────────────────────────────────

const GetDispatchStatusParams = z.object({
  /** One group's id; omit for the recent groups. */
  dispatch_id: z.string().optional(),
});

export const getDispatchStatus: ActionDef<typeof GetDispatchStatusParams> = {
  name: "get_dispatch_status",
  description:
    "Check a multi-pane dispatch group: which targets are staged (awaiting approval), running, done, or blocked, and whether the whole group has completed. Omit dispatch_id for the recent groups.",
  params: GetDispatchStatusParams,
  capability: "read_pane",
  readOnly: true,
  surfaces: new Set(["voice", "rest"]),
  rest: {
    method: "get",
    path: "/api/dispatch",
    toHttp: (result): { status: number; body: unknown } => ({
      status: 200,
      body: result.kind === "ok" ? ((result.output as { dispatches?: unknown })?.dispatches ?? []) : [],
    }),
  },
  handler: (args, ctx): ActionResult => {
    void ctx;
    if (args.dispatch_id) {
      const g = dispatchJoinTracker.get(args.dispatch_id);
      if (!g) return { kind: "ok", output: `Dispatch ${args.dispatch_id} not found (groups are kept in memory for the session).` };
      return { kind: "ok", output: { dispatches: [g] } };
    }
    return { kind: "ok", output: { dispatches: dispatchJoinTracker.list() } };
  },
};

/** The multi-pane dispatch registry slice. */
export const DISPATCH_ACTIONS: ActionDef[] = [dispatchToPanes, getDispatchStatus];
