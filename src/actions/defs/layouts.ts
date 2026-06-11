/**
 * src/actions/defs/layouts.ts — PANE LAYOUTS (journey-expansion: "mise en place", split out of
 * recipes). A layout is a SNAPSHOT of a project's pane formation — launch command, cwd, preset,
 * permission mode per pane. Pure furniture: no orchestration logic, nothing is ever auto-run.
 *
 * Four defs:
 *  - save_project_layout : snapshot the LIVE panes of a project into a named layout
 *                          (gateOrDefer "update_metadata", default Auto — it writes only metadata).
 *  - list_layouts        : READ — capability "read_notes", readOnly:true.
 *  - apply_layout        : re-materialize the formation — rides the SAME gates as a recipe apply
 *                          (apply_recipe layout Off-veto + per-pane create_pane via gateOrDefer),
 *                          reusing the pure planner planRecipeApply so the two paths cannot drift.
 *  - delete_layout       : gateOrDefer "update_metadata".
 *
 * Persistence: ledger.layouts — a self-persisting document array (kv/Proxy on JanusStore; JSON
 * field on the legacy Ledger), the watchRules/plans pattern. Deferred intents are not
 * durable-replayable across a restart (send_keys scope-out precedent); in-process confirm replays.
 */

import { z } from "zod";
import type { ActionDef, ActionResult } from "../types";
import type { PaneLayout, LayoutPane } from "../../types";
import { planRecipeApply } from "../../recipeApply";

// ─────────────────────────────────────────────────────────────────────────────
// save_project_layout — POST /api/layouts (gated update_metadata, default Auto).
// ─────────────────────────────────────────────────────────────────────────────

const SaveProjectLayoutParams = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  /** Project to snapshot; defaults to the active project. */
  project_id: z.string().optional(),
});

export const saveProjectLayout: ActionDef<typeof SaveProjectLayoutParams> = {
  name: "save_project_layout",
  description:
    "Snapshot the current project's running panes (launch command, directory, preset, permission mode) as a named layout you can re-apply later with apply_layout. Only live panes are captured.",
  params: SaveProjectLayoutParams,
  capability: "update_metadata",
  readOnly: false,
  surfaces: new Set(["voice", "rest"]),
  rest: { method: "post", path: "/api/layouts" },
  handler: (args, ctx): ActionResult => {
    const projectId = args.project_id || ctx.manager.ledger.activeProjectId || "default_project";
    const proj = ctx.manager.ledger.getProject(projectId);
    if (!proj) {
      return { kind: "ok", output: `Error: project '${projectId}' not found; nothing to snapshot.` };
    }
    const panes: LayoutPane[] = Object.values(ctx.manager.terminals)
      .filter((t: any) => t.projectId === projectId)
      .map((t: any) => ({
        id: t.terminalId,
        name: t.terminalId,
        command: String(t.shellCmd ?? ""),
        cwd: String(t.cwd ?? ""),
        preset: t.toolPreset ?? "Custom",
        permissionsMode: t.permissionsMode ?? "Human-in-the-Loop",
      }));
    if (panes.length === 0) {
      return { kind: "ok", output: `Project '${projectId}' has no live panes to snapshot. Start the panes you want captured first.` };
    }
    const now = Date.now();
    const layout: PaneLayout = {
      id: "layout_" + now.toString(36) + Math.random().toString(36).slice(2, 7),
      name: args.name,
      description: args.description,
      sourceProjectId: projectId,
      panes,
      created_at: now,
    };
    const saveEffect = (): string => {
      ctx.manager.ledger.layouts.push(layout);
      ctx.manager.ledger["save"](true);
      ctx.broadcast({ type: "layouts_updated", layouts: ctx.manager.ledger.layouts });
      return `Layout '${layout.name}' saved (id ${layout.id}) with ${panes.length} pane(s): ${panes.map((p) => p.id).join(", ")}.`;
    };
    const g = ctx.gateOrDefer(
      "update_metadata",
      null,
      `Save layout '${args.name}' from project ${projectId}`,
      saveEffect,
      { ...(ctx.versionStamp ?? {}), origin: ctx.surface ?? "rest" }
    );
    if (g.disposition === "forbidden") {
      return { kind: "blocked", reason: "Error: the 'update_metadata' capability is gated Off; saving layouts is forbidden by policy." };
    }
    if (g.disposition === "deferred") {
      return { kind: "pending", messageId: g.actionId, summary: g.summary };
    }
    return { kind: "ok", output: saveEffect() };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// list_layouts — GET /api/layouts (READ).
// ─────────────────────────────────────────────────────────────────────────────

const ListLayoutsParams = z.object({});

export const listLayouts: ActionDef<typeof ListLayoutsParams> = {
  name: "list_layouts",
  description: "List the saved pane layouts (name, source project, and the panes each would spawn).",
  params: ListLayoutsParams,
  capability: "read_notes",
  readOnly: true,
  surfaces: new Set(["voice", "rest"]),
  rest: {
    method: "get",
    path: "/api/layouts",
    toHttp: (result): { status: number; body: unknown } => ({
      status: 200,
      body: result.kind === "ok" ? ((result.output as { layouts?: unknown })?.layouts ?? []) : [],
    }),
  },
  handler: (_args, ctx): ActionResult => {
    const layouts = ctx.manager.ledger.layouts;
    return { kind: "ok", output: { count: layouts.length, layouts } };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// apply_layout — POST /api/layouts/:layout_id/apply (apply_recipe veto + per-pane create_pane).
// ─────────────────────────────────────────────────────────────────────────────

const ApplyLayoutParams = z.object({
  layout_id: z.string(),
});

export const applyLayout: ActionDef<typeof ApplyLayoutParams> = {
  name: "apply_layout",
  description:
    "Re-materialize a saved pane layout into the active project: spawn each captured pane with its saved command, directory, preset, and permission mode. Already-running pane ids are skipped. Gated like applying a recipe.",
  params: ApplyLayoutParams,
  capability: "apply_recipe",
  readOnly: false,
  surfaces: new Set(["voice", "rest"]),
  rest: { method: "post", path: "/api/layouts/:layout_id/apply" },
  handler: (args, ctx): ActionResult => {
    const layout = ctx.manager.ledger.layouts.find((l) => l.id === args.layout_id || l.name === args.layout_id);
    if (!layout) {
      return { kind: "ok", output: `Layout '${args.layout_id}' not found. Use list_layouts to see what is saved.` };
    }
    const activeProjectId = ctx.manager.ledger.activeProjectId || "default_project";
    const proj = ctx.manager.ledger.getProject(activeProjectId);
    if (!proj) {
      return { kind: "ok", output: "Error: There is no active project context to apply the layout under." };
    }
    // The SAME gate shape as apply_orchestration_recipe: one audit row for the layout-level
    // capability, the pure planner for the Off-veto + per-pane dispositions, then per-pane
    // gateOrDefer("create_pane") around an identical spawn closure.
    ctx.gateCapability("apply_recipe", null);
    const plan = planRecipeApply(
      layout.panes,
      new Set(Object.keys(ctx.manager.terminals)),
      () => ctx.effectiveCapabilityGateFor(null, "apply_recipe"),
      (id) => ctx.effectiveCapabilityGateFor(id, "create_pane"),
    );
    if (plan.layoutForbidden) {
      return {
        kind: "blocked",
        reason: "Error: the 'apply_recipe' capability is gated Off; spawning layouts is forbidden by policy.",
      };
    }
    const paneById = new Map(layout.panes.map((p) => [p.id, p]));
    const spawned: string[] = [];
    const deferred: string[] = [];
    const blocked: string[] = [];
    const skipped: string[] = [];
    for (const planned of plan.panes) {
      if (planned.disposition === "skip-existing") {
        skipped.push(planned.paneId);
        continue;
      }
      if (planned.disposition === "block") {
        blocked.push(planned.paneId);
        continue;
      }
      const p = paneById.get(planned.paneId)!;
      const spawnPane = (): string => {
        ctx.manager.addTerminal(
          p.id,
          p.cwd || proj.directory || process.cwd(),
          p.command,
          p.preset,
          p.permissionsMode as any,
          "",
          activeProjectId,
        );
        ctx.broadcastLedgerUpdate();
        ctx.broadcast({ type: "terminals_updated" });
        return p.id;
      };
      if (planned.disposition === "defer") {
        const g = ctx.gateOrDefer(
          "create_pane",
          p.id,
          `Create pane ${p.id} (layout ${layout.name})`,
          spawnPane,
          {
            ...(ctx.versionStamp ?? {}),
            origin: "recipe",
            paneId: p.id,
            cwd: p.cwd || proj.directory || process.cwd(),
            command: p.command,
            toolPreset: p.preset,
            permissionsMode: p.permissionsMode,
            projectId: activeProjectId,
          }
        );
        if (g.disposition === "deferred") deferred.push(p.id);
        else if (g.disposition === "forbidden") blocked.push(p.id);
        else spawned.push(spawnPane());
      } else {
        spawned.push(spawnPane());
      }
    }
    const parts: string[] = [`Layout '${layout.name}' applied to project ${activeProjectId}.`];
    if (spawned.length) parts.push(`Spawned: ${spawned.join(", ")}.`);
    if (deferred.length) parts.push(`Awaiting confirmation (gated Ask): ${deferred.join(", ")}.`);
    if (skipped.length) parts.push(`Already running (skipped): ${skipped.join(", ")}.`);
    if (blocked.length) parts.push(`Blocked by policy: ${blocked.join(", ")}.`);
    return { kind: "ok", output: parts.join(" ") };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// delete_layout — DELETE /api/layouts/:layout_id (gated update_metadata).
// ─────────────────────────────────────────────────────────────────────────────

const DeleteLayoutParams = z.object({
  layout_id: z.string(),
});

export const deleteLayout: ActionDef<typeof DeleteLayoutParams> = {
  name: "delete_layout",
  description: "Delete a saved pane layout by its id.",
  params: DeleteLayoutParams,
  capability: "update_metadata",
  readOnly: false,
  surfaces: new Set(["voice", "rest"]),
  rest: { method: "delete", path: "/api/layouts/:layout_id" },
  handler: (args, ctx): ActionResult => {
    const idx = ctx.manager.ledger.layouts.findIndex((l) => l.id === args.layout_id);
    if (idx === -1) {
      return { kind: "ok", output: `Layout ${args.layout_id} not found.` };
    }
    const deleteEffect = (): string => {
      const i = ctx.manager.ledger.layouts.findIndex((l) => l.id === args.layout_id);
      if (i !== -1) {
        const [removed] = ctx.manager.ledger.layouts.splice(i, 1);
        ctx.manager.ledger["save"](true);
        ctx.broadcast({ type: "layouts_updated", layouts: ctx.manager.ledger.layouts });
        return `Layout '${removed.name}' deleted.`;
      }
      return `Layout ${args.layout_id} not found.`;
    };
    const g = ctx.gateOrDefer(
      "update_metadata",
      null,
      `Delete layout ${args.layout_id}`,
      deleteEffect,
      { ...(ctx.versionStamp ?? {}), origin: ctx.surface ?? "rest" }
    );
    if (g.disposition === "forbidden") {
      return { kind: "blocked", reason: "Error: the 'update_metadata' capability is gated Off; deleting layouts is forbidden by policy." };
    }
    if (g.disposition === "deferred") {
      return { kind: "pending", messageId: g.actionId, summary: g.summary };
    }
    return { kind: "ok", output: deleteEffect() };
  },
};

/** The pane-layouts registry slice. */
export const LAYOUTS_ACTIONS: ActionDef[] = [
  saveProjectLayout,
  listLayouts,
  applyLayout,
  deleteLayout,
];
