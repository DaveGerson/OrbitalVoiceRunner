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

// BEAD 1qs: boot-prune the pending_actions table. A crash between claimAction()
// and deletePendingAction() leaks a claimed=1 row; an unconfirmed action past its
// grace window leaks an expired row. Both must be swept on boot. A live, unclaimed,
// unexpired action MUST survive (it's a legitimate boot-hydration survivor).
test("pruneOnBoot sweeps claimed + expired pending_actions, keeps the live one", () => {
  const s = new JanusStore(":memory:"); s.init();
  const now = 1_000_000_000_000;
  const min = 60_000;

  // (a) claimed=1 survivor (mid-resolve crash leak) — must be deleted.
  s.insertPendingAction({
    id: "claimed-leak", capability: "create_pane", summary: "", params: "{}",
    claimed: true, timestamp: now - min, expires_at: now + 100 * min,
  });
  // (b) expired (claimed=0 but well past grace) — must be deleted.
  s.insertPendingAction({
    id: "stale-expired", capability: "create_pane", summary: "", params: "{}",
    claimed: false, timestamp: now - 1000 * min, expires_at: now - 1000 * min,
  });
  // (c) live: claimed=0, NOT expired — must SURVIVE.
  s.insertPendingAction({
    id: "live", capability: "create_pane", summary: "", params: "{}",
    claimed: false, timestamp: now, expires_at: now + 100 * min,
  });

  s.bootMaintenance({ now, eventsTtlDays: 90, archiveTtlDays: 30, scrollbackDirs: [] });

  // getPendingActions only returns claimed=0 survivors; the live row is the sole survivor.
  const survivors = s.getPendingActions().map(a => a.id);
  assert.deepEqual(survivors, ["live"], "only the live unclaimed/unexpired action survives");

  // The claimed=1 leak is invisible to getPendingActions/getExpiredActions (both filter
  // claimed=0), so prove PHYSICAL deletion via the raw row count: 3 inserted, 2 pruned,
  // exactly 1 (the live row) remains.
  assert.equal(s.countPendingActions(), 1, "claimed=1 leak + expired row physically pruned; only live remains");

  // No claimed=0 row is expired as of the prune's `now` (the live row's expiry is in the
  // future; the stale-expired row was deleted).
  assert.equal(s.getExpiredActions(now).length, 0, "no expired unclaimed rows remain at boot time");
  s.close();
});

// Phase 5.5: context_injections TTL — the pre-existing gap the 5.4 security review reported
// (schema v10 telemetry had no retention anywhere). Same 30d default as its v9 join siblings.
const mkInjection = (id: string, ts: number) => ({
  id, ts,
  session_id: null, interaction_id: null, inject_id: null,
  trigger: "session_start" as const,
  active_project_id: null, active_pane_id: null, brief_active_pane_id: null,
  source: "fallback" as const, disposition: "injected" as const,
  skipped_reason: null, source_snapshot_hash: null, brief_hash: null,
  brief_chars: 0, estimated_tokens: 0, elapsed_ms: null, error: null,
});

test("pruneOnBoot sweeps context_injections past the 30d TTL, keeps fresh rows", () => {
  const s = new JanusStore(":memory:"); s.init();
  const now = 1_000_000_000_000;
  const day = 86_400_000;
  s.recordContextInjection(mkInjection("old-inj", now - 100 * day));
  s.recordContextInjection(mkInjection("fresh-inj", now - 1 * day));
  s.bootMaintenance({ now, eventsTtlDays: 90, archiveTtlDays: 30, scrollbackDirs: [] });
  const remaining = s.getContextInjections().map((r) => r.id);
  assert.deepEqual(remaining, ["fresh-inj"], "old telemetry row pruned, fresh kept");
  s.close();
});

test("sweepMaintenance batches context_injections and reports `more` at the batch cap", () => {
  const s = new JanusStore(":memory:"); s.init();
  const now = 1_000_000_000_000;
  const day = 86_400_000;
  for (let i = 0; i < 3; i++) s.recordContextInjection(mkInjection(`inj-${i}`, now - 100 * day));
  const first = s.sweepMaintenance({ now, eventsTtlDays: 90, archiveTtlDays: 30, batchLimit: 1 });
  assert.equal(first.deleted["context_injections"], 1, "one row per tick at batchLimit=1");
  assert.equal(first.more, true, "backlog remains");
  s.sweepMaintenance({ now, eventsTtlDays: 90, archiveTtlDays: 30, batchLimit: 1 });
  s.sweepMaintenance({ now, eventsTtlDays: 90, archiveTtlDays: 30, batchLimit: 1 });
  assert.equal(s.getContextInjections().length, 0, "backlog drains over ticks");
  s.close();
});
