/**
 * tests/test_exchange_integration_battery.ts — AgentExchange spine, Phase 1 Step 1.5: the
 * INTEGRATION battery (spec docs/superpowers/specs/2026-07-09-agent-exchange-spine.md).
 *
 * This suite sits ON TOP OF the already-landed unit/store/correlation suites
 * (test_exchange_lifecycle.ts, test_exchange_correlation.ts, test_exchange_approval_version.ts,
 * test_exchange_store.ts, test_exchange_recovery.ts, test_dispatch_join_exchange.ts) — it does not
 * re-test the pure state machine or the storage CRUD/CAS contract in isolation. It drives FULL
 * JOURNEYS across a REAL JanusStore (a real SQLite file for the two restart scenarios) and asserts
 * DURABLE state — the exchange row, its event timeline, the bound pending-approval row, and
 * dispatch-join member state — at every step, not just an in-memory snapshot or an output string.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * CRITICAL FINDING (reported prominently per the test-engineer brief — NOT fixed here, no
 * production code was touched by this pass):
 *
 * The ExchangeService <-> SQLite persistence bridge described throughout the spec (§2, §4, §6) is
 * NOT WIRED in production. src/exchanges/spine.ts says so explicitly in its own module doc: "It
 * does NOT yet dual-write to the agent_exchanges / exchange_events SQLite tables that landed in
 * step 1.2 ... that persistence bridge ... was deliberately deferred rather than rushed." Verified
 * by grep across the whole src/ tree: EVERY live call site that touches exchanges
 * (src/gating/index.ts, src/dispatch/paneWrite.ts, src/observe/index.ts, src/voice/index.ts) goes
 * through the in-memory `getExchangeService()` singleton ONLY. Not one of them calls
 * `store.insertExchange` / `store.updateExchange` / `store.appendExchangeEvent`. The ONLY
 * production code that touches the durable `agent_exchanges` table at all is
 * `src/exchanges/recovery.ts`'s `recoverExchangesOnBoot` — and grep finds ZERO call sites for that
 * function outside its own test file (tests/test_exchange_recovery.ts). Nothing in server.ts's
 * boot sequence invokes it.
 *
 * Net effect: **a real process restart today loses 100% of in-flight exchange state, silently.**
 * `agent_exchanges` never has any rows in it in production (nothing ever inserts them), so even if
 * boot recovery WERE wired up, it would find nothing to quarantine. There is no `exchange_recovered`
 * event, no quarantine, no attention-item surfacing — despite spec §4 ("Restart behavior: durable
 * state, recovery, quarantine") describing exactly that behavior as the whole point of the schema.
 * This is the exact failure mode §4's hard rules are written to prevent, and it is currently
 * un-prevented for the ONLY mode (`primary`) where it would matter operationally.
 *
 * Per the task brief ("if you find a real product bug, do NOT fix it — write the failing test,
 * mark it with test.todo ... and report it prominently"): see the `it.todo(...)` at the bottom of
 * this file titled "BUG-shaped gap: production journeys never persist". This is also why every
 * scenario below that needs "durable state" uses `ExchangeHarness` (defined next) instead of the
 * real `getExchangeService()` singleton for the store-writing half of each step — there IS no real
 * seam that does both today. `ExchangeHarness` is the closest real seam available without doing
 * production-code work: every store call it makes is a real, unmodified `JanusStore` method (the
 * exact ones `src/exchanges/recovery.ts` already uses), applied in lockstep with the REAL
 * `ExchangeService`'s in-memory transition. If the in-memory transition is illegal, no store write
 * happens — mirroring spec §9.6 ("a spine outage must never block or loosen a write decision") in
 * reverse: a refused in-memory transition must never leave a lying durable record either.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Runner: npx tsx --test --test-force-exit tests/test_exchange_integration_battery.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { JanusStore } from "../src/store/sqliteStore";
import { ExchangeService, type PaneSignalKind, type SettleOutcome } from "../src/exchanges/service";
import type { ExchangeSnapshot, ExchangeState, LifecycleResult } from "../src/exchanges/lifecycle";
import type { ExchangeEventType } from "../src/exchanges/types";
import { recoverExchangesOnBoot } from "../src/exchanges/recovery";
import { DispatchJoinTracker } from "../src/dispatch/joinTracker";
import { PendingApprovalStore } from "../src/pendingApprovals";
import { exchangeSpineActive } from "../src/exchanges/spine";
import { readExchangeSpineMode, exchangeSpineWrites } from "../src/exchanges/flag";

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────

function freshStore(dbPath: string = ":memory:"): JanusStore {
  const s = new JanusStore(dbPath);
  s.init();
  return s;
}

function tempDbPath(label: string): string {
  return path.join(os.tmpdir(), `exchange-battery-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

function cleanupDbFile(p: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try { fs.unlinkSync(p + suffix); } catch { /* best-effort cleanup, file may never have existed */ }
  }
}

// ── ExchangeHarness — see the file-header CRITICAL FINDING for why this exists ────────────────────

const SIGNAL_EVENT: Partial<Record<PaneSignalKind, ExchangeEventType>> = {
  running: "terminal_running",
  idle: "terminal_idle",
  prompt: "needs_input_detected",
  error: "agent_failure_reported",
  exited: "agent_failure_reported",
  // quiescing intentionally omitted: advisory-only, spec §1.4 — never a store event either.
};

/**
 * Drives a REAL `ExchangeService` for every lifecycle/correlation decision, and mirrors each
 * resulting transition into a REAL `JanusStore` via the store's own unmodified CAS/event APIs.
 * See the file-header CRITICAL FINDING for why this is necessary (no production bridge exists) and
 * why this is the "closest real seam" rather than new production logic: every store call is an
 * ordinary `updateExchange`/`appendExchangeEvent` call, gated on the in-memory result.
 */
class ExchangeHarness {
  readonly svc: ExchangeService;
  private readonly store: JanusStore;
  private readonly projectId: string;

  constructor(store: JanusStore, opts?: { projectId?: string }) {
    this.store = store;
    this.svc = new ExchangeService();
    this.projectId = opts?.projectId ?? "proj-1";
  }

  create(paneId: string, utterance: string, instruction: string): string {
    const snap = this.svc.createExchange({
      projectId: this.projectId, paneId, operatorUtterance: utterance, distilledInstruction: instruction,
    });
    this.store.insertExchange({
      exchange_id: snap.exchangeId, project_id: this.projectId, pane_id: paneId,
      operator_utterance: utterance, distilled_instruction: instruction,
      created_at: snap.createdAt, updated_at: snap.updatedAt,
    });
    this.store.appendExchangeEvent({
      exchange_id: snap.exchangeId, event_type: "exchange_created",
      pane_id: paneId, project_id: this.projectId, ts: snap.createdAt,
    });
    return snap.exchangeId;
  }

  /** Persist one in-memory transition. No-op (no store write at all) when the in-memory transition
   *  was refused — a refused transition must never produce a durable record either. */
  private mirror(
    id: string, before: ExchangeSnapshot, result: LifecycleResult, eventType: ExchangeEventType,
    opts?: { gateApproval?: boolean; payload?: Record<string, unknown> },
  ): boolean {
    if (!result.ok) return false;
    const after = result.snapshot;
    const cas: { state: ExchangeState; approvalId?: string | null; approvalDraftVersion?: number | null } = { state: before.state };
    if (opts?.gateApproval) { cas.approvalId = before.approvalId; cas.approvalDraftVersion = before.approvalDraftVersion; }
    const res = this.store.updateExchange(id, {
      state: after.state,
      draft_version: after.draftVersion,
      approval_id: after.approvalId,
      approval_draft_version: after.approvalDraftVersion,
      delivery_attempt: after.deliveryAttempt,
      delivered_at: after.deliveredAt,
      completed_at: after.completedAt,
      result_summary: after.resultSummary,
      terminal_state: after.terminalState,
      distilled_instruction: after.distilledInstruction,
      updated_at: after.updatedAt,
    }, cas);
    assert.ok(res.changed, `harness/production drift: store CAS lost for ${eventType} on ${id} even though the in-memory transition succeeded`);
    this.store.appendExchangeEvent({
      exchange_id: id, event_type: eventType,
      pane_id: after.paneId, project_id: after.projectId,
      payload_redacted_json: JSON.stringify(opts?.payload ?? {}),
      ts: after.updatedAt,
    });
    return true;
  }

  requestApproval(id: string, approvalId: string): LifecycleResult {
    const before = this.svc.get(id)!;
    const r = this.svc.requestApproval(id, approvalId);
    this.mirror(id, before, r, "approval_requested", { payload: { approval_id: approvalId } });
    return r;
  }

  confirmApproval(id: string, approvalId: string, draftVersion: number): LifecycleResult {
    const before = this.svc.get(id)!;
    const r = this.svc.confirmApproval(id, approvalId, draftVersion);
    this.mirror(id, before, r, "approval_confirmed", { gateApproval: true, payload: { approval_id: approvalId, draft_version: draftVersion } });
    return r;
  }

  reviseDraft(id: string, instruction: string): LifecycleResult {
    const before = this.svc.get(id)!;
    const r = this.svc.reviseDraft(id, instruction);
    this.mirror(id, before, r, "draft_revised", { payload: { superseded_approval_id: before.approvalId } });
    return r;
  }

  beginDeliveryAttempt(id: string): LifecycleResult {
    const before = this.svc.get(id)!;
    const r = this.svc.beginDeliveryAttempt(id);
    this.mirror(id, before, r, "delivery_attempted");
    return r;
  }

  completeDelivery(id: string): LifecycleResult {
    const before = this.svc.get(id)!;
    const r = this.svc.completeDelivery(id);
    this.mirror(id, before, r, "delivery_succeeded");
    return r;
  }

  failDelivery(id: string, detail: string): LifecycleResult {
    const before = this.svc.get(id)!;
    const r = this.svc.failDelivery(id, detail);
    this.mirror(id, before, r, "delivery_failed", { payload: { detail } });
    return r;
  }

  onPaneSignal(paneId: string, kind: PaneSignalKind, detail?: string): SettleOutcome[] {
    const activeId = this.svc.activeExchangeForPane(paneId);
    const before = activeId ? this.svc.get(activeId) : undefined;
    const settled = this.svc.onPaneSignal({ paneId, kind, detail });
    if (before && activeId && settled.some((s) => s.exchangeId === activeId)) {
      const eventType = SIGNAL_EVENT[kind];
      if (eventType) {
        const after = this.svc.get(activeId)!;
        this.mirror(activeId, before, { ok: true, snapshot: after }, eventType, detail ? { payload: { detail } } : undefined);
      }
    }
    return settled;
  }

  cancel(id: string, reason?: string): LifecycleResult {
    const before = this.svc.get(id)!;
    const r = this.svc.cancel(id, reason);
    this.mirror(id, before, r, "exchange_cancelled", reason ? { payload: { reason } } : undefined);
    return r;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 1. Two staged exchanges on one pane, only one approved.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("scenario 1: two exchanges on one pane, only one approved", () => {
  it("the approved exchange delivers/settles fully; the other stays awaiting_approval, untouched, in the store AND the dispatch-join tracker", () => {
    const store = freshStore();
    const h = new ExchangeHarness(store);
    const tracker = new DispatchJoinTracker();

    const a = h.create("pane-1", "please run the tests", "run the unit test suite");
    const b = h.create("pane-1", "also run the linter", "run the linter");
    const group = tracker.create("two-writes", "two writes on pane-1", ["pane-1", "pane-1"]);

    h.requestApproval(a, "appr-a");
    h.requestApproval(b, "appr-b");
    tracker.recordOutcomeAt(group.id, 0, "staged", undefined, a);
    tracker.recordOutcomeAt(group.id, 1, "staged", undefined, b);

    // Only A is approved.
    assert.ok(h.confirmApproval(a, "appr-a", 1).ok);
    h.beginDeliveryAttempt(a);
    h.completeDelivery(a);

    tracker.noteRunning("pane-1", h.svc.activeExchangeForPane("pane-1"));
    h.onPaneSignal("pane-1", "running");
    const idleGroups = tracker.noteTransition("pane-1", "idle", Date.now(), h.svc.activeExchangeForPane("pane-1"));
    h.onPaneSignal("pane-1", "idle");
    assert.deepEqual(idleGroups, [], "B is still staged in the join tracker -> the group cannot be complete yet");

    // -- Durable exchange-row + event-timeline assertions --
    const aRow = store.getExchange(a)!;
    assert.equal(aRow.state, "terminal_idle");
    assert.equal(aRow.delivery_attempt, 1);
    assert.ok(aRow.delivered_at !== null);
    assert.deepEqual(store.listExchangeEvents(a).map((e) => e.event_type), [
      "exchange_created", "approval_requested", "approval_confirmed",
      "delivery_attempted", "delivery_succeeded", "terminal_running", "terminal_idle",
    ]);

    const bRow = store.getExchange(b)!;
    assert.equal(bRow.state, "awaiting_approval", "B is untouched — never approved, never delivered");
    assert.equal(bRow.approval_id, "appr-b");
    assert.equal(bRow.delivery_attempt, 0);
    assert.equal(bRow.delivered_at, null);
    assert.deepEqual(store.listExchangeEvents(b).map((e) => e.event_type), ["exchange_created", "approval_requested"],
      "no delivery/settlement event ever touched B");

    // -- Dispatch-join member assertions --
    assert.equal(group.members[0].status, "done");
    assert.equal(group.members[1].status, "staged", "B's dispatch-join member is untouched too");
    assert.equal(group.completed, false, "the group cannot complete while B is still staged");

    store.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 2. Manual pane activity between delivery and completion.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("scenario 2: manual pane activity between delivery and completion", () => {
  it("a manual (uncorrelated) write/edge never settles the delivered exchange — only marker-gated edges advance it, at BOTH the join-tracker layer and the durable-store layer", () => {
    const store = freshStore();
    const h = new ExchangeHarness(store);
    const tracker = new DispatchJoinTracker();

    const a = h.create("pane-1", "run the build", "run the release build");
    h.requestApproval(a, "appr-a");
    h.confirmApproval(a, "appr-a", 1);
    h.beginDeliveryAttempt(a);
    h.completeDelivery(a);

    const group = tracker.create("solo", "one write", ["pane-1"]);
    tracker.recordOutcomeAt(group.id, 0, "staged", undefined, a);
    tracker.noteRunning("pane-1", h.svc.activeExchangeForPane("pane-1"));
    h.onPaneSignal("pane-1", "running");
    assert.equal(store.getExchange(a)!.state, "running");
    assert.equal(group.members[0].status, "running");

    // The operator ALSO types a manual command by hand on the SAME pane, mid-flight — the raw WS
    // input path (spec §5's correlation table: "server.ts:1043 ... the raw WS input path never
    // [stamps exchange_id]"). It is recorded in the command log with exchangeId:null and never
    // touches the machine.
    h.svc.recordManualCommand("pane-1", "git status");
    const log = h.svc.commandLog("pane-1");
    assert.deepEqual(log.map((e) => e.exchangeId), [a, null], "the manual write stays uncorrelated even though it landed on the exchange's own pane");
    assert.equal(store.getExchange(a)!.state, "running", "the manual WRITE alone changes nothing");

    const beforeManualEdge = store.getExchange(a)!;
    const eventsBeforeManualEdge = store.listExchangeEvents(a);

    // The manual command's own eventual settle-edge, fired the OLD, unconditional way — WITHOUT
    // the pane's active-exchange marker (exactly what a caller with no exchange correlation does;
    // every pre-1.4 call site reproduces this by omitting the argument entirely).
    const settledByManualEdge = tracker.noteTransition("pane-1", "idle", Date.now()); // no marker
    assert.deepEqual(settledByManualEdge, [], "an edge with no exchange marker must not settle an exchange-correlated member");
    assert.equal(group.members[0].status, "running", "A's dispatch-join member is untouched by the unmarked (manual) edge");
    assert.deepEqual(store.getExchange(a), beforeManualEdge, "the durable exchange row is byte-identical after the manual/unmarked edge");
    assert.deepEqual(store.listExchangeEvents(a), eventsBeforeManualEdge, "no exchange_events row was appended for the manual edge");

    // The SAME kind of edge, correctly marker-gated (the real observe/index.ts call shape), DOES
    // advance both the join-tracker member and the durable store row.
    const activeNow = h.svc.activeExchangeForPane("pane-1");
    const settledByMarkedEdge = tracker.noteTransition("pane-1", "idle", Date.now(), activeNow);
    h.onPaneSignal("pane-1", "idle");
    assert.deepEqual(settledByMarkedEdge.map((g) => g.id), [group.id], "the marker-gated edge settles the group");
    assert.equal(group.members[0].status, "done");
    assert.equal(store.getExchange(a)!.state, "terminal_idle");

    store.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 3. Draft edit while approval pending.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("scenario 3: draft edit while approval pending", () => {
  it("editing invalidates the outstanding approval durably (CAS fails, draft_revised recorded); approving the stale version is rejected at both the service AND the raw store-CAS layer", () => {
    const store = freshStore();
    const h = new ExchangeHarness(store);

    const id = h.create("pane-1", "run the tests", "run the unit test suite");
    h.requestApproval(id, "appr-1");
    assert.equal(store.getExchange(id)!.state, "awaiting_approval");
    assert.equal(store.getExchange(id)!.approval_draft_version, 1);

    const revised = h.reviseDraft(id, "actually, run only the store tests");
    assert.ok(revised.ok);
    assert.equal(revised.snapshot!.draftVersion, 2);

    const row = store.getExchange(id)!;
    assert.equal(row.state, "draft", "reverted to draft, durably");
    assert.equal(row.approval_id, null, "the old binding is cleared in the STORE, not just in memory");
    assert.equal(row.approval_draft_version, null);
    assert.equal(row.draft_version, 2);
    assert.equal(row.distilled_instruction, "actually, run only the store tests");
    assert.deepEqual(store.listExchangeEvents(id).map((e) => e.event_type),
      ["exchange_created", "approval_requested", "draft_revised"]);

    // Approving the STALE (pre-edit) version is rejected — in-memory...
    const staleConfirm = h.confirmApproval(id, "appr-1", 1);
    assert.equal(staleConfirm.ok, false);
    assert.equal(store.getExchange(id)!.state, "draft", "the stale confirm never touched the store");

    // ...AND independently at the store's own CAS layer (belt-and-suspenders: the durable guard is
    // correct on its own, not merely because the harness chose not to call it).
    const rawStaleCas = store.updateExchange(
      id, { state: "staged" },
      { state: "awaiting_approval", approvalId: "appr-1", approvalDraftVersion: 1 },
    );
    assert.equal(rawStaleCas.changed, false, "a raw store-level CAS with the pre-edit binding is refused too");

    // A fresh approval request binds the NEW version, and only it can confirm.
    h.requestApproval(id, "appr-2");
    assert.equal(store.getExchange(id)!.approval_draft_version, 2);
    const win = h.confirmApproval(id, "appr-2", 2);
    assert.ok(win.ok);
    assert.equal(store.getExchange(id)!.state, "staged");

    store.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 4. Restart BEFORE approval — a real file-based restart (close + reopen the SAME on-disk file),
//    not the :memory: single-instance reuse tests/test_exchange_recovery.ts already covers. This is
//    the genuinely new angle: it proves the disposition rule holds across an actual WAL round-trip
//    to disk, not just against a live in-process object.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("scenario 4: restart before approval (real file-based restart)", () => {
  it("awaiting_approval with a surviving durable approval row is KEPT across a genuine close+reopen of the DB file", () => {
    const dbPath = tempDbPath("s4-kept");
    try {
      let store = freshStore(dbPath);
      const id = store.insertExchange({
        project_id: "p1", pane_id: "pane-1", state: "awaiting_approval",
        approval_id: "appr-1", approval_draft_version: 1,
      }).exchange_id;
      store.appendExchangeEvent({ exchange_id: id, event_type: "exchange_created" });
      store.appendExchangeEvent({ exchange_id: id, event_type: "approval_requested" });
      store.insertPendingApproval({
        id: "appr-1", session_id: "sess-1", workspace_id: "w1", pane_id: "pane-1",
        command: "run the tests", kind: "agent_instruction", rationale: null,
        claimed: false, timestamp: Date.now(), expires_at: Date.now() + 100_000, exchange_id: id,
      });
      store.close(); // simulate the crash / process exit — no clean shutdown hook fires

      // "Restart": a FRESH JanusStore instance opens the SAME on-disk file, not the same
      // in-process object, and not :memory: (which can never model a restart at all).
      store = freshStore(dbPath);
      assert.equal(store.getExchange(id)!.state, "awaiting_approval", "the row survived the file round-trip");
      assert.ok(store.hasPendingApproval("appr-1"), "the bound approval row survived too");

      const report = recoverExchangesOnBoot(store);
      assert.ok(report.kept.includes(id));
      assert.equal(store.getExchange(id)!.state, "awaiting_approval", "kept — never assumed confirmed");
      assert.equal(store.getExchange(id)!.approval_id, "appr-1");
      store.close();
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  it("awaiting_approval REVERTED to draft when the bound approval row did NOT survive the crash — across a real file restart", () => {
    const dbPath = tempDbPath("s4-reverted");
    try {
      let store = freshStore(dbPath);
      const id = store.insertExchange({
        project_id: "p1", pane_id: "pane-1", state: "awaiting_approval",
        approval_id: "appr-GONE", approval_draft_version: 3,
      }).exchange_id;
      store.appendExchangeEvent({ exchange_id: id, event_type: "exchange_created" });
      // Deliberately NO insertPendingApproval — claimed+deleted, or TTL-swept, before the crash.
      store.close();

      store = freshStore(dbPath);
      assert.equal(store.hasPendingApproval("appr-GONE"), false, "confirms the row really is gone post-restart");

      const report = recoverExchangesOnBoot(store);
      assert.ok(report.reverted.includes(id));
      const row = store.getExchange(id)!;
      assert.equal(row.state, "draft");
      assert.equal(row.approval_id, null);
      assert.equal(row.approval_draft_version, null);
      assert.deepEqual(store.listExchangeEvents(id).map((e) => e.event_type), ["exchange_created", "exchange_recovered"]);
      store.close();
    } finally {
      cleanupDbFile(dbPath);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 5. Restart AFTER delivery — real file-based restart.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("scenario 5: restart after delivery (real file-based restart)", () => {
  it("a running (delivered + observed) exchange -> interrupted via recovery across a real restart; exchange_recovered is appended; no duplicate delivery is possible afterward from ANY plausible stale state", () => {
    const dbPath = tempDbPath("s5");
    try {
      let store = freshStore(dbPath);
      const h = new ExchangeHarness(store);
      const id = h.create("pane-1", "run the deploy", "run scripts/deploy.sh");
      h.requestApproval(id, "appr-1");
      h.confirmApproval(id, "appr-1", 1);
      h.beginDeliveryAttempt(id);
      h.completeDelivery(id);
      h.onPaneSignal("pane-1", "running");
      assert.equal(store.getExchange(id)!.state, "running");
      store.close(); // crash mid-flight — no clean shutdown, no cancellation

      store = freshStore(dbPath); // "restart": fresh process, fresh store handle, SAME file
      assert.equal(store.getExchange(id)!.state, "running", "the pre-crash state really did persist to disk");

      const report = recoverExchangesOnBoot(store);
      assert.ok(report.interrupted.includes(id));
      assert.equal(store.getExchange(id)!.state, "interrupted");

      const last = store.listExchangeEvents(id).at(-1)!;
      assert.equal(last.event_type, "exchange_recovered");
      const payload = JSON.parse(last.payload_redacted_json);
      assert.equal(payload.disposition, "interrupted");
      assert.equal(payload.from_state, "running");

      // NO DUPLICATE DELIVERY: the pane is inert post-restart (no PTY, and a brand-new process
      // would construct a fresh, empty in-memory ExchangeService with no memory of this exchange
      // at all). Any code that still believed this exchange deliverable loses the CAS from EVERY
      // plausible stale "from" state — not just the one state test_exchange_recovery.ts covers.
      for (const staleFrom of ["running", "delivered", "staged"] as const) {
        const resend = store.updateExchange(id, { state: "delivered", delivered_at: Date.now() }, { state: staleFrom });
        assert.equal(resend.changed, false, `a resend CAS from '${staleFrom}' must be refused once interrupted`);
      }
      assert.equal(store.getExchange(id)!.state, "interrupted", "unchanged by every rejected resend attempt");
      store.close();
    } finally {
      cleanupDbFile(dbPath);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 6. Failed pane write.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("scenario 6: failed pane write", () => {
  it("delivery_attempted then delivery_failed are both durably recorded; the exchange is recoverable (kept as draft on a later restart), and was NEVER delivered", () => {
    const store = freshStore();
    const h = new ExchangeHarness(store);

    const id = h.create("pane-1", "run the deploy script", "run scripts/deploy.sh");
    h.requestApproval(id, "appr-1");
    h.confirmApproval(id, "appr-1", 1);
    assert.equal(store.getExchange(id)!.state, "staged");

    h.beginDeliveryAttempt(id); // durable pre-write intent — BEFORE the (simulated) pane write
    assert.equal(store.getExchange(id)!.delivery_attempt, 1);

    // Certain failure: pane missing / Exited (spec §1.3 note ᵉ) — nothing landed.
    const failed = h.failDelivery(id, "pane_exited");
    assert.ok(failed.ok);

    const row = store.getExchange(id)!;
    assert.equal(row.state, "draft", "re-armed for a fresh approval, never left dangling in staged");
    assert.equal(row.approval_id, null, "a re-send needs a FRESH approval");
    assert.equal(row.approval_draft_version, null);
    assert.equal(row.delivery_attempt, 1, "the attempt stays on the record as forensic evidence");
    assert.equal(row.delivered_at, null, "NEVER delivered");

    const events = store.listExchangeEvents(id);
    assert.deepEqual(events.map((e) => e.event_type), [
      "exchange_created", "approval_requested", "approval_confirmed", "delivery_attempted", "delivery_failed",
    ]);
    assert.equal(JSON.parse(events.at(-1)!.payload_redacted_json).detail, "pane_exited");

    // Recoverable: a later restart finds it in `draft` (pure durable text) and keeps it — never
    // resent, never invented.
    const report = recoverExchangesOnBoot(store);
    assert.ok(report.kept.includes(id));
    assert.equal(store.getExchange(id)!.state, "draft");

    store.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 7. Repeated approval.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("scenario 7: repeated approval", () => {
  it("a second confirm on an already-staged exchange is a structural no-op — state unchanged, no duplicate store write, no duplicate event", () => {
    const store = freshStore();
    const h = new ExchangeHarness(store);
    const id = h.create("pane-1", "run the tests", "run the unit test suite");
    h.requestApproval(id, "appr-1");

    assert.ok(h.confirmApproval(id, "appr-1", 1).ok);
    const rowAfterFirst = store.getExchange(id)!;
    const eventsAfterFirst = store.listExchangeEvents(id);
    assert.equal(rowAfterFirst.state, "staged");
    assert.equal(eventsAfterFirst.at(-1)!.event_type, "approval_confirmed");

    const second = h.confirmApproval(id, "appr-1", 1);
    assert.equal(second.ok, false, "the replayed confirm must not 'win' again");

    assert.deepEqual(store.getExchange(id), rowAfterFirst, "byte-identical row — not even updated_at moved");
    assert.deepEqual(store.listExchangeEvents(id), eventsAfterFirst, "no duplicate event was appended for the no-op replay");

    store.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 8. Repeated terminal edge.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("scenario 8: repeated terminal edge", () => {
  it("a repeated Running/Idle edge is idempotent — one terminal_running/terminal_idle progression, no duplicate exchange_events for the repeat", () => {
    const store = freshStore();
    const h = new ExchangeHarness(store);
    const id = h.create("pane-1", "run the tests", "run the unit test suite");
    h.requestApproval(id, "appr-1");
    h.confirmApproval(id, "appr-1", 1);
    h.beginDeliveryAttempt(id);
    h.completeDelivery(id);

    h.onPaneSignal("pane-1", "running");
    assert.equal(store.getExchange(id)!.state, "running");
    const eventsAfterFirstRunning = store.listExchangeEvents(id);

    // running->running is not a legal transition (no self-loops, spec §1.3) — a redundant Running
    // edge (e.g. a debounce-adjacent duplicate) must be a harmless no-op.
    const repeatRunning = h.onPaneSignal("pane-1", "running");
    assert.deepEqual(repeatRunning, [], "no settle outcome for the illegal self-loop");
    assert.deepEqual(store.listExchangeEvents(id), eventsAfterFirstRunning, "no duplicate terminal_running event");

    h.onPaneSignal("pane-1", "idle");
    assert.equal(store.getExchange(id)!.state, "terminal_idle");
    const eventsAfterFirstIdle = store.listExchangeEvents(id);
    assert.equal(eventsAfterFirstIdle.filter((e) => e.event_type === "terminal_running").length, 1);
    assert.equal(eventsAfterFirstIdle.filter((e) => e.event_type === "terminal_idle").length, 1);

    // A second idle edge — the fast-command / re-announced-idle case.
    const repeatIdle = h.onPaneSignal("pane-1", "idle");
    assert.deepEqual(repeatIdle, []);
    assert.deepEqual(store.listExchangeEvents(id), eventsAfterFirstIdle, "no duplicate terminal_idle event either");
    assert.equal(store.getExchange(id)!.state, "terminal_idle", "state is stable across the repeat");

    store.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 9. Uncorrelated legacy command — flag off / shadow-but-uncorrelated.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("scenario 9: uncorrelated legacy command", () => {
  it("flag=off end-to-end journey writes NO exchange rows; the pending-approval row and dispatch member stay uncorrelated (exchange_id NULL everywhere)", () => {
    // This test PROCESS never sets JANUS_EXCHANGE_SPINE, so the real frozen EXCHANGE_SPINE_MODE
    // the whole app boots with is "off" here — the production default (spec §8). We reproduce the
    // SAME branch shape src/voice/index.ts's stampExchangeForDispatch uses (voice/index.ts:956-973):
    // `if (!exchangeSpineActive()) return undefined;` — using the REAL exported flag function.
    assert.equal(exchangeSpineActive(), false, "sanity: this test process's frozen flag is off, matching the production default");

    const store = freshStore();
    const tracker = new DispatchJoinTracker();
    const approvals = new PendingApprovalStore(store);

    const exchangeId = exchangeSpineActive() ? "unreachable" : undefined; // the real off-mode gate
    const group = tracker.create("legacy-macro", "run the linter", ["pane-1"]);
    approvals.add(
      { messageId: "appr-legacy-1", instruction: "npm run lint", kind: "agent_instruction", terminalId: "pane-1", callId: "call-1", timestamp: Date.now(), exchangeId },
      {}, { workspaceId: "proj-1" },
    );
    tracker.recordOutcomeAt(group.id, 0, "staged", undefined, exchangeId);
    tracker.noteRunning("pane-1", exchangeId);
    tracker.noteTransition("pane-1", "idle", Date.now(), exchangeId);

    assert.equal(store.listExchangesByState("draft").length, 0);
    assert.equal(store.listExchangesByState("awaiting_approval").length, 0);
    assert.equal(store.listExchangesByState("staged").length, 0);
    const [row] = store.getExpiredApprovals(Number.MAX_SAFE_INTEGER);
    assert.equal(row.exchange_id, null, "the durable pending-approval row is uncorrelated");
    assert.equal(group.members[0].exchangeId, undefined, "the dispatch-join member is uncorrelated");
    assert.equal(group.members[0].status, "done", "the legacy member still settles fine — flag off is zero behavior delta, not broken behavior");

    store.close();
  });

  it("flag=shadow: a non-exchange action path leaves agent_exchanges/exchange_events completely untouched and stays uncorrelated", () => {
    // EXCHANGE_SPINE_MODE (src/exchanges/flag.ts) is a MODULE-LOAD-TIME constant read once from
    // process.env, so this test process's `exchangeSpineActive()` view is permanently frozen to
    // "off" (pinned above) — it cannot be flipped to "shadow" mid-process to exercise the real
    // singleton. To exercise the "shadow" leg of this scenario we use the flag module's own
    // PARAMETERIZED (non-frozen) functions instead — `readExchangeSpineMode`/`exchangeSpineWrites`
    // — the exact seam its module doc says exists "so tests can pass an explicit env map without
    // mutating process.env". A directly-constructed `ExchangeService` stands in for what
    // `getExchangeService()` would return if the singleton really were in shadow mode (constructing
    // one directly is the identical class production uses; it just isn't the frozen singleton).
    const shadowMode = readExchangeSpineMode({ JANUS_EXCHANGE_SPINE: "shadow" });
    assert.equal(shadowMode, "shadow");
    assert.equal(exchangeSpineWrites(shadowMode), true, "shadow mode DOES write exchange rows for exchange-aware actions");

    const store = freshStore();
    const svcForShadow = new ExchangeService(); // stands in for a hypothetically shadow-mode singleton

    // The scenario: a NON-exchange action — the raw WS input path (spec §5's correlation table:
    // "server.ts:1043 ... the raw WS input path... never [stamps exchange_id]") or any legacy
    // action definition that predates the spine. Exchange correlation is opt-in at the handful of
    // call sites the spec names, never automatic — so this path never calls
    // svc.createExchange/insertExchange, by construction, REGARDLESS of the flag's mode.
    const approvals = new PendingApprovalStore(store);
    approvals.add(
      { messageId: "appr-raw-1", instruction: "ls -la", kind: "shell", terminalId: "pane-1", callId: "call-raw", timestamp: Date.now() },
      {}, { workspaceId: "proj-1" },
    );

    assert.equal(store.listExchangesByState("draft").length, 0);
    assert.equal(store.listExchangesByState("awaiting_approval").length, 0);
    const [row] = store.getExpiredApprovals(Number.MAX_SAFE_INTEGER);
    assert.equal(row.exchange_id, null, "the raw/legacy action's pending-approval row stays uncorrelated even in shadow mode");
    assert.equal(svcForShadow.commandLog("pane-1").length, 0, "the shadow-capable ExchangeService was never invoked for this action — it has no record of it either");

    store.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// CRITICAL FINDING — pinned as an explicit, visible test.todo (see the file-header comment block).
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("CRITICAL FINDING: the ExchangeService <-> SQLite persistence bridge is not wired in production", () => {
  it.todo(
    "BUG-shaped gap (not fixed here — out of this pass's allowed paths): a real production journey " +
    "through the ACTUAL singleton (getExchangeService(), exactly as gating/index.ts + " +
    "dispatch/paneWrite.ts + observe/index.ts call it) writes NOTHING to agent_exchanges/" +
    "exchange_events — grep across src/ finds zero call sites for store.insertExchange/" +
    "updateExchange/appendExchangeEvent outside src/exchanges/recovery.ts, and zero call sites for " +
    "recoverExchangesOnBoot itself outside its own test file. Every scenario in this suite therefore " +
    "has to hand-mirror ExchangeService transitions into the store itself (see ExchangeHarness) " +
    "because the real bridge does not exist. Consequence: a real process restart in `primary` mode " +
    "loses 100% of in-flight exchange state — no quarantine, no exchange_recovered event, no " +
    "attention-item surfacing — even though spec §4 describes exactly that behavior as the schema's " +
    "reason to exist. Fix = wire getExchangeService()'s call sites (or ExchangeService itself) to " +
    "dual-write through the store's CAS/event APIs, and call recoverExchangesOnBoot from the real " +
    "boot sequence (server.ts)."
  );
});
