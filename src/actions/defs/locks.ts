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
import { findPaneOwningProject } from "../../paneOwnership";

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

/** The three valid Janus modes (shared by set_pane_permissions + restart_pane). */
const VALID_MODES = ["Full Auto", "Human-in-the-Loop", "Read-Only"] as const;
type JanusMode = (typeof VALID_MODES)[number];

/**
 * The LEGACY (P0–P3) pane-permission path: gate, then mutate only the NEXT spawn's command string +
 * persist the ledger mode. This is bug B1 — it never reaches the live process. Retained as the
 * fallback when ctx.applyPaneMode is NOT wired (REST/test contexts). The P4 path (ctx.applyPaneMode)
 * reaches the LIVE process; see applyPaneModeDelegate below.
 */
function legacyApplyPanePerms(
  ctx: Parameters<ActionDef<typeof SetPanePermissionsParams>["handler"]>[1],
  project_id: string,
  pane_id: string,
  permissions_mode: string,
): ActionResult {
  const applyPanePerms = (): string => {
    if (ctx.manager.terminals[pane_id])
      ctx.manager.terminals[pane_id].setPermissionsMode(permissions_mode as JanusMode);
    const ws2 = ctx.manager.ledger.getProject(project_id);
    if (ws2 && ws2.panes[pane_id]) {
      ws2.panes[pane_id].permissions_mode = permissions_mode as JanusMode;
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
}

/**
 * The P4 delegate: route the mode change through ctx.applyPaneMode (the live choke point, bead 1y8).
 * The output strings are mapped from PaneModeResult so the voice-tool goldens stay byte-for-byte for
 * the gate dispositions (forbidden / deferred), and a live success reads the same "updated ...
 * successfully" shape. Returns null if ctx.applyPaneMode is not wired (caller falls back to legacy).
 */
async function applyPaneModeDelegate(
  ctx: Parameters<ActionDef<typeof SetPanePermissionsParams>["handler"]>[1],
  pane_id: string,
  permissions_mode: JanusMode,
  source: "voice" | "ui" | "restart_pane",
): Promise<ActionResult | null> {
  if (!ctx.applyPaneMode) return null;
  const r = await ctx.applyPaneMode(pane_id, permissions_mode, source);
  if (r.ok) {
    return { kind: "ok", output: `Safety permission mode for pane ${pane_id} updated to ${permissions_mode} successfully.` };
  }
  // forbidden / deferred / unsupported / live-signal-timeout all carry an operator-facing reason
  // (the forbidden + deferred reasons are byte-for-byte the legacy gate-disposition strings).
  return { kind: "ok", output: r.reason ?? `Could not set pane ${pane_id} permissions to ${permissions_mode}.` };
}

export const setPanePermissions: ActionDef<typeof SetPanePermissionsParams> = {
  name: "set_pane_permissions",
  description:
    "Set the safety permission policy mode for a specific terminal pane. Promotes or reverts autonomy (Full Auto, Human-in-the-Loop, Read-Only).",
  params: SetPanePermissionsParams,
  capability: "set_pane_permissions",
  readOnly: false,
  surfaces: new Set(["voice", "rest"]),
  // c55 Batch D: snake_case route segments so Express injects :project_id/:pane_id directly onto the
  // snake_case zod keys (no camelCase param skew). The inline twin read camelCase :projectId/:paneId
  // and a `permissions` BODY key; coerceArgs below aliases body {permissions -> permissions_mode}.
  rest: { method: "put", path: "/api/projects/:project_id/panes/:pane_id/permissions" },
  // REST body alias: the UI matrix editor PUTs { permissions: <mode> }; the voice schema key is
  // `permissions_mode`. Alias it so the REST body lands on the snake_case zod key (only when the
  // snake key is absent, so a voice call carrying permissions_mode is never clobbered).
  coerceArgs: (raw) => {
    const out = { ...raw };
    if (out.permissions_mode == null && out.permissions != null) out.permissions_mode = out.permissions;
    delete out.permissions;
    return out;
  },
  // Merge note (c55 + concurrent multi-cli): the handler body below delegates to the LIVE applyPaneMode
  // choke point via `await applyPaneModeDelegate`, so the handler is async (concurrent's signature wins);
  // c55 contributes the snake_case rest.path + coerceArgs above. The concurrent applyPaneMode delegate
  // carries the gate disposition (forbidden/deferred) internally, superseding c55's gateOrDefer plan.
  handler: async (args, ctx): Promise<ActionResult> => {
    const { project_id, pane_id, permissions_mode } = args;
    // Ungated validation pre-checks (cheap reads, no side effect) BEFORE the gate.
    const term = ctx.manager.terminals[pane_id];
    const ws = ctx.manager.ledger.getProject(project_id);
    const paneExists = !!(ws && ws.panes[pane_id]);
    if (!VALID_MODES.includes(permissions_mode as JanusMode)) {
      return {
        kind: "ok",
        output: `Invalid permissions mode "${permissions_mode}". Must be one of: ${VALID_MODES.join(", ")}.`,
      };
    }
    if (!term && !paneExists) {
      return {
        kind: "ok",
        output: `Pane ${pane_id} not found in project ${project_id}; no permission change applied.`,
      };
    }
    // P4: delegate to the LIVE choke point when wired (reaches the running process + drains on
    // promotion). A live pane is required for the live mechanics; when there is no live term (a
    // ledger-only pane), fall back to the legacy next-spawn path so the persisted mode still lands.
    if (term) {
      const delegated = await applyPaneModeDelegate(ctx, pane_id, permissions_mode as JanusMode, "ui");
      if (delegated) return delegated;
    }
    return legacyApplyPanePerms(ctx, project_id, pane_id, permissions_mode);
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// restart_pane — the gated voice tool that makes Full-Auto reach the LIVE process (bead 1y8).
// Mirrors set_pane_permissions (same gate, same intent params); routed through ctx.applyPaneMode so a
// promotion either live-signals (Claude) or restart-resumes (Codex/agy) and drains pending (§11).
// ─────────────────────────────────────────────────────────────────────────────

const RestartPaneParams = z.object({
  project_id: z.string(),
  pane_id: z.string(),
  permissions_mode: z.string(),
});

export const restartPane: ActionDef<typeof RestartPaneParams> = {
  name: "restart_pane",
  description:
    "Apply a permission mode to a LIVE terminal pane, reaching the running CLI: promote to Full Auto (or revert) so the change takes effect now, not just on the next launch. Use to make an agent run unattended.",
  params: RestartPaneParams,
  capability: "set_pane_permissions", // rides the same lock-change gate (no new matrix row for v1).
  readOnly: false,
  surfaces: new Set(["voice"]),
  handler: async (args, ctx): Promise<ActionResult> => {
    const { project_id, pane_id, permissions_mode } = args;
    const term = ctx.manager.terminals[pane_id];
    const ws = ctx.manager.ledger.getProject(project_id);
    const paneExists = !!(ws && ws.panes[pane_id]);
    if (!VALID_MODES.includes(permissions_mode as JanusMode)) {
      return {
        kind: "ok",
        output: `Invalid permissions mode "${permissions_mode}". Must be one of: ${VALID_MODES.join(", ")}.`,
      };
    }
    if (!term && !paneExists) {
      return {
        kind: "ok",
        output: `Pane ${pane_id} not found in project ${project_id}; no permission change applied.`,
      };
    }
    // restart_pane is the LIVE tool: it only makes sense on a running pane. When the pane has no live
    // term (inert / ledger-only), there is no process to reach — fall back to the legacy persist so
    // the next launch carries the mode.
    if (term) {
      const delegated = await applyPaneModeDelegate(ctx, pane_id, permissions_mode as JanusMode, "restart_pane");
      if (delegated) return delegated;
    }
    return legacyApplyPanePerms(ctx, project_id, pane_id, permissions_mode);
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
  // c55.16 (set_pane_gates convergence): set_capability_gate is now VOICE-ONLY. Its dormant `rest`
  // binding (never in the mountRestRoutes only-set) has been REMOVED and the capability-gates path is
  // re-homed onto the new bulk-write `setPaneGates` def below. The voice meta-tool keeps its
  // single-entry, tighten-only, self-gating contract unchanged. The §8.4 coverage guard reads
  // def.surfaces.has('rest') (the SET, not the binding), so flipping surfaces to {voice} is what makes
  // it single-surface — it MUST be added to INTENTIONAL_ASYMMETRY as ['voice'] (done in coverage.ts).
  surfaces: new Set(["voice"]),
  handler: (args, ctx): ActionResult => {
    // META self-gate (design §6, director posture 2026-06-01): "changing the locks" is the one
    // deliberate exception to defaults-are-overridable. TIGHTENING a gate by voice (e.g. Auto->Ask,
    // Ask->Off) is always safe and applies immediately. LOOSENING by voice (e.g. Off->Ask, Ask->Auto)
    // is REFUSED — it must be a deliberate UI act, so a confused/misheard Janus cannot loosen its own
    // restraints. This handler does its OWN directional enforcement; it does NOT call gateOrDefer.
    const { pane_id, capability, gate } = args;
    // ALL outcomes collapse to one ok-shaped { output: <string> } in legacy (invalid-gate,
    // refused-loosen, pane-not-found, and both successes). Each branch below returns that single shape.
    if (!VALID_CAPABILITY_GATES.includes(gate)) {
      return { kind: "ok", output: `Invalid gate "${gate}". Must be one of: Auto, Ask, Off.` };
    }
    const current = ctx.effectiveCapabilityGateFor(pane_id || null, capability as CapabilityGate);
    if (isLoosening(current, gate as GateValue)) {
      return { kind: "ok", output: refuseVoiceLoosen(ctx, pane_id, capability, current, gate) };
    }
    return { kind: "ok", output: applyCapabilityGate(ctx, pane_id, capability, gate) };
  },
};

/** The three valid gate values (set_capability_gate's in-handler `gate` allowlist). */
const VALID_CAPABILITY_GATES = ["Auto", "Ask", "Off"];

/**
 * Build the tighten-only LOOSEN refusal string and (best-effort) record the refusal audit row.
 * Extracted from set_capability_gate so the handler stays under CC 10 — same string, same audit
 * payload, same store guard (behavior-preserving).
 */
function refuseVoiceLoosen(
  ctx: Parameters<ActionDef<typeof SetCapabilityGateParams>["handler"]>[1],
  pane_id: string | undefined,
  capability: string,
  current: GateValue,
  gate: string,
): string {
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
  return `For safety I can't LOOSEN a capability gate by voice (you asked to change '${capability}' from ${current} to ${gate}). Loosening must be done deliberately in the Settings UI. I can TIGHTEN gates by voice anytime.`;
}

/**
 * Apply a tighten/equal capability-gate change (per-pane or global), then audit + broadcast. Returns
 * the operator-facing result string. The per-pane not-found path returns WITHOUT auditing/broadcasting
 * (faithful to the legacy nested-else, which only audited+broadcast on a successful set). The gate-map
 * WRITES (nextGates / globalGates) are byte-identical to the inlined branches (behavior-preserving).
 */
function applyCapabilityGate(
  ctx: Parameters<ActionDef<typeof SetCapabilityGateParams>["handler"]>[1],
  pane_id: string | undefined,
  capability: string,
  gate: string,
): string {
  if (!ctx.manager.settings.advanced.capabilityGates)
    ctx.manager.settings.advanced.capabilityGates = {};
  // Stable non-null handle to the global map (the guard above guarantees it exists). The legacy
  // indexes ctx.manager.settings.advanced.capabilityGates directly under `args: any`; this local
  // preserves the SAME object reference + write while staying type-correct across the branch.
  const globalGates: CapabilityGateMap = ctx.manager.settings.advanced.capabilityGates;
  let resp: string;
  if (pane_id) {
    // Resolve the pane's OWNING project (paneOwnership.ts) — the write side of the owning-project
    // fix: a voice "lock down that pane" for a pane in a NON-active project used to fail with
    // not-found because only getActiveProject() was consulted.
    const owned = findPaneOwningProject(ctx.manager, pane_id);
    if (!owned) {
      return `Pane ${pane_id} not found in any project.`;
    }
    const { projectId, pane } = owned;
    const nextGates: CapabilityGateMap = { ...(pane.capabilityGates || {}) };
    nextGates[capability as CapabilityGate] = gate as GateValue;
    pane.capabilityGates = nextGates;
    // Persist via updatePane so the per-pane override survives in BOTH backends (SQLite writes the
    // capability_gates column; a bare save() would be a no-op there — bead 8sq schema v4).
    ctx.manager.ledger.updatePane(projectId, pane, true);
    resp = `Set per-pane gate '${capability}' = ${gate} for pane ${pane_id}.`;
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
  return resp;
}

// ─────────────────────────────────────────────────────────────────────────────
// set_pane_gates — server.ts:868 (the BULK whole-map per-pane override writer; the operator
// matrix-editor's "Save". REST-ONLY, UNGATED, VERBATIM — the deliberate UI loosening surface).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The WHOLE per-pane override map (full replacement, not a single entry — that is set_capability_gate).
 * Values are validated/normalized IN-HANDLER (Auto|Ask|Off filter), NOT via z.enum, to reproduce the
 * inline route's SILENT-DROP of invalid entries: a z.enum would 500 on a bad value; the inline route
 * quietly skips it (regression bar #3 in tests/test_pane_gates_rest.ts). An empty / all-invalid /
 * absent map CLEARS the override (the pane falls back to the global default — no masking `{}`).
 */
const SetPaneGatesParams = z.object({
  project_id: z.string(),
  pane_id: z.string(),
  capability_gates: z.record(z.string(), z.string()).optional(),
});

export const setPaneGates: ActionDef<typeof SetPaneGatesParams> = {
  name: "set_pane_gates",
  description:
    "Set the per-pane capability-gate OVERRIDE map from the matrix editor (bulk, whole-map, loosening allowed — the deliberate operator-direct UI sibling of the voice set_capability_gate tool). Operator UI, rest-only.",
  params: SetPaneGatesParams,
  // Reuses the EXISTING set_capability_gate capability row (for matrix projection + audit attribution).
  // deriveCapabilities de-dupes on def.capability (restart_pane/set_pane_permissions already share a
  // cap), so this adds ZERO matrix rows — the §8.1b subset invariant holds with no matrix-file edits.
  // Declaring the capability is NOT a promise runAction enforces it (handler-owned gate model,
  // types.ts:200-213): this handler is UNGATED by design (see below).
  capability: "set_capability_gate",
  readOnly: false,
  surfaces: new Set(["rest"]),
  // c55.16: snake_case route segments so Express injects :project_id/:pane_id directly onto the snake
  // zod keys (the Batch-B/-D param-skew pattern). The inline twin read camelCase :projectId/:paneId and
  // a `capabilityGates` BODY key; coerceArgs below aliases body {capabilityGates -> capability_gates}.
  rest: {
    method: "put",
    path: "/api/projects/:project_id/panes/:pane_id/capability-gates",
    // Reproduce the inline route's exact status+body contract (the flat {output} default cannot carry a
    // structured body, and resultToHttp has no 404 path). The 404 is an ok-shaped {notFound:true}
    // sentinel (NOT kind:"blocked"/"error", which would change the status the live suite asserts).
    toHttp: (result): { status: number; body: unknown } => {
      const out =
        result.kind === "ok"
          ? (result.output as { notFound?: boolean; capabilityGates?: CapabilityGateMap | null })
          : undefined;
      if (out && out.notFound) {
        return { status: 404, body: { error: "Pane not found" } };
      }
      const gates = (out && out.capabilityGates) ?? null;
      return { status: 200, body: { success: true, capabilityGates: gates } };
    },
  },
  // REST body alias: the matrix editor PUTs { capabilityGates: {...} }; the snake zod key is
  // `capability_gates`. Alias it ONLY when the snake key is absent, so a snake-keyed call is never
  // clobbered (mirrors set_pane_permissions coerceArgs).
  coerceArgs: (raw) => {
    const out = { ...raw };
    if (out.capability_gates == null && out.capabilityGates != null) out.capability_gates = out.capabilityGates;
    delete out.capabilityGates;
    return out;
  },
  // UNGATED / VERBATIM / IMMEDIATE — a faithful port of the inline route (server.ts:868-902). This is
  // the deliberate UI place where LOOSENING is allowed (voice may only tighten — see setCapabilityGate
  // above); it does NOT route through gateOrDefer and does NOT apply the tighten-only isLoosening
  // refusal. Per the handler-owned gate model, declaring capability:'set_capability_gate' is purely for
  // matrix projection/audit, not an enforcement promise.
  handler: (args, ctx): ActionResult => {
    const { project_id, pane_id, capability_gates } = args;
    // (A) pane-existence pre-check — returns the ok-shaped {notFound:true} sentinel BEFORE any mutation
    // or broadcast (faithful to the inline early-return).
    const ws = ctx.manager.ledger.getProject(project_id);
    const pane = ws?.panes?.[pane_id];
    if (!pane) {
      return { kind: "ok", output: { notFound: true } };
    }
    // (B) normalize: only valid {Auto|Ask|Off} entries survive; (C) an empty / all-invalid map clears
    // the override (so the pane falls back to the global default rather than persisting a masking `{}`).
    const clean = normalizePaneGates(capability_gates);
    const override = clean ?? undefined;
    pane.capabilityGates = override;
    // (D) Persist via updatePane (the durable path for BOTH backends): the SQLite store writes the
    // capability_gates column (schema v4); a bare ledger.save() would be a SQLite no-op and silently
    // drop the override. Fires on BOTH the set and clear paths.
    ctx.manager.ledger.updatePane(project_id, pane, true);
    // (E) audit — guarded by if(ctx.store) + try/catch (store is null under JANUS_LEDGER_BACKEND=legacy).
    recordPaneGatesActivity(ctx, project_id, pane_id, clean);
    // (F)+(G) re-broadcast on BOTH set and clear so the chips repaint from the new server-resolved
    // posture (the clear path repaints back to the global default — R7).
    ctx.broadcastLedgerUpdate();
    ctx.broadcastTerminalsUpdated();
    // (H) success: the ok-shaped output the toHttp re-projects into 200 {success,capabilityGates}.
    return { kind: "ok", output: { capabilityGates: pane.capabilityGates ?? null } };
  },
};

/**
 * Normalize the inbound per-pane gate map: keep ONLY the {Auto|Ask|Off} entries (invalid values are
 * silently dropped — the inline route's behavior, regression bar #3). Returns the clean map, or null
 * when nothing valid survived (the CLEAR signal: an empty / all-invalid / absent map clears the
 * override rather than persisting a masking `{}`). FLAG (locks.ts gate-map-copy, separate hardening
 * decision): this copies entries by STRING KEY into a plain object — the same prototype-leak class the
 * standing lesson calls out; left structurally unchanged in this behavior-preserving pass.
 */
function normalizePaneGates(capability_gates: unknown): CapabilityGateMap | null {
  const clean: CapabilityGateMap = {};
  let any = false;
  if (capability_gates && typeof capability_gates === "object") {
    for (const [k, v] of Object.entries(capability_gates)) {
      if (v === "Auto" || v === "Ask" || v === "Off") {
        (clean as Record<string, GateValue>)[k] = v as GateValue;
        any = true;
      }
    }
  }
  return any ? clean : null;
}

/**
 * Best-effort audit row for set_pane_gates (guarded by if(ctx.store) + try/catch — store is null under
 * JANUS_LEDGER_BACKEND=legacy). `clean` is the normalized map (null on the clear path). Same summary /
 * payload as the inlined block (behavior-preserving).
 */
function recordPaneGatesActivity(
  ctx: Parameters<ActionDef<typeof SetPaneGatesParams>["handler"]>[1],
  project_id: string,
  pane_id: string,
  clean: CapabilityGateMap | null,
): void {
  if (!ctx.store) return;
  try {
    ctx.store.recordActivity({
      type: "permission_changed",
      project_id,
      pane_id,
      summary: `UI set per-pane gates for ${pane_id} (${clean ? Object.keys(clean).length : 0} override(s))`,
      payload: { action: "set_pane_gates", capabilityGates: clean ?? null },
    });
  } catch { /* store optional */ }
}

/** The "Changing the locks" group, in dispatch order. */
export const LOCKS_ACTIONS: ActionDef[] = [
  setGlobalPermissions,
  setPanePermissions,
  restartPane,
  setCapabilityGate,
  setPaneGates,
];
