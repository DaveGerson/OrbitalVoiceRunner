/**
 * gateSurface — PURE, FRONTEND-SAFE surface derivations for the capability-matrix UI
 * (spec docs/superpowers/specs/2026-06-01-wsm-8sq-matrix-surface-design.md §4, §6, §7).
 *
 * This module is the single source of truth for THREE surface concerns:
 *   1. deriveEffectiveGates — the 16 effective gate values per pane (override -> spotlight -> global).
 *   2. derivePostureWord    — the calm one-word posture (OPEN | GUARDED | LOCKED) the chip renders.
 *   3. CAPABILITY_LABELS + CAPABILITY_CATEGORIES — the plain-language label map (NO PRODUCT JARGON).
 *
 * It imports ONLY types from ./types — no React, no PTY, no server, no `fs`. That keeps it usable
 * from the browser bundle (GateChip / CapabilityMatrixTab) AND unit-testable without the server.
 *
 * Precedence is a DELIBERATE MIRROR of resolveCapabilityGateWithContext in src/pendingApprovals.ts
 * (the server's pure resolver). We re-implement it here (rather than import) because pendingApprovals
 * pulls in ./terminal -> redactSecrets -> `fs`, which is not frontend-safe. Keep the two in lockstep:
 * any change to the override -> spotlight -> global precedence must land in BOTH.
 */

import type { CapabilityGate, GateValue, CapabilityGateMap } from "./types";

/** The pane's effective autonomy mode (mirrors EffectiveMode in src/pendingApprovals.ts). */
export type EffectiveMode = "Full Auto" | "Human-in-the-Loop" | "Read-Only";

/** The calm one-word posture the per-pane chip shows (spec §2.A / §7). */
export type PostureWord = "OPEN" | "GUARDED" | "LOCKED";

/**
 * The closed CapabilityGate union as a runtime array. This is the canonical enumeration the
 * surface iterates (deriveEffectiveGates fills all 16; the totality tests assert against it).
 * Kept in lockstep with the `CapabilityGate` union in src/types.ts.
 */
export const ALL_CAPABILITIES: readonly CapabilityGate[] = [
  "write_to_pane", "deliver_handoff", "create_pane", "close_pane",
  "restart_pane", "set_pane_permissions", "set_global_permissions",
  "set_capability_gate", "add_watch_rule", "execute_plan",
  "apply_recipe", "create_project", "update_metadata",
  "switch_context", "set_voice_mute", "dismiss_attention",
] as const;

/**
 * Capabilities the SPOTLIGHT may loosen to Auto on the ACTIVE pane ("trust follows focus").
 * MIRRORS SPOTLIGHT_CAPABILITIES in src/pendingApprovals.ts — only PRODUCTIVE writes are
 * spotlight-eligible. Destructive / meta / spawn capabilities are NEVER loosened by focus.
 */
const SPOTLIGHT_CAPABILITIES: ReadonlySet<CapabilityGate> = new Set<CapabilityGate>([
  "write_to_pane",
  "deliver_handoff",
]);

/**
 * Resolve ONE capability's effective gate value (override -> spotlight -> global -> Auto).
 * Private mirror of resolveCapabilityGateWithContext (src/pendingApprovals.ts) — see file header.
 */
function resolveOne(
  paneGate: GateValue | undefined,
  globalGate: GateValue | undefined,
  capability: CapabilityGate,
  isActivePane: boolean
): GateValue {
  if (paneGate !== undefined) return paneGate;                                   // explicit override wins
  if (isActivePane && SPOTLIGHT_CAPABILITIES.has(capability)) return "Auto";     // spotlight loosens
  return globalGate ?? "Auto";                                                   // global default, else Auto
}

/**
 * Derive the full 16-capability effective gate map for a pane — "what would actually happen if
 * Janus acted here now" (spec §2.A). Honors override -> spotlight -> global precedence per
 * capability. Total: every CapabilityGate is present in the result (never a sparse map).
 *
 * @param paneGates    the pane's per-pane override map (PaneMeta.capabilityGates) — may be undefined.
 * @param globalGates  the global default map (settings.advanced.capabilityGates) — may be undefined.
 * @param isActivePane whether this pane currently holds the spotlight (the active write target).
 */
export function deriveEffectiveGates(
  paneGates: CapabilityGateMap | undefined,
  globalGates: CapabilityGateMap | undefined,
  isActivePane: boolean
): Record<CapabilityGate, GateValue> {
  const out = {} as Record<CapabilityGate, GateValue>;
  for (const capability of ALL_CAPABILITIES) {
    out[capability] = resolveOne(paneGates?.[capability], globalGates?.[capability], capability, isActivePane);
  }
  return out;
}

/**
 * Derive the calm posture word from a pane's EFFECTIVE gate map + its effective mode (spec §7):
 *
 *   if effectiveMode === "Read-Only" OR effective.write_to_pane === "Off"  -> "LOCKED"
 *   else if any capability === "Ask" OR any capability === "Off"           -> "GUARDED"
 *   else                                                                   -> "OPEN"
 *
 * LOCKED is reserved for "Janus can't type here at all" so it stays meaningful — a peripheral Off
 * (e.g. close_pane) reads GUARDED, with the popover showing specifics.
 */
export function derivePostureWord(
  effective: Record<CapabilityGate, GateValue>,
  effectiveMode: EffectiveMode
): PostureWord {
  // LOCKED: Janus literally cannot type into this pane (Read-Only mode, or write_to_pane Off).
  if (effectiveMode === "Read-Only" || effective.write_to_pane === "Off") return "LOCKED";
  // GUARDED: not locked, but there is friction — any Ask, or any (non-write) Off.
  for (const capability of ALL_CAPABILITIES) {
    const v = effective[capability];
    if (v === "Ask" || v === "Off") return "GUARDED";
  }
  // OPEN: every relevant capability resolves Auto; Janus acts freely.
  return "OPEN";
}

/**
 * PLAIN-LANGUAGE label map (spec §6, operator directive: NO PRODUCT JARGON). Every operator-facing
 * surface (chip popover, matrix editor, voice read-backs) renders THESE strings — never the raw
 * snake_case identifier. TOTAL over the CapabilityGate union (a unit test asserts this).
 */
export const CAPABILITY_LABELS: Record<CapabilityGate, string> = {
  write_to_pane: "Type a command into a pane",
  deliver_handoff: "Hand a prompt to another pane",
  close_pane: "Close a pane",
  restart_pane: "Restart a pane",
  set_pane_permissions: "Change a pane's autonomy mode",
  set_global_permissions: "Change the global autonomy mode",
  set_capability_gate: "Change these safety gates",
  create_pane: "Open a new pane",
  execute_plan: "Run a multi-step plan",
  apply_recipe: "Apply a workspace recipe",
  add_watch_rule: "Add an automation rule",
  create_project: "Create a project",
  update_metadata: "Update notes & metadata",
  switch_context: "Switch focus",
  set_voice_mute: "Mute or unmute voice",
  dismiss_attention: "Dismiss an alert",
};

/**
 * The matrix editor's grouped sections (spec §6) — sections by intent, each listing its plain-
 * labeled capabilities. Covers all 16 capabilities EXACTLY ONCE (a unit test asserts this), so the
 * grouped-toggle editor can render every capability with no orphans or duplicates. Category NAMES
 * are themselves plain language (NO PRODUCT JARGON).
 */
export const CAPABILITY_CATEGORIES: Record<string, readonly CapabilityGate[]> = {
  "Acting in a pane": ["write_to_pane", "deliver_handoff"],
  "Destructive": ["close_pane", "restart_pane"],
  "Changing the locks": ["set_pane_permissions", "set_global_permissions", "set_capability_gate"],
  "Spawning work": ["create_pane", "execute_plan", "apply_recipe", "add_watch_rule"],
  "Orientation (low-risk)": ["create_project", "update_metadata", "switch_context", "set_voice_mute", "dismiss_attention"],
};
