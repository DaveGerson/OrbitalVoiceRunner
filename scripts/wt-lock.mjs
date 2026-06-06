#!/usr/bin/env node
// scripts/wt-lock.mjs
//
// I/O shell for the Worktree Mutual-Exclusion Lock. The DECISION lives in
// src/wtLock.ts (pure, unit-tested); this file only does git plumbing + file
// I/O and then prints/acts on the verdict.
//
// Subcommands:
//   check     (default)  Evaluate the lock for the current branch/worktree.
//                        In strict mode + contention -> exit 1 (blocks commit).
//                        Otherwise acquires/refreshes and exits 0 (allows).
//   acquire              Force-write a lock for this worktree (exit 0).
//   release  [--force]   Remove the lock for the current branch. Without
//                        --force, only removes a lock this worktree owns.
//   status               Print the current lock record (if any) and exit 0.
//
// SAFETY: every failure path FAILS OPEN (prints a warning, exits 0). The hook
// must never block a commit because of a bug in the lock tooling itself.
// The single intentional non-zero exit is strict-mode contention in `check`.
//
// Lock storage: $GIT_COMMON_DIR/janus-wt-locks/<sanitized-branch>.lock.json
// This dir lives INSIDE .git, so it is never committed and is shared across
// all worktrees of the same clone (exactly the contention domain we guard).
//
// Pure logic is loaded via tsx so we have a single source of truth even though
// this is a .mjs file. We fall back to a vendored copy of the decision if tsx
// is unavailable, but tsx is a devDependency so it is normally present.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { hostname, userInfo } from "node:os";

const ENV_MODE = "JANUS_WT_LOCK";
const ENV_STALE = "JANUS_WT_LOCK_STALE_MS";
const ENV_SESSION = "JANUS_WT_SESSION";
const LOCK_DIRNAME = "janus-wt-locks";

function warn(msg) {
  process.stderr.write(`[wt-lock] ${msg}\n`);
}

function git(args, opts = {}) {
  return execFileSync("git", args, { encoding: "utf8", ...opts }).trim();
}

// Resolve the pure decision module. Prefer compiling src/wtLock.ts via tsx's
// loader; if that import fails for any reason, FAIL OPEN to a permissive stub.
async function loadLogic() {
  const here = new URL(".", import.meta.url);
  const tsPath = new URL("../src/wtLock.ts", here);
  try {
    return await import(tsPath.href);
  } catch (e) {
    warn(`could not load decision logic (${e?.message ?? e}); failing open (advisory).`);
    return null;
  }
}

function discoverContext() {
  // git rev-parse gives us everything we need; if ANY of it fails we fail open.
  const commonDir = resolveCommonDir();
  let branch = "DETACHED";
  try {
    branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (!branch || branch === "HEAD") branch = "DETACHED";
  } catch {
    /* fail open */
  }
  let worktree = process.cwd();
  try {
    worktree = git(["rev-parse", "--show-toplevel"]);
  } catch {
    /* fall back to cwd */
  }
  return { commonDir, branch, worktree };
}

function resolveCommonDir() {
  // --git-common-dir may be relative to cwd; resolve it to absolute.
  let dir;
  try {
    dir = git(["rev-parse", "--git-common-dir"]);
  } catch {
    dir = ".git";
  }
  // execFileSync runs in cwd; resolve relative paths against cwd.
  if (!isAbsolute(dir)) dir = join(process.cwd(), dir);
  return dir;
}

function isAbsolute(p) {
  return /^(?:[A-Za-z]:[\\/]|[\\/])/.test(p);
}

function sessionId() {
  if (process.env[ENV_SESSION]) return String(process.env[ENV_SESSION]);
  // Stable-ish per process/host. Not security-sensitive — just identity.
  let user = "unknown";
  try {
    user = userInfo().username || "unknown";
  } catch {
    /* ignore */
  }
  return `${hostname()}:${user}:${process.ppid ?? process.pid}`;
}

function holderLabel() {
  // Best-effort friendly label for diagnostics only.
  let user = "";
  try {
    user = userInfo().username || "";
  } catch {
    /* ignore */
  }
  return user ? `${user}@${hostname()}` : hostname();
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv.find((a) => !a.startsWith("-")) ?? "check";
  const force = argv.includes("--force") || argv.includes("-f");

  const logic = await loadLogic();
  const ctx = discoverContext();

  // If logic failed to load, we can still service release/status structurally,
  // and `check` simply fails open.
  const mode = logic ? logic.parseMode(process.env[ENV_MODE]) : "advisory";
  const staleMs =
    logic && process.env[ENV_STALE] && Number.isFinite(Number(process.env[ENV_STALE]))
      ? Number(process.env[ENV_STALE])
      : logic
        ? logic.DEFAULT_STALE_MS
        : 2 * 60 * 60 * 1000;

  const lockDir = join(ctx.commonDir, LOCK_DIRNAME);
  const fileName = logic ? logic.lockFileName(ctx.branch) : `${sanitize(ctx.branch)}.lock.json`;
  const lockPath = join(lockDir, fileName);

  const self = {
    worktree: ctx.worktree,
    session: sessionId(),
    branch: ctx.branch,
    holder: holderLabel(),
  };

  const existing = readLock(lockPath, logic);

  switch (cmd) {
    case "status":
      return doStatus(existing, ctx, mode, lockPath);
    case "release":
      return doRelease(existing, self, force, lockPath, logic);
    case "acquire":
      writeLock(lockPath, lockDir, self, logic);
      process.stdout.write(`[wt-lock] acquired lock for '${ctx.branch}'.\n`);
      return 0;
    case "check":
    default:
      return doCheck({ existing, self, mode, staleMs, lockPath, lockDir, logic });
  }
}

function sanitize(branch) {
  return (branch || "DETACHED").replace(/[^A-Za-z0-9._-]+/g, "_");
}

function readLock(lockPath, logic) {
  if (!existsSync(lockPath)) return null;
  let text = null;
  try {
    text = readFileSync(lockPath, "utf8");
  } catch {
    return null; // unreadable -> treat as absent (fail open)
  }
  if (logic) return logic.parseLockFile(text);
  try {
    const o = JSON.parse(text);
    return o && typeof o === "object" ? o : null;
  } catch {
    return null;
  }
}

function writeLock(lockPath, lockDir, self, logic) {
  try {
    mkdirSync(lockDir, { recursive: true });
    const rec = logic
      ? logic.makeLockRecord(self, Date.now())
      : { ...self, acquiredAt: Date.now() };
    writeFileSync(lockPath, JSON.stringify(rec, null, 2) + "\n", "utf8");
  } catch (e) {
    // Could not persist the lock — that's fine, it's advisory. Warn, fail open.
    warn(`could not write lock file (${e?.message ?? e}); continuing.`);
  }
}

function doStatus(existing, ctx, mode, lockPath) {
  process.stdout.write(`[wt-lock] mode=${mode} branch='${ctx.branch}' worktree='${ctx.worktree}'\n`);
  if (!existing) {
    process.stdout.write(`[wt-lock] no active lock (${lockPath} absent).\n`);
  } else {
    const ageMin = Number.isFinite(existing.acquiredAt)
      ? Math.round((Date.now() - existing.acquiredAt) / 60000)
      : "?";
    process.stdout.write(
      `[wt-lock] held by ${existing.holder ?? "?"} in ${existing.worktree} ` +
        `(session ${existing.session}, ~${ageMin}m old)\n`,
    );
  }
  return 0;
}

function doRelease(existing, self, force, lockPath, logic) {
  if (!existing) {
    process.stdout.write(`[wt-lock] nothing to release.\n`);
    return 0;
  }
  const mine = logic ? logic.isSelf(existing, self) : sameWorktree(existing, self);
  if (!mine && !force) {
    warn(
      `lock is held by another worktree (${existing.worktree}). ` +
        `Refusing to release without --force.`,
    );
    return 0; // fail open: do not error, just decline
  }
  try {
    rmSync(lockPath, { force: true });
    process.stdout.write(`[wt-lock] released lock for '${existing.branch}'.\n`);
  } catch (e) {
    warn(`could not remove lock file (${e?.message ?? e}).`);
  }
  return 0;
}

function sameWorktree(existing, self) {
  const n = (p) => String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return n(existing.worktree) === n(self.worktree);
}

function doCheck({ existing, self, mode, staleMs, lockPath, lockDir, logic }) {
  if (!logic) {
    // Decision logic unavailable -> fail open.
    warn("decision logic unavailable; allowing commit (fail open).");
    return 0;
  }
  const outcome = logic.decide({ existing, self, mode, now: Date.now(), staleMs });
  switch (outcome.action) {
    case "acquire":
      writeLock(lockPath, lockDir, self, logic);
      // A foreign-stale RECLAIM is worth surfacing; a self-owned REFRESH (bead 5rq) is a
      // silent timestamp bump on our own lock — don't spam the hook output on every commit.
      if (existing && !logic.isSelf(existing, self)) warn(outcome.reason);
      return 0;
    case "none":
      return 0;
    case "warn":
      warn(outcome.reason);
      return 0;
    case "block":
      process.stderr.write(`\n[wt-lock] COMMIT BLOCKED\n  ${outcome.reason}\n\n`);
      return 1;
    default:
      return 0;
  }
}

main()
  .then((code) => process.exit(typeof code === "number" ? code : 0))
  .catch((e) => {
    // Absolute last-resort guard: ANY uncaught error fails open.
    warn(`unexpected error (${e?.message ?? e}); allowing commit (fail open).`);
    process.exit(0);
  });
