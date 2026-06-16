/**
 * src/actions/defs/archive.ts — c55.13: the ARCHIVE group (operator-UI archive management).
 *
 * Faithful ports of the inline GET/POST/DELETE /api/archive routes: list/delete are UNGATED
 * operator-direct (spec §10 step 3 classifies archive RECORD management as plumbing), unredacted,
 * ALWAYS_ALLOWED + readOnly:false (the §8.1 invariant binds readOnly to read_pane/read_notes;
 * ungated reads use false, same as get_stop_all_status). restore is the exception (core-journeys
 * gap fix): its LEDGER restore stays plumbing, but it now ALSO respawns the pane's PTY, and
 * respawning a process is NOT plumbing — the spawn rides the `restart_pane` gate via
 * ctx.gateOrDefer, exactly like the burner's Re-fire (respawn_pane). list rides rest.toHttp to
 * emit {archived:[…]} top-level; restore/delete use the default {output} map (the UI repaints off
 * ledger_updated/terminals_updated). rest-only (no voice twin planned).
 */
import { z } from "zod";
import type { ActionDef, ActionResult } from "../types";
import { ALWAYS_ALLOWED } from "../types";
import { normalizePreset, presetCommand } from "../../terminal";

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
    const archived = ctx.manager.ledger.listArchived().map((a) => ({
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

/**
 * restore_archived_pane — restore the LEDGER row (plumbing, ungated — the original c55.13 port)
 * AND respawn the pane's terminal from its PERSISTED identity (core-journeys gap fix; the gap was
 * surfaced honestly by e2e/live_journeys.spec.ts: the kitchen board derives stations from
 * GET /api/terminals = live manager.terminals only, so a ledger-only restore showed NO card anywhere).
 *
 * The RESPAWN is NOT plumbing — it starts a process — so it rides the SAME `restart_pane` gate as the
 * burner's Re-fire (respawn_pane, src/actions/defs/panes_rest.ts), via ctx.gateOrDefer. The def's
 * declared capability moves ALWAYS_ALLOWED -> restart_pane for HONEST matrix projection/audit (no new
 * matrix row: deriveCapabilities de-dupes; respawn_pane already rides it). Per the handler-owned gate
 * model (types.ts:200-213) the LEDGER restore itself stays ungated — only the spawn is gated:
 *   - Auto → ledger row back + spawn now (the card reappears immediately).
 *   - Ask  → ledger row back NOW; the spawn is STAGED to the action dialog (pendingActions). The
 *            narration says exactly that. Confirm replays the real closure in-process; a
 *            confirm-AFTER-restart degrades to the buildActionRun "unknown capability" no-op string —
 *            the SAME accepted limitation as respawn_pane (panes_rest.ts:21-25).
 *   - Off  → ledger row back; the spawn is refused and narrated (the pane is parked/inert — panes
 *            boot INERT by convention, so a ledger-only pane is a legitimate state).
 * The respawn launches the pane's RUNTIME command derived from tool_preset (presetCommand — one launch
 * home, exactly like respawn_pane's ledger-only branch). It NEVER auto-runs pane.last_command.
 * All three dispositions return 200 ok-narration: the ledger restore genuinely succeeded, and the
 * Pantry client only checks res.ok before its "back on the line" toast + refetches.
 */
export const restoreArchivedPane: ActionDef<typeof PaneIdParams> = {
  name: "restore_archived_pane",
  description: "Restore an archived pane back into its project AND respawn its terminal from the persisted identity (cwd/preset/permissions). The ledger restore is operator-UI plumbing; the respawn rides the restart_pane gate (Ask defers to the action dialog, Off restores the row only).",
  params: PaneIdParams,
  capability: "restart_pane", // the respawn's matrix row (shared with respawn_pane — no new row)
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: { method: "post", path: "/api/archive/:pane_id/restore" },
  handler: (args, ctx): ActionResult => {
    // 2S.4: frozen means frozen — the ledger-restore half of this handler is deliberately UNGATED
    // (it never routes through effectiveCapabilityGateFor, where the STOP-ALL frozen short-circuit
    // lives), so this mutator must check the STOP-ALL brake itself, BEFORE any side effect.
    if (ctx.isFrozen()) return { kind: "error", message: "Stop-all is engaged — release it first." };
    const entry = ctx.manager.ledger.restoreArchivedPane(args.pane_id);
    // Accepted delta (c55 program): not-found maps to 200 ok-narration, not the inline 404. The UI
    // ignores the body and repaints off the broadcasts (which do NOT fire on this failure path).
    if (!entry) return { kind: "ok", output: `Archived pane ${args.pane_id} not found.` };
    ctx.broadcastLedgerUpdate();
    ctx.broadcastTerminalsUpdated();

    // Already live (a lingering terminal object for the archived id): the row is back and the
    // process already exists — nothing to spawn, so nothing to gate.
    if (ctx.manager.terminals[args.pane_id]) {
      return { kind: "ok", output: `Pane ${args.pane_id} restored; its terminal is already running.` };
    }

    // Respawn from the PERSISTED identity — the exact respawn_pane ledger-only branch: cwd = the
    // pane's own project directory (legacy ledger recreates a missing project; SQLite falls back to
    // process.cwd()), command DERIVED from tool_preset (never last_command), persisted
    // permissions_mode + session_id, spawned INTO entry.project_id (not the active project).
    const pane = entry.pane;
    const preset = normalizePreset(pane.tool_preset);
    const cmd = presetCommand(preset, ctx.manager.settings.presets, ctx.manager.settings.advanced?.defaultShellCommand);
    const cwd = ctx.manager.ledger.getProject(entry.project_id)?.directory || process.cwd();
    const spawnEffect = (): string => {
      ctx.manager.addTerminal(
        args.pane_id,
        cwd,
        cmd,
        preset,
        pane.permissions_mode || "Human-in-the-Loop",
        pane.session_id || "",
        entry.project_id,
      );
      ctx.broadcastLedgerUpdate();
      ctx.broadcastTerminalsUpdated();
      return `Pane ${args.pane_id} restored and its terminal respawned.`;
    };
    const g = ctx.gateOrDefer(
      "restart_pane",
      args.pane_id,
      `Restart pane ${args.pane_id}`,
      spawnEffect,
      // Mirrors respawn_pane's staging bag. buildActionRun has no restart_pane case, so only the
      // in-process confirm replays (accepted limitation, panes_rest.ts:21-25).
      { ...(ctx.versionStamp ?? {}), origin: "rest", paneId: args.pane_id },
    );
    if (g.disposition === "forbidden") {
      // NOT kind:"blocked": the ledger restore DID land — a 403 would make the Pantry toast lie.
      return {
        kind: "ok",
        output: `Pane ${args.pane_id} restored to project ${entry.project_id}, but its terminal was NOT respawned: the 'restart_pane' capability is gated Off (forbidden by policy). The pane is parked until you restart it.`,
      };
    }
    if (g.disposition === "deferred") {
      return {
        kind: "ok",
        output: `Pane ${args.pane_id} restored to project ${entry.project_id}; respawning its terminal needs operator confirmation (gated Ask). I've queued it — confirm to start it.`,
      };
    }
    // Auto: gateOrDefer does NOT invoke `run` on the "run" disposition — the caller runs it now
    // (mirrors respawn_pane / create_pane).
    return { kind: "ok", output: spawnEffect() };
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
    // 2S.4: frozen means frozen — a permanent record delete may not run while the brake is engaged.
    if (ctx.isFrozen()) return { kind: "error", message: "Stop-all is engaged — release it first." };
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
