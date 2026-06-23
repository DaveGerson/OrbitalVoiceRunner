// tests/test_wt_lock_e2e.ts
//
// bead gn4 — END-TO-END subprocess coverage for the Worktree Mutual-Exclusion Lock.
//
// test_wt_lock.ts proves the PURE decision core (src/wtLock.ts). This file proves the
// WIRING: it spawns the real I/O shell (scripts/wt-lock.mjs) and the committed
// .githooks/pre-commit launcher as SUBPROCESSES against a throwaway git repo + worktree,
// so the contract is verified all the way through git plumbing, the lock-file store under
// $GIT_COMMON_DIR/janus-wt-locks, and the actual process exit codes the hook returns.
//
// Scenarios (all six the bead names):
//   • acquire        — `acquire` writes a lock; `status` reports it.
//   • advisory-warn  — a FOREIGN live lock + default mode → exit 0, warns on stderr.
//   • strict-block   — a FOREIGN live lock + JANUS_WT_LOCK=strict → exit 1 (commit blocked).
//   • force-release  — `release --force` removes a foreign lock; plain `release` declines it.
//   • stale-lock     — a FOREIGN lock older than the stale window is reclaimed → exit 0.
//   • fail-open      — a CORRUPT lock file never blocks (check exits 0); the hook fails open
//                      from a non-repo dir.
//
// The whole repo lives in os.tmpdir() and is removed in an after() hook, so it never touches
// the real clone or its .git/janus-wt-locks store.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WT_LOCK = path.join(repoRoot, "scripts", "wt-lock.mjs");
const PRE_COMMIT = path.join(repoRoot, ".githooks", "pre-commit");
const BRANCH = "feat/gn4-e2e";

// One shared scratch fixture: a main repo + a linked worktree on `feat/gn4-e2e`. The worktree
// is where we run the lock as "self"; foreign locks are seeded directly into the shared store.
let scratch = "";
let mainRepo = "";
let worktree = "";
let lockDir = "";
let lockFile = "";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Run wt-lock.mjs from `cwd` with extra env; capture exit code + stdout + stderr (never throws). */
function runLock(args: string[], cwd: string, env: Record<string, string> = {}) {
  const res = spawnSync("node", [WT_LOCK, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: res.status ?? 0, out: res.stdout ?? "", err: res.stderr ?? "" };
}

/** Run the committed pre-commit hook via /bin/sh from `cwd`; capture exit code + streams. */
function runHook(cwd: string, env: Record<string, string> = {}) {
  const res = spawnSync("sh", [PRE_COMMIT], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: res.status ?? 0, out: res.stdout ?? "", err: res.stderr ?? "" };
}

/** Seed a FOREIGN lock record (a different worktree + session) directly into the shared store. */
function seedForeignLock(acquiredAt: number): void {
  mkdirSync(lockDir, { recursive: true });
  const rec = {
    branch: BRANCH,
    worktree: path.join(scratch, "some-other-worktree"),
    session: "otherhost:other:99999",
    acquiredAt,
    holder: "other@otherhost",
  };
  writeFileSync(lockFile, JSON.stringify(rec, null, 2) + "\n", "utf8");
}

function clearLock(): void {
  if (existsSync(lockFile)) rmSync(lockFile, { force: true });
}

before(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "wtlock-e2e-"));
  mainRepo = path.join(scratch, "main");
  mkdirSync(mainRepo, { recursive: true });
  git(["init", "-q", "-b", "main"], mainRepo);
  git(["config", "user.email", "e2e@example.com"], mainRepo);
  git(["config", "user.name", "e2e"], mainRepo);
  writeFileSync(path.join(mainRepo, "README.md"), "seed\n", "utf8");
  git(["add", "README.md"], mainRepo);
  git(["commit", "-q", "-m", "seed"], mainRepo);

  // A linked worktree on a feature branch — the "self" tree the lock guards.
  worktree = path.join(scratch, "wt");
  git(["worktree", "add", "-q", "-b", BRANCH, worktree], mainRepo);

  // The committed pre-commit hook resolves its helper as `$ROOT/scripts/wt-lock.mjs` where ROOT is
  // `git rev-parse --show-toplevel` — i.e. the WORKTREE root, not the real clone. So drop the real
  // helper + its decision module onto disk inside the worktree (untracked is fine; the hook reads
  // them off the filesystem, not git). Node strips the .ts on import natively, so no tsx/node_modules
  // is needed in the scratch tree for the logic to load.
  mkdirSync(path.join(worktree, "scripts"), { recursive: true });
  mkdirSync(path.join(worktree, "src"), { recursive: true });
  copyFileSync(WT_LOCK, path.join(worktree, "scripts", "wt-lock.mjs"));
  copyFileSync(path.join(repoRoot, "src", "wtLock.ts"), path.join(worktree, "src", "wtLock.ts"));

  // The lock store lives under the SHARED common dir (.git of the main repo). Resolve it the
  // exact way the script does, from inside the worktree, so the path matches byte-for-byte.
  let commonDir = git(["rev-parse", "--git-common-dir"], worktree);
  if (!path.isAbsolute(commonDir)) commonDir = path.resolve(worktree, commonDir);
  lockDir = path.join(commonDir, "janus-wt-locks");
  lockFile = path.join(lockDir, `${BRANCH.replace(/[^A-Za-z0-9._-]+/g, "_")}.lock.json`);
});

after(() => {
  if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
});

// ── acquire ────────────────────────────────────────────────────────────────
test("acquire writes a lock for this worktree; status reports it", () => {
  clearLock();
  const acq = runLock(["acquire"], worktree);
  assert.equal(acq.code, 0, acq.err);
  assert.match(acq.out, /acquired lock/i);
  assert.ok(existsSync(lockFile), "lock file should exist after acquire");

  const rec = JSON.parse(readFileSync(lockFile, "utf8"));
  assert.equal(rec.branch, BRANCH);
  assert.equal(path.resolve(rec.worktree).toLowerCase(), path.resolve(worktree).toLowerCase());

  const st = runLock(["status"], worktree);
  assert.equal(st.code, 0);
  assert.match(st.out, /held by/i);
});

// ── advisory-warn (default mode never blocks a foreign live lock) ────────────
test("advisory mode: a foreign live lock WARNS but exits 0 (never blocks)", () => {
  clearLock();
  seedForeignLock(Date.now());
  const r = runLock(["check"], worktree); // default mode = advisory
  assert.equal(r.code, 0, "advisory must never block");
  assert.match(r.err, /advisory/i);
  // The foreign lock is untouched (advisory does not reclaim a live foreign lock).
  const rec = JSON.parse(readFileSync(lockFile, "utf8"));
  assert.equal(rec.session, "otherhost:other:99999");
});

// ── strict-block ─────────────────────────────────────────────────────────────
test("strict mode: a foreign live lock BLOCKS the commit (exit 1)", () => {
  clearLock();
  seedForeignLock(Date.now());
  const r = runLock(["check"], worktree, { JANUS_WT_LOCK: "strict" });
  assert.equal(r.code, 1, "strict must block a foreign live lock");
  assert.match(r.err, /COMMIT BLOCKED/);
  assert.match(r.err, /--force/); // tells the operator how to clear a dead lock
});

test("strict mode: the pre-commit HOOK propagates the block (exit 1)", () => {
  clearLock();
  seedForeignLock(Date.now());
  const r = runHook(worktree, { JANUS_WT_LOCK: "strict" });
  assert.equal(r.code, 1, "the hook must surface the strict block as a non-zero exit");
  assert.match(r.err, /COMMIT BLOCKED/);
});

// ── force-release ────────────────────────────────────────────────────────────
test("release without --force declines a foreign lock; --force removes it", () => {
  clearLock();
  seedForeignLock(Date.now());

  const declined = runLock(["release"], worktree);
  assert.equal(declined.code, 0, "release fails open (exit 0) even when it declines");
  assert.match(declined.err, /Refusing to release without --force/i);
  assert.ok(existsSync(lockFile), "a foreign lock must survive a non-forced release");

  const forced = runLock(["release", "--force"], worktree);
  assert.equal(forced.code, 0);
  assert.match(forced.out, /released lock/i);
  assert.ok(!existsSync(lockFile), "--force must remove the foreign lock");
});

// ── stale-lock (a long-dead session can never permanently brick commits) ─────
test("strict mode: a foreign STALE lock is reclaimed and allowed (exit 0)", () => {
  clearLock();
  // Older than the default 2h window — reclaimable. Use a tiny custom window to be unambiguous.
  seedForeignLock(Date.now() - 10_000);
  const r = runLock(["check"], worktree, {
    JANUS_WT_LOCK: "strict",
    JANUS_WT_LOCK_STALE_MS: "1000", // 1s window → the 10s-old lock is stale
  });
  assert.equal(r.code, 0, "a stale lock must be reclaimed, not block");
  // The reclaimed lock now belongs to THIS worktree.
  const rec = JSON.parse(readFileSync(lockFile, "utf8"));
  assert.equal(path.resolve(rec.worktree).toLowerCase(), path.resolve(worktree).toLowerCase());
});

// ── fail-open ────────────────────────────────────────────────────────────────
test("fail-open: a CORRUPT lock file never blocks (check exits 0, acquires)", () => {
  clearLock();
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(lockFile, "{ this is not valid json", "utf8");
  const r = runLock(["check"], worktree, { JANUS_WT_LOCK: "strict" });
  assert.equal(r.code, 0, "a corrupt lock must fail open, never block");
  // It was treated as absent and replaced with our own valid record.
  const rec = JSON.parse(readFileSync(lockFile, "utf8"));
  assert.equal(rec.branch, BRANCH);
});

test("fail-open: the hook exits 0 when run outside any git repo", () => {
  const nonRepo = path.join(scratch, "not-a-repo");
  mkdirSync(nonRepo, { recursive: true });
  const r = runHook(nonRepo, { JANUS_WT_LOCK: "strict" });
  assert.equal(r.code, 0, "the hook must fail open (exit 0) when it cannot resolve a repo root");
});

test("mode=off fully disables the lock even with a foreign live lock present", () => {
  clearLock();
  seedForeignLock(Date.now());
  const r = runLock(["check"], worktree, { JANUS_WT_LOCK: "off" });
  assert.equal(r.code, 0, "off must always allow");
  // off does not touch the foreign lock.
  assert.ok(existsSync(lockFile));
  const rec = JSON.parse(readFileSync(lockFile, "utf8"));
  assert.equal(rec.session, "otherhost:other:99999");
});
