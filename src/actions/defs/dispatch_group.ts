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
import type { ActionContext, ActionDef, ActionResult, DispatchOutcome } from "../types";
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
    // Reject the ambiguous case rather than silently preferring one (review finding C3).
    if (a.instruction && a.template_id) {
      zctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "provide instruction OR template_id, not both",
        path: ["template_id"],
      });
    }
  });

type DispatchArgs = z.infer<typeof DispatchToPanesParams>;

/**
 * Resolve the instruction text + group label from raw args (template instantiation clarifies on
 * missing slots — never guesses). Returns either the resolved { text, label } or an early
 * ActionResult to return verbatim (unknown template -> ok narration; missing slots -> clarify).
 * Behavior-preserving extraction of the handler's template-resolution preamble.
 */
function resolveDispatchText(
  args: DispatchArgs,
  ctx: ActionContext
): { text: string; label: string } | { early: ActionResult } {
  let text = args.instruction ?? "";
  let label = args.name ?? "";
  if (args.template_id) {
    const tpl = ctx.manager.ledger.promptTemplates.find(
      (t) => t.id === args.template_id || t.name === args.template_id
    );
    if (!tpl) {
      return { early: { kind: "ok", output: `Template '${args.template_id}' not found. Use list_prompt_templates to see what is saved.` } };
    }
    const inst = instantiateTemplate(tpl.body, valuesArrayToRecord(args.values));
    if (inst.missing.length) {
      return {
        early: {
          kind: "clarify",
          text: `Template '${tpl.name}' needs values for: ${inst.missing.join(", ")}. Ask the operator, then dispatch again with the values filled in.`,
        },
      };
    }
    text = inst.text;
    if (!label) label = tpl.name;
  }
  if (!label) label = text.slice(0, 40);
  return { text, label };
}

/**
 * The exchange bound to this member's synthetic pendingId, if any (AgentExchange spine, step 1.4,
 * spec §5). `ctx.dispatchProposal` (the injected pane-write choke-point) mints + binds the
 * exchange internally when JANUS_EXCHANGE_SPINE is shadow/primary — this reads that binding back
 * via the SAME pending-approval record the write staged, so the join tracker can attach it to the
 * matching member (recordOutcomeAt). Best-effort: `ctx.pendingApprovals` is optional on hand-built
 * test contexts, and the flag-off / defensive 'executed' path never bound anything — both degrade
 * to `undefined`, which keeps the member legacy/pane-scoped (see joinTracker.ts).
 */
function exchangeIdForPending(ctx: ActionContext, pendingId: string): string | undefined {
  return ctx.pendingApprovals?.get(pendingId)?.exchangeId;
}

/**
 * Stamp ONE per-pane dispatch outcome onto the join group (by member INDEX, step 1.4 — see
 * recordOutcomeAt) and classify it as staged or refused. Behavior-preserving extraction of the
 * per-pane outcome branch inside the fan-out loop, plus the exchange-id thread-through.
 */
function recordDispatchOutcome(
  ctx: ActionContext,
  groupId: string,
  index: number,
  paneId: string,
  pendingId: string,
  outcome: DispatchOutcome
): { staged: boolean; refused?: string } {
  if (outcome.kind === "pending") {
    dispatchJoinTracker.recordOutcomeAt(groupId, index, "staged", undefined, exchangeIdForPending(ctx, pendingId));
    return { staged: true };
  }
  if (outcome.kind === "executed") {
    // Defensive: forceStage should make this unreachable, but record it honestly if the engine
    // ever executes (e.g. a future caller drops the flag).
    dispatchJoinTracker.recordOutcomeAt(groupId, index, "running", undefined, exchangeIdForPending(ctx, pendingId));
    return { staged: true };
  }
  dispatchJoinTracker.recordOutcomeAt(
    groupId,
    index,
    outcome.kind === "blocked" ? "blocked" : "error",
    outcome.text
  );
  return { staged: false, refused: `${paneId} (${outcome.kind})` };
}

/** Assemble the spoken read-back from the staged/refused tallies. Behavior-preserving extraction.
 *  Exported so voice macros (src/macros.ts) narrate their fan-out in the IDENTICAL shape. */
export function narrateDispatch(label: string, groupId: string, staged: string[], refused: string[]): string {
  const parts: string[] = [];
  if (staged.length) {
    parts.push(
      `Dispatch '${label}' (${groupId}) staged ${staged.length} approval(s): ${staged.join(", ")}. Nothing runs until the operator approves each one; I'll be told when the whole group finishes.`
    );
  }
  if (refused.length) parts.push(`Not staged: ${refused.join("; ")}.`);
  if (!staged.length) parts.push("No writes were staged.");
  return parts.join(" ");
}

/** One staging target for stageDispatchGroup: a unique per-step `key` (so N synthetic pendingIds
 *  never collide on one functionCall id), the resolved pane id, and its per-target instruction. */
export interface StageTarget {
  key: string;
  paneId: string;
  instruction: string;
}

/**
 * The SHARED staging/join/narration kernel (extracted so dispatch_to_panes AND voice macros reuse it
 * verbatim — never a fork). Creates ONE join group, forceStages EVERY target through the same
 * ctx.dispatchProposal pane-write choke-point with a DISTINCT synthetic pendingId, broadcasts
 * dispatch_updated, and returns the group id + staged/refused tallies. `forceStage:true` on every
 * write is THE fan-out safety invariant — a Full-Auto decision is downgraded to pending_approval
 * inside the engine, so a group can never silently land N writes. dispatch_to_panes fans ONE
 * instruction to N panes (key = paneId, format-identical to the pre-extraction inline loop); a macro
 * fans N per-step instructions (key = step index + pane, so repeated panes still get unique pendingIds).
 */
export function stageDispatchGroup(
  ctx: ActionContext,
  label: string,
  groupInstruction: string,
  targets: StageTarget[],
  trigger: string,
): { groupId: string; staged: string[]; refused: string[] } {
  const group = dispatchJoinTracker.create(label, groupInstruction, targets.map((t) => t.paneId));
  const base = ctx.callId ?? group.id;
  const staged: string[] = [];
  const refused: string[] = [];
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    // Synthetic per-step pending id (the execute_plan precedent) so N stagings never collide on one
    // functionCall id — `key` is unique per target (paneId for a fan-out, step-index+pane for a macro).
    const pendingId = `${base}__${group.id}__${t.key}`;
    const outcome = ctx.dispatchProposal({
      sess: ctx.session,
      callId: base,
      pendingId,
      targetId: t.paneId,
      instruction: t.instruction,
      trigger,
      capability: "write_to_pane",
      // The fan-out invariant: never auto-execute; every write parks as an approval. See paneWrite.ts.
      forceStage: true,
    });
    // `i` (not paneId alone) addresses the member — see recordDispatchOutcome/recordOutcomeAt.
    const recorded = recordDispatchOutcome(ctx, group.id, i, t.paneId, pendingId, outcome);
    if (recorded.staged) staged.push(t.paneId);
    else refused.push(recorded.refused!);
  }
  ctx.broadcast({ type: "dispatch_updated", dispatches: dispatchJoinTracker.list() });
  return { groupId: group.id, staged, refused };
}

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
    const resolved = resolveDispatchText(args, ctx);
    if ("early" in resolved) return resolved.early;
    const { text, label } = resolved;

    // ONE instruction to N deduped panes: build the targets (key = paneId, so the synthetic pendingId
    // stays format-identical to the pre-extraction inline loop) and route through the shared kernel.
    const paneIds = [...new Set(args.pane_ids)];
    const targets: StageTarget[] = paneIds.map((paneId) => ({ key: paneId, paneId, instruction: text }));
    const trigger = ctx.userUtterance || `Dispatch group '${label}'`;
    const { groupId, staged, refused } = stageDispatchGroup(ctx, label, text, targets, trigger);
    return { kind: "ok", output: narrateDispatch(label, groupId, staged, refused) };
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
