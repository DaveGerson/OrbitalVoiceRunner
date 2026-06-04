/**
 * src/actions/defs/locks.ts — the "Changing the locks" group (REG1 unified registry).
 *
 * FAITHFUL PORTS of the three gate-matrix mutators in server.ts. Each handler is a near-verbatim
 * transcription of its legacy dispatch branch — same gate calls, same operator-facing strings
 * (byte-for-byte), same serializable intent params (in LOCKSTEP with src/actionEffects.ts
 * buildActionRun), same broadcasts. There is NO central gate in runAction; the handlers OWN their
 * gating exactly as the legacy branches do.
 *
 *   set_global_permissions (server.ts:2887) — GATED via ctx.gateOrDefer (durable Ask-defer). Intent
 *     params { permissionsMode } match SetGlobalPermissionsParams; requestedMode rider = the mode.
 *   set_pane_permissions   (server.ts:3449) — GATED via ctx.gateOrDefer. Ungated validation pre-checks
 *     run BEFORE the gate (faithful to legacy ordering). Intent { paneId, projectId, permissionsMode }
 *     match SetPanePermissionsParams; requestedMode rider = the mode.
 *   set_capability_gate    (server.ts:3335) — the META self-gate. Does NOT call gateOrDefer; it does
 *     its OWN directional (tighten-only) enforcement via isLoosening + effectiveCapabilityGateFor.
 *     Loosen-by-voice is refused; tighten/equal applies immediately.
 */

import { z } from "zod";
import type { ActionDef, ActionResult } from "../types";
import type { CapabilityGate, CapabilityGateMap, GateValue } from "../../types";
import { isLoosening } from "../../pendingApprovals";

// ─────────────────────────────────────────────────────────────────────────────
// set_global_permissions — server.ts:2887 (GATED, durable Ask-defer via gateOrDefer)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * permissions_mode is z.string() (NOT z.enum): the legacy branch never validates it against a list
 * (unlike set_pane_permissions), it is passed straight through. Promoting to z.enum would start
 * rejecting modes the legacy accepted. Documented values: Full Auto, Human-in-the-Loop, Read-Only,
 * Inherit.
 */
const SetGlobalPermissionsParams = z.object({
  permissions_mode: z.string(),
});

export const setGlobalPermissions: ActionDef<typeof SetGlobalPermissionsParams> = {
  name: "set_global_permissions",
  description: "Set the system wide voice execution permission mode.",
  params: SetGlobalPermissionsParams,
  capability: "set_global_permissions",
  readOnly: false,
  surfaces: new Set(["voice"]),
  handler: (args, ctx): ActionResult => {
    const { permissions_mode } = args;
    // The deferred side effect (runs now on Auto, or on operator confirm under Ask).
    const applyGlobalPerms = (): string => {
      ctx.manager.globalPermissionsMode = permissions_mode as
        | "Full Auto"
        | "Human-in-the-Loop"
        | "Read-Only"
        | "Inherit";
      ctx.manager.settings.advanced.globalPermissionsMode = permissions_mode as
        | "Full Auto"
        | "Human-in-the-Loop"
        | "Read-Only"
        | "Inherit";
      ctx.manager.saveSettings();
      ctx.broadcast({
        type: "settings_updated",
        globalPermissionsMode: permissions_mode,
        settings: ctx.sanitizeSettingsForClient(ctx.manager.settings),
      });
      return `Global permissions updated to ${permissions_mode}.`;
    };
    const g = ctx.gateOrDefer(
      "set_global_permissions",
      null,
      `Set global permissions to ${permissions_mode}`,
      applyGlobalPerms,
      // kzt: persist the global-permissions INTENT for restart parity (lockstep w/ actionEffects).
      { ...(ctx.versionStamp ?? {}), permissionsMode: permissions_mode },
      // rbh: pass the requested mode STRUCTURALLY (never parsed from the summary) so the confirm
      // dialog can render the divergence "heads up" when the engine resolves tighter.
      permissions_mode,
    );
    if (g.disposition === "forbidden") {
      return {
        kind: "ok",
        output: `Error: the 'set_global_permissions' capability is gated Off; this change is forbidden by policy.`,
      };
    }
    if (g.disposition === "deferred") {
      return {
        kind: "ok",
        output: `'${g.summary}' needs operator confirmation (gated Ask). I've queued it — confirm to apply.`,
      };
    }
    return { kind: "ok", output: applyGlobalPerms() };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// set_pane_permissions — server.ts:3449 (GATED, durable Ask-defer via gateOrDefer)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * permissions_mode is z.string() (not z.enum): the in-handler validModes check produces a friendly
 * clarify string; a zod enum would change that failure shape. The ungated validation pre-checks
 * (invalid mode; pane-not-found) run BEFORE the gate — faithful to the legacy branch ordering.
 */
const SetPanePermissionsParams = z.object({
  project_id: z.string(),
  pane_id: z.string(),
  permissions_mode: z.string(),
});

export const setPanePermissions: ActionDef<typeof SetPanePermissionsParams> = {
  name: "set_pane_permissions",
  description:
    "Set the safety permission policy mode for a specific terminal pane. Promotes or reverts autonomy (Full Auto, Human-in-the-Loop, Read-Only).",
  params: SetPanePermissionsParams,
  capability: "set_pane_permissions",
  readOnly: false,
  surfaces: new Set(["voice", "rest"]),
  rest: { method: "put", path: "/api/projects/:projectId/panes/:paneId/permissions" },
  handler: (args, ctx): ActionResult => {
    const { project_id, pane_id, permissions_mode } = args;
    // Ungated validation pre-checks (cheap reads, no side effect) BEFORE the gate.
    const validModes = ["Full Auto", "Human-in-the-Loop", "Read-Only"];
    const term = ctx.manager.terminals[pane_id];
    const ws = ctx.manager.ledger.getProject(project_id);
    const paneExists = !!(ws && ws.panes[pane_id]);
    if (!validModes.includes(permissions_mode)) {
      return {
        kind: "ok",
        output: `Invalid permissions mode "${permissions_mode}". Must be one of: ${validModes.join(", ")}.`,
      };
    }
    if (!term && !paneExists) {
      return {
        kind: "ok",
        output: `Pane ${pane_id} not found in project ${project_id}; no permission change applied.`,
      };
    }
    const applyPanePerms = (): string => {
      if (ctx.manager.terminals[pane_id])
        ctx.manager.terminals[pane_id].setPermissionsMode(
          permissions_mode as "Full Auto" | "Human-in-the-Loop" | "Read-Only",
        );
      const ws2 = ctx.manager.ledger.getProject(project_id);
      if (ws2 && ws2.panes[pane_id]) {
        ws2.panes[pane_id].permissions_mode = permissions_mode as
          | "Full Auto"
          | "Human-in-the-Loop"
          | "Read-Only";
        ctx.manager.ledger["save"]();
      }
      ctx.broadcastLedgerUpdate();
      ctx.broadcastTerminalsUpdated();
      return `Safety permission mode for pane ${pane_id} updated to ${permissions_mode} successfully.`;
    };
    const g = ctx.gateOrDefer(
      "set_pane_permissions",
      pane_id ?? null,
      `Set pane ${pane_id} permissions to ${permissions_mode}`,
      applyPanePerms,
      // kzt: persist the pane-permissions INTENT for restart parity (lockstep w/ actionEffects).
      { ...(ctx.versionStamp ?? {}), paneId: pane_id, projectId: project_id, permissionsMode: permissions_mode },
      // rbh: requested mode passed structurally for the dialog divergence rider.
      permissions_mode,
    );
    if (g.disposition === "forbidden") {
      return {
        kind: "ok",
        output: `Error: the 'set_pane_permissions' capability is gated Off for pane ${pane_id}; forbidden by policy.`,
      };
    }
    if (g.disposition === "deferred") {
      return {
        kind: "ok",
        output: `'${g.summary}' needs operator confirmation (gated Ask). I've queued it — confirm to apply.`,
      };
    }
    return { kind: "ok", output: applyPanePerms() };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// set_capability_gate — server.ts:3335 (META self-gate; NOT gateOrDefer-deferred)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * capability/gate are z.string() (not z.enum): the legacy handler validates `gate` against
 * validGates IN-HANDLER (returning a friendly string, not a parse error), and accepts ANY capability
 * string verbatim. Promoting either to z.enum would change the permissive behavior / failure shape.
 */
const SetCapabilityGateParams = z.object({
  pane_id: z.string().optional(),
  capability: z.string(),
  gate: z.string(),
});

export const setCapabilityGate: ActionDef<typeof SetCapabilityGateParams> = {
  name: "set_capability_gate",
  description:
    "Set a capability gate to Auto, Ask, or Off — globally or for one pane (meta capability). Auto=proceed, Ask=require human approval, Off=forbidden.",
  params: SetCapabilityGateParams,
  capability: "set_capability_gate",
  readOnly: false,
  surfaces: new Set(["voice", "rest"]),
  rest: { method: "put", path: "/api/projects/:projectId/panes/:paneId/capability-gates" },
  handler: (args, ctx): ActionResult => {
    // META self-gate (design §6, director posture 2026-06-01): "changing the locks" is the one
    // deliberate exception to defaults-are-overridable. TIGHTENING a gate by voice (e.g. Auto->Ask,
    // Ask->Off) is always safe and applies immediately. LOOSENING by voice (e.g. Off->Ask, Ask->Auto)
    // is REFUSED — it must be a deliberate UI act, so a confused/misheard Janus cannot loosen its own
    // restraints. This handler does its OWN directional enforcement; it does NOT call gateOrDefer.
    const { pane_id, capability, gate } = args;
    const validGates = ["Auto", "Ask", "Off"];
    let resp: string;
    if (!validGates.includes(gate)) {
      resp = `Invalid gate "${gate}". Must be one of: Auto, Ask, Off.`;
    } else if (
      isLoosening(
        ctx.effectiveCapabilityGateFor(pane_id || null, capability as CapabilityGate),
        gate as GateValue,
      )
    ) {
      const current = ctx.effectiveCapabilityGateFor(pane_id || null, capability as CapabilityGate);
      resp = `For safety I can't LOOSEN a capability gate by voice (you asked to change '${capability}' from ${current} to ${gate}). Loosening must be done deliberately in the Settings UI. I can TIGHTEN gates by voice anytime.`;
      if (ctx.store) {
        const activeProjectId = ctx.manager.ledger.activeProjectId || "default_project";
        ctx.store.recordActivity({
          type: "permission_changed",
          project_id: activeProjectId,
          pane_id: pane_id ?? null,
          summary: `REFUSED voice loosen ${capability} ${current}->${gate}${pane_id ? ` (pane ${pane_id})` : " (global)"}`,
          payload: { capability, from: current, to: gate, pane_id: pane_id ?? null, refused: true },
        });
      }
    } else {
      if (!ctx.manager.settings.advanced.capabilityGates)
        ctx.manager.settings.advanced.capabilityGates = {};
      // Stable non-null handle to the global map (the guard above guarantees it exists). The legacy
      // indexes ctx.manager.settings.advanced.capabilityGates directly under `args: any`; this local
      // preserves the SAME object reference + write while staying type-correct across the branch.
      const globalGates: CapabilityGateMap = ctx.manager.settings.advanced.capabilityGates;
      if (pane_id) {
        const proj = ctx.manager.ledger.getActiveProject();
        const pane = proj?.panes?.[pane_id];
        if (!pane) {
          resp = `Pane ${pane_id} not found in the active project.`;
        } else {
          const nextGates: CapabilityGateMap = { ...(pane.capabilityGates || {}) };
          nextGates[capability as CapabilityGate] = gate as GateValue;
          pane.capabilityGates = nextGates;
          // Persist via updatePane so the per-pane override survives in BOTH backends (SQLite writes
          // the capability_gates column; a bare save() would be a no-op there — bead 8sq schema v4).
          ctx.manager.ledger.updatePane(
            ctx.manager.ledger.activeProjectId || "default_project",
            pane,
            true,
          );
          resp = `Set per-pane gate '${capability}' = ${gate} for pane ${pane_id}.`;
        }
      } else {
        globalGates[capability as CapabilityGate] = gate as GateValue;
        ctx.manager.saveSettings();
        resp = `Set global gate '${capability}' = ${gate}.`;
      }
      if (ctx.store) {
        const activeProjectId = ctx.manager.ledger.activeProjectId || "default_project";
        ctx.store.recordActivity({
          type: "permission_changed",
          project_id: activeProjectId,
          pane_id: pane_id ?? null,
          summary: `gate ${capability}=${gate}${pane_id ? ` (pane ${pane_id})` : " (global)"}`,
          payload: { capability, gate, pane_id: pane_id ?? null },
        });
      }
      ctx.broadcast({
        type: "settings_updated",
        settings: ctx.sanitizeSettingsForClient(ctx.manager.settings),
      });
    }
    // ALL outcomes collapse to one ok-shaped { output: resp } in legacy (invalid-gate, refused-loosen,
    // pane-not-found, and both successes). Reproduce that single wire shape verbatim.
    return { kind: "ok", output: resp };
  },
};

/** The "Changing the locks" group, in dispatch order. */
export const LOCKS_ACTIONS: ActionDef[] = [
  setGlobalPermissions,
  setPanePermissions,
  setCapabilityGate,
];
