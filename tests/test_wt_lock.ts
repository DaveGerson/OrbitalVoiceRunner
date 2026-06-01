// tests/test_wt_lock.ts
//
// Unit tests for the Worktree Mutual-Exclusion Lock decision core
// (src/wtLock.ts). The lock's entire safety contract is encoded in these pure
// functions, so this is where we prove it:
//   - advisory is the default and NEVER blocks
//   - strict blocks ONLY a foreign, live lock
//   - stale locks are always reclaimable (no permanent brick)
//   - corrupt/ambiguous input FAILS OPEN
import { test } from "node:test";
import assert from "node:assert";
import {
  parseMode,
  isSelf,
  isStale,
  decide,
  parseLockFile,
  makeLockRecord,
  lockFileName,
  DEFAULT_STALE_MS,
  type WtLockRecord,
} from "../src/wtLock";

const SELF = { worktree: "C:/wt/a", session: "hostA:me:111", branch: "feat/x", holder: "me@hostA" };

function foreignLock(over: Partial<WtLockRecord> = {}): WtLockRecord {
  return {
    branch: "feat/x",
    worktree: "C:/wt/b",
    session: "hostB:other:222",
    acquiredAt: Date.now(),
    holder: "other@hostB",
    ...over,
  };
}

// ---- parseMode -------------------------------------------------------------

test("parseMode defaults to advisory for empty/unknown/undefined", () => {
  assert.equal(parseMode(undefined), "advisory");
  assert.equal(parseMode(null), "advisory");
  assert.equal(parseMode(""), "advisory");
  assert.equal(parseMode("   "), "advisory");
  assert.equal(parseMode("warn"), "advisory");
  assert.equal(parseMode("garbage"), "advisory");
});

test("parseMode recognizes strict and off aliases (case-insensitive)", () => {
  for (const v of ["strict", "STRICT", " Strict ", "block", "1", "on"]) {
    assert.equal(parseMode(v), "strict", `expected strict for '${v}'`);
  }
  for (const v of ["off", "OFF", "disable", "disabled", "0"]) {
    assert.equal(parseMode(v), "off", `expected off for '${v}'`);
  }
});

// ---- isSelf ----------------------------------------------------------------

test("isSelf matches on identical session id", () => {
  assert.ok(isSelf({ worktree: "C:/wt/b", session: SELF.session }, SELF));
});

test("isSelf matches on worktree path regardless of case/slashes/trailing slash", () => {
  assert.ok(isSelf({ worktree: "c:\\WT\\A\\", session: "different" }, SELF));
});

test("isSelf is false for a genuinely foreign lock", () => {
  assert.equal(isSelf({ worktree: "C:/wt/b", session: "other" }, SELF), false);
});

// ---- isStale ---------------------------------------------------------------

test("isStale: fresh lock is not stale, aged lock is", () => {
  const now = 10_000_000;
  assert.equal(isStale({ acquiredAt: now - 1000 }, now), false);
  assert.equal(isStale({ acquiredAt: now - (DEFAULT_STALE_MS + 1) }, now), true);
});

test("isStale: exactly at the window is reclaimable", () => {
  const now = 10_000_000;
  assert.equal(isStale({ acquiredAt: now - DEFAULT_STALE_MS }, now), true);
});

test("isStale: malformed acquiredAt is treated as stale (fail open)", () => {
  const now = 10_000_000;
  assert.equal(isStale({ acquiredAt: NaN }, now), true);
  // @ts-expect-error deliberately wrong type
  assert.equal(isStale({ acquiredAt: "nope" }, now), true);
  // @ts-expect-error missing field
  assert.equal(isStale({}, now), true);
});

test("isStale: custom window honored", () => {
  const now = 10_000_000;
  assert.equal(isStale({ acquiredAt: now - 5000 }, now, 1000), true);
  assert.equal(isStale({ acquiredAt: now - 500 }, now, 1000), false);
});

// ---- decide: the safety contract ------------------------------------------

test("decide: mode=off always allows with no action", () => {
  const o = decide({ existing: foreignLock(), self: SELF, mode: "off", now: Date.now() });
  assert.equal(o.verdict, "allow");
  assert.equal(o.action, "none");
});

test("decide: no existing lock -> acquire + allow", () => {
  const o = decide({ existing: null, self: SELF, mode: "strict", now: Date.now() });
  assert.equal(o.action, "acquire");
  assert.equal(o.verdict, "allow");
});

test("decide: own lock -> allow (action none), even in strict", () => {
  const own = foreignLock({ worktree: SELF.worktree, session: SELF.session });
  const o = decide({ existing: own, self: SELF, mode: "strict", now: Date.now() });
  assert.equal(o.verdict, "allow");
  assert.equal(o.action, "none");
});

test("decide: foreign + STALE lock is reclaimed and allowed (no permanent brick)", () => {
  const now = Date.now();
  const stale = foreignLock({ acquiredAt: now - (DEFAULT_STALE_MS + 60_000) });
  const o = decide({ existing: stale, self: SELF, mode: "strict", now });
  assert.equal(o.action, "acquire");
  assert.equal(o.verdict, "allow");
});

test("decide: foreign + live + advisory -> WARN but ALLOW (default never blocks)", () => {
  const o = decide({ existing: foreignLock(), self: SELF, mode: "advisory", now: Date.now() });
  assert.equal(o.action, "warn");
  assert.equal(o.verdict, "allow");
  assert.match(o.reason, /advisory/i);
});

test("decide: foreign + live + strict -> BLOCK (opt-in only)", () => {
  const o = decide({ existing: foreignLock(), self: SELF, mode: "strict", now: Date.now() });
  assert.equal(o.action, "block");
  assert.equal(o.verdict, "block");
  assert.match(o.reason, /--force/); // tells the user how to clear it
});

test("decide: corrupt lock (parsed to null) fails open by acquiring", () => {
  // parseLockFile returns null on corruption; decide then sees no lock.
  const existing = parseLockFile("{not valid json");
  assert.equal(existing, null);
  const o = decide({ existing, self: SELF, mode: "strict", now: Date.now() });
  assert.equal(o.verdict, "allow");
  assert.equal(o.action, "acquire");
});

// ---- parseLockFile ---------------------------------------------------------

test("parseLockFile returns null for empty/garbage/incomplete records", () => {
  assert.equal(parseLockFile(null), null);
  assert.equal(parseLockFile(""), null);
  assert.equal(parseLockFile("not json"), null);
  assert.equal(parseLockFile("123"), null);
  assert.equal(parseLockFile(JSON.stringify({ branch: "x" })), null); // missing fields
});

test("parseLockFile round-trips a valid record", () => {
  const rec = makeLockRecord(SELF, 1234);
  const parsed = parseLockFile(JSON.stringify(rec));
  assert.deepEqual(parsed, rec);
});

// ---- lockFileName ----------------------------------------------------------

test("lockFileName sanitizes slashes so feature branches don't nest dirs", () => {
  assert.equal(lockFileName("feat/worktree-mutex-lock"), "feat_worktree-mutex-lock.lock.json");
  assert.equal(lockFileName(""), "DETACHED.lock.json");
  assert.match(lockFileName("a/b\\c:d"), /^a_b_c_d\.lock\.json$/);
});
