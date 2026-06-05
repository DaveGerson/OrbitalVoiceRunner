/**
 * src/actions/defs/panes_rest.ts — c55 Batch C (wsm-e2e-pinned-c55.3).
 *
 * Five NEW rest-only ActionDefs that converge inline pane/UI routes which have NO voice twin today.
 * surfaces = {'rest'} ONLY (so they never force a Gemini voice-tool description), and each replicates
 * its inline server.ts route logic FAITHFULLY. The default {output} body is fine because the UI clients
 * read only res.ok and repaint off the terminals_updated / ledger_updated WS frames the handlers fan out.
 *
 * Routes converged (the inline app.post(...) twins are deleted in the SAME change — never both, or
 * Express keeps the first-registered handler and silently masks the cutover):
 *   - respawn_pane   POST /api/terminals/:pane_id/restart        (server.ts ~648)
 *   - send_keys      POST /api/terminals/:pane_id/input          (server.ts ~700)
 *   - resize_pane    POST /api/terminals/:pane_id/resize         (server.ts ~721)
 *   - clear_history  POST /api/terminals/:pane_id/history/clear  (server.ts ~746)
 *   - clear_exited   POST /api/terminals/clear-exited            (server.ts ~976)
 *
 * GATING / SAFE DEFAULTS (Decision 3 + the c55 safe-default policy):
 *   - respawn_pane is GATED via ctx.gateOrDefer("restart_pane", ...) — the capability (still named
 *     restart_pane) already exists in the matrix (default Ask). The inline route SKIPPED the gate;
 *     converging it ENFORCES the gate (a deliberate safety improvement — recorded as a behaviorDelta).
 *     Off->blocked->403, Ask->pending->202, Auto->run-now->200. NOTE: buildActionRun (src/actionEffects.ts)
 *     has no restart_pane case, so an IN-PROCESS Ask->confirm replays the real `run` closure correctly
 *     (pendingActions keeps it), while a confirm-AFTER-process-restart would degrade to the "unknown
 *     capability" no-op string — an accepted limitation for this batch (durable restart-intent replay for
 *     respawn_pane is out of scope here).
 *   - send_keys / resize_pane / clear_history / clear_exited were UNGATED inline → registered
 *     ALWAYS_ALLOWED to preserve current instant behavior (recorded in appliedDefaults). A clear_history
 *     capability row exists in the matrix (default Ask), but the inline route was ungated, so the c55
 *     safe-default policy (preserve current behavior) wins: ALWAYS_ALLOWED, flagged for later tightening.
 *
 * STATUS-CODE DELTAS (Decision 2 — the client ignores the body / does not status-branch on these):
 *   - inline 404 "Terminal not found" (restart/send_keys) → 200 ok-narration.
 *   - inline 400 "Missing command" (send_keys) → zod-500 error.
 *   - inline 400 "cols/rows must be positive" (resize) → zod-500 error.
 *
 * HistoryManager (server.ts:129) is a server.ts-defined process-global singleton; importing it would
 * import server.ts and BOOT a real listener. So send_keys / clear_history re-implement its
 * addCommand / saveHistory inline against the SAME `.janus_history.json` at process.cwd() with the SAME
 * limits (settings.advanced.historyMaxCommands ?? 50 / historyMaxOutputLength ?? 5000) — byte-identical
 * behavior, no server cycle. This mirrors the reads.ts precedent (it inlines loadHistory the same way).
 */

import fs from "fs";
import path from "path";
import { z } from "zod";
import type { ActionContext, ActionDef, ActionResult } from "../types";
import { normalizePreset, presetCommand } from "../../terminal";

// ─────────────────────────────────────────────────────────────────────────────
// HistoryManager re-derivation (faithful port of server.ts:129-217 load/save/add).
// ─────────────────────────────────────────────────────────────────────────────

interface HistoryEntry {
  command: string;
  timestamp: string;
  output: string;
  finalResponse?: string;
}

function historyFilePath(): string {
  return path.join(process.cwd(), ".janus_history.json");
}

function historyLimits(ctx: ActionContext): { maxCmds: number; maxOutput: number } {
  const adv = ctx.manager.settings?.advanced as { historyMaxCommands?: number; historyMaxOutputLength?: number } | undefined;
  return { maxCmds: adv?.historyMaxCommands ?? 50, maxOutput: adv?.historyMaxOutputLength ?? 5000 };
}

/** FAITHFUL PORT of HistoryManager.loadHistory (server.ts:151): read .janus_history.json, return the
 *  pane's last maxCmds entries (or [] on missing/corrupt file / missing key). */
function loadHistory(ctx: ActionContext, terminalId: string): HistoryEntry[] {
  const { maxCmds } = historyLimits(ctx);
  try {
    const fp = historyFilePath();
    if (fs.existsSync(fp)) {
      const parsed = JSON.parse(fs.readFileSync(fp, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const list = parsed[terminalId];
        if (Array.isArray(list)) return list.slice(-maxCmds);
      }
    }
  } catch {
    /* missing / corrupt -> [] */
  }
  return [];
}

/** FAITHFUL PORT of HistoryManager.saveHistory (server.ts:171): prune to the last maxCmds, clamp each
 *  entry.output to maxOutput, merge into the on-disk map, write pretty JSON. Best-effort (warns, never
 *  throws). An empty array is a legitimate clear (clear_history). */
function saveHistory(ctx: ActionContext, terminalId: string, history: HistoryEntry[]): void {
  const { maxCmds, maxOutput } = historyLimits(ctx);
  try {
    const pruned = history.slice(-maxCmds).map((entry) => ({ ...entry, output: (entry.output || "").slice(-maxOutput) }));
    let allHistory: Record<string, HistoryEntry[]> = {};
    const fp = historyFilePath();
    if (fs.existsSync(fp)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(fp, "utf-8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) allHistory = parsed;
      } catch {
        /* corrupt existing file -> start fresh for this key */
      }
    }
    allHistory[terminalId] = pruned;
    fs.writeFileSync(fp, JSON.stringify(allHistory, null, 2), "utf-8");
  } catch (e) {
    console.warn(`[panes_rest] Failed to save history to ${historyFilePath()}:`, e);
  }
}

/** FAITHFUL PORT of HistoryManager.addCommand (server.ts:197): append a new empty-output entry, save. */
function addCommand(ctx: ActionContext, terminalId: string, command: string): void {
  const history = loadHistory(ctx, terminalId);
  history.push({ command, timestamp: new Date().toISOString(), output: "" });
  saveHistory(ctx, terminalId, history);
}

// ─────────────────────────────────────────────────────────────────────────────
// respawn_pane — POST /api/terminals/:pane_id/restart (GATED; behaviorDelta).
//   Renamed from restart_pane to resolve a name collision with the concurrent voice-only
//   `restart_pane` action (src/actions/defs/locks.ts), which applies a LIVE permission mode (it
//   does NOT restart a process). This action genuinely respawns the pane process (stop()+start()).
//   The CAPABILITY it rides is still named `restart_pane` (unchanged matrix row).
// ─────────────────────────────────────────────────────────────────────────────

const RespawnPaneParams = z.object({
  pane_id: z.string(),
});

/**
 * respawn_pane — FAITHFUL PORT of the inline app.post("/api/terminals/:id/restart") (server.ts ~648),
 * now ROUTED THROUGH ctx.gateOrDefer("restart_pane", ...) (the inline route skipped the gate). The gated
 * `run` closure (a single synchronous closure, so the SAME closure serves Auto-run-now AND the in-process
 * Ask->confirm replay via pendingActions) branches:
 *   - live terminal     -> kick off an ORDERED async restart: await term.stop() THEN term.start() (the
 *                          await ordering is load-bearing — the dying PTY's onExit must fire before the
 *                          replacement spawns, or the late exit flips the fresh pane to Exited, a zombie).
 *                          The ordering is preserved INSIDE the async IIFE; the closure returns its
 *                          confirm string immediately (the gate contract is synchronous `() => string`).
 *   - ledger-only pane  -> rebuild synchronously via manager.addTerminal with the DERIVED launch command
 *                          (presetCommand(normalizePreset(pane.tool_preset), ...)) — one launch home.
 *   - unknown pane      -> resolved BEFORE the gate: ok narration (inline 404 -> 200 ok, Decision 2), no
 *                          stage/forbid of a non-existent pane.
 * Off->blocked->403, Ask->pending->202, Auto->run-now->200.
 */
export const respawnPane: ActionDef<typeof RespawnPaneParams> = {
  name: "respawn_pane",
  description: "Respawn a terminal pane (stop its process and start it again). REST/UI surface only.",
  params: RespawnPaneParams,
  capability: "restart_pane",
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: { method: "post", path: "/api/terminals/:pane_id/restart" },
  handler: (args, ctx): ActionResult => {
    const id = args.pane_id;
    const term = ctx.manager.terminals[id];
    const activeProject = ctx.manager.ledger.getActiveProject();
    const pane = activeProject?.panes[id];

    // Unknown pane: faithful inline 404 path, surfaced as ok-narration (200) — the client ignores the
    // body. Resolve BEFORE the gate so we never stage/forbid a restart of a pane that does not exist.
    if (!term && !pane) {
      return { kind: "ok", output: `Terminal ${id} not found.` };
    }

    // ONE synchronous gated effect closure (serves Auto-run-now AND the in-process Ask->confirm replay).
    const restartEffect = (): string => {
      if (term) {
        // Ordered async restart, fire-and-return: stop() (SIGTERM->SIGKILL) MUST resolve before start()
        // spawns the replacement. The ordering is preserved inside this IIFE; the gate's sync `run`
        // contract only needs the confirm string back, which the inline route returned eagerly too.
        void (async () => {
          await term.stop();
          term.start();
          ctx.broadcastLedgerUpdate();
          ctx.broadcastTerminalsUpdated();
        })();
        return `Terminal ${id} restarted.`;
      }
      const preset = normalizePreset(pane!.tool_preset);
      const cmd = presetCommand(preset, ctx.manager.settings.presets, ctx.manager.settings.advanced?.defaultShellCommand);
      ctx.manager.addTerminal(id, activeProject!.directory || process.cwd(), cmd, preset, pane!.permissions_mode, pane!.session_id);
      ctx.broadcastLedgerUpdate();
      ctx.broadcastTerminalsUpdated();
      return `Terminal ${id} restored and started.`;
    };

    const g = ctx.gateOrDefer(
      "restart_pane",
      id,
      `Restart pane ${id}`,
      restartEffect,
      { ...(ctx.versionStamp ?? {}), origin: "rest", paneId: id }
    );

    if (g.disposition === "forbidden") {
      return { kind: "blocked", reason: "Error: the 'restart_pane' capability is gated Off; restarting panes is forbidden by policy." };
    }
    if (g.disposition === "deferred") {
      return { kind: "pending", messageId: g.actionId, summary: g.summary };
    }
    // Auto: gateOrDefer does NOT invoke `run` on the "run" disposition (it stages run only on Ask). The
    // caller runs the effect now (mirrors create_pane: `output: createPaneEffect()`).
    return { kind: "ok", output: restartEffect() };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// send_keys — POST /api/terminals/:pane_id/input (ALWAYS_ALLOWED; was ungated).
// ─────────────────────────────────────────────────────────────────────────────

const SendKeysParams = z.object({
  pane_id: z.string(),
  command: z.string(),
});

/**
 * send_keys — FAITHFUL PORT of inline app.post("/api/terminals/:id/input") (server.ts ~700). Records the
 * command in pane history (HistoryManager.addCommand re-derived inline) THEN writes it to the live PTY,
 * THEN broadcasts the ledger update. Unknown pane -> ok narration (inline 404 -> 200, Decision 2). The
 * inline route 400'd a missing command body; here the zod-required `command` makes that a 500 error
 * (Decision 2 — replaces inline 400). SAFE DEFAULT ALWAYS_ALLOWED (was ungated).
 */
export const sendKeys: ActionDef<typeof SendKeysParams> = {
  name: "send_keys",
  description: "Write a command directly to a terminal pane's input. REST/UI surface only.",
  params: SendKeysParams,
  capability: "ALWAYS_ALLOWED",
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: { method: "post", path: "/api/terminals/:pane_id/input" },
  handler: (args, ctx): ActionResult => {
    const id = args.pane_id;
    const command = args.command;
    const term = ctx.manager.terminals[id];
    if (!term) {
      return { kind: "ok", output: `Terminal ${id} not found or offline.` };
    }
    addCommand(ctx, id, command);
    term.writeInput(command);
    ctx.broadcastLedgerUpdate();
    return { kind: "ok", output: `Command successfully dispatched to terminal ${id}.` };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// resize_pane — POST /api/terminals/:pane_id/resize (ALWAYS_ALLOWED; was ungated).
// ─────────────────────────────────────────────────────────────────────────────

/** cols/rows must be POSITIVE INTEGERS — the zod schema replaces the inline `Number(...)` + manual 400
 *  (server.ts ~725). z.coerce.number() accepts the JSON-string body values a client may send. */
const ResizePaneParams = z.object({
  pane_id: z.string(),
  cols: z.coerce.number().int().positive(),
  rows: z.coerce.number().int().positive(),
});

/**
 * resize_pane — FAITHFUL PORT of inline app.post("/api/terminals/:id/resize") (server.ts ~721).
 * manager.resize(id, cols, rows) (a safe no-op for an unknown id — the inline route 404'd, here an
 * unknown id just no-ops to a 200 ok, Decision 2). Bad cols/rows are now a zod rejection (500) instead
 * of the inline 400 (Decision 2). SAFE DEFAULT ALWAYS_ALLOWED.
 */
export const resizePane: ActionDef<typeof ResizePaneParams> = {
  name: "resize_pane",
  description: "Resize a terminal pane's PTY grid to match the operator's viewport. REST/UI surface only.",
  params: ResizePaneParams,
  capability: "ALWAYS_ALLOWED",
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: { method: "post", path: "/api/terminals/:pane_id/resize" },
  handler: (args, ctx): ActionResult => {
    const id = args.pane_id;
    if (!ctx.manager.terminals[id]) {
      // Inline route 404'd; the manager.resize no-op + a 200 ok is the Decision-2 collapse (client
      // ignores the body — a stale client resizing a just-exited pane should not error).
      return { kind: "ok", output: `Terminal ${id} not found or offline.` };
    }
    ctx.manager.resize(id, args.cols, args.rows);
    return { kind: "ok", output: `Pane ${id} resized to ${args.cols}x${args.rows}.` };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// clear_history — POST /api/terminals/:pane_id/history/clear (ALWAYS_ALLOWED; was ungated).
// ─────────────────────────────────────────────────────────────────────────────

const ClearHistoryParams = z.object({
  pane_id: z.string(),
});

/**
 * clear_history — FAITHFUL PORT of inline app.post("/api/terminals/:id/history/clear") (server.ts ~746):
 * HistoryManager.saveHistory(id, []) (re-derived inline). SAFE DEFAULT ALWAYS_ALLOWED — the inline route
 * was ungated; even though a clear_history capability row exists (default Ask), the c55 safe-default
 * policy preserves current instant behavior (flagged for later tightening).
 */
export const clearHistory: ActionDef<typeof ClearHistoryParams> = {
  name: "clear_history",
  description: "Clear a terminal pane's recorded command history. REST/UI surface only.",
  params: ClearHistoryParams,
  capability: "ALWAYS_ALLOWED",
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: { method: "post", path: "/api/terminals/:pane_id/history/clear" },
  handler: (args, ctx): ActionResult => {
    saveHistory(ctx, args.pane_id, []);
    return { kind: "ok", output: `History cleared for terminal ${args.pane_id}.` };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// clear_exited — POST /api/terminals/clear-exited (ALWAYS_ALLOWED; was ungated).
// ─────────────────────────────────────────────────────────────────────────────

const ClearExitedParams = z.object({});

/**
 * clear_exited — FAITHFUL PORT of inline app.post("/api/terminals/clear-exited") (server.ts ~976):
 * stop+drop any live terminal objects for already-dead panes in the active project, archive all Exited
 * panes (recoverable, not a hard delete) via ledger.archiveExitedPanes(activeId), then broadcast ledger
 * + postures. SAFE DEFAULT ALWAYS_ALLOWED (was ungated). The {archived} count is carried in `output`.
 */
export const clearExited: ActionDef<typeof ClearExitedParams> = {
  name: "clear_exited",
  description: "Archive all exited panes in the active project (recoverable, not a hard delete). REST/UI surface only.",
  params: ClearExitedParams,
  capability: "ALWAYS_ALLOWED",
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: { method: "post", path: "/api/terminals/clear-exited" },
  handler: (_args, ctx): ActionResult => {
    const activeId = ctx.manager.ledger.activeProjectId || undefined;
    const ws = activeId ? ctx.manager.ledger.getProject(activeId) : null;
    if (ws) {
      for (const paneId of Object.keys(ws.panes)) {
        if (!ws.panes[paneId].alive && ctx.manager.terminals[paneId]) {
          ctx.manager.terminals[paneId].stop();
          delete ctx.manager.terminals[paneId];
        }
      }
    }
    const archived = ctx.manager.ledger.archiveExitedPanes(activeId);
    ctx.broadcastLedgerUpdate();
    ctx.broadcastTerminalsUpdated();
    return { kind: "ok", output: { success: true, archived } };
  },
};

/** The c55 Batch C rest-only registry slice. */
export const PANES_REST_ACTIONS: ActionDef[] = [
  respawnPane,
  sendKeys,
  resizePane,
  clearHistory,
  clearExited,
];
