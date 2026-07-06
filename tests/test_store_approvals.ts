// tests/test_store_approvals.ts
import { test } from "node:test";
import assert from "node:assert";
import { JanusStore } from "../src/store/sqliteStore";
import type { StoredPendingApproval } from "../src/store/types";

function mkApproval(id: string): StoredPendingApproval {
  return { id, session_id:"s1", workspace_id:"p1", pane_id:"t1", command:"npm test",
    kind:"agent_instruction", rationale:null, claimed:false, timestamp:1, expires_at:9_999_999_999_999 };
}

test("claimApproval succeeds once; a second claim returns false (N-1)", () => {
  const s = new JanusStore(":memory:"); s.init();
  s.insertPendingApproval(mkApproval("a1"));
  assert.equal(s.claimApproval("a1"), true);
  assert.equal(s.claimApproval("a1"), false);
  s.close();
});

test("getPendingApprovals returns only unclaimed; getExpiredApprovals respects now", () => {
  const s = new JanusStore(":memory:"); s.init();
  s.insertPendingApproval({ ...mkApproval("a1"), expires_at: 100 });
  s.insertPendingApproval({ ...mkApproval("a2"), expires_at: 9_999_999_999_999 });
  assert.equal(s.getPendingApprovals("s1").length, 2);
  assert.deepEqual(s.getExpiredApprovals(1000).map(a=>a.id), ["a1"]);
  s.claimApproval("a2");
  assert.equal(s.getPendingApprovals("s1").length, 1);
  s.close();
});

// wsm-e2e-pinned-4s2 (2): expires_at alone has no tiebreak; two rows with an IDENTICAL expires_at
// must still come out in a deterministic order (timestamp ASC, then id ASC as the final tiebreak).
test("getExpiredApprovals: same-expiry rows are deterministically ordered by timestamp then id", () => {
  const s = new JanusStore(":memory:"); s.init();
  const sameExpiry = 5000;
  // Same expires_at, DIFFERENT timestamp — timestamp ASC must win the tie.
  s.insertPendingApproval({ ...mkApproval("z"), timestamp: 300, expires_at: sameExpiry });
  s.insertPendingApproval({ ...mkApproval("a"), timestamp: 100, expires_at: sameExpiry });
  s.insertPendingApproval({ ...mkApproval("m"), timestamp: 200, expires_at: sameExpiry });
  // Same expires_at AND same timestamp — id ASC is the final tiebreak.
  s.insertPendingApproval({ ...mkApproval("y2"), timestamp: 400, expires_at: sameExpiry });
  s.insertPendingApproval({ ...mkApproval("y1"), timestamp: 400, expires_at: sameExpiry });
  const ids = s.getExpiredApprovals(sameExpiry + 1).map(a => a.id);
  assert.deepEqual(ids, ["a", "m", "z", "y1", "y2"]);
  s.close();
});

// wsm-e2e-pinned-4s2 (3): INSERT OR REPLACE previously let a re-add of an existing messageId reset
// claimed=1 -> 0, re-opening an exactly-once row for a second write. The sticky-claimed guard must
// survive a re-insert of the SAME id.
test("insertPendingApproval: re-adding an existing claimed id cannot un-claim it", () => {
  const s = new JanusStore(":memory:"); s.init();
  s.insertPendingApproval(mkApproval("a1"));
  assert.equal(s.claimApproval("a1"), true, "first claim wins");
  // A re-add with claimed:false (e.g. a stray retry/hydration re-insert) must NOT reset claimed.
  s.insertPendingApproval({ ...mkApproval("a1"), claimed: false, command: "rm -rf /tmp/x" });
  assert.equal(s.claimApproval("a1"), false, "row must still read as claimed after the re-add");
  const rows = s.getExpiredApprovals(9_999_999_999_999);
  assert.deepEqual(rows.map(r => r.id), [], "a claimed row is invisible to the unclaimed/expired view");
  s.close();
});

// A re-add of an UNCLAIMED row must still behave as a normal upsert (fields rewrite through).
test("insertPendingApproval: re-adding an unclaimed id still rewrites the other fields", () => {
  const s = new JanusStore(":memory:"); s.init();
  s.insertPendingApproval(mkApproval("a1"));
  s.insertPendingApproval({ ...mkApproval("a1"), command: "npm run build", expires_at: 42 });
  const rows = s.getExpiredApprovals(43);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].command, "npm run build", "unclaimed re-add still rewrites non-claimed fields");
  s.close();
});

test("attention upsert/dismiss survives and filters", () => {
  const s = new JanusStore(":memory:"); s.init();
  s.upsertAttention({ id:"x1", type:"error", terminal_id:"t1", project_id:"p1", message:"boom", timestamp:1, dismissed:false, details:null });
  assert.equal(s.getAttention({ includeDismissed:false }).length, 1);
  s.dismissAttention("x1");
  assert.equal(s.getAttention({ includeDismissed:false }).length, 0);
  assert.equal(s.getAttention({ includeDismissed:true }).length, 1);
  s.close();
});
