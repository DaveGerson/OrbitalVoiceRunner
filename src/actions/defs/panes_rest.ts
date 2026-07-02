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
 *   - send_keys was UNGATED inline → registered ALWAYS_ALLOWED at cutover; c55.10 TIGHTENS it to its OWN
 *     matrix row `send_keys` (default Ask) + ctx.gateOrDefer — it is term.writeInput straight to the live
 *     PTY, the most consequential CLI keystroke act (the rest-only twin of the gated voice write).
 *     Off->blocked->403, Ask->pending->202, Auto->run-now->200.
 *   - resize_pane / clear_history / clear_exited STAY UNGATED (ALWAYS_ALLOWED) per c55.10 + the P2
 *     taxonomy: resize is viewport plumbing (Janus-of-Janus); clear_history clears the LOCAL
 *     .janus_history.json display/metadata buffer (neither a result read nor a CLI act); clear_exited
 *     archives already-exited panes (reversible, not a hard delete). A clear_history capability row
 *     EXISTS in the matrix (default Ask) but stays RESERVED/unwired — the c55.10 decision is to keep the
 *     rest def ALWAYS_ALLOWED (display-buffer vs result-loss); flipping it later needs no new cap id.
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
import { getHistoryBridge } from "../../historyBridge";
import { findPaneOwningProject } from "../../paneOwnership";
import { respawnFromLedger } from "../respawnFromLedger";

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

/** Bridge-first port of HistoryManager.addCommand: in a running server, write through the
 *  manager's dirty cache (a direct file write would race the debounced flush — PR #68 review);
 *  fall back to the faithful file port only when no server has registered the bridge. */
function addCommand(ctx: ActionContext, terminalId: string, command: string): void {
  const bridge = getHistoryBridge();
  if (bridge) { bridge.addCommand(terminalId, command); return; }
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
    // Resolve the pane via its OWNING project, not the active one (mirrors archive.ts Restore). A
    // ledger-only pane in a NON-active project would otherwise be missed here and — worse — respawned
    // into the active project's directory with no project id (lands it in the wrong project/cwd).
    const owner = findPaneOwningProject(ctx.manager, id);
    const pane = owner?.pane;

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
          // 86-during-restart race (wsm-e2e-pinned-kdtu): while stop() is awaited the pane reads Exited,
          // so the UI legitimately offers one-tap 86. If the operator archives in that gap, resuming here
          // and calling term.start() would respawn a GHOST PTY for a pane no longer on the board. TWO
          // guards, because the archive can land on either side of this continuation:
          //   1. OWNERSHIP — terminals[id] must still be THIS instance. Catches paths that delete the
          //      slot before this continuation resumes (delete_pane's synchronous hard delete, or an
          //      archive whose stop() completed on an earlier tick), and instance replacement.
          //   2. ARCHIVE INTENT — stopAndArchivePane may instead JOIN our in-flight stop(): its promise
          //      reaction is registered AFTER ours, so when stop() resolves WE resume first and the slot
          //      is still populated (ownership alone passes — the ghost the adversarial review proved).
          //      The archive marks manager.archivingPanes SYNCHRONOUSLY at entry, so that intent is
          //      visible here regardless of reaction order. (`?.` tolerates slim test fakes.)
          // The checks and term.start() share one synchronous tick — no await re-opens the window.
          if (ctx.manager.terminals[id] !== term || ctx.manager.archivingPanes?.has(id)) return;
          term.start();
          ctx.broadcastLedgerUpdate();
          ctx.broadcastTerminalsUpdated();
        })().catch((e) => console.error(`[restart_pane] deferred restart failed for ${id}:`, e));
        return `Terminal ${id} restarted.`;
      }
      // Spawn into the pane's OWNING project (its directory + project id as the 7th arg), NOT the active
      // project — mirrors archive.ts Restore so a non-active-project pane lands back where it belongs.
      // Shared spawn closure: presetCommand(normalizePreset(pane.tool_preset), …) — one launch home.
      return respawnFromLedger(ctx, id, pane!, owner!.projectId, `Terminal ${id} restored and started.`);
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
// send_keys — POST /api/terminals/:pane_id/input (GATED send_keys, default Ask — c55.10).
//   send_keys is term.writeInput(command) straight to the live PTY — the most direct, most
//   consequential CLI keystroke act there is, the rest-only twin of the gated voice write path
//   (propose_command -> write_to_pane). c55.10 tightens it from ALWAYS_ALLOWED to its OWN matrix row
//   `send_keys` (default Ask) so the operator can tune the raw-REST keystroke channel independently of
//   write_to_pane's voice spotlight semantics. Off->blocked->403, Ask->pending->202, Auto->run-now->200.
//   NOTE (durable replay): like respawn_pane, buildActionRun (src/actionEffects.ts) has no send_keys
//   case, so an IN-PROCESS Ask->confirm replays the real closure correctly (pendingActions holds it),
//   while a confirm-AFTER-process-restart degrades to the "unknown capability" no-op string — an
//   accepted out-of-scope limitation for these rest-only caps (matches the c55 batch precedent).
// ─────────────────────────────────────────────────────────────────────────────

const SendKeysParams = z.object({
  pane_id: z.string(),
  command: z.string(),
});

/**
 * send_keys — FAITHFUL PORT of inline app.post("/api/terminals/:id/input") (server.ts ~700). Records the
 * command in pane history (HistoryManager.addCommand re-derived inline) THEN writes it to the live PTY,
 * THEN broadcasts the ledger update — now ROUTED THROUGH ctx.gateOrDefer("send_keys", ...). Unknown pane
 * -> ok narration resolved BEFORE the gate (inline 404 -> 200, Decision 2): we never stage/forbid a write
 * to a pane that does not exist. The inline route 400'd a missing command body; here the zod-required
 * `command` makes that a 500 error (Decision 2). The side effects are wrapped in ONE synchronous effect
 * closure (serves Auto-run-now AND the in-process Ask->confirm replay).
 */
export const sendKeys: ActionDef<typeof SendKeysParams> = {
  name: "send_keys",
  description: "Write a command directly to a terminal pane's input. GATED (send_keys, default Ask). REST/UI surface only.",
  params: SendKeysParams,
  capability: "send_keys",
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: { method: "post", path: "/api/terminals/:pane_id/input" },
  handler: (args, ctx): ActionResult => {
    const id = args.pane_id;
    const command = args.command;
    const term = ctx.manager.terminals[id];
    // Unknown pane: resolve to ok-narration BEFORE the gate (inline 404 -> 200, Decision 2). No
    // stage/forbid of a write to a non-existent pane.
    if (!term) {
      return { kind: "ok", output: `Terminal ${id} not found or offline.` };
    }
    // ONE synchronous gated effect closure (serves Auto-run-now AND the in-process Ask->confirm replay).
    const sendEffect = (): string => {
      addCommand(ctx, id, command);
      term.writeInput(command);
      ctx.broadcastLedgerUpdate();
      return `Command successfully dispatched to terminal ${id}.`;
    };
    const g = ctx.gateOrDefer(
      "send_keys",
      id,
      `Send keystrokes to pane ${id}`,
      sendEffect,
      { ...(ctx.versionStamp ?? {}), origin: "rest", paneId: id }
    );
    if (g.disposition === "forbidden") {
      return { kind: "blocked", reason: "Error: the 'send_keys' capability is gated Off; writing keystrokes to panes is forbidden by policy." };
    }
    if (g.disposition === "deferred") {
      return { kind: "pending", messageId: g.actionId, summary: g.summary };
    }
    // Auto: gateOrDefer does NOT invoke `run` on the "run" disposition (it stages run only on Ask). The
    // caller runs the effect now (mirrors respawn_pane: `output: restartEffect()`).
    return { kind: "ok", output: sendEffect() };
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
 * HistoryManager.saveHistory(id, []) (re-derived inline). PHASE 1 (deferrable-toggle honesty): the
 * clear_history capability row already exists (default Ask, pinned) but the def was ALWAYS_ALLOWED —
 * the toggle was unenforced. It now declares `clear_history` and routes the history-clear mutation
 * through ctx.gateOrDefer("clear_history", ...) with a durable-intent bag { op:"clear", paneId } in
 * lockstep with src/actionEffects.ts buildActionRun's clear_history case, so a deferred clear replays
 * after a restart. Default stays Ask (no default changed) → it now genuinely asks; a power user may set
 * it Auto for instant clears. Off->blocked->403, Ask->pending->202, Auto->run-now->200.
 *
 * The explicit STOP-ALL frozen self-check is KEPT (BEFORE the gate): it preserves the distinct
 * "Stop-all is engaged" error narration for a destructive mutator. (gateOrDefer's resolver also
 * short-circuits to Off→forbidden while frozen, so the self-check is belt-and-suspenders, not a
 * double-block — the early return wins and the gate is never reached during a freeze.)
 */
export const clearHistory: ActionDef<typeof ClearHistoryParams> = {
  name: "clear_history",
  description: "Clear a terminal pane's recorded command history. Gated 'clear_history' (default Ask — destructive). REST/UI surface only.",
  params: ClearHistoryParams,
  capability: "clear_history",
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: { method: "post", path: "/api/terminals/:pane_id/history/clear" },
  handler: (args, ctx): ActionResult => {
    // 2S.4: keep the explicit brake self-check (preserves the distinct "Stop-all is engaged" error
    // narration). gateOrDefer would also forbid while frozen, but this early return wins.
    if (ctx.isFrozen()) return { kind: "error", message: "Stop-all is engaged — release it first." };
    // ONE synchronous gated effect closure (serves Auto-run-now AND the in-process Ask->confirm replay).
    // Bridge-first (review block on PR #68): in a running server the HistoryManager owns a debounced
    // dirty cache — a direct file clear here would be RESURRECTED by a pending flush. The bridge clears
    // cache+disk through the flush chain; the direct write below remains only for bare def-level tests
    // with no server registered (no concurrent writer to race).
    const clearEffect = (): string => {
      const bridge = getHistoryBridge();
      if (bridge) bridge.clearHistory(args.pane_id);
      else saveHistory(ctx, args.pane_id, []);
      return `History cleared for terminal ${args.pane_id}.`;
    };
    // PHASE 1: persist the clear INTENT (op + paneId) so a deferred clear survives a restart and
    // rebuilds the SAME effect on confirm. Keys in lockstep with src/actionEffects.ts ClearHistoryParams
    // ({ op:"clear", paneId }).
    const g = ctx.gateOrDefer(
      "clear_history",
      args.pane_id,
      `Clear history for pane ${args.pane_id}`,
      clearEffect,
      { ...(ctx.versionStamp ?? {}), op: "clear", paneId: args.pane_id }
    );
    if (g.disposition === "forbidden") {
      return { kind: "blocked", reason: "Error: the 'clear_history' capability is gated Off; clearing pane history is forbidden by policy." };
    }
    if (g.disposition === "deferred") {
      return { kind: "pending", messageId: g.actionId, summary: g.summary };
    }
    // Auto: gateOrDefer does NOT invoke `run` on the "run" disposition — the caller runs it now.
    return { kind: "ok", output: clearEffect() };
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
    // 2S.4: frozen means frozen — this stops/drops lingering terminal objects and archives panes,
    // none of which may happen while the STOP-ALL brake is engaged (ALWAYS_ALLOWED bypasses the gate).
    if (ctx.isFrozen()) return { kind: "error", message: "Stop-all is engaged — release it first." };
    // Phase 4 live-lane finding: ws.panes[].alive is only as fresh as the last syncLedger(), and
    // nothing on the REST surface re-syncs after a pane SELF-exits — so clear-exited read
    // alive:true for dead panes and archived 0 forever. Force the live PTY->ledger sync first
    // (the same seam switch_context uses, orient.ts).
    ctx.manager.refreshLedger();
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

// ─────────────────────────────────────────────────────────────────────────────
// archive_pane — POST /api/terminals/:pane_id/archive (PHASE 1 — NEW gated action).
//   The standalone "archive THIS pane" operation: a pure LEDGER move of a single pane's row into the
//   archive (recoverable), WITHOUT terminating its process. Distinct from close_pane (voice: terminate
//   + archive via stopAndArchivePane) and clear_exited (bulk-archive only already-Exited panes). The
//   archive_pane capability row already existed in the matrix (default Auto, enforcement deferrable)
//   but no action declared it — this fills that gap honestly and makes the toggle enforce.
//   Default Auto → no behavior change unless the operator tightens it. Off->blocked->403,
//   Ask->pending->202, Auto->run-now->200.
// ─────────────────────────────────────────────────────────────────────────────

const ArchivePaneParams = z.object({
  pane_id: z.string(),
});

/**
 * archive_pane — resolve the pane's OWNING project (findPaneOwningProject, the canonical resolver),
 * archive the ledger row (ledger.archivePane, recoverable), broadcast ledger + postures, narrate.
 * Routed through ctx.gateOrDefer("archive_pane", …) with a durable-intent bag { paneId, projectId } in
 * lockstep with src/actionEffects.ts buildActionRun's archive_pane case, so a deferred archive replays
 * after a restart. Unknown pane → ok narration resolved BEFORE the gate (we never stage/forbid an
 * archive of a pane that does not exist). archivePane returns false if the row is already gone (a
 * concurrent archive between stage and run) — narrated, no broadcast.
 */
export const archivePane: ActionDef<typeof ArchivePaneParams> = {
  name: "archive_pane",
  description: "Archive a single pane's record into the recoverable archive (does NOT terminate its process). Gated 'archive_pane' (default Auto). REST/UI surface only.",
  params: ArchivePaneParams,
  capability: "archive_pane",
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: { method: "post", path: "/api/terminals/:pane_id/archive" },
  handler: (args, ctx): ActionResult => {
    const id = args.pane_id;
    // Resolve the pane via its OWNING project (the canonical resolver) BEFORE the gate so we never
    // stage/forbid an archive of a pane that does not exist.
    const owner = findPaneOwningProject(ctx.manager, id);
    if (!owner) {
      return { kind: "ok", output: `Pane ${id} not found.` };
    }
    const projectId = owner.projectId;
    // ONE synchronous gated effect closure (serves Auto-run-now AND the in-process Ask->confirm replay).
    const archiveEffect = (): string => {
      const ok = ctx.manager.ledger.archivePaneOwned(projectId, id);
      if (ok) {
        ctx.broadcastLedgerUpdate();
        ctx.broadcastTerminalsUpdated();
        return `Pane ${id} archived (recoverable).`;
      }
      return `Pane ${id} could not be archived (already gone).`;
    };
    // PHASE 1: persist the archive INTENT (paneId + projectId) so a deferred archive survives a restart
    // and rebuilds the SAME effect on confirm. Keys in lockstep with src/actionEffects.ts ArchivePaneParams.
    const g = ctx.gateOrDefer(
      "archive_pane",
      id,
      `Archive pane ${id}`,
      archiveEffect,
      { ...(ctx.versionStamp ?? {}), paneId: id, projectId }
    );
    if (g.disposition === "forbidden") {
      return { kind: "blocked", reason: "Error: the 'archive_pane' capability is gated Off; archiving panes is forbidden by policy." };
    }
    if (g.disposition === "deferred") {
      return { kind: "pending", messageId: g.actionId, summary: g.summary };
    }
    // Auto: gateOrDefer does NOT invoke `run` on the "run" disposition — the caller runs it now.
    return { kind: "ok", output: archiveEffect() };
  },
};

/** The c55 Batch C rest-only registry slice (+ Phase 1 archive_pane). */
export const PANES_REST_ACTIONS: ActionDef[] = [
  respawnPane,
  sendKeys,
  resizePane,
  clearHistory,
  clearExited,
  archivePane,
];
