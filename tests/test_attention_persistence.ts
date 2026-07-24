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

/** A durable pane row (mirrors tests/test_boot_recovery_summary.ts paneRow) — `alive:true` seeds a
 *  pane that was RUNNING before the "restart", so the constructor's announceBootRecovery fires. */
function paneRow(id: string, workspaceId: string, alive: boolean): StoredPane {
  return {
    pane_id: id, workspace_id: workspaceId, name: id, runtime_type: "interactive_cli",
    tool_preset: "Claude Code", permissions_mode: "Human-in-the-Loop", session_id: "",
    last_known_state: alive ? "Running" : "Exited", is_busy: alive, alive, context_size: 0,
    last_status_change_at: null, last_command: null, scrollback_path: null,
    created_at: 0, updated_at: 0,
  };
}

// ── observe-pipeline harness (mirrors tests/test_observe_pipeline.ts makeFakeManager/makeDeps) ───────
// A throwaway manager exposing only the surface attachObserve reads on the error-transition path, PLUS
// a `pushAttention` SPY. This lets us pin that a REAL observe push site routes its attention through
// `manager.pushAttention` (the required single seam) rather than the raw `manager.attentionQueue.push`
// it uses today — without spinning up a PTY-backed terminal (campaign rule: no live processes).
function makeObserveManagerWithSpy(): {
  manager: OrchestratorManager;
  attentionQueue: AttentionItem[];
  pushed: AttentionItem[];
} {
  const attentionQueue: AttentionItem[] = [];
  const pushed: AttentionItem[] = [];
  const manager = {
    terminals: { p1: { status: "Running", runtimeType: "shell", lastCommand: "" } },
    attentionQueue,
    // The seam under construction. Recording-and-appending so the fixed observe path (which calls
    // manager.pushAttention) both routes through here AND still lands the item in the queue the
    // trailing broadcast reads. The UNFIXED observe path calls attentionQueue.push directly and never
    // touches this — so `pushed` stays empty (the RED signal).
    pushAttention: (item: AttentionItem) => { pushed.push(item); attentionQueue.push(item); },
    settings: { secrets: {} },
    ledger: { watchRules: [] as any[], plans: [] as any[], activeProjectId: "proj_test", save: () => {} },
  } as unknown as OrchestratorManager;
  return { manager, attentionQueue, pushed };
}

function makeObserveDeps(broadcast: (msg: any) => void) {
  return {
    broadcast,
    announcementBus: new AnnouncementBus({ broadcast: () => {}, getTemplates: () => DEFAULT_ANNOUNCEMENT_TEMPLATES }),
    paneSignalBus: new PaneSignalBus(0),
    pruneAttention: () => {},
    interactionLog: new InteractionLogger({ sink: () => {} }),
    getLastInteractionId: () => null,
    setLastInteractionId: (_v: string | null) => {},
    redact: (s: string) => s,
    historyManager: { loadHistory: () => [], saveHistory: () => {}, appendOutputToLastCommand: () => {} },
    ai: {} as any,
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

  // ── DESIGN-INTEGRITY: the six existing push sites must ROUTE THROUGH the seam (not just exist) ─────
  // Tests (a) prove `pushAttention` itself dual-writes, but an implementer could add the method and
  // leave the six real push sites (src/observe/index.ts:397/670/720/767/844 + src/terminal.ts:1651)
  // still doing the raw `manager.attentionQueue.push({...})` — the tests above would all pass while the
  // ACTUAL BUG (observation-derived alerts don't persist) stays unfixed. These two tests pin that at
  // least one REAL push site per category actually flows through the seam.

  it("(design-integrity) a REAL push site — announceBootRecovery (terminal.ts:1651) — persists durably via the seam", () => {
    // Uses the REAL manager + REAL store end to end (no fakes). The constructor's reconcilePanesInert →
    // announceBootRecovery pushes ONE 'idle' boot-recovery item. If that site still does the raw array
    // push, NOTHING lands in the durable table (RED today); once it is rewritten to this.pushAttention
    // (design §7.2), the item write-throughs — observable on the same store.
    const { dir, prev } = mkcwd("boot-persist");
    const store = new JanusStore(":memory:"); store.init();
    store.addProject("proj1", dir, "test project");
    store.switchContext("proj1");
    store.savePane(paneRow("p1", "proj1", true)); // was live before the "restart"
    try {
      const manager = new OrchestratorManager({ ledger: store });

      // In-memory side already worked pre-fix — this is the control that the push fired at all.
      assert.ok(manager.attentionQueue.some((i) => /before this restart/.test(i.message)),
        "announceBootRecovery pushed its boot-recovery item into the in-memory queue");

      // The load-bearing assertion: the SAME push must have written through durably. A raw
      // attentionQueue.push at :1651 leaves this table EMPTY.
      const rows = store.getAttention({ includeDismissed: false });
      const recovery = rows.filter((r) => /before this restart/.test(r.message));
      assert.equal(recovery.length, 1,
        "the boot-recovery push persisted durably — proves terminal.ts:1651 routes through the pushAttention seam, not the raw array (an implementer cannot leave this site unwired)");
      assert.equal(recovery[0].type, "idle", "boot-recovery item keeps its 'idle' type through the mapping");
      assert.equal(recovery[0].project_id, "proj1", "projectId → project_id maps on the real-site write");
    } finally {
      store.close();
      restore(prev, dir);
    }
  });

  it("(design-integrity) a REAL observe push site — emitHighSeverityTransition (observe/index.ts:844) — routes through manager.pushAttention", () => {
    // Drive an error chunk through the real observe pipeline (attachObserve). Today the failure
    // escalation does `manager.attentionQueue.push({...}); pruneAttention()`; the fix rewrites it to
    // `manager.pushAttention({...})` (design §7.3). We assert the seam SPY caught it — so an implementer
    // who wires terminal.ts:1651 (test above) but forgets the observe sites is still caught RED here.
    const frames: any[] = [];
    const { manager, attentionQueue, pushed } = makeObserveManagerWithSpy();
    const deps = makeObserveDeps((msg) => frames.push(msg));
    try {
      const { onOutput } = attachObserve(manager, deps) as { onOutput: (id: string, chunk: string) => void };

      onOutput("p1", "Error: something exploded\n"); // classifies + detects an `error` transition edge

      // Sanity: the failure escalation fired at all (mirrors test_observe_pipeline's anchor).
      assert.ok(frames.some((f) => f.type === "attention_updated"),
        "the error transition reached emitHighSeverityTransition (attention_updated broadcast)");

      // Load-bearing: it must have gone THROUGH the seam, not the raw array push.
      assert.equal(pushed.length, 1,
        "the observe failure push routed through manager.pushAttention (observe/index.ts:844 is wired to the seam, not the raw attentionQueue.push)");
      assert.equal(pushed[0].type, "error", "the faithfully-forwarded failure item reaches the seam");
      assert.equal(pushed[0].terminalId, "p1", "the item names the erroring pane");
      assert.equal(attentionQueue.filter((i) => i.type === "error").length, 1,
        "no double-push: the item lands exactly once (seam OR raw array, not both)");
    } finally {
      deps.announcementBus.stop(); // deterministic teardown of the coalesce/earcon timer
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

  // ── (c/end-to-end) DISMISS survives a RESTART: a row dismissed through the manager does NOT resurrect ─
  // Stitches (a)+(b)+(c): push + dismiss through the REAL manager seams on a temp-FILE store, close,
  // reopen a fresh store + fresh manager on the SAME path. Directly catches the "dismiss flips the
  // in-memory flag but never writes through to the store" fake — that fake would leave the durable row
  // un-dismissed, so it would RESURRECT into the rehydrated queue on restart.
  it("(c) an item dismissed via manager.dismissAttention stays dismissed across a restart — it is NOT rehydrated (dismiss wrote THROUGH to the store)", () => {
    const { dir, prev } = mkcwd("resurrect");
    const dbPath = path.join(dir, ".janus.db");
    try {
      // ── boot 1: push + dismiss through the real seams, then "restart" (close). ──
      {
        const s1 = new JanusStore(dbPath); s1.init();
        const m1 = new OrchestratorManager({ ledger: s1 });
        const push = (m1 as unknown as { pushAttention?: (i: AttentionItem) => void }).pushAttention;
        assert.equal(typeof push, "function", "manager.pushAttention seam must exist");
        push!.call(m1, mkItem("att_resurrect", { message: "flapping build" }));
        const dismiss = (m1 as unknown as { dismissAttention?: (id: string) => void }).dismissAttention;
        assert.equal(typeof dismiss, "function", "manager.dismissAttention seam must exist");
        dismiss!.call(m1, "att_resurrect");
        s1.close();
      }

      // ── boot 2: fresh store + fresh manager on the SAME db. ──
      const s2 = new JanusStore(dbPath); s2.init();
      try {
        const m2 = new OrchestratorManager({ ledger: s2 });
        assert.ok(!m2.attentionQueue.some((i) => i.id === "att_resurrect"),
          "the dismissed item does NOT resurrect after restart — dismissAttention wrote through durably, so hydration (includeDismissed:false) skips it");
        assert.equal(s2.getAttention({ includeDismissed: true }).filter((r) => r.id === "att_resurrect").length, 1,
          "the row still EXISTS durably as dismissed (dismiss ≠ delete — audit read still sees it)");
        assert.equal(s2.getAttention({ includeDismissed: false }).filter((r) => r.id === "att_resurrect").length, 0,
          "and it is filtered from the un-dismissed view");
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
      const hour = 3_600_000;
      const min = 60_000;
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
      // MINUTE-SCALE discriminator: an active alert 2h old is FAR past the 10-min attention TTL yet
      // FAR within the 30-day generic default. A fake that reuses ttlCutoffMs's 30-day default (or any
      // day-scale sibling TTL) would KEEP this row — so it pins that attention has its OWN minute-scale
      // TTL (design §6), not the borrowed day-scale one.
      store.upsertAttention({
        id: "att_hour", type: "error", terminal_id: "t1", project_id: "p1",
        message: "two hours old", timestamp: now - 2 * hour, dismissed: false, details: null,
      });
      // TWO-TIER discriminator: a DISMISSED row 5 min old is past the ~1-min dismissed TTL → prune,
      // while an ACTIVE row 5 min old is within the ~10-min active TTL → survive. Pins that dismissed
      // rows evict on the SHORTER tier (design §6), catching a fake that uses one TTL for both.
      store.upsertAttention({
        id: "att_dis_5m", type: "error", terminal_id: "t1", project_id: "p1",
        message: "dismissed 5m ago", timestamp: now - 5 * min, dismissed: true, details: null,
      });
      store.upsertAttention({
        id: "att_active_5m", type: "error", terminal_id: "t1", project_id: "p1",
        message: "active 5m ago", timestamp: now - 5 * min, dismissed: false, details: null,
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
      assert.ok(!liveIds.includes("att_hour"),
        "a 2h-old active row is pruned — attention uses its own MINUTE-scale TTL, not the 30-day generic default");
      assert.ok(!liveIds.includes("att_dis_5m"),
        "a 5-min-old DISMISSED row is pruned — dismissed rows evict on the shorter dismissed TTL");
      assert.ok(liveIds.includes("att_active_5m"),
        "a 5-min-old ACTIVE row SURVIVES — the active TTL is minute-scale (~10min) but not as short as the dismissed tier");
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
      const hour = 3_600_000;
      store.upsertAttention({
        id: "att_old", type: "error", terminal_id: "t1", project_id: "p1",
        message: "ancient", timestamp: now - 100 * day, dismissed: false, details: null,
      });
      // MINUTE-SCALE discriminator (see the boot-prune test): 2h old is past the 10-min attention TTL
      // but within the 30-day generic default — a fake that reuses the day-scale default keeps it.
      store.upsertAttention({
        id: "att_hour", type: "error", terminal_id: "t1", project_id: "p1",
        message: "two hours old", timestamp: now - 2 * hour, dismissed: false, details: null,
      });
      store.upsertAttention({
        id: "att_fresh", type: "error", terminal_id: "t1", project_id: "p1",
        message: "fresh", timestamp: now - 1000, dismissed: false, details: null,
      });

      const res = store.sweepMaintenance({ now, eventsTtlDays: 30, archiveTtlDays: 14 });

      const liveIds = store.getAttention({ includeDismissed: true }).map((r) => r.id);
      assert.ok(!liveIds.includes("att_old"),
        "the periodic sweep prunes attention rows past the TTL (pruneIncremental covers the attention table)");
      assert.ok(!liveIds.includes("att_hour"),
        "the sweep prunes a 2h-old active row — attention uses its own minute-scale TTL, not the 30-day generic default");
      assert.ok(liveIds.includes("att_fresh"), "the fresh attention row survives the sweep");
      assert.ok("attention" in res.deleted,
        "the sweep result reports an `attention` category (the table is now part of the retention model)");
    } finally {
      store.close();
      restore(prev, dir);
    }
  });
});
