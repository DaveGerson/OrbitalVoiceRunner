// src/wtLock.ts
//
// Pure decision logic for the Worktree Mutual-Exclusion Lock.
//
// Context (see AGENTS.md "Worktree Isolation"): concurrent team-maintainer
// agent sessions share ONE git object store. When two sessions operate on the
// same working tree / branch they stash, commit, and switch over each other —
// and over a human's uncommitted WIP. The lock enforces "one committer per
// worktree/branch" at the `pre-commit` choke point.
//
// SAFETY CONTRACT (this module is the source of truth for that contract):
//   1. Default mode is ADVISORY: a contended lock WARNS but NEVER blocks. Strict
//      (blocking) mode is OPT-IN via JANUS_WT_LOCK=strict.
//   2. Stale locks auto-expire by timestamp (default 2h). A dead/abandoned
//      session can NEVER permanently block commits.
//   3. On ANY ambiguity (corrupt lock file, unparseable env, clock skew) we
//      FAIL OPEN: allow the commit and warn. We never fail closed.
//
// This file performs NO I/O. The decision is a pure function of (current lock
// file contents, this session's identity, mode, clock). The thin I/O shell
// lives in scripts/wt-lock.mjs and the committed .githooks/pre-commit.

/** A lock record as persisted (JSON) under $GIT_COMMON_DIR/janus-wt-locks/. */
export interface WtLockRecord {
  /** Branch the lock guards (ref short name). */
  branch: string;
  /** Absolute path of the worktree that holds the lock. */
  worktree: string;
  /** Opaque per-session identifier (pid + host + nonce). */
  session: string;
  /** Epoch ms when the lock was acquired/refreshed. */
  acquiredAt: number;
  /** Optional human/agent label for diagnostics. */
  holder?: string;
}

export type WtLockMode = "advisory" | "strict" | "off";

/** Default staleness window: a lock older than this is reclaimable. 2 hours. */
export const DEFAULT_STALE_MS = 2 * 60 * 60 * 1000;

/**
 * Parse JANUS_WT_LOCK into a mode. Unknown / empty / undefined => "advisory"
 * (the safe default). "off" fully disables the lock; "strict" enables blocking.
 * Parsing NEVER throws — an unrecognized value FAILS OPEN to advisory.
 */
export function parseMode(raw: string | undefined | null): WtLockMode {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "strict" || v === "block" || v === "1" || v === "on") return "strict";
  if (v === "off" || v === "disable" || v === "disabled" || v === "0") return "off";
  // "advisory", "warn", "", anything else -> advisory (fail open)
  return "advisory";
}

/**
 * Is `record` the SAME logical owner as the current session?
 * Same worktree path OR same session id counts as "self" — re-committing in
 * your own tree must never be treated as contention. Path comparison is
 * normalized case-insensitively because Windows paths are case-insensitive.
 */
export function isSelf(
  record: Pick<WtLockRecord, "worktree" | "session">,
  self: { worktree: string; session: string },
): boolean {
  if (record.session && self.session && record.session === self.session) return true;
  return normPath(record.worktree) === normPath(self.worktree);
}

function normPath(p: string): string {
  return (p ?? "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/**
 * Is the existing lock stale (reclaimable) at time `now`?
 * A missing/invalid acquiredAt is treated as stale (fail open: never let a
 * malformed lock block forever). A future timestamp (clock skew) is NOT stale
 * but is also never honored beyond the window — see decide().
 */
export function isStale(
  record: Pick<WtLockRecord, "acquiredAt">,
  now: number,
  staleMs: number = DEFAULT_STALE_MS,
): boolean {
  const t = record?.acquiredAt;
  if (typeof t !== "number" || !Number.isFinite(t)) return true; // malformed -> reclaimable
  const age = now - t;
  if (!Number.isFinite(age)) return true;
  return age >= staleMs;
}

export type WtLockOutcome =
  | { action: "acquire"; verdict: "allow"; reason: string }   // no/own/stale lock -> take it
  | { action: "none"; verdict: "allow"; reason: string }      // already ours
  | { action: "warn"; verdict: "allow"; reason: string }      // contended, advisory
  | { action: "block"; verdict: "block"; reason: string };    // contended, strict

export interface DecideInput {
  /** Parsed contents of the existing lock file, or null if none / unparseable. */
  existing: WtLockRecord | null;
  /** Identity of the session attempting to commit. */
  self: { worktree: string; session: string; branch: string; holder?: string };
  mode: WtLockMode;
  now: number;
  staleMs?: number;
}

/**
 * Core decision. Pure. Given the current lock state and this session's
 * identity, decide what the pre-commit hook should do.
 *
 * Invariants:
 *  - mode "off"            => always allow, action "none".
 *  - no existing lock      => acquire + allow.
 *  - existing is self      => acquire (REFRESH): rewrite the record so acquiredAt
 *                              bumps to `now` and an active session never lets its
 *                              own lock go stale (bead 5rq).
 *  - existing is stale     => reclaim (acquire) + allow.
 *  - existing is foreign &
 *      live & advisory     => warn + allow.
 *  - existing is foreign &
 *      live & strict       => block.
 *  - existing is corrupt   => treated as null upstream => acquire + allow
 *                              (FAIL OPEN).
 */
export function decide(input: DecideInput): WtLockOutcome {
  const { existing, self, mode, now } = input;
  const staleMs = input.staleMs ?? DEFAULT_STALE_MS;

  if (mode === "off") {
    return { action: "none", verdict: "allow", reason: "lock disabled (JANUS_WT_LOCK=off)" };
  }

  if (!existing) {
    return {
      action: "acquire",
      verdict: "allow",
      reason: `no active lock on '${self.branch}' — acquiring`,
    };
  }

  if (isSelf(existing, self)) {
    // BEAD 5rq: REFRESH our own lock on every self-commit. Returning "acquire" makes the
    // I/O shell rewrite the record with acquiredAt=now (via makeLockRecord), so an ACTIVE
    // session that commits at least once per stale window keeps its lock — otherwise a
    // long-idle-then-commit session could have its OWN live lock reclaimed as stale by
    // another worktree (weakening mutual exclusion under strict mode). The write is a
    // self-owned no-op apart from the bumped timestamp, so this is always safe.
    return {
      action: "acquire",
      verdict: "allow",
      reason: `lock on '${existing.branch}' already held by this worktree — refreshing`,
    };
  }

  if (isStale(existing, now, staleMs)) {
    const ageMin = Math.round((now - (existing.acquiredAt ?? 0)) / 60000);
    return {
      action: "acquire",
      verdict: "allow",
      reason: `reclaiming stale lock (held by ${describeHolder(existing)}, ~${ageMin}m old)`,
    };
  }

  // Foreign + live lock: contention.
  const desc = describeHolder(existing);
  if (mode === "strict") {
    return {
      action: "block",
      verdict: "block",
      reason:
        `branch '${existing.branch}' is locked by ${desc}. ` +
        `Commit blocked (JANUS_WT_LOCK=strict). ` +
        `If that session is dead, clear it: 'node scripts/wt-lock.mjs release --force'.`,
    };
  }
  return {
    action: "warn",
    verdict: "allow",
    reason:
      `branch '${existing.branch}' appears to be in use by ${desc}. ` +
      `Proceeding anyway (advisory mode). Set JANUS_WT_LOCK=strict to block, ` +
      `or 'node scripts/wt-lock.mjs release --force' to clear a dead lock.`,
  };
}

function describeHolder(r: WtLockRecord): string {
  const who = r.holder ? `${r.holder} ` : "";
  const wt = r.worktree ? r.worktree : "unknown worktree";
  return `${who}in ${wt}`;
}

/**
 * Safely parse a lock file's text into a record. Returns null on ANY problem
 * (missing fields, bad JSON) so the caller treats it as "no lock" and FAILS
 * OPEN by acquiring. Never throws.
 */
export function parseLockFile(text: string | null | undefined): WtLockRecord | null {
  if (!text) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.branch !== "string" || typeof o.worktree !== "string" || typeof o.session !== "string") {
    return null;
  }
  const acquiredAt = typeof o.acquiredAt === "number" ? o.acquiredAt : NaN;
  return {
    branch: o.branch,
    worktree: o.worktree,
    session: o.session,
    acquiredAt,
    holder: typeof o.holder === "string" ? o.holder : undefined,
  };
}

/** Serialize a fresh lock record for the current session at `now`. */
export function makeLockRecord(
  self: { worktree: string; session: string; branch: string; holder?: string },
  now: number,
): WtLockRecord {
  return {
    branch: self.branch,
    worktree: self.worktree,
    session: self.session,
    acquiredAt: now,
    holder: self.holder,
  };
}

/**
 * Map a branch ref to a safe lock filename. Slashes and unsafe chars are
 * replaced so 'feat/foo' does not create nested dirs. Collisions across
 * sanitized names are acceptable: the lock is advisory-first and self-checks
 * by worktree path inside the record anyway.
 */
export function lockFileName(branch: string): string {
  const safe = (branch || "DETACHED").replace(/[^A-Za-z0-9._-]+/g, "_");
  return `${safe}.lock.json`;
}
