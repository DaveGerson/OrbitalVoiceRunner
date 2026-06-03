/**
 * actionPendingPayload — PURE resolution of the EFFECTIVE posture the server broadcasts on the
 * action_pending frame (rbh / bead wsm-e2e-pinned-rbh, reviewer-remediation: server-truth seam).
 *
 * WHY a separate module: server.ts calls startServer() at module load (a real listener), so its
 * gateOrDefer closure cannot be imported by a unit test. Exactly as src/restGate.ts (G6) extracted
 * the REST-contract mapping, we extract the posture RESOLUTION here. server.ts's gateOrDefer calls
 * resolveActionPendingPosture with the live policy state; the unit test calls it with fixtures and
 * asserts the DERIVED truth (e.g. global Read-Only + pane Full Auto ⇒ LOCKED/Read-Only). This proves
 * the engine computes the overridden posture at its SOURCE — not that a dialog renders a hand-fed
 * mock.
 *
 * It mirrors three server resolvers verbatim (kept in LOCKSTEP):
 *   - effectiveModeFor          (server.ts) — global mode dominates unless "Inherit".
 *   - effectiveCapabilityGateFor(server.ts) — override → spotlight → global via gateSurface.
 *   - posturePayloadForPane     (server.ts) — deriveEffectiveGates + derivePostureWord.
 *
 * RE-SCOPE (rbh-rescope.md Integration Risk #1 — HIGH): current main landed STOP-ALL/frozen, and main's
 * effectiveGatesForPane overlays applyFrozenShortCircuit so the chip reads LOCKED while frozen. The
 * ORIGINAL resolver had no `frozen` arg, so an action_pending dialog raised mid-freeze would show
 * pre-freeze posture (chip LOCKED, dialog OPEN) — breaking the "dialog == chip == engine" invariant.
 * Option A: `frozen` is an input; when true we short-circuit EVERY resolved gate to Off and re-derive
 * the posture from the frozen map (the frozen short-circuit is the trivial `frozen ? "Off" : v`, kept
 * inline rather than importing pendingApprovals.applyFrozenShortCircuit — that module pulls in ./terminal
 * → fs and is NOT frontend-safe; gateSurface deliberately re-implements pure logic for the same reason).
 *
 * Frontend-unsafe? No — it imports ONLY ./types + ./gateSurface (both pure). Stays server/test-only
 * by intent but carries no React/PTY/fs dependency.
 */

import type { CapabilityGate, GateValue, CapabilityGateMap } from "./types";
import {
  deriveEffectiveGates,
  derivePostureWord,
  ALL_CAPABILITIES,
  type EffectiveMode,
  type PostureWord,
} from "./gateSurface";

/** The global autonomy mode as stored on the manager — "Inherit" defers to the pane mode. */
export type GlobalMode = "Inherit" | EffectiveMode;

/**
 * The raw policy state gateOrDefer holds when it stages an Ask-tier action. Passing primitives (not
 * the live `manager`) keeps this pure and unit-testable; the server adapts its closures to this shape.
 */
export interface ActionPostureInput {
  /** Target pane, or null for a GLOBAL action (set_global_permissions has no pane scope — D2). */
  paneId: string | null;
  /** The capability being gated (its effective gate is surfaced on the rider). */
  capability: CapabilityGate;
  /** The resolved global autonomy mode (manager.globalPermissionsMode). */
  globalMode: GlobalMode;
  /** The TARGET pane's current mode (term.permissionsMode); ignored when globalMode !== "Inherit". */
  paneMode: EffectiveMode | undefined;
  /** The pane's per-pane capability overrides (PaneMeta.capabilityGates). */
  paneGates: CapabilityGateMap | undefined;
  /** The global default gates (settings.advanced.capabilityGates). */
  globalGates: CapabilityGateMap | undefined;
  /** Whether the target pane currently holds the spotlight (active write target). */
  isActivePane: boolean;
  /**
   * Whether STOP-ALL is engaged (manager-level `frozen`). When true every resolved gate short-circuits
   * to Off and the posture re-derives to LOCKED — mirroring main's effectiveGatesForPane frozen
   * overlay so the dialog stays in lockstep with the chip (Integration Risk #1).
   */
  frozen?: boolean;
}

/** The resolved fields the server stamps onto the action_pending broadcast (all degrade-safe). */
export interface ActionPostureResult {
  /** Effective gate for `capability` after override → spotlight → global (and frozen) resolution. */
  effective_gate: GateValue;
  /** Effective autonomy mode the engine will enforce (global override or the pane mode). */
  effective_mode: EffectiveMode;
  /** Posture word for the target pane — undefined for a global action (no pane scope, D2). */
  posture?: PostureWord;
  /** The full 16-capability effective map — undefined for a global action (D2). */
  effective_gates?: Record<CapabilityGate, GateValue>;
}

/** The frozen short-circuit (inline mirror of pendingApprovals.applyFrozenShortCircuit — see header). */
function frozenGate(frozen: boolean | undefined, resolved: GateValue): GateValue {
  return frozen ? "Off" : resolved;
}

/** Mirror of server.ts effectiveModeFor: global mode dominates unless it is "Inherit". */
export function effectiveModeFromState(globalMode: GlobalMode, paneMode: EffectiveMode | undefined): EffectiveMode {
  if (globalMode === "Inherit") return paneMode ?? "Human-in-the-Loop";
  return globalMode;
}

/** Mirror of server.ts effectiveCapabilityGateFor: one capability's effective gate (via gateSurface). */
export function effectiveGateFromState(
  capability: CapabilityGate,
  paneId: string | null,
  paneGates: CapabilityGateMap | undefined,
  globalGates: CapabilityGateMap | undefined,
  isActivePane: boolean
): GateValue {
  // deriveEffectiveGates resolves all 16 (override → spotlight → global → Auto); read the one we want.
  // For a global action (paneId null) there is no per-pane override and no spotlight, so we resolve
  // against the global map only (no pane gates, isActivePane forced false).
  const gates = deriveEffectiveGates(paneId ? paneGates : undefined, globalGates, !!paneId && isActivePane);
  return gates[capability];
}

/**
 * Resolve the EFFECTIVE posture the action_pending broadcast must carry — the engine's truth, not the
 * operator's nominal request. Global actions (paneId null) surface the resolved global mode + global
 * gate only (no per-pane posture word / gate map, D2). Per-pane actions surface the full posture.
 * When `frozen` every gate short-circuits to Off and the posture re-derives to LOCKED (Risk #1).
 */
export function resolveActionPendingPosture(inp: ActionPostureInput): ActionPostureResult {
  const effective_mode = effectiveModeFromState(inp.globalMode, inp.paneMode);
  const effective_gate = frozenGate(
    inp.frozen,
    effectiveGateFromState(inp.capability, inp.paneId, inp.paneGates, inp.globalGates, inp.isActivePane)
  );

  if (!inp.paneId) {
    // Global action — no pane to chip (D2). Mode + the global gate only (frozen-overlaid above).
    return { effective_gate, effective_mode };
  }

  // Per-pane action — derive the full posture exactly as posturePayloadForPane does, then overlay the
  // frozen short-circuit on every cap (mirror of effectiveGatesForPane) and re-derive the posture word.
  const base = deriveEffectiveGates(inp.paneGates, inp.globalGates, inp.isActivePane);
  let effective_gates = base;
  if (inp.frozen) {
    const out = {} as Record<CapabilityGate, GateValue>;
    for (const cap of ALL_CAPABILITIES) out[cap] = frozenGate(true, base[cap]);
    effective_gates = out;
  }
  const posture = derivePostureWord(effective_gates, effective_mode);
  return { effective_gate, effective_mode, posture, effective_gates };
}
