/**
 * src/binaryOnPath.ts — pre-spawn PATH preflight for NON-Custom create_pane presets (bead
 * wsm-e2e-pinned-0bof). Today a bad launch binary is only discoverable by SPAWNING it (a demo
 * watched a dead pane instead of getting a spoken refusal). This module is the small, pure,
 * dependency-injectable resolver the create_pane handler consults before calling addTerminal —
 * pure/sync so it is trivially unit-testable and safe on the hot dispatch path (no PTY, no I/O
 * beyond a handful of existsSync stats).
 *
 * FAIL-OPEN BY DESIGN: this is a courtesy preflight, not a security gate. An unparseable command
 * (e.g. an unterminated quote) makes firstCommandToken return null; every caller here treats null
 * as "skip the preflight, spawn anyway" — never as "refuse". Custom-preset commands (shell
 * builtins, bare relative paths, `cd x && y`) are NEVER routed through this module — the caller
 * (src/actions/defs/panes_write.ts) is responsible for that exclusion.
 */

import fs from "fs";

/** Injectable knobs so every case here is deterministic on any host/CI — no real fs/env reads
 *  unless the caller omits them (the production call site lets these default to the real thing). */
export interface BinaryLookupEnv {
  platform?: NodeJS.Platform;
  pathEnv?: string;
  pathExtEnv?: string;
  existsSync?: (p: string) => boolean;
}

// win32's own default when the process has no PATHEXT set at all (rare, but defensive).
const DEFAULT_WIN32_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/**
 * Extract the first whitespace-delimited token of a shell command line, honoring a leading
 * quoted segment (single or double) so a quoted path-with-spaces (e.g.
 * `"C:\Program Files\agy\agy.exe" --flag`) resolves to the full UNQUOTED path, not just
 * "C:\Program". Returns null when the command is empty/blank, or when a leading quote never
 * closes — an unparseable command the caller must fail OPEN on (spawn anyway), never refuse.
 */
export function firstCommandToken(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const end = trimmed.indexOf(quote, 1);
    if (end === -1) return null; // unterminated quote — unparseable, fail open
    const token = trimmed.slice(1, end);
    return token || null;
  }
  const spaceIdx = trimmed.search(/\s/);
  return spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
}

/**
 * Candidate filenames for `bin` under Windows PATHEXT resolution. Off win32 this is always just
 * `[bin]` (PATHEXT is a Windows-only concept). On win32, a `bin` that already carries an
 * extension (e.g. "agy.exe") is checked AS-IS — cmd.exe's real resolver does not re-append
 * PATHEXT to an already-extensioned name, so re-appending here would just waste existsSync calls
 * and could false-positive on a coincidental "agy.exe.cmd". PATHEXT entries are used byte-for-byte
 * (own their own case) and never compared against anything — only concatenated — so PATHEXT
 * casing (".exe" vs ".EXE") can never gate the match either way; only existsSync decides.
 */
function pathExtCandidates(bin: string, platform: NodeJS.Platform, pathExtEnv: string): string[] {
  if (platform !== "win32" || /\.[^\\/]+$/.test(bin)) return [bin];
  const exts = pathExtEnv.split(";").map((e) => e.trim()).filter(Boolean);
  return [bin, ...exts.map((ext) => bin + ext)];
}

/** Resolved (defaults-applied) lookup knobs — isOnPath's helpers all take this instead of the raw
 *  BinaryLookupEnv so each `??` default fallback is applied exactly ONCE, in one place. */
interface ResolvedLookupEnv {
  platform: NodeJS.Platform;
  existsSync: (p: string) => boolean;
  pathExtEnv: string;
}

function resolveLookupEnv(env: BinaryLookupEnv): ResolvedLookupEnv {
  return {
    platform: env.platform ?? process.platform,
    existsSync: env.existsSync ?? fs.existsSync,
    pathExtEnv: env.pathExtEnv ?? process.env.PATHEXT ?? DEFAULT_WIN32_PATHEXT,
  };
}

/** True iff `bin` carries a path separator — an absolute OR relative path, checked directly
 *  (no PATH scan) rather than as a bare command name to look up. */
function looksLikePath(bin: string): boolean {
  return bin.includes("/") || bin.includes("\\");
}

/** existsSync check for a single already-joined path, expanded through PATHEXT candidates. */
function pathHit(fullPath: string, r: ResolvedLookupEnv): boolean {
  return pathExtCandidates(fullPath, r.platform, r.pathExtEnv).some(r.existsSync);
}

/** Scan every `pathEnv` directory for `bin`, joined with the platform's own path separator. */
function scanPathDirs(bin: string, pathEnv: string, r: ResolvedLookupEnv): boolean {
  const dirSep = r.platform === "win32" ? ";" : ":";
  const slash = r.platform === "win32" ? "\\" : "/";
  const dirs = pathEnv.split(dirSep).filter(Boolean);
  return dirs.some((dir) => pathHit(`${dir}${slash}${bin}`, r));
}

/**
 * True iff `bin` resolves to a real file: either directly (an absolute/relative path carrying a
 * separator — "the absolute path hit" case) or by scanning PATH directories (a bare command
 * name). Synchronous (existsSync), so it is safe to call inline on the create_pane dispatch path.
 */
export function isOnPath(bin: string, env: BinaryLookupEnv = {}): boolean {
  const trimmed = (bin || "").trim();
  if (!trimmed) return false;
  const r = resolveLookupEnv(env);
  if (looksLikePath(trimmed)) return pathHit(trimmed, r);
  const pathEnv = env.pathEnv ?? process.env.PATH ?? process.env.Path ?? "";
  return scanPathDirs(trimmed, pathEnv, r);
}

/**
 * The single call the create_pane handler makes. Given a DERIVED (non-Custom preset) launch
 * command, returns:
 *   - null            -> safe to spawn (either the binary resolved, or the command was
 *                        unparseable and we fail open — the caller cannot tell the two apart,
 *                        and doesn't need to: both mean "proceed").
 *   - the bin string  -> the resolved-but-missing first token; the caller refuses the spawn and
 *                        builds its refusal message from this value.
 */
export function unresolvedPresetBinary(command: string, env: BinaryLookupEnv = {}): string | null {
  const bin = firstCommandToken(command);
  if (bin === null) return null;
  return isOnPath(bin, env) ? null : bin;
}
