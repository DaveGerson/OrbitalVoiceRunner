// tests/test_attention_persistence.ts
//
// W5 — attentionQueue persistence (BUG-013 residual, P0 #5). TDD RED suite.
//
// THE RESIDUAL (validation verdict E-persistence, BUG-013):
//   pendingApprovals, the resumption token, and the prompt buffer are all durable now. The last
//   volatile island is `manager.attentionQueue` — a plain in-memory array (src/terminal.ts:1337)
//   mutated at six push sites (src/observe/index.ts:397/670/720/767/844 + src/terminal.ts:1651) and
//   flipped-to-dismissed in src/actions/defs/orient.ts:316-317. A DURABLE `attention` table + store
//   methods ALREADY EXIST and round-trip correctly (src/store/sqliteStore.ts:455 upsertAttention,
//   :461 dismissAttention, :463 getAttention — pinned green by tests/test_store_approvals.ts) but
//   have ZERO runtime callers. So on restart every observation-derived alert vanishes, and
//   GET /api/attention (src/actions/defs/reads.ts get_attention_queue → manager.attentionQueue)
//   comes back empty.
//
// REQUIRED POST-FIX BEHAVIOR pinned here (all RED today):
//   (a) A single seam `manager.pushAttention(item)` through which ALL pushes flow: it appends to the
//       in-memory queue (BUG-035 cap/TTL via pruneAttentionQueue PRESERVED) AND writes through to
//       store.upsertAttention with the AttentionItem→StoredAttention mapping.
//   (b) `manager.dismissAttention(id)` / `manager.dismissAllAttention()` flip in-memory AND write
//       through to store.dismissAttention (the orient.ts dismiss + clear paths call these).
//   (c) On construct, the manager HYDRATES attentionQueue from store.getAttention({includeDismissed:
//       false}) — mirroring pendingApprovals.hydrateFromStore — so a restarted server re-reports
//       un-dismissed items over GET /api/attention (which reads manager.attentionQueue verbatim).
//   (d) Durable attention rows participate in the retention sweep (src/store/retention.ts) so they
//       respect a cap/TTL like the in-memory prune (BUG-035), instead of growing unbounded.
//
// Idioms borrowed: tests/test_store_approvals.ts (JanusStore round-trip), tests/test_us_epic06_
// durability.ts (temp-file store REOPEN + hermetic mkcwd + retention seams), tests/test_sync_ledger_
// persist_wins.ts (new OrchestratorManager({ ledger: store })).
//
// Determinism: no timers, no network, no live Gemini. Fresh temp cwd per manager test; fixed
// millisecond timestamps for the store-row assertions.
//
// Runner: npx tsx --test --test-force-exit tests/test_attention_persistence.ts

import { describe, it, before } from "node:test";
import assert from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { JanusStore } from "../src/store/sqliteStore";
import { OrchestratorManager } from "../src/terminal";
import { ATTENTION_QUEUE_CAP, AnnouncementBus, DEFAULT_ANNOUNCEMENT_TEMPLATES } from "../src/announcementBus";
import { attachObserve } from "../src/observe";
import { PaneSignalBus } from "../src/paneSignalBus";
import { InteractionLogger } from "../src/interactionLog";
import type { AttentionItem } from "../src/types";
import type { StoredAttention, StoredPane } from "../src/store/types";

// ── hermetic temp cwd (mirrors test_us_epic06_durability.ts mkcwd/restore) ──────────────────────────
function mkcwd(tag: string): { dir: string; prev: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `janus-w5-${tag}-`));
  const prev = process.cwd();
  process.chdir(dir);
  return { dir, prev };
}
function restore(prev: string, dir: string): void {
  process.chdir(prev);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

/** Build an AttentionItem the way the observe push sites do (ISO timestamp, dismissed:false). */
function mkItem(id: string, over: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id,
    type: "error",
    terminalId: "t1",
    projectId: "p1",
    message: `pane t1 → error (${id})`,
    timestamp: new Date().toISOString(),
    dismissed: false,
    ...over,
  };
}

describe("W5 attentionQueue persistence — BUG-013 residual (RED)", () => {
  before(() => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";
  });

  // ── (a) pushAttention DUAL-WRITES: in-memory append + store.upsertAttention with the mapping ──────
  it("(a) manager.pushAttention appends in-memory AND write-throughs to store.upsertAttention with the AttentionItem→StoredAttention mapping", () => {
    const { dir, prev } = mkcwd("push");
    const store = new JanusStore(":memory:"); store.init();
    try {
      const manager = new OrchestratorManager({ ledger: store });

      const ts = Date.now();
      const item = mkItem("att_push_1", {
        type: "build-failed",
        terminalId: "pane-7",
        projectId: "proj-a",
        message: "build failed on pane-7",
        timestamp: new Date(ts).toISOString(),
        details: { kind: "plan_step_suggestion", planId: "pl1" },
      });

      // The seam under construction. Guarded so the RED reads as a labeled miss, not a bare TypeError.
      const push = (manager as unknown as { pushAttention?: (i: AttentionItem) => void }).pushAttention;
      assert.equal(typeof push, "function",
        "manager.pushAttention seam must exist (single choke-point for all six attention pushes)");
      push!.call(manager, item);

      // 1) in-memory queue got it (server.ts get_attention_queue reads this array verbatim).
      assert.ok(manager.attentionQueue.some((i) => i.id === "att_push_1"),
        "pushAttention appends to the in-memory attentionQueue");

      // 2) write-through to the durable table with the correct field mapping.
      const rows = store.getAttention({ includeDismissed: false });
      const row = rows.find((r) => r.id === "att_push_1");
      assert.ok(row, "pushAttention write-throughs to store.upsertAttention (row is durable)");
      assert.equal(row!.type, "build-failed", "type maps straight through");
      assert.equal(row!.terminal_id, "pane-7", "terminalId → terminal_id");
      assert.equal(row!.project_id, "proj-a", "projectId → project_id");
      assert.equal(row!.message, "build failed on pane-7", "message maps straight through");
      assert.equal(row!.timestamp, ts, "ISO timestamp → epoch-ms number (Date.parse)");
      assert.equal(row!.dismissed, false, "a fresh push is un-dismissed durably");
      assert.deepEqual(row!.details, { kind: "plan_step_suggestion", planId: "pl1" },
        "details JSON round-trips through the durable column");
    } finally {
      store.close();
      restore(prev, dir);
    }
  });

  // ── (a/BUG-035) pushAttention preserves the in-memory cap; durable rows are bounded by RETENTION ──
  it("(a) pushAttention keeps the BUG-035 in-memory cap; the durable table is NOT capped at push time (that is retention's job, test (d))", () => {
    const { dir, prev } = mkcwd("cap");
    const store = new JanusStore(":memory:"); store.init();
    try {
      const manager = new OrchestratorManager({ ledger: store });
      const push = (manager as unknown as { pushAttention?: (i: AttentionItem) => void }).pushAttention;
      assert.equal(typeof push, "function", "manager.pushAttention seam must exist");

      const N = ATTENTION_QUEUE_CAP + 5; // 55 fresh (within TTL) items
      for (let i = 0; i < N; i++) {
        push!.call(manager, mkItem(`att_cap_${i}`, { message: `m${i}` }));
      }

      // BUG-035 (pruneAttentionQueue) still bounds the in-memory queue.
      assert.equal(manager.attentionQueue.length, ATTENTION_QUEUE_CAP,
        `in-memory queue capped at ATTENTION_QUEUE_CAP=${ATTENTION_QUEUE_CAP} (BUG-035 preserved through the seam)`);

      // pushAttention itself does not evict durable rows — the durable cap/TTL is retention's job.
      assert.equal(store.getAttention({ includeDismissed: false }).length, N,
        "every push is persisted; the durable table is bounded by the retention sweep, not by push");
    } finally {
      store.close();
      restore(prev, dir);
    }
  });

  // ── (b) dismissal WRITE-THROUGH: single item + clear-all ──────────────────────────────────────────
  it("(b) manager.dismissAttention(id) flips in-memory AND write-throughs to store.dismissAttention", () => {
    const { dir, prev } = mkcwd("dismiss-one");
    const store = new JanusStore(":memory:"); store.init();
    try {
      const manager = new OrchestratorManager({ ledger: store });

      // Seed one live alert both in-memory and durably (decoupled from pushAttention so this test's
      // RED is specifically the dismissal write-through).
      const item = mkItem("att_dis_1", { terminalId: "t2", projectId: "p2" });
      manager.attentionQueue.push(item);
      store.upsertAttention({
        id: "att_dis_1", type: item.type, terminal_id: "t2", project_id: "p2",
        message: item.message, timestamp: Date.parse(item.timestamp), dismissed: false, details: null,
      });
      assert.equal(store.getAttention({ includeDismissed: false }).length, 1, "precondition: durable row present, un-dismissed");

      const dismiss = (manager as unknown as { dismissAttention?: (id: string) => void }).dismissAttention;
      assert.equal(typeof dismiss, "function",
        "manager.dismissAttention seam must exist (orient.ts dismiss path calls it)");
      dismiss!.call(manager, "att_dis_1");

      assert.equal(manager.attentionQueue.find((i) => i.id === "att_dis_1")?.dismissed, true,
        "in-memory item flipped to dismissed");
      assert.equal(store.getAttention({ includeDismissed: false }).length, 0,
        "durable row is dismissed too (store.dismissAttention was called)");
      assert.equal(store.getAttention({ includeDismissed: true }).length, 1,
        "the row still EXISTS durably, just dismissed (dismiss ≠ delete)");
    } finally {
      store.close();
      restore(prev, dir);
    }
  });

  it("(b) manager.dismissAllAttention() flips every in-memory item AND write-throughs each dismissal to the store", () => {
    const { dir, prev } = mkcwd("dismiss-all");
    const store = new JanusStore(":memory:"); store.init();
    try {
      const manager = new OrchestratorManager({ ledger: store });
      for (const id of ["att_all_1", "att_all_2", "att_all_3"]) {
        const it = mkItem(id);
        manager.attentionQueue.push(it);
        store.upsertAttention({
          id, type: it.type, terminal_id: it.terminalId, project_id: it.projectId,
          message: it.message, timestamp: Date.parse(it.timestamp), dismissed: false, details: null,
        });
      }
      assert.equal(store.getAttention({ includeDismissed: false }).length, 3, "precondition: 3 durable live rows");

      const dismissAll = (manager as unknown as { dismissAllAttention?: () => unknown }).dismissAllAttention;
      assert.equal(typeof dismissAll, "function",
        "manager.dismissAllAttention seam must exist (orient.ts clear/dismiss-all path calls it)");
      dismissAll!.call(manager);

      assert.ok(manager.attentionQueue.every((i) => i.dismissed), "every in-memory item flipped to dismissed");
      assert.equal(store.getAttention({ includeDismissed: false }).length, 0,
        "all durable rows dismissed (each write-through landed)");
      assert.equal(store.getAttention({ includeDismissed: true }).length, 3, "the rows still exist durably");
    } finally {
      store.close();
      restore(prev, dir);
    }
  });

  // ── (c) BOOT HYDRATION: reopen the store, construct a fresh manager → attentionQueue rehydrated ────
  it("(c) a fresh OrchestratorManager hydrates attentionQueue from store.getAttention({includeDismissed:false}) — un-dismissed survives a restart, dismissed is excluded", () => {
    const { dir, prev } = mkcwd("hydrate");
    const dbPath = path.join(dir, ".janus.db");
    try {
      const survivorTs = 1_700_000_000_000; // fixed epoch-ms for an exact reverse-map assertion
      // ── boot 1: seed the durable attention table, then "restart" (close). ──
      {
        const s1 = new JanusStore(dbPath); s1.init();
        s1.upsertAttention({
          id: "att_live", type: "exited", terminal_id: "pane-9", project_id: "proj-z",
          message: "pane-9 exited", timestamp: survivorTs, dismissed: false, details: { code: 1 },
        });
        s1.upsertAttention({
          id: "att_gone", type: "error", terminal_id: "pane-9", project_id: "proj-z",
          message: "already handled", timestamp: survivorTs, dismissed: true, details: null,
        });
        s1.close();
      }

      // ── boot 2: a fresh store + a fresh manager on the SAME db. ──
      const s2 = new JanusStore(dbPath); s2.init();
      try {
        const manager = new OrchestratorManager({ ledger: s2 });

        const ids = manager.attentionQueue.map((i) => i.id);
        assert.ok(ids.includes("att_live"),
          "the un-dismissed durable alert is hydrated into attentionQueue on boot (survives restart)");
        assert.ok(!ids.includes("att_gone"),
          "a dismissed durable row is NOT hydrated (getAttention includeDismissed:false)");

        // Reverse mapping StoredAttention→AttentionItem is faithful.
        const rehydrated = manager.attentionQueue.find((i) => i.id === "att_live")!;
        assert.equal(rehydrated.terminalId, "pane-9", "terminal_id → terminalId");
        assert.equal(rehydrated.projectId, "proj-z", "project_id → projectId");
        assert.equal(rehydrated.type, "exited", "type maps straight back");
        assert.equal(rehydrated.dismissed, false, "hydrated survivor is un-dismissed");
        assert.equal(Date.parse(rehydrated.timestamp), survivorTs, "epoch-ms number → ISO timestamp (round-trips)");
        assert.deepEqual(rehydrated.details, { code: 1 }, "details JSON round-trips back");
      } finally {
        s2.close();
      }
    } finally {
      restore(prev, dir);
    }
  });

  // ── (d) RETENTION: durable attention rows are pruned by TTL on boot + incremental sweep ───────────
  it("(d) the retention boot prune drops durable attention rows past the attention TTL and keeps fresh ones", () => {
    const { dir, prev } = mkcwd("retention-boot");
    const store = new JanusStore(":memory:"); store.init();
    try {
      const now = 1_700_000_000_000;
      const day = 86_400_000;
      // Old ACTIVE alert (100 days > any reasonable attention TTL, e.g. ATTENTION_TTL_MS=10min) → prune.
      store.upsertAttention({
        id: "att_old", type: "error", terminal_id: "t1", project_id: "p1",
        message: "ancient alert", timestamp: now - 100 * day, dismissed: false, details: null,
      });
      // Old DISMISSED alert → prune (dismissed rows have an even shorter TTL).
      store.upsertAttention({
        id: "att_old_dis", type: "error", terminal_id: "t1", project_id: "p1",
        message: "ancient dismissed", timestamp: now - 100 * day, dismissed: true, details: null,
      });
      // Fresh ACTIVE alert (1s old, well within any attention TTL) → survive.
      store.upsertAttention({
        id: "att_fresh", type: "error", terminal_id: "t1", project_id: "p1",
        message: "just now", timestamp: now - 1000, dismissed: false, details: null,
      });

      store.bootMaintenance({ now, eventsTtlDays: 30, archiveTtlDays: 14, scrollbackDirs: [dir] });

      const live: StoredAttention[] = store.getAttention({ includeDismissed: true });
      const liveIds = live.map((r) => r.id);
      assert.ok(!liveIds.includes("att_old"),
        "an active attention row past the attention TTL is pruned by bootMaintenance (retention now covers the attention table)");
      assert.ok(!liveIds.includes("att_old_dis"), "an old dismissed attention row is pruned too");
      assert.ok(liveIds.includes("att_fresh"), "a fresh attention row survives the boot prune");
    } finally {
      store.close();
      restore(prev, dir);
    }
  });

  it("(d) the incremental retention sweep also prunes durable attention rows past the TTL", () => {
    const { dir, prev } = mkcwd("retention-sweep");
    const store = new JanusStore(":memory:"); store.init();
    try {
      const now = 1_700_000_000_000;
      const day = 86_400_000;
      store.upsertAttention({
        id: "att_old", type: "error", terminal_id: "t1", project_id: "p1",
        message: "ancient", timestamp: now - 100 * day, dismissed: false, details: null,
      });
      store.upsertAttention({
        id: "att_fresh", type: "error", terminal_id: "t1", project_id: "p1",
        message: "fresh", timestamp: now - 1000, dismissed: false, details: null,
      });

      const res = store.sweepMaintenance({ now, eventsTtlDays: 30, archiveTtlDays: 14 });

      const liveIds = store.getAttention({ includeDismissed: true }).map((r) => r.id);
      assert.ok(!liveIds.includes("att_old"),
        "the periodic sweep prunes attention rows past the TTL (pruneIncremental covers the attention table)");
      assert.ok(liveIds.includes("att_fresh"), "the fresh attention row survives the sweep");
      assert.ok("attention" in res.deleted,
        "the sweep result reports an `attention` category (the table is now part of the retention model)");
    } finally {
      store.close();
      restore(prev, dir);
    }
  });
});
