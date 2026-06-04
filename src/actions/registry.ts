/**
 * src/actions/registry.ts — the canonical ActionDef[] (REG1 PHASE A: a SMALL PROOF registry).
 *
 * This phase proves the SHAPE, not the full migration. Only four tools are migrated, chosen to
 * exercise every limb of the runAction wrapper:
 *   - stop_all / confirm_stop_all / release_stop_all — the emergency brake. capability ALWAYS_ALLOWED
 *     (bypasses the gate, even while frozen), empty params, surfaces voice+rest+ws (the one group
 *     wired identically across all three surfaces today — §4.2 Group 8, the template the registry
 *     generalizes).
 *   - list_panes — a READ. capability read_pane (default Auto), readOnly:true (so its output is
 *     redacted on the way out), empty params, surfaces voice+rest (voice tool + GET /api/terminals).
 *
 * Handlers here are THIN: they call ctx.manager / ctx.broadcast and return an ActionResult. The
 * heavy brake logic (stopAll/releaseStopAll, the `frozen` flag) lives in server.ts closures that are
 * NOT yet on ActionContext; this phase does not swap the dispatch (that is Phase C), so the brake
 * handlers here return a proof ok-result and broadcast the same frames the real handlers do. The
 * other 37 tools — and the full brake wiring — land in Phase B.
 */

import { z } from "zod";
import type { ActionDef, ActionResult } from "./types";
import { ALWAYS_ALLOWED } from "./types";

/** Empty-params schema shared by the brake trio + list_panes (pins §8.2 #8 -> properties {}). */
const NoParams = z.object({});

export const stopAll: ActionDef<typeof NoParams> = {
  name: "stop_all",
  description:
    "EMERGENCY BRAKE Stage 1 (always allowed): freeze Janus (every capability becomes Off) and cancel everything in flight. Panes KEEP RUNNING. Call IMMEDIATELY on 'stop', 'halt', 'abort', 'freeze', or 'stop everything'.",
  params: NoParams,
  capability: ALWAYS_ALLOWED,
  readOnly: false,
  surfaces: new Set(["voice", "rest", "ws"]),
  rest: { method: "post", path: "/api/stop-all" },
  handler: (_args, ctx): ActionResult => {
    // PROOF handler: the real stopAll(false) closure lives in server.ts and is wired on ctx in
    // Phase C. Here we broadcast the same `frozen` frame the operator sees and report ok.
    ctx.broadcast({ type: "frozen", frozen: true });
    return { kind: "ok", output: "Frozen and cancelled everything in flight; panes keep running." };
  },
};

export const confirmStopAll: ActionDef<typeof NoParams> = {
  name: "confirm_stop_all",
  description:
    "EMERGENCY BRAKE Stage 2 (always allowed): the deliberate, irreversible kill of running panes. Only valid while frozen-awaiting-confirm. Call on a spoken 'kill them' / 'yes' after stop_all.",
  params: NoParams,
  capability: ALWAYS_ALLOWED,
  readOnly: false,
  surfaces: new Set(["voice", "rest", "ws"]),
  rest: { method: "post", path: "/api/stop-all/confirm" },
  handler: (_args, ctx): ActionResult => {
    ctx.broadcast({ type: "stop_all" });
    return { kind: "ok", output: "Killed running panes; they stay killed. Still frozen — say 'release' to resume." };
  },
};

export const releaseStopAll: ActionDef<typeof NoParams> = {
  name: "release_stop_all",
  description:
    "Clear the freeze (always allowed): un-freeze Janus; safety gates restore exactly as they were. Does NOT auto-restart any killed panes. Call on 'release' / 'resume'.",
  params: NoParams,
  capability: ALWAYS_ALLOWED,
  readOnly: false,
  surfaces: new Set(["voice", "rest", "ws"]),
  rest: { method: "post", path: "/api/stop-all/release" },
  handler: (_args, ctx): ActionResult => {
    ctx.broadcast({ type: "frozen", frozen: false });
    return { kind: "ok", output: "Released — un-frozen; your safety gates are back exactly as they were." };
  },
};

export const listPanes: ActionDef<typeof NoParams> = {
  name: "list_panes",
  description:
    "List all projects and their panes with runtime_type, is_busy, alive, a one-line state, and live timing. The authoritative source of current pane status — always call it before reporting whether something is busy or done. Cheap orientation call.",
  params: NoParams,
  capability: "read_pane",
  readOnly: true, // result is redacted on the way out (§5.6) — readOnly binds only read capabilities (§8.1 #5)
  surfaces: new Set(["voice", "rest"]), // voice tool + GET /api/terminals (§4.2 Group 1)
  rest: { method: "get", path: "/api/terminals" },
  handler: (_args, ctx): ActionResult => {
    // THIN: the genuine domain call. listPanes() syncs the ledger and returns the project/pane tree.
    return { kind: "ok", output: ctx.manager.listPanes() };
  },
};

/**
 * The canonical registry array. Phase B appends the remaining 37 tools; Phase C swaps server.ts to
 * dispatch through runAction(REGISTRY, ...). Keep this the SINGLE export everything derives from.
 */
export const REGISTRY: readonly ActionDef[] = [
  stopAll,
  confirmStopAll,
  releaseStopAll,
  listPanes,
];
