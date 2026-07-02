import { describe, it } from "node:test";
import assert from "node:assert";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

import {
  deliverOutcomeToHandoff,
  resolveReasonToHandoffState,
} from "../src/handoffFlow";
import { JanusStore } from "../src/store/sqliteStore";

/**
 * G3 closure — the handoff deliver/flip mappings were previously only reachable through the
 * server's WebSocket closure and so went unverified. These test the EXTRACTED pure mappings
 * (the exact logic server.ts now calls) AND drive a real on-disk JanusStore through the full
 * approve / reject / expire flips so the persisted-row transitions are proven without a PTY.
 */

// ---------------------------------------------------------------------------
// Pure mapping 1 — dispatch outcome -> persisted-row effect (the deliver_handoff decision)
// ---------------------------------------------------------------------------
describe("deliverOutcomeToHandoff (deliver mapping)", () => {
  it("executed (Full Auto) => deliver_now/delivered/full_auto", () => {
    assert.deepStrictEqual(deliverOutcomeToHandoff("executed"), { kind: "deliver_now", state: "delivered", approvedVia: "full_auto" });
  });
  it("pending (HiTL) => await_approval", () => {
    assert.deepStrictEqual(deliverOutcomeToHandoff("pending"), { kind: "await_approval" });
  });
  it("blocked (Read-Only/mode) => block/blocked_read_only", () => {
    assert.deepStrictEqual(deliverOutcomeToHandoff("blocked"), { kind: "block", state: "blocked_read_only" });
  });
  it("error and clarify => noop (no state change)", () => {
    assert.deepStrictEqual(deliverOutcomeToHandoff("error"), { kind: "noop" });
    assert.deepStrictEqual(deliverOutcomeToHandoff("clarify"), { kind: "noop" });
  });
});

// ---------------------------------------------------------------------------
// Pure mapping 2 — resolution reason -> handoff state (the flipHandoffOnResolve decision)
// ---------------------------------------------------------------------------
describe("resolveReasonToHandoffState (flip mapping)", () => {
  it("approved => delivered", () => assert.strictEqual(resolveReasonToHandoffState("approved"), "delivered"));
  it("rejected => rejected", () => assert.strictEqual(resolveReasonToHandoffState("rejected"), "rejected"));
  it("expired => expired", () => assert.strictEqual(resolveReasonToHandoffState("expired"), "expired"));
  it("dead_pane => expired", () => assert.strictEqual(resolveReasonToHandoffState("dead_pane"), "expired"));
});

// ---------------------------------------------------------------------------
// Real-store integration — the mappings applied against an on-disk JanusStore
// ---------------------------------------------------------------------------
describe("handoff flip applied to a real JanusStore", () => {
  function freshStore(): { store: JanusStore; dbPath: string } {
    const dbPath = path.join(os.tmpdir(), `janus-flowtest-${process.pid}-${Math.floor(performance.now())}.db`);
    const store = new JanusStore(dbPath);
    store.init();
    return { store, dbPath };
  }
  function cleanup(store: JanusStore, dbPath: string) {
    store.close();
    for (const p of [dbPath, dbPath + "-wal", dbPath + "-shm"]) { try { fs.unlinkSync(p); } catch {} }
  }
  function stage(store: JanusStore) {
    const h = store.createHandoff({ workspace_id: "ws", to_pane: "p1", kind: "agent_instruction", composed_prompt: "do x", state: "composing" });
    store.updateHandoffState(h.id, "staged");
    return h.id;
  }

  it("approved flip => row becomes delivered with delivered_at + approved_via", () => {
    const { store, dbPath } = freshStore();
    try {
      const id = stage(store);
      const next = resolveReasonToHandoffState("approved")!;
      store.updateHandoffState(id, next, { approved_via: "voice", delivered_at: 123 });
      const row = store.getHandoff(id)!;
      assert.strictEqual(row.state, "delivered");
      assert.ok(row.delivered_at, "delivered_at should be set");
      assert.strictEqual(row.approved_via, "voice");
    } finally { cleanup(store, dbPath); }
  });

  it("rejected flip => row becomes rejected (no delivered_at)", () => {
    const { store, dbPath } = freshStore();
    try {
      const id = stage(store);
      store.updateHandoffState(id, resolveReasonToHandoffState("rejected")!);
      const row = store.getHandoff(id)!;
      assert.strictEqual(row.state, "rejected");
      assert.ok(!row.delivered_at, "rejected row must not have delivered_at");
    } finally { cleanup(store, dbPath); }
  });

  it("expired/dead_pane flip => row becomes expired", () => {
    const { store, dbPath } = freshStore();
    try {
      const id = stage(store);
      store.updateHandoffState(id, resolveReasonToHandoffState("dead_pane")!);
      assert.strictEqual(store.getHandoff(id)!.state, "expired");
    } finally { cleanup(store, dbPath); }
  });

  // wsm-e2e-pinned-3vl (2): defense-in-depth — once a row is TERMINAL, a further
  // updateHandoffState call must be a silent no-op (unchanged row, no 2nd audit event), even
  // though under correct operation the upstream claim gate already makes this unreachable.
  it("updateHandoffState on an already-terminal row is a no-op (defense-in-depth)", () => {
    const { store, dbPath } = freshStore();
    try {
      const id = stage(store);
      store.updateHandoffState(id, "rejected");
      const before = store.getHandoff(id)!;
      assert.strictEqual(before.state, "rejected");

      // A second flip attempt against the now-terminal row (e.g. approved, delivered_at set)
      // must NOT mutate the row at all.
      const after = store.updateHandoffState(id, "delivered", { approved_via: "voice", delivered_at: 999 });
      assert.strictEqual(after!.state, "rejected", "state must stay rejected, not flip to delivered");
      assert.ok(!after!.delivered_at, "delivered_at must not be stamped on a terminal-state no-op");
      assert.deepStrictEqual(after, before, "the row must be byte-for-byte unchanged");
    } finally { cleanup(store, dbPath); }
  });

  it("Full-Auto deliver effect drives the row to delivered (the smoke's non-PTY half)", () => {
    const { store, dbPath } = freshStore();
    try {
      const id = stage(store);
      const effect = deliverOutcomeToHandoff("executed");
      assert.strictEqual(effect.kind, "deliver_now");
      if (effect.kind === "deliver_now") {
        store.updateHandoffState(id, effect.state, { approved_via: effect.approvedVia });
      }
      const row = store.getHandoff(id)!;
      assert.strictEqual(row.state, "delivered");
      assert.strictEqual(row.approved_via, "full_auto");
    } finally { cleanup(store, dbPath); }
  });
});
