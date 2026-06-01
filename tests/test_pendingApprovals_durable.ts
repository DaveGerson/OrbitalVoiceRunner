// tests/test_pendingApprovals_durable.ts
//
// WS-M / bead wsm-e2e-pinned-nzt — durable PendingApprovalStore backed by JanusStore (SQLite).
//
// The point of the task: an approval must SURVIVE a process restart / store reopen, while the
// safety-critical N-1 atomic-claim gate (BUG-013: REST + voice double-approve race — exactly ONE
// claim winner may write) is preserved and now backed by the durable SQL claim.
//
// These tests are RED-first against the to-be-built constructor injection + sid mapping. They use a
// TEMP FILE (not ":memory:") so a SECOND JanusStore can reopen the SAME db and see the survivors.

import { test, afterEach } from "node:test";
import assert from "node:assert";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

import { JanusStore } from "../src/store/sqliteStore";
import {
  PendingApprovalStore,
  resolveDecision,
  type PendingApproval,
} from "../src/pendingApprovals";

const TTL = 5 * 60 * 1000;
const tmpDirs: string[] = [];

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "janus-approvals-"));
  tmpDirs.push(dir);
  return join(dir, "approvals.db");
}

afterEach(() => {
  // Clean up every temp DB dir so the suite exits clean under --test-force-exit.
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function mkRecord(id: string, terminalId: string, instruction: string, ts = Date.now()): PendingApproval {
  return { messageId: id, instruction, kind: "agent_instruction", terminalId, callId: id, timestamp: ts };
}

const alive = (_tid: string) => true;

// ---------------------------------------------------------------------------
// DURABILITY: add -> close -> reopen -> still pending & claimable exactly once.
// ---------------------------------------------------------------------------
test("durable: an approval survives a store reopen and stays pending + claimable", () => {
  const path = tmpDbPath();
  const handle = { id: "live-ws-1" };

  const store1 = new JanusStore(path); store1.init();
  const s1 = new PendingApprovalStore(store1);
  s1.add(mkRecord("a1", "pane_a", "run the tests"), handle, { workspaceId: "p1", ttlMs: TTL });
  store1.close();

  // Process "restart": brand new store + brand new PendingApprovalStore over the same file.
  const store2 = new JanusStore(path); store2.init();
  const s2 = new PendingApprovalStore(store2);
  assert.strictEqual(s2.has("a1"), true, "survivor must be visible after reopen (hydrate-on-construct)");

  // It is still pending and claimable exactly once via the durable claim.
  const action = resolveDecision(s2, "a1", "approve", alive);
  assert.strictEqual(action.reason, "approved");
  assert.strictEqual(action.doWrite, true);
  store2.close();
});

// ---------------------------------------------------------------------------
// ATOMIC CLAIM SURVIVES REOPEN: a claimed-but-undeleted row stays claimed=1 across reopen.
// ---------------------------------------------------------------------------
test("durable: a claim survives reopen — the survivor cannot be double-claimed", () => {
  const path = tmpDbPath();
  const handle = { id: "live-ws-2" };

  const store1 = new JanusStore(path); store1.init();
  const s1 = new PendingApprovalStore(store1);
  s1.add(mkRecord("a1", "pane_a", "deploy"), handle, { workspaceId: "p1", ttlMs: TTL });
  // Claim the durable row but do NOT delete it (simulates a crash AFTER claim, BEFORE delete).
  assert.strictEqual(store1.claimApproval("a1"), true);
  store1.close();

  const store2 = new JanusStore(path); store2.init();
  const s2 = new PendingApprovalStore(store2);
  // The durable claim is honored across reopen: re-claiming returns false (no double write).
  assert.strictEqual(s2.claim("a1"), false, "an already-claimed survivor must not be re-claimable");
  store2.close();
});

// ---------------------------------------------------------------------------
// N-1 RACE within ONE process, store-backed: first approve wins, second loses.
// ---------------------------------------------------------------------------
test("durable: N-1 race — two approves on the same id, exactly one writes (store-backed)", () => {
  const path = tmpDbPath();
  const store = new JanusStore(path); store.init();
  const s = new PendingApprovalStore(store);
  s.add(mkRecord("a1", "pane_a", "build"), { id: "h" }, { workspaceId: "p1", ttlMs: TTL });

  const first = resolveDecision(s, "a1", "approve", alive);
  assert.strictEqual(first.reason, "approved");
  assert.strictEqual(first.doWrite, true);
  // Winner deleted the record; a second resolve is a no-op (not_found) — never a 2nd write.
  const second = resolveDecision(s, "a1", "approve", alive);
  assert.strictEqual(second.doWrite, false);
  assert.notStrictEqual(second.reason, "approved");
  store.close();
});

// ---------------------------------------------------------------------------
// EXPIRED SWEEP reads DURABLE rows after reopen.
// ---------------------------------------------------------------------------
test("durable: the expired sweep reads durable rows after reopen and claims+deletes them", () => {
  const path = tmpDbPath();
  const past = 1_000; // timestamp far in the past
  const handle = { id: "live-ws-3" };

  const store1 = new JanusStore(path); store1.init();
  const s1 = new PendingApprovalStore(store1);
  s1.add(mkRecord("a1", "pane_a", "stale", past), handle, { workspaceId: "p1", ttlMs: TTL });
  store1.close();

  const store2 = new JanusStore(path); store2.init();
  const s2 = new PendingApprovalStore(store2);
  const now = past + TTL + 1;
  const expired = s2.expired(TTL, now);
  assert.deepStrictEqual(expired.map((e) => e.messageId), ["a1"], "durable expired sweep must surface the survivor");

  // Resolve-expire claims + deletes it durably.
  const action = resolveDecision(s2, "a1", "expire", alive);
  assert.strictEqual(action.reason, "expired");
  assert.strictEqual(s2.has("a1"), false, "expired survivor is deleted durably");
  store2.close();

  // A fresh reopen sees no rows for the sid.
  const store3 = new JanusStore(path); store3.init();
  const s3 = new PendingApprovalStore(store3);
  assert.strictEqual(s3.has("a1"), false);
  store3.close();
});

// ---------------------------------------------------------------------------
// RATIONALE round-trips through the TEXT column (JSON (de)serialization).
// ---------------------------------------------------------------------------
test("durable: rationale {trigger,summary} round-trips through reopen", () => {
  const path = tmpDbPath();
  const handle = { id: "live-ws-4" };
  const rationale = { trigger: "run the build please", summary: "pane snapshot: idle" };

  const store1 = new JanusStore(path); store1.init();
  const s1 = new PendingApprovalStore(store1);
  s1.add({ ...mkRecord("a1", "pane_a", "build"), rationale }, handle, { workspaceId: "p1", ttlMs: TTL });
  store1.close();

  const store2 = new JanusStore(path); store2.init();
  const s2 = new PendingApprovalStore(store2);
  const rec = s2.get("a1");
  assert.ok(rec, "survivor record present");
  assert.deepStrictEqual(rec!.rationale, rationale, "rationale object must survive JSON round-trip");
  store2.close();
});

// ---------------------------------------------------------------------------
// SESSION_ID MAPPING: distinct handles get distinct sids; forSession is scoped.
// ---------------------------------------------------------------------------
test("durable: distinct handles get distinct durable sessions; forSession is scoped", () => {
  const path = tmpDbPath();
  const store = new JanusStore(path); store.init();
  const s = new PendingApprovalStore(store);
  const hA = { id: "A" }, hB = { id: "B" };
  s.add(mkRecord("a1", "pane_a", "x"), hA, { workspaceId: "p1", ttlMs: TTL });
  s.add(mkRecord("b1", "pane_b", "y"), hB, { workspaceId: "p1", ttlMs: TTL });

  assert.deepStrictEqual(s.forSession(hA).map((r) => r.messageId), ["a1"]);
  assert.deepStrictEqual(s.forSession(hB).map((r) => r.messageId), ["b1"]);
  store.close();
});

// ---------------------------------------------------------------------------
// PURGE is durable: rows are deleted, not just the in-memory mirror.
// ---------------------------------------------------------------------------
test("durable: purgeSession deletes durable rows for that handle", () => {
  const path = tmpDbPath();
  const handle = { id: "live-ws-5" };

  const store1 = new JanusStore(path); store1.init();
  const s1 = new PendingApprovalStore(store1);
  s1.add(mkRecord("a1", "pane_a", "x"), handle, { workspaceId: "p1", ttlMs: TTL });
  s1.add(mkRecord("a2", "pane_a", "y"), handle, { workspaceId: "p1", ttlMs: TTL });
  const purged = s1.purgeSession(handle);
  assert.deepStrictEqual(purged.sort(), ["a1", "a2"]);
  store1.close();

  const store2 = new JanusStore(path); store2.init();
  const s2 = new PendingApprovalStore(store2);
  assert.strictEqual(s2.has("a1"), false, "purged rows must not survive reopen");
  assert.strictEqual(s2.has("a2"), false);
  store2.close();
});

// ---------------------------------------------------------------------------
// LEGACY byte-for-byte: new PendingApprovalStore(null) behaves exactly as today.
// ---------------------------------------------------------------------------
test("legacy: store=null behaves exactly as the in-memory store (regression guard)", () => {
  for (const s of [new PendingApprovalStore(null), new PendingApprovalStore()]) {
    const h1 = { id: "s1" }, h2 = { id: "s2" };
    s.add(mkRecord("a", "p1", "one"), h1);
    s.add(mkRecord("b", "p2", "two"), h2);
    s.add(mkRecord("c", "p3", "three"), h1);
    assert.deepStrictEqual(s.forSession(h1).map((r) => r.messageId), ["a", "c"]);
    assert.strictEqual(s.lastAnnouncedFor(h1), "c");
    assert.strictEqual(s.has("a"), true);
    assert.strictEqual(s.claim("a"), true);
    assert.strictEqual(s.claim("a"), false);
    assert.deepStrictEqual(s.all().map((r) => r.messageId), ["a", "b", "c"]);
    const purged = s.purgeSession(h1);
    assert.deepStrictEqual(purged.sort(), ["a", "c"]);
    assert.strictEqual(s.has("a"), false);
    assert.strictEqual(s.has("b"), true);
  }
});
