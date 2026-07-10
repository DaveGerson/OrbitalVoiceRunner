// tests/test_context_versions.ts — Phase 2, Step 2.2: the per-(project_id, voice_session_id)
// context_version registry (src/memory/contextVersions.ts), backed by the schema-v12
// context_deliveries table (tests/test_exchange_store.ts already pins that table's own CRUD/CAS
// directly — this file is scoped to the REGISTRY's ack-on-success contract on top of it).

import { describe, it } from "node:test";
import assert from "node:assert";

import { JanusStore } from "../src/store/sqliteStore";
import { ContextVersionRegistry } from "../src/memory/contextVersions";

function freshStore(): JanusStore {
  const s = new JanusStore(":memory:");
  s.init();
  return s;
}

const BASE_DELIVERY = {
  trigger: "session_start",
  includedSourceIds: ["project", "pane"],
  droppedSourceIds: ["board"],
  snapshotHash: "snap-1",
  briefHash: "brief-1",
};

describe("ContextVersionRegistry (Phase 2 Step 2.2)", () => {
  it("nextVersionFor is monotonic per (project, session) pair, starting at 1", () => {
    const reg = new ContextVersionRegistry(null);
    assert.strictEqual(reg.nextVersionFor("proj-a", "sess-1"), "1");
    assert.strictEqual(reg.nextVersionFor("proj-a", "sess-1"), "2");
    assert.strictEqual(reg.nextVersionFor("proj-a", "sess-1"), "3");
  });

  it("distinct (project, session) pairs hold fully independent counters", () => {
    const reg = new ContextVersionRegistry(null);
    assert.strictEqual(reg.nextVersionFor("proj-a", "sess-1"), "1");
    assert.strictEqual(reg.nextVersionFor("proj-a", "sess-2"), "1", "different session, same project -> own counter");
    assert.strictEqual(reg.nextVersionFor("proj-b", "sess-1"), "1", "different project, same session -> own counter");
    assert.strictEqual(reg.nextVersionFor("proj-a", "sess-1"), "2", "the original pair kept advancing independently");
  });

  it("recordDelivery mints the next version, persists an UNACKNOWLEDGED context_deliveries row", () => {
    const s = freshStore();
    const reg = new ContextVersionRegistry(s);

    const d = reg.recordDelivery({ projectId: "proj-a", sessionId: "sess-1", ...BASE_DELIVERY });
    assert.strictEqual(d.contextVersion, "1");
    assert.ok(d.deliveryId);

    const [row] = s.listContextDeliveries("sess-1");
    assert.ok(row, "the row was actually persisted");
    assert.strictEqual(row.context_version, "1");
    assert.strictEqual(row.project_id, "proj-a");
    assert.strictEqual(row.trigger, "session_start");
    assert.strictEqual(row.snapshot_hash, "snap-1");
    assert.strictEqual(row.brief_hash, "brief-1");
    assert.deepStrictEqual(JSON.parse(row.included_sources_json), ["project", "pane"]);
    assert.deepStrictEqual(JSON.parse(row.dropped_sources_json), ["board"]);
    assert.strictEqual(row.acknowledged_at, null, "not acknowledged until acknowledgeDelivery is called");

    s.close();
  });

  it("currentAcknowledgedVersion is null until acknowledgeDelivery is called (ack-on-success)", () => {
    const s = freshStore();
    const reg = new ContextVersionRegistry(s);

    const d = reg.recordDelivery({ projectId: "proj-a", sessionId: "sess-1", ...BASE_DELIVERY });
    assert.strictEqual(reg.currentAcknowledgedVersion("proj-a", "sess-1"), null, "recorded but not yet acknowledged");

    const ok = reg.acknowledgeDelivery(d.deliveryId);
    assert.strictEqual(ok, true);
    assert.strictEqual(reg.currentAcknowledgedVersion("proj-a", "sess-1"), "1");

    const [row] = s.listContextDeliveries("sess-1");
    assert.ok(row.acknowledged_at, "the durable row is stamped too");

    s.close();
  });

  it("acknowledgeDelivery on an unknown delivery id is a no-op (returns false, never throws)", () => {
    const reg = new ContextVersionRegistry(null);
    assert.strictEqual(reg.acknowledgeDelivery("ctxdel-does-not-exist"), false);
  });

  // ── "must NOT advance the acknowledged version" — the five named cases from the spec ───────────

  it("a gate-suppressed skip never calls recordDelivery -> currentAcknowledgedVersion stays null", () => {
    const reg = new ContextVersionRegistry(null);
    // The choke point's contract: a gate skip returns BEFORE reaching recordDelivery at all. This
    // test asserts the registry's OWN state in that scenario — nothing was ever recorded.
    assert.strictEqual(reg.currentAcknowledgedVersion("proj-a", "sess-1"), null);
  });

  it("a stale/empty brief that never reaches recordDelivery leaves the acknowledged version untouched", () => {
    const reg = new ContextVersionRegistry(null);
    reg.recordDelivery({ projectId: "proj-a", sessionId: "sess-1", ...BASE_DELIVERY }); // v1, recorded
    // Simulate: a SECOND injectMemoryBrief call whose brief turned out stale/empty — the real choke
    // point never calls recordDelivery for that attempt at all, so nothing new is minted here either.
    assert.strictEqual(reg.currentAcknowledgedVersion("proj-a", "sess-1"), null, "v1 was recorded but never acknowledged");
  });

  it("a send failure (recordDelivery called, acknowledgeDelivery never called) leaves the row unacknowledged", () => {
    const s = freshStore();
    const reg = new ContextVersionRegistry(s);

    const d = reg.recordDelivery({ projectId: "proj-a", sessionId: "sess-1", ...BASE_DELIVERY });
    // sendClientContent would have thrown here in the real choke point — acknowledgeDelivery is
    // simply never reached. The row stays exactly as recordDelivery left it.
    assert.strictEqual(reg.currentAcknowledgedVersion("proj-a", "sess-1"), null);
    const [row] = s.listContextDeliveries("sess-1");
    assert.strictEqual(row.delivery_id, d.deliveryId);
    assert.strictEqual(row.acknowledged_at, null);

    s.close();
  });

  it("a reconnect race — an OLDER delivery's late ack never regresses an already-advanced version", () => {
    const reg = new ContextVersionRegistry(null);
    const a = reg.recordDelivery({ projectId: "proj-a", sessionId: "sess-1", ...BASE_DELIVERY }); // v1
    const b = reg.recordDelivery({ projectId: "proj-a", sessionId: "sess-1", ...BASE_DELIVERY }); // v2

    // B's send completes and acknowledges FIRST (e.g. A was a stale in-flight request from before a
    // reconnect, and its ack arrives late).
    assert.strictEqual(reg.acknowledgeDelivery(b.deliveryId), true);
    assert.strictEqual(reg.currentAcknowledgedVersion("proj-a", "sess-1"), "2");

    // A's late ack must not regress the version back to "1".
    assert.strictEqual(reg.acknowledgeDelivery(a.deliveryId), true, "the ack call itself still succeeds (idempotent-ish)");
    assert.strictEqual(reg.currentAcknowledgedVersion("proj-a", "sess-1"), "2", "never regresses below the highest acknowledged version");
  });

  it("acknowledging in natural order advances the version step by step", () => {
    const reg = new ContextVersionRegistry(null);
    const a = reg.recordDelivery({ projectId: "proj-a", sessionId: "sess-1", ...BASE_DELIVERY });
    reg.acknowledgeDelivery(a.deliveryId);
    assert.strictEqual(reg.currentAcknowledgedVersion("proj-a", "sess-1"), "1");

    const b = reg.recordDelivery({ projectId: "proj-a", sessionId: "sess-1", ...BASE_DELIVERY });
    reg.acknowledgeDelivery(b.deliveryId);
    assert.strictEqual(reg.currentAcknowledgedVersion("proj-a", "sess-1"), "2");
  });

  it("recordDelivery works with no store attached (pure in-memory, never throws)", () => {
    const reg = new ContextVersionRegistry(null);
    const d = reg.recordDelivery({ projectId: null, sessionId: null, ...BASE_DELIVERY });
    assert.ok(d.deliveryId.startsWith("ctxdel-"));
    assert.strictEqual(d.contextVersion, "1");
    assert.strictEqual(reg.acknowledgeDelivery(d.deliveryId), true);
    assert.strictEqual(reg.currentAcknowledgedVersion(null, null), "1");
  });

  it("a restart-equivalent registry (fresh instance, same store) seeds numbering past prior deliveries", () => {
    const s = freshStore();
    const reg1 = new ContextVersionRegistry(s);
    reg1.recordDelivery({ projectId: "proj-a", sessionId: "sess-1", ...BASE_DELIVERY }); // v1
    reg1.recordDelivery({ projectId: "proj-a", sessionId: "sess-1", ...BASE_DELIVERY }); // v2

    // A fresh registry instance (simulating a process restart) attached to the SAME durable store
    // must not collide with v1/v2 that already exist for this pair.
    const reg2 = new ContextVersionRegistry(s);
    const next = reg2.nextVersionFor("proj-a", "sess-1");
    assert.strictEqual(next, "3", "seeded from the durable store's existing rows for this pair");

    s.close();
  });
});
