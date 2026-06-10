// Phase 4 Track E — Card 4E.3: the DB stops flooding itself + periodic retention.
//
// FINDINGS (verified):
//  (a) savePane unconditionally emitted a PANE_CREATED event (+FTS row) on every call —
//      and listPanes()→syncLedger()→updatePane→savePane runs per voice turn, so the
//      events table grew unbounded with bogus 'created' spam.
//  (b) retention ran ONLY at boot — an always-on server never pruned, and the eventual
//      boot prune was one giant blocking delete.
//  (c) claimed pending_approvals rows were never pruned, and action_log had NO retention.
//
// CONTRACT under test:
//  - savePane/updatePane emit pane_created exactly once per genuine first insert;
//  - pruneIncremental deletes in bounded batches (LIMIT per table per tick) so a sweep
//    can never stall the serving loop, and stays FTS-consistent;
//  - claimed=1 pending_approvals are pruned; unclaimed rows (even expired) are KEPT —
//    the disconnected-clock-pause semantics are deliberate;
//  - action_log gets a TTL (default 30d — safely above the PLM4 replay window, which has
//    no explicit bound in code; 24h is documented as the safe operational window);
//  - bootMaintenance covers the two new categories too;
//  - sweepMaintenance is safe to call on a closed store (the unref'd interval may fire
//    during teardown).

import { test } from "node:test";
import assert from "node:assert";
import { JanusStore } from "../src/store/sqliteStore";
import type { StoredPane } from "../src/store/types";

const NOW = 1_000_000_000_000;
const DAY = 86_400_000;

function mkPane(id: string, name = id): StoredPane {
  return {
    pane_id: id, workspace_id: "p1", name, runtime_type: "shell",
    tool_preset: "Custom", permissions_mode: "Human-in-the-Loop", session_id: "",
    last_known_state: "Idle", is_busy: false, alive: true, context_size: 0,
    last_status_change_at: null, last_command: null, scrollback_path: null,
    created_at: 0, updated_at: 0,
  };
}

function seed(): JanusStore {
  const s = new JanusStore(":memory:"); s.init();
  s.saveWorkspace({ id: "p1", name: "P1", directory: "", summary: "", key_terms: [], created_at: 0, updated_at: 0 });
  return s;
}

function countRows(s: JanusStore, table: string): number {
  return (s.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as any).n as number;
}

// ── (a) savePane event dedup ─────────────────────────────────────────────────

test("repeated savePane of the same pane emits exactly one pane_created event", () => {
  const s = seed();
  const p = mkPane("t1");
  s.savePane(p);
  s.savePane({ ...p, name: "renamed" }); // the per-voice-turn syncLedger path
  s.savePane({ ...p, name: "renamed-again" });

  const created = s.getEvents({ type: "pane_created" });
  assert.strictEqual(created.length, 1, `3 savePane calls for one pane must emit ONE pane_created, got ${created.length}`);
  assert.strictEqual(created[0].pane_id, "t1");

  // The updates themselves still land (dedup is on the EVENT, not the upsert).
  assert.strictEqual(s.getPanes("p1")["t1"].name, "renamed-again");
  s.close();
});

test("a genuinely new pane still emits its own pane_created (audit semantics preserved)", () => {
  const s = seed();
  s.savePane(mkPane("t1"));
  s.savePane(mkPane("t1"));
  s.savePane(mkPane("t2"));
  const created = s.getEvents({ type: "pane_created" });
  assert.deepStrictEqual(created.map(e => e.pane_id).sort(), ["t1", "t2"], "one creation event per distinct pane");
  s.close();
});

test("updatePane (the manager syncLedger seam) rides the same dedup", () => {
  const s = seed();
  const meta = { pane_id: "t9", name: "t9", alive: true, last_known_state: "Idle", is_busy: false } as any;
  s.updatePane("p1", meta, false);
  s.updatePane("p1", { ...meta, is_busy: true }, false);
  s.updatePane("p1", meta, false);
  assert.strictEqual(s.getEvents({ type: "pane_created" }).length, 1);
  s.close();
});

// ── (b) incremental, batched retention ───────────────────────────────────────

test("pruneIncremental deletes events in bounded batches and stays FTS-consistent", async () => {
  const { pruneIncremental } = await import("../src/store/retention");
  const s = new JanusStore(":memory:"); s.init();

  for (let i = 0; i < 25; i++) s.appendEvent({ type: "command_outcome" as any, summary: `ancient ${i}`, ts: NOW - 100 * DAY });
  s.appendEvent({ type: "command_outcome" as any, summary: "fresh", ts: NOW - 1 * DAY });

  const first = pruneIncremental(s.db, { now: NOW, eventsTtlDays: 30, archiveTtlDays: 14, batchLimit: 10 });
  assert.strictEqual(first.deleted.events, 10, "a sweep tick deletes at most batchLimit rows per table");
  assert.strictEqual(first.more, true, "a full batch reports more work remaining");
  assert.strictEqual(countRows(s, "events"), 16, "25+1 rows minus one batch of 10");

  const second = pruneIncremental(s.db, { now: NOW, eventsTtlDays: 30, archiveTtlDays: 14, batchLimit: 10 });
  assert.strictEqual(second.deleted.events, 10);
  const third = pruneIncremental(s.db, { now: NOW, eventsTtlDays: 30, archiveTtlDays: 14, batchLimit: 10 });
  assert.strictEqual(third.deleted.events, 5, "the final partial batch drains the backlog");
  assert.strictEqual(third.more, false, "a partial batch reports the backlog drained");

  const remaining = s.getEvents({});
  assert.strictEqual(remaining.length, 1);
  assert.strictEqual(remaining[0].summary, "fresh");
  // FTS triggers fired for every batched delete.
  assert.strictEqual(s.search("ancient").length, 0, "events_fts stays consistent through batched deletes");
  assert.strictEqual(s.search("fresh").length, 1);
  s.close();
});

test("pruneIncremental: claimed pending_approvals are pruned; unclaimed (even expired) are KEPT", async () => {
  const { pruneIncremental } = await import("../src/store/retention");
  const s = new JanusStore(":memory:"); s.init();

  const base = { session_id: "sess", workspace_id: "p1", pane_id: "t1", command: "x", kind: "agent_instruction" as const, rationale: null };
  // Unclaimed but long-expired: KEPT (disconnected-clock-pause semantics are deliberate).
  s.insertPendingApproval({ ...base, id: "expired-unclaimed", claimed: false, timestamp: NOW - 100 * DAY, expires_at: NOW - 100 * DAY });
  // Claimed leak (crash between claim and delete): pruned.
  s.insertPendingApproval({ ...base, id: "claimed-leak", claimed: false, timestamp: NOW - 1 * DAY, expires_at: NOW + 1 * DAY });
  assert.strictEqual(s.claimApproval("claimed-leak"), true);
  // Live unclaimed: kept.
  s.insertPendingApproval({ ...base, id: "live", claimed: false, timestamp: NOW, expires_at: NOW + 1 * DAY });

  pruneIncremental(s.db, { now: NOW, eventsTtlDays: 30, archiveTtlDays: 14 });

  const ids = (s.db.prepare("SELECT id FROM pending_approvals ORDER BY id").all() as any[]).map(r => r.id);
  assert.deepStrictEqual(ids, ["expired-unclaimed", "live"], "claimed=1 pruned; unclaimed rows (expired or live) untouched");
  s.close();
});

test("pruneIncremental: action_log TTL prunes old rows, keeps recent (TTL ≥ the replay window)", async () => {
  const { pruneIncremental } = await import("../src/store/retention");
  const s = new JanusStore(":memory:"); s.init();

  const ins = s.db.prepare(
    "INSERT INTO action_log(ts,name,capability,result_kind,ms,idempotency_key) VALUES(?,?,?,?,?,?)"
  );
  ins.run(NOW - 40 * DAY, "old_action", "cap", "ok", 1, "key-old");
  ins.run(NOW - 1 * DAY, "recent_action", "cap", "ok", 1, "key-recent");

  pruneIncremental(s.db, { now: NOW, eventsTtlDays: 30, archiveTtlDays: 14, actionLogTtlDays: 30 });

  const names = (s.db.prepare("SELECT name FROM action_log").all() as any[]).map(r => r.name);
  assert.deepStrictEqual(names, ["recent_action"], "rows past the 30d TTL are pruned; recent rows survive");
  // PLM4 replay detection still works for everything inside the TTL (the replay window —
  // 24h documented — is far inside 30d).
  assert.strictEqual(s.hasSucceededIdempotencyKey("key-recent"), true);
  assert.strictEqual(s.hasSucceededIdempotencyKey("key-old"), false);
  s.close();
});

test("pruneIncremental batches the new categories too (LIMIT respected per table)", async () => {
  const { pruneIncremental } = await import("../src/store/retention");
  const s = new JanusStore(":memory:"); s.init();
  const ins = s.db.prepare("INSERT INTO action_log(ts,name,capability,result_kind,ms) VALUES(?,?,?,?,?)");
  for (let i = 0; i < 7; i++) ins.run(NOW - 40 * DAY, `old${i}`, "cap", "ok", 1);

  const r = pruneIncremental(s.db, { now: NOW, eventsTtlDays: 30, archiveTtlDays: 14, actionLogTtlDays: 30, batchLimit: 3 });
  assert.strictEqual(r.deleted.action_log, 3, "action_log deletes are batch-capped");
  assert.strictEqual(r.more, true);
  assert.strictEqual(countRows(s, "action_log"), 4);
  s.close();
});

// ── (c) boot prune covers the new categories; wrapper is teardown-safe ───────

test("bootMaintenance sweeps claimed approvals and expired action_log rows too", () => {
  const s = new JanusStore(":memory:"); s.init();
  const base = { session_id: "sess", workspace_id: "p1", pane_id: "t1", command: "x", kind: "agent_instruction" as const, rationale: null };
  s.insertPendingApproval({ ...base, id: "claimed-boot-leak", claimed: true, timestamp: NOW - DAY, expires_at: NOW + DAY });
  s.insertPendingApproval({ ...base, id: "live", claimed: false, timestamp: NOW, expires_at: NOW + DAY });
  s.db.prepare("INSERT INTO action_log(ts,name,capability,result_kind,ms) VALUES(?,?,?,?,?)").run(NOW - 40 * DAY, "old", "cap", "ok", 1);

  s.bootMaintenance({ now: NOW, eventsTtlDays: 90, archiveTtlDays: 30, scrollbackDirs: [] });

  const ids = (s.db.prepare("SELECT id FROM pending_approvals").all() as any[]).map(r => r.id);
  assert.deepStrictEqual(ids, ["live"], "boot prune reclaims the claimed=1 approval leak");
  assert.strictEqual(countRows(s, "action_log"), 0, "boot prune applies the action_log TTL");
  s.close();
});

test("sweepMaintenance is a safe no-op on a closed store (unref'd interval may fire at teardown)", () => {
  const s = new JanusStore(":memory:"); s.init();
  s.close();
  assert.doesNotThrow(() => {
    (s as any).sweepMaintenance({ now: NOW, eventsTtlDays: 30, archiveTtlDays: 14 });
  });
});
