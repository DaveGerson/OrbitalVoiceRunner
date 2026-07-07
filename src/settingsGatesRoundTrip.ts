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

import type { CapabilityGate, CapabilityGateMap, CliPreset, GateValue, PostureProfile } from "./types";
import { DEFAULT_CAPABILITY_GATES, SEED_POSTURE_PROFILES } from "./types";

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

// ─────────────────────────────────────────────────────────────────────────────
// f09.3 — posture profiles (pure, frontend-safe: SettingsDialog + BackOfHouse both use these;
// locks.ts (backend apply_posture) resolves a name through findPostureProfileByName). Names are
// matched case- and punctuation-insensitively so voice ("go heads down") and the seed label
// ("Heads-down") collapse to one key.
// ─────────────────────────────────────────────────────────────────────────────

/** Fold a profile name to a stable match key: lowercase, strip everything but [a-z0-9]. */
export function normalizePostureName(name: string): string {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Validate/normalize a raw postureProfiles array from persisted JSON. Drops entries without a
 * non-empty string name; normalizes each gate map (empty ⇒ {} so the shape stays a profile).
 * Applying is FAIL-CLOSED: applyPostureProfile deep-merges the profile over
 * DEFAULT_CAPABILITY_GATES, so an empty/partial profile installs the default matrix for omitted
 * capabilities — it never clears the map and never falls through to the permissive resolver
 * fallback. Returns undefined for a non-array / all-invalid input so an absent array never
 * persists a masking `[]`.
 */
/** Keep a valid globalPermissionsMode string, else undefined (defensive against malformed JSON). */
function validPostureMode(mode: unknown): PostureProfile["globalPermissionsMode"] | undefined {
  return mode === "Full Auto" || mode === "Human-in-the-Loop" || mode === "Read-Only" || mode === "Inherit"
    ? mode
    : undefined;
}

/** Build one normalized profile from a raw JSON entry, or null when it lacks a usable name. */
function toPostureProfile(item: any): PostureProfile | null {
  if (!item || typeof item !== "object" || typeof item.name !== "string" || !item.name.trim()) return null;
  const profile: PostureProfile = { name: item.name, capabilityGates: normalizeGateMap(item.capabilityGates) ?? {} };
  const mode = validPostureMode(item.globalPermissionsMode);
  if (mode) profile.globalPermissionsMode = mode;
  return profile;
}

export function normalizePostureProfiles(raw: any): PostureProfile[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: PostureProfile[] = [];
  for (const item of raw) {
    const profile = toPostureProfile(item);
    if (profile) out.push(profile);
  }
  return out.length ? out : undefined;
}

/**
 * Carry the operator-saved postureProfiles array through the SettingsDialog compile (the sibling of
 * withAdvancedGates). The caller rebuilds `advanced` from a literal that OMITS postureProfiles, so a
 * save would silently erase the operator's saved profiles — this re-attaches them (the same
 * data-loss class the capabilityGates round-trip guard pins). Returns advanced unchanged when there
 * are no valid profiles (no empty `[]` injected).
 */
export function preservePostureProfiles<T extends Record<string, any>>(
  advanced: T,
  profiles: PostureProfile[] | undefined
): T & { postureProfiles?: PostureProfile[] } {
  const normalized = normalizePostureProfiles(profiles);
  if (!normalized) return advanced;
  return { ...advanced, postureProfiles: normalized };
}

/**
 * The full profile set the operator sees/uses: the three SEED profiles first, then operator-saved
 * ones. A saved profile whose name folds to a seed's key OVERRIDES that seed (so "save current as
 * profile" named "Locked" re-snapshots Locked). De-duped on the folded name key.
 */
export function resolvePostureProfiles(saved: PostureProfile[] | undefined): PostureProfile[] {
  const byName = new Map<string, PostureProfile>();
  for (const p of SEED_POSTURE_PROFILES) byName.set(normalizePostureName(p.name), p);
  for (const p of saved ?? []) {
    if (p && typeof p.name === "string" && p.name.trim()) byName.set(normalizePostureName(p.name), p);
  }
  return [...byName.values()];
}

/** Resolve a posture by (fuzzy) name across seeds + saved. Undefined when no profile matches. */
export function findPostureProfileByName(
  name: string,
  saved: PostureProfile[] | undefined
): PostureProfile | undefined {
  const key = normalizePostureName(name);
  if (!key) return undefined;
  return resolvePostureProfiles(saved).find((p) => normalizePostureName(p.name) === key);
}

/** The effective gate for a capability, treating an absent key as its DEFAULT matrix value (the UI's
 *  seeded display baseline — NOT the server's `?? "Auto"` resolver; this is display/match-only). */
function displayGateOf(map: CapabilityGateMap, cap: string): GateValue {
  return (Object.hasOwn(map, cap) ? (map as Record<string, GateValue>)[cap] : DEFAULT_CAPABILITY_GATES[cap as CapabilityGate]) ?? "Auto";
}

/** True when two matrices represent the SAME posture over the DEFAULT-seeded capability universe. */
function gatesEqual(a: CapabilityGateMap, b: CapabilityGateMap): boolean {
  const keys = new Set<string>([...Object.keys(DEFAULT_CAPABILITY_GATES), ...Object.keys(a), ...Object.keys(b)]);
  for (const cap of keys) {
    if (displayGateOf(a, cap) !== displayGateOf(b, cap)) return false;
  }
  return true;
}

/**
 * Which profile (if any) the current global matrix EXACTLY matches — the "active" pill to highlight.
 * Compares over the DEFAULT-seeded universe so a partial saved map and the seeded display map line up.
 * Returns the profile name, or undefined when the current matrix matches no profile.
 */
export function matchActiveProfile(
  currentGates: CapabilityGateMap,
  saved: PostureProfile[] | undefined
): string | undefined {
  for (const p of resolvePostureProfiles(saved)) {
    if (gatesEqual(currentGates, p.capabilityGates)) return p.name;
  }
  return undefined;
}
