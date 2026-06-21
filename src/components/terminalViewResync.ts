// ---------------------------------------------------------------------------
// Pure helpers for TerminalView's resync async arrow (3C.2b).
//
// Extracted into this CSS-free module (TerminalView.tsx imports `xterm/css`,
// which the node test runner cannot load) so the unit tests import the REAL
// implementations rather than mirror copies. Pure + deterministic.
// ---------------------------------------------------------------------------

/**
 * Wraps a backfill fetch in try/catch so callers don't need to handle it.
 * Returns null on any error or when no fetcher is provided.
 */
export async function tryFetchBackfill(
  fetcher: (() => Promise<string | null>) | undefined,
): Promise<string | null> {
  try {
    return (await fetcher?.()) ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolves the authoritative backfill string: prefers the freshly-fetched
 * server value; falls back to the latest React-state snapshot when the fetch
 * returned null.
 */
export function resolveBackfill(
  fetched: string | null,
  reactFallback: string | undefined,
): string | null {
  return fetched !== null ? fetched : (reactFallback ?? null);
}

/**
 * Returns true when a quiet (non-marker) resync should be skipped.
 * Skips when there is nothing to write, the snapshot is identical to what is
 * already on screen, or the operator has scrolled up and reading.
 */
export function shouldSkipQuietResync(
  fresh: string | null,
  lastBase: string,
  atBottom: boolean,
): boolean {
  return fresh === null || fresh === lastBase || !atBottom;
}
