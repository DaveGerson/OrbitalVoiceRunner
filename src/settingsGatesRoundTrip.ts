/**
 * settingsGatesRoundTrip — PURE, frontend-safe helpers that carry the capability-gate matrix
 * through the Settings save/load round-trip (spec §3 / §2.B "Landmine fix").
 *
 * THE BUG (regression-pinned by tests/test_settings_gates_roundtrip.ts):
 * `SettingsDialog.getCompiledSettings()` rebuilt `advanced` from a flat literal that omitted
 * `capabilityGates`, and `parsePresetsSafe()` rebuilt each preset field-by-field, dropping the
 * per-preset `capabilityGates`. So every save SILENTLY ERASED both the global default matrix and
 * every per-preset matrix — a real data-loss bug the matrix editor necessarily had to close.
 *
 * These helpers are the single source of truth for "preserve the gates on the round-trip". They
 * import ONLY types (no React, no fs) so SettingsDialog uses them AND node:test can pin them
 * without booting the browser bundle. Keep SettingsDialog's compile/parse delegating here.
 */

import type { CapabilityGateMap, CliPreset } from "./types";

/**
 * Normalize a raw per-preset `capabilityGates` value into a clean CapabilityGateMap, or undefined.
 * Only string-valued keys survive (defensive against malformed imported JSON); an empty/absent map
 * normalizes to `undefined` so we never persist an empty `{}` that would mask the global default.
 */
export function normalizeGateMap(raw: any): CapabilityGateMap | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: CapabilityGateMap = {};
  let any = false;
  for (const [k, v] of Object.entries(raw)) {
    if (v === "Auto" || v === "Ask" || v === "Off") {
      (out as any)[k] = v;
      any = true;
    }
  }
  return any ? out : undefined;
}

/**
 * Carry the per-preset `capabilityGates` through a parsed preset. The caller (parsePresetsSafe)
 * builds the rest of the preset field-by-field; this restores the one field that was being dropped.
 * Returns a NEW preset object so callers can spread it without mutating their literal.
 */
export function preservePresetGates(preset: CliPreset, rawSource: any): CliPreset {
  const gates = normalizeGateMap(rawSource?.capabilityGates);
  return gates ? { ...preset, capabilityGates: gates } : preset;
}

/**
 * Carry the global default matrix (`advanced.capabilityGates`) through compile. The caller builds
 * the rest of `advanced` from a literal; this re-attaches the gates from current form/source state
 * so a save no longer erases them. Returns the advanced object WITH capabilityGates when present.
 */
export function withAdvancedGates<T extends Record<string, any>>(
  advanced: T,
  gates: CapabilityGateMap | undefined
): T & { capabilityGates?: CapabilityGateMap } {
  const normalized = normalizeGateMap(gates);
  if (!normalized) return advanced;
  return { ...advanced, capabilityGates: normalized };
}
