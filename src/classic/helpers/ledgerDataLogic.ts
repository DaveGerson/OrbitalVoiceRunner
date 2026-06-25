// src/classic/helpers/ledgerDataLogic.ts — pure, browser-API-free response normalizers for the
// ledger-data hook (useLedgerData). Extracted out of src/App.tsx (bead wsm-e2e-pinned-4ib — the
// final dbt4 App.tsx decomposition keystone), mirroring the idleDiff.ts / earconLogic.ts gold-standard
// seam. The 7 GET fetchers are irreducibly I/O (apiFetch → setState) and stay in the hook; this module
// pins the ONE pure piece of each fetcher — how a parsed JSON body is normalized before it reaches
// setState. Each function is VERBATIM from the original inline fetcher body, so the extraction is
// provably a behavior no-op. See tests/test_ledger_data_logic.ts.
//
// Inputs are always post-`res.json()` objects (the fetchers only reach these lines after `res.ok`),
// so the helpers mirror the inline code's non-defensive member access exactly — they do NOT add `?.`
// guards the runtime never needed (that would be a behavior change, not a characterization).

/** fetchProjectNotes (App.tsx): `setActiveProjectNotes(Array.isArray(data.notes) ? data.notes : [])`. */
export function normalizeProjectNotes(data: { notes?: unknown }): unknown[] {
  return Array.isArray(data.notes) ? data.notes : [];
}

/**
 * fetchFrozenStatus (App.tsx) — the SAFETY-CRITICAL kill-switch normalizer:
 *   `setFrozen(!!data.frozen); setFrozenRunning(Array.isArray(data.running) ? data.running : [])`.
 * `frozen` is double-banged to a hard boolean; `running` falls back to [] for any non-array body.
 */
export function normalizeFrozenStatus(
  data: { frozen?: unknown; running?: unknown },
): { frozen: boolean; running: unknown[] } {
  return { frozen: !!data.frozen, running: Array.isArray(data.running) ? data.running : [] };
}

/** fetchArchive (App.tsx): `setArchive(data.archived || [])`. */
export function normalizeArchive(data: { archived?: unknown }): unknown {
  return data.archived || [];
}

/**
 * fetchSettings (App.tsx): `setSettings(data); if (data.advanced) setGlobalPermissionsMode(data.advanced.globalPermissionsMode)`.
 * Returns a discriminator so the hook reproduces the inline `if (data.advanced)` guard byte-for-byte:
 * `apply` mirrors the truthiness of `data.advanced`; when true the hook calls the setter with `mode`
 * (which may itself be `undefined` if `advanced` carries no mode — exactly as the inline code does).
 * When `apply` is false the hook leaves globalPermissionsMode UNCHANGED.
 */
export function globalModeFromSettings(
  data: { advanced?: { globalPermissionsMode?: string } },
): { apply: boolean; mode: string | undefined } {
  return data.advanced ? { apply: true, mode: data.advanced.globalPermissionsMode } : { apply: false, mode: undefined };
}
