/**
 * src/actions/defs/archive.ts — c55.13: the ARCHIVE group (operator-UI archive management).
 *
 * Faithful ports of the inline GET/POST/DELETE /api/archive routes: UNGATED operator-direct
 * (spec §10 step 3 classifies archive as plumbing), unredacted. ALWAYS_ALLOWED + readOnly:false
 * (the §8.1 invariant binds readOnly to read_pane/read_notes; ungated reads use false, same as
 * get_stop_all_status). list rides rest.toHttp to emit {archived:[…]} top-level; restore/delete
 * use the default {output} map (the UI repaints off ledger_updated/terminals_updated). rest-only
 * (no voice twin planned).
 */
import { z } from "zod";
import type { ActionDef, ActionResult } from "../types";
import { ALWAYS_ALLOWED } from "../types";

const NoParams = z.object({});
const PaneIdParams = z.object({ pane_id: z.string() });

export const listArchivedPanes: ActionDef<typeof NoParams> = {
  name: "list_archived_panes",
  description: "List archived (exited+cleared) panes for the UI restore tray (pane_id/name/project/preset/last_command/archived_at). UNGATED operator-UI read.",
  params: NoParams,
  capability: ALWAYS_ALLOWED,
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: {
    method: "get",
    path: "/api/archive",
    // Emit {archived:[…]} TOP-LEVEL — the exact legacy inline body shape.
    toHttp: (result): { status: number; body: unknown } => ({
      status: 200,
      body: { archived: result.kind === "ok" ? result.output : [] },
    }),
  },
  handler: (_args, ctx): ActionResult => {
    const archived = ctx.manager.ledger.listArchived().map((a: any) => ({
      pane_id: a.pane.pane_id,
      name: a.pane.name,
      project_id: a.project_id,
      tool_preset: a.pane.tool_preset,
      last_command: a.pane.last_command || "",
      archived_at: a.archived_at,
    }));
    return { kind: "ok", output: archived };
  },
};

export const restoreArchivedPane: ActionDef<typeof PaneIdParams> = {
  name: "restore_archived_pane",
  description: "Restore an archived pane back into its project (operator-UI, ungated). Re-fans the ledger + terminals so the live tree repaints.",
  params: PaneIdParams,
  capability: ALWAYS_ALLOWED,
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: { method: "post", path: "/api/archive/:pane_id/restore" },
  handler: (args, ctx): ActionResult => {
    const entry = ctx.manager.ledger.restoreArchivedPane(args.pane_id);
    // Accepted delta (c55 program): not-found maps to 200 ok-narration, not the inline 404. The UI
    // ignores the body and repaints off the broadcasts (which do NOT fire on this failure path).
    if (!entry) return { kind: "ok", output: `Archived pane ${args.pane_id} not found.` };
    ctx.broadcastLedgerUpdate();
    ctx.broadcastTerminalsUpdated();
    return { kind: "ok", output: `Pane ${args.pane_id} restored.` };
  },
};

export const deleteArchivedPane: ActionDef<typeof PaneIdParams> = {
  name: "delete_archived_pane",
  description: "Permanently delete an archived pane record from the restore tray (operator-UI, ungated).",
  params: PaneIdParams,
  capability: ALWAYS_ALLOWED,
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: { method: "delete", path: "/api/archive/:pane_id" },
  handler: (args, ctx): ActionResult => {
    const ok = ctx.manager.ledger.deleteArchivedPane(args.pane_id);
    if (!ok) return { kind: "ok", output: `Archived pane ${args.pane_id} not found.` };
    ctx.broadcastLedgerUpdate();
    return { kind: "ok", output: `Archived pane ${args.pane_id} deleted.` };
  },
};

/** The ARCHIVE group of the canonical registry. */
export const ARCHIVE_ACTIONS: ActionDef[] = [
  listArchivedPanes,
  restoreArchivedPane,
  deleteArchivedPane,
];
