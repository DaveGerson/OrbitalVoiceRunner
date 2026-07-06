/**
 * src/actions/defs/approvals_rest.ts — c55.15: approvals/pending HiTL convergence (rest-only).
 *
 * The 5 inline approvals/pending routes converged into rest-only registry defs. All ALWAYS_ALLOWED:
 * this is the OPERATOR surface that RESOLVES gated actions (the gate already fired when the action was
 * staged; confirming / cancelling / approving is the human-in-the-loop ANSWER, not a new gated act —
 * so the resolver is itself above-the-gate).
 *
 * STATUS CONTRACT (the design care): the legacy inline handlers emit non-200 statuses (404 / 422 /
 * 500) the default kind->status map (resultToHttp) cannot express. Each def therefore carries a
 * `rest.toHttp` (c55 Batch E primitive): the handler returns `{ kind:"ok", output:<discriminated> }`
 * where `output` is a `{outcome,...}` tag (POSTs) or the projected array (GETs), and `toHttp`
 * re-projects that into the EXACT legacy `{status, body}`. Field-for-field parity with server.ts
 * for every WELL-FORMED request:
 *   GET  /api/commands/pending      -> 200, pendingApprovals.all().map(serializePending) top-level
 *   GET  /api/actions/pending       -> 200, {id,capability,summary,ageSeconds}[] top-level
 *   POST /api/actions/:id/confirm   -> 404 / 200(already) / 200(output, +broadcast) / 500
 *   POST /api/actions/:id/cancel    -> 404 / 200(already, +broadcast)
 *   POST /api/commands/approve      -> 404 / 422 / 200(already) / 200
 * PLUS (wsm-e2e-pinned-wqk, a deliberate delta from legacy on MALFORMED input only): a top-level
 * ActionResult kind:'error' maps to 400 {error} (zod validation reject / unknown action — a client
 * fault) or 500 {error} (an uncaught handler throw / deadline timeout — a server fault) on ALL FIVE
 * routes, instead of folding into not_found 404 (POSTs) or a silent 200 [] (GETs). Fails closed — no
 * resolution side effect ever fires. wsm-e2e-pinned-f9ne: runAction now stamps ActionResult
 * kind:'error' with a `cause: 'validation' | 'handler' | 'timeout'` discriminator at each of its four
 * construction sites, so this 400-vs-500 split reads `result.cause` directly (no more folding a
 * server fault into a client-fault 400 — the coarseness this comment used to flag is resolved).
 *
 * TYPING IDIOM (mirrors the c55.11 toHttp reads in reads.ts): ActionResult.output is typed `unknown`,
 * so a handler stuffs a structured value through it with no cast; toHttp guards `result.kind === "ok"`
 * then narrows `result.output` to the def-local discriminated shape. The VOICE path never reaches
 * toHttp (surfaces = {'rest'}), so these UI-shaped outputs never leak through resultToToolResponse.
 */
import { z } from "zod";
import type { ActionDef, ActionResult } from "../types";
import { ALWAYS_ALLOWED } from "../types";
import { serializePending } from "../../pendingApprovals";

const NoParams = z.object({});
const IdParams = z.object({ id: z.string() });
const ApproveParams = z.object({ messageId: z.string(), approved: z.boolean() });

/**
 * wsm-e2e-pinned-f9ne: shared top-level kind:'error' -> {status,body} projection for all five
 * routes below. `cause: 'validation'` (bad action name / zod arg reject) is a client fault -> 400;
 * `cause: 'handler' | 'timeout'` (or an absent cause, e.g. a legacy handler-constructed error) is a
 * server fault -> 500. Extracted so each toHttp stays a one-line early-return.
 */
function errorToHttp(result: Extract<ActionResult, { kind: "error" }>): { status: number; body: unknown } {
  return { status: result.cause === "validation" ? 400 : 500, body: { error: result.message } };
}

// ── GET /api/commands/pending ────────────────────────────────────────────────
export const listPendingCommands: ActionDef<typeof NoParams> = {
  name: "list_pending_commands",
  description: "List the pending spoken-command approvals (the HiTL queue the ApprovalDialog renders). Operator UI, ALWAYS_ALLOWED plumbing read.",
  params: NoParams,
  capability: ALWAYS_ALLOWED,
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: {
    method: "get",
    path: "/api/commands/pending",
    // wsm-e2e-pinned-wqk: a handler/validation throw (kind:'error') must surface as a 4xx, not fold
    // into the ok-shaped [] default (which would silently report "no pending commands").
    toHttp: (result): { status: number; body: unknown } => {
      if (result.kind === "error") return errorToHttp(result);
      return { status: 200, body: result.kind === "ok" ? result.output : [] };
    },
  },
  handler: (_args, ctx): ActionResult => ({
    kind: "ok",
    output: ctx.pendingApprovals.all().map((p) => serializePending(p)),
  }),
};

// ── GET /api/actions/pending ─────────────────────────────────────────────────
export const listPendingActions: ActionDef<typeof NoParams> = {
  name: "list_pending_actions",
  description: "List the pending NON-PTY deferred actions (gated-Ask staging) with their age. Operator UI, ALWAYS_ALLOWED plumbing read.",
  params: NoParams,
  capability: ALWAYS_ALLOWED,
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: {
    method: "get",
    path: "/api/actions/pending",
    // wsm-e2e-pinned-wqk: same fold hazard as list_pending_commands above — surface kind:'error' via errorToHttp.
    toHttp: (result): { status: number; body: unknown } => {
      if (result.kind === "error") return errorToHttp(result);
      return { status: 200, body: result.kind === "ok" ? result.output : [] };
    },
  },
  handler: (_args, ctx): ActionResult => ({
    kind: "ok",
    // ageSeconds: EXACT legacy expression (server.ts) — clamp a future timestamp to 0.
    output: ctx.pendingActions.all().map((a) => ({
      id: a.id,
      capability: a.capability,
      summary: a.summary,
      ageSeconds: Math.max(0, Math.floor((Date.now() - a.timestamp) / 1000)),
    })),
  }),
};

// ── POST /api/actions/:id/confirm ────────────────────────────────────────────
/** The discriminated handler output for confirm — toHttp narrows this. */
type ConfirmOutcome =
  | { outcome: "not_found" }
  | { outcome: "already" }
  | { outcome: "ok"; output?: string }
  | { outcome: "error"; error: string };

export const confirmPendingAction: ActionDef<typeof IdParams> = {
  name: "confirm_pending_action",
  description: "Confirm (run) a pending NON-PTY deferred action by id. The operator's HiTL yes — ALWAYS_ALLOWED (resolving a gated action is above the gate).",
  params: IdParams,
  capability: ALWAYS_ALLOWED,
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: {
    method: "post",
    path: "/api/actions/:id/confirm",
    toHttp: (result): { status: number; body: unknown } => {
      // wsm-e2e-pinned-wqk: a handler/validation throw (kind:'error', e.g. malformed body) must NOT
      // fold into the not_found 404 default below — that would mask an invalid request as "not found"
      // and, worse, is indistinguishable from a real absent-id 404. Surface it via errorToHttp (400/500).
      if (result.kind === "error") return errorToHttp(result);
      const o = (result.kind === "ok" ? result.output : { outcome: "not_found" }) as ConfirmOutcome;
      if (o.outcome === "not_found") return { status: 404, body: { error: "Pending action not found" } };
      if (o.outcome === "already") return { status: 200, body: { success: true, already: true } };
      if (o.outcome === "error") return { status: 500, body: { success: false, error: o.error } };
      return { status: 200, body: { success: true, output: o.output } };
    },
  },
  handler: (args, ctx): ActionResult => {
    if (!ctx.pendingActions.has(args.id)) return { kind: "ok", output: { outcome: "not_found" } satisfies ConfirmOutcome };
    try {
      const res = ctx.pendingActions.confirm(args.id);
      if (res.reason === "lost_race") return { kind: "ok", output: { outcome: "already" } satisfies ConfirmOutcome };
      if (res.reason === "not_found") return { kind: "ok", output: { outcome: "not_found" } satisfies ConfirmOutcome };
      ctx.broadcast({ type: "action_resolved", actionId: args.id, outcome: "confirmed" });
      return { kind: "ok", output: { outcome: "ok", output: res.output } satisfies ConfirmOutcome };
    } catch (e) {
      return { kind: "ok", output: { outcome: "error", error: e instanceof Error ? e.message : String(e) } satisfies ConfirmOutcome };
    }
  },
};

// ── POST /api/actions/:id/cancel ─────────────────────────────────────────────
/** The discriminated handler output for cancel — toHttp narrows this. */
type CancelOutcome =
  | { outcome: "not_found" }
  | { outcome: "ok"; already: boolean };

export const cancelPendingAction: ActionDef<typeof IdParams> = {
  name: "cancel_pending_action",
  description: "Cancel (discard, no side effect) a pending NON-PTY deferred action by id. The operator's HiTL no — ALWAYS_ALLOWED.",
  params: IdParams,
  capability: ALWAYS_ALLOWED,
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: {
    method: "post",
    path: "/api/actions/:id/cancel",
    toHttp: (result): { status: number; body: unknown } => {
      // wsm-e2e-pinned-wqk: see confirm's identical note — don't fold kind:'error' into not_found 404.
      if (result.kind === "error") return errorToHttp(result);
      const o = (result.kind === "ok" ? result.output : { outcome: "not_found" }) as CancelOutcome;
      if (o.outcome === "not_found") return { status: 404, body: { error: "Pending action not found" } };
      return { status: 200, body: { success: true, already: o.already } };
    },
  },
  handler: (args, ctx): ActionResult => {
    if (!ctx.pendingActions.has(args.id)) return { kind: "ok", output: { outcome: "not_found" } satisfies CancelOutcome };
    const res = ctx.pendingActions.cancel(args.id);
    // Parity: the inline route broadcasts cancelled unconditionally after the has() guard.
    ctx.broadcast({ type: "action_resolved", actionId: args.id, outcome: "cancelled" });
    return { kind: "ok", output: { outcome: "ok", already: res.reason === "lost_race" } satisfies CancelOutcome };
  },
};

// ── POST /api/commands/approve ───────────────────────────────────────────────
/** The discriminated handler output for approve — toHttp narrows this. */
type ApproveOutcome =
  | { outcome: "not_found" }
  | { outcome: "dead_pane" }
  | { outcome: "already" }
  | { outcome: "ok" };

export const approvePendingCommand: ActionDef<typeof ApproveParams> = {
  name: "approve_pending_command",
  description: "Approve or reject a pending spoken-command approval by messageId (approved=true approves, false rejects). The operator's HiTL decision — ALWAYS_ALLOWED.",
  params: ApproveParams,
  capability: ALWAYS_ALLOWED,
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: {
    method: "post",
    path: "/api/commands/approve",
    toHttp: (result): { status: number; body: unknown } => {
      // wsm-e2e-pinned-wqk: a malformed body (missing/non-boolean `approved`) fails zod validation
      // BEFORE the handler runs, producing a top-level kind:'error' ActionResult — NOT a def-shaped
      // ApproveOutcome. The old code cast the ok-fallback `{outcome:'not_found'}` onto this case,
      // which folded any handler/validation throw into the same 404 a real missing-messageId gets.
      // Special-case it via errorToHttp (400 validation / 500 handler-fault) instead: distinct from 404,
      // and (unlike loosening ApproveParams to coerce a missing `approved` to false) never silently
      // applies a reject side effect on bad input.
      if (result.kind === "error") return errorToHttp(result);
      const o = (result.kind === "ok" ? result.output : { outcome: "not_found" }) as ApproveOutcome;
      if (o.outcome === "not_found") return { status: 404, body: { error: "Pending command not found" } };
      if (o.outcome === "dead_pane") return { status: 422, body: { success: false, error: "target pane missing" } };
      if (o.outcome === "already") return { status: 200, body: { success: true, already: true } };
      return { status: 200, body: { success: true } };
    },
  },
  handler: (args, ctx): ActionResult => {
    if (!ctx.pendingApprovals.has(args.messageId)) return { kind: "ok", output: { outcome: "not_found" } satisfies ApproveOutcome };
    const action = ctx.applyResolution(args.messageId, args.approved ? "approve" : "reject");
    if (action.reason === "not_found") return { kind: "ok", output: { outcome: "not_found" } satisfies ApproveOutcome };
    if (action.reason === "dead_pane") return { kind: "ok", output: { outcome: "dead_pane" } satisfies ApproveOutcome };
    if (action.reason === "lost_race") return { kind: "ok", output: { outcome: "already" } satisfies ApproveOutcome };
    return { kind: "ok", output: { outcome: "ok" } satisfies ApproveOutcome };
  },
};

/** The c55.15 approvals/pending REST group registry slice. */
export const APPROVALS_REST_ACTIONS: ActionDef[] = [
  listPendingCommands,
  listPendingActions,
  confirmPendingAction,
  cancelPendingAction,
  approvePendingCommand,
];
