/**
 * src/actions/defs/lifecycle_rest.ts — c55.14: project/pane lifecycle (rest-only).
 *
 * update_project + stop_pane are ungated plumbing (ALWAYS_ALLOWED). delete_project + delete_pane are
 * the DESTRUCTIVE deletes — GATED (delete_project / delete_pane, default Ask) via ctx.gateOrDefer with
 * STATUS-VIA-KINDS (Off->blocked->403, Ask->pending->202, Auto->ok->200), mirroring respawn_pane. This
 * is a deliberate behaviorDelta: the inline deletes were ungated; they now Ask (director decision, c55.14).
 */
import { z } from "zod";
import type { ActionDef, ActionResult } from "../types";
import { ALWAYS_ALLOWED } from "../types";
import { getExchangeService } from "../../exchanges/spine";
import {
  resumeInspectExchange,
  retryExchange,
  cancelExchangeDurable,
  openExchangePane,
} from "../../exchanges/recoveryActions";

const UpdateProjectParams = z.object({
  project_id: z.string(),
  directory: z.string().optional(),
  summary: z.string().optional(),
  keyTerms: z.array(z.string()).optional(),
  name: z.string().optional(),
});
export const updateProject: ActionDef<typeof UpdateProjectParams> = {
  name: "update_project",
  description: "Update a project's directory/summary/keyTerms/name (operator-UI, ungated).",
  params: UpdateProjectParams,
  capability: ALWAYS_ALLOWED,
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: { method: "put", path: "/api/projects/:project_id" },
  handler: (args, ctx): ActionResult => {
    // 2S.4: frozen means frozen — ALWAYS_ALLOWED bypasses the gate matrix (and its frozen
    // short-circuit), so this project-metadata mutator must check the STOP-ALL brake itself.
    // (stop_pane below stays EXEMPT: stopping a pane is a de-escalation, like the brake trio.)
    if (ctx.isFrozen()) return { kind: "error", message: "Stop-all is engaged — release it first." };
    const ws = ctx.manager.ledger.getProject(args.project_id);
    if (!ws) return { kind: "ok", output: `Project ${args.project_id} not found.` }; // inline 404 -> 200 ok-narration
    if (args.directory !== undefined) ws.directory = args.directory;
    if (args.summary !== undefined) ws.summary = args.summary;
    if (args.keyTerms !== undefined) ws.keyTerms = Array.isArray(args.keyTerms) ? args.keyTerms : [];
    if (args.name !== undefined) ws.name = args.name;
    ctx.manager.ledger["save"](true);
    ctx.broadcastLedgerUpdate();
    return { kind: "ok", output: `Project ${args.project_id} updated.` };
  },
};

const StopPaneParams = z.object({ project_id: z.string(), pane_id: z.string() });
export const stopPane: ActionDef<typeof StopPaneParams> = {
  name: "stop_pane",
  description: "Gracefully stop a pane and archive it (recoverable). Operator-UI, ungated (the destructive hard-delete is delete_pane).",
  params: StopPaneParams,
  capability: ALWAYS_ALLOWED,
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: { method: "post", path: "/api/projects/:project_id/panes/:pane_id/stop" },
  handler: async (args, ctx): Promise<ActionResult> => {
    const archived = await ctx.manager.stopAndArchivePane(args.project_id, args.pane_id);
    ctx.broadcastLedgerUpdate();
    ctx.broadcastTerminalsUpdated();
    return { kind: "ok", output: `Pane ${args.pane_id} stopped and archived (${archived}).` };
  },
};

const DeleteProjectParams = z.object({ project_id: z.string() });
export const deleteProject: ActionDef<typeof DeleteProjectParams> = {
  name: "delete_project",
  description: "Permanently delete a project workspace. GATED (delete_project, default Ask): refused Off, asks in Ask, runs in Auto.",
  params: DeleteProjectParams,
  capability: "delete_project",
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: { method: "delete", path: "/api/projects/:project_id" },
  handler: (args, ctx): ActionResult => {
    const id = args.project_id;
    if (!ctx.manager.ledger.workspaces[id]) return { kind: "ok", output: `Project ${id} not found.` }; // resolve before gate
    const deleteEffect = (): string => {
      // wsm-e2e-pinned major-finding fix: a snapshot mutation (`delete workspaces[id]`) is a silent
      // no-op against JanusStore (the only production backend) — `deleteProject` issues the real
      // durable row DELETE (panes cascade via the schema's ON DELETE CASCADE).
      ctx.manager.ledger.deleteProject(id);
      const remainingIds = Object.keys(ctx.manager.ledger.workspaces);
      if (ctx.manager.ledger.activeProjectId === id) {
        const nextId = remainingIds[0] || "default_project";
        if (!ctx.manager.ledger.workspaces[nextId]) {
          ctx.manager.ledger.addProject(nextId, process.cwd(), "Default workspace");
        }
        ctx.manager.ledger.switchContext(nextId);
        ctx.manager.settings.projects.activeContext = nextId;
        ctx.manager.settings.projects.localWorkspacePath = ctx.manager.ledger.workspaces[nextId]?.directory || process.cwd();
        ctx.manager.saveSettings();
      }
      ctx.manager.ledger["save"]();
      ctx.broadcastLedgerUpdate();
      return `Project ${id} deleted.`;
    };
    const g = ctx.gateOrDefer("delete_project", null, `Delete project ${id}`, deleteEffect, { ...(ctx.versionStamp ?? {}), origin: "rest", projectId: id });
    if (g.disposition === "forbidden") return { kind: "blocked", reason: "Error: the 'delete_project' capability is gated Off; deleting projects is forbidden by policy." };
    if (g.disposition === "deferred") return { kind: "pending", messageId: g.actionId, summary: g.summary };
    return { kind: "ok", output: deleteEffect() };
  },
};

const DeletePaneParams = z.object({ project_id: z.string(), pane_id: z.string() });
export const deletePane: ActionDef<typeof DeletePaneParams> = {
  name: "delete_pane",
  description: "Permanently delete a pane record (hard delete; not the recoverable stop_pane). GATED (delete_pane, default Ask).",
  params: DeletePaneParams,
  capability: "delete_pane",
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: { method: "delete", path: "/api/projects/:project_id/panes/:pane_id" },
  handler: (args, ctx): ActionResult => {
    const { project_id, pane_id } = args;
    // Resolve a non-existent pane to ok-narration BEFORE the gate — consistent with delete_project /
    // respawn_pane: we never stage (Ask) or forbid (Off) a delete of a pane that does not exist.
    const existingWs = ctx.manager.ledger.getProject(project_id);
    if (!ctx.manager.terminals[pane_id] && !(existingWs && existingWs.panes[pane_id])) {
      return { kind: "ok", output: `Pane ${pane_id} not found.` };
    }
    const deleteEffect = (): string => {
      const term = ctx.manager.terminals[pane_id];
      if (term) { term.stop(); delete ctx.manager.terminals[pane_id]; }
      // wsm-e2e-pinned major-finding fix: a snapshot mutation (`delete ws.panes[id]`) is a silent
      // no-op against JanusStore — `deletePane` issues the real durable row DELETE. The pre-gate
      // existence check above already guarantees a row (or a live term) is present, so this always
      // fires; `save()` stays for LedgerLike parity (a no-op on JanusStore, a real flush for a
      // hand-rolled test double).
      ctx.manager.ledger.deletePane(project_id, pane_id);
      ctx.manager.ledger["save"]();
      ctx.broadcastLedgerUpdate();
      ctx.broadcastTerminalsUpdated();
      return `Pane ${pane_id} deleted.`;
    };
    const g = ctx.gateOrDefer("delete_pane", pane_id, `Delete pane ${pane_id}`, deleteEffect, { ...(ctx.versionStamp ?? {}), origin: "rest", paneId: pane_id });
    if (g.disposition === "forbidden") return { kind: "blocked", reason: "Error: the 'delete_pane' capability is gated Off; deleting panes is forbidden by policy." };
    if (g.disposition === "deferred") return { kind: "pending", messageId: g.actionId, summary: g.summary };
    return { kind: "ok", output: deleteEffect() };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// AgentExchange spine — RECOVERY ACTIONS (Phase 4, Step 4.3). The operator-facing surface for
// what boot recovery (src/exchanges/recovery.ts) leaves behind: an INTERRUPTED (or provably-
// failed-draft) exchange sits quarantined until the operator explicitly inspects/retries/cancels
// it — never auto-resumed (spec §4). Logic lives in src/exchanges/recoveryActions.ts (store-level,
// so it works on an exchange minted in a PRIOR process); these four defs are thin REST wrappers.
//
// SCOPE NOTE (voice): these all key off an opaque `exchange_id` (the id an attention item /
// notification already carries per the correlation map, spec §5) — not naturally something an
// operator would SPEAK. A voice-natural phrasing ("retry the failed one on the codex pane") needs
// pane-scoped resolution instead of an id lookup, which is a larger surface than this step owns;
// deferred, not silently dropped. REST is what the Workbench/attention UI needs today, and is
// fully wired.
// ─────────────────────────────────────────────────────────────────────────────

const ExchangeIdParams = z.object({ exchange_id: z.string() });

/** resume-inspect: surface an interrupted (or any) exchange's current durable state + its recent
 *  event timeline. Read-only; ALWAYS_ALLOWED (mirrors get_status_summary's ALWAYS_ALLOWED +
 *  readOnly:false resolution — the §8.1 invariant only permits readOnly:true for read_pane/
 *  read_notes, so an ALWAYS_ALLOWED read stays readOnly:false here too). */
export const resumeInspectExchangeAction: ActionDef<typeof ExchangeIdParams> = {
  name: "resume_inspect_exchange",
  description: "Inspect an interrupted (or any) exchange's current state and recent event history — the recovery drill-down for an attention item.",
  params: ExchangeIdParams,
  capability: ALWAYS_ALLOWED,
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: { method: "get", path: "/api/exchanges/:exchange_id/inspect" },
  handler: (args, ctx): ActionResult => {
    if (!ctx.store) return { kind: "ok", output: "Exchange spine store unavailable." };
    const view = resumeInspectExchange(ctx.store, args.exchange_id);
    if (!view) return { kind: "ok", output: `Exchange ${args.exchange_id} not found.` };
    return { kind: "ok", output: view };
  },
};

/**
 * retry: re-deliver a provably-failed `draft` exchange under the SAME exchange, or (for an
 * `interrupted` exchange, which the lifecycle machine never lets resume) create a brand-new
 * follow-up draft instead — see src/exchanges/recoveryActions.ts's module doc for the full
 * reconciliation of this policy against the spec's "never auto-resume" hard rule. GATED
 * write_to_pane (the same-exchange leg performs a real pane write; the whole action is gated
 * uniformly for a single, simple, conservative rule). Off->blocked->403, Ask->pending->202,
 * Auto->run-now->200.
 * NOTE (durable replay): like respawn_pane/send_keys, an IN-PROCESS Ask->confirm replays this
 * exact closure; a confirm AFTER a process restart has no buildActionRun case for it yet — an
 * accepted out-of-scope limitation matching the c55 precedent for these rest-only recovery caps.
 */
export const retryExchangeAction: ActionDef<typeof ExchangeIdParams> = {
  name: "retry_exchange",
  description: "Retry an exchange: re-delivers the SAME exchange only when its prior attempt is provably failed; an interrupted exchange instead gets a brand-new follow-up draft (never an automatic resend). GATED (write_to_pane, default Ask).",
  params: ExchangeIdParams,
  capability: "write_to_pane",
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: { method: "post", path: "/api/exchanges/:exchange_id/retry" },
  handler: (args, ctx): ActionResult => {
    if (!ctx.store) return { kind: "ok", output: "Exchange spine store unavailable." };
    const exchange = ctx.store.getExchange(args.exchange_id);
    if (!exchange) return { kind: "ok", output: `Exchange ${args.exchange_id} not found.` };
    const term = ctx.manager.terminals[exchange.pane_id];
    const retryEffect = (): string =>
      retryExchange(ctx.store!, getExchangeService(), args.exchange_id, term).message;
    const g = ctx.gateOrDefer(
      "write_to_pane",
      exchange.pane_id,
      `Retry exchange ${args.exchange_id}`,
      retryEffect,
      { ...(ctx.versionStamp ?? {}), exchangeId: args.exchange_id }
    );
    if (g.disposition === "forbidden") {
      return { kind: "blocked", reason: "Error: the 'write_to_pane' capability is gated Off; retrying exchanges is forbidden by policy." };
    }
    if (g.disposition === "deferred") {
      return { kind: "pending", messageId: g.actionId, summary: g.summary };
    }
    return { kind: "ok", output: retryEffect() };
  },
};

/** cancel: dismiss any cancellable exchange (including `interrupted` — its only real legal edge).
 *  ALWAYS_ALLOWED — a de-escalation, like stop_pane / the brake trio: dismissing something never
 *  writes to a pane or does anything an Off gate would need to forbid. */
export const cancelExchangeAction: ActionDef<typeof ExchangeIdParams> = {
  name: "cancel_exchange",
  description: "Cancel/dismiss an exchange (including an interrupted one — this is its only way out besides a retry follow-up). Ungated de-escalation.",
  params: ExchangeIdParams,
  capability: ALWAYS_ALLOWED,
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: { method: "post", path: "/api/exchanges/:exchange_id/cancel" },
  handler: (args, ctx): ActionResult => {
    if (!ctx.store) return { kind: "ok", output: "Exchange spine store unavailable." };
    const result = cancelExchangeDurable(ctx.store, getExchangeService(), args.exchange_id, "operator_cancelled");
    return { kind: "ok", output: result.message };
  },
};

/** open-pane: resolve which (project, pane) an exchange belongs to, for a client that only has an
 *  exchange_id (from an attention item) and needs to navigate the UI there. Read-only. */
export const openExchangePaneAction: ActionDef<typeof ExchangeIdParams> = {
  name: "open_exchange_pane",
  description: "Resolve the (project, pane) an exchange belongs to, so a client holding only an exchange_id can navigate to it.",
  params: ExchangeIdParams,
  capability: ALWAYS_ALLOWED,
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: { method: "get", path: "/api/exchanges/:exchange_id/pane" },
  handler: (args, ctx): ActionResult => {
    if (!ctx.store) return { kind: "ok", output: "Exchange spine store unavailable." };
    const view = openExchangePane(ctx.store, args.exchange_id);
    if (!view) return { kind: "ok", output: `Exchange ${args.exchange_id} not found.` };
    return { kind: "ok", output: view };
  },
};

export const LIFECYCLE_REST_ACTIONS: ActionDef[] = [
  updateProject,
  stopPane,
  deleteProject,
  deletePane,
  resumeInspectExchangeAction,
  retryExchangeAction,
  cancelExchangeAction,
  openExchangePaneAction,
];
