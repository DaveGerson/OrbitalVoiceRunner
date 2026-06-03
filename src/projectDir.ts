import fs from "fs";

/**
 * Resolve a caller-supplied project directory to a REAL, existing directory.
 *
 * Mirrors the POST /api/terminals cwd validator (server.ts) so the voice + REST
 * create_project paths can no longer persist a bogus dir that later taints a child
 * pane's cwd (node-pty throws ERROR_DIRECTORY / code 267 on a bad path).
 *
 * Resolution order:
 *   1. blank / "." / undefined            -> `fallback` (default process.cwd())
 *   2. a path that exists AND isDirectory -> the trimmed path
 *   3. anything else (missing / a file)   -> `fallback`
 *
 * Note: "." is treated as "use the fallback" (the real cwd), NOT dropped — we keep
 * valid orientation intent instead of throwing it away.
 */
export function resolveProjectDir(raw: unknown, fallback: string = process.cwd()): string {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed || trimmed === ".") return fallback;
  try {
    if (fs.existsSync(trimmed) && fs.statSync(trimmed).isDirectory()) {
      return trimmed;
    }
  } catch {
    /* fall through to fallback */
  }
  return fallback;
}

/** True iff `raw` is a non-blank, non-"." path that does NOT resolve to a real directory. */
export function isBadProjectDir(raw: unknown): boolean {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed || trimmed === ".") return false;
  try {
    return !(fs.existsSync(trimmed) && fs.statSync(trimmed).isDirectory());
  } catch {
    return true;
  }
}
