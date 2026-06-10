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
      delete ctx.manager.ledger.workspaces[id];
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
      const ws = ctx.manager.ledger.getProject(project_id);
      if (ws && ws.panes[pane_id]) { delete ws.panes[pane_id]; ctx.manager.ledger["save"](); }
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

export const LIFECYCLE_REST_ACTIONS: ActionDef[] = [updateProject, stopPane, deleteProject, deletePane];
