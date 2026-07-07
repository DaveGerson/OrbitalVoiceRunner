/**
 * src/gating/postureProfiles.ts — the ONE decision f09.3 adds to the gate machinery: does applying a
 * posture profile LOOSEN the global matrix?
 *
 * This is the voice directional contract (design §6 / set_capability_gate): TIGHTENING (or equal) by
 * voice is always safe and applies immediately; LOOSENING by voice must defer to a deliberate operator
 * confirm. A profile is a whole-matrix REPLACEMENT, so "loosens" means: for ANY capability, the gate the
 * profile would install is less restrictive than the CURRENT effective global gate.
 *
 * It REUSES `isLoosening` (pendingApprovals) verbatim — the same tighten-only machinery
 * set_capability_gate + grant_autonomy_window already enforce — so there is exactly ONE definition of
 * "loosen" in the codebase (spec seam: porting a map-diff across the Python daemon would duplicate the
 * safety contract in two languages for zero decision gain). Pure + backend-only (isLoosening lives next
 * to redactSecrets in the node bundle); the frontend never classifies — the BoH tap is the deliberate
 * UI loosen surface and applies directly.
 */

import { isLoosening } from "../pendingApprovals";
import { DEFAULT_CAPABILITY_GATES, type CapabilityGate, type CapabilityGateMap, type GateValue } from "../types";

/** The gate this CLASSIFIER assumes a profile would install for an omitted `cap`: Auto — the
 *  maximally-permissive assumption. The APPLY (locks.ts applyPostureProfile) actually installs
 *  DEFAULT_CAPABILITY_GATES[cap] for omitted keys (deep-merge over DEFAULT, the Wave-7 fail-open
 *  fix), which is <= Auto in permissiveness. The divergence is DELIBERATE and strictly fail-closed:
 *  assuming Auto here means the loosen check can only OVER-defer (ask when the apply would in fact
 *  tighten), never under-defer — every real loosen is still caught. Pinned by
 *  tests/test_posture_profiles.ts (empty/omitted-key profiles classify as loosen → voice defers). */
function nextGlobalGateOf(profileGates: CapabilityGateMap, cap: string): GateValue {
  return Object.hasOwn(profileGates, cap) ? (profileGates as Record<string, GateValue>)[cap] : "Auto";
}

/**
 * Does applying `profileGates` LOOSEN the global matrix vs the current effective posture?
 *
 * @param profileGates   the profile's global map (already normalized by the caller).
 * @param currentGates   the CURRENT persisted global map (settings.advanced.capabilityGates) — used ONLY
 *                        to enumerate capabilities that presently carry a non-default gate, so a key that
 *                        the profile OMITS (→ resolves to Auto) is still checked for a loosen.
 * @param currentGateFor the current EFFECTIVE gate resolver — pass ctx.effectiveCapabilityGateFor(null, cap)
 *                        so the "current" side is byte-identical to what set_capability_gate compares against.
 * @returns true if ANY capability would end up less restrictive than it is now (⇒ voice must defer).
 *
 * Fail-closed: the key universe is DEFAULT ∪ profile ∪ current, so no currently-tightened capability can
 * be silently loosened by omission.
 */
export function profileLoosens(
  profileGates: CapabilityGateMap,
  currentGates: CapabilityGateMap | undefined,
  currentGateFor: (cap: CapabilityGate) => GateValue,
): boolean {
  const keys = new Set<string>([
    ...Object.keys(DEFAULT_CAPABILITY_GATES),
    ...Object.keys(profileGates ?? {}),
    ...Object.keys(currentGates ?? {}),
  ]);
  for (const cap of keys) {
    const current = currentGateFor(cap as CapabilityGate);
    if (isLoosening(current, nextGlobalGateOf(profileGates, cap))) return true;
  }
  return false;
}
