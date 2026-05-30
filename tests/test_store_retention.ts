// tests/test_store_retention.ts
import { test } from "node:test";
import assert from "node:assert";
import { JanusStore } from "../src/store/sqliteStore";

test("pruneOnBoot deletes old events + archive, keeps recent, FTS stays consistent", () => {
  const s = new JanusStore(":memory:"); s.init();
  const now = 1_000_000_000_000;
  const day = 86_400_000;
  s.appendEvent({ type:"command_outcome" as any, summary:"ancient", ts: now - 100*day });
  s.appendEvent({ type:"command_outcome" as any, summary:"fresh", ts: now - 1*day });
  s.bootMaintenance({ now, eventsTtlDays: 90, archiveTtlDays: 30, scrollbackDirs: [] });
  const remaining = s.getEvents({});
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].summary, "fresh");
  assert.equal(s.search("ancient").length, 0);
  assert.equal(s.search("fresh").length, 1);
  s.close();
});
