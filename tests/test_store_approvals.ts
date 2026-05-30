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

test("attention upsert/dismiss survives and filters", () => {
  const s = new JanusStore(":memory:"); s.init();
  s.upsertAttention({ id:"x1", type:"error", terminal_id:"t1", project_id:"p1", message:"boom", timestamp:1, dismissed:false, details:null });
  assert.equal(s.getAttention({ includeDismissed:false }).length, 1);
  s.dismissAttention("x1");
  assert.equal(s.getAttention({ includeDismissed:false }).length, 0);
  assert.equal(s.getAttention({ includeDismissed:true }).length, 1);
  s.close();
});
