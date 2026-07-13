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

  // ── Phase 2 Step 2.4 (cross-project journeys) ────────────────────────────────────────────────

  it("journey 3 companion: a failed send's row stays unacknowledged FOREVER; the retry mints a strictly newer version and acks normally", () => {
    const s = freshStore();
    const reg = new ContextVersionRegistry(s);

    // recordDelivery ALWAYS happens before the send (src/voice/index.ts's choke point) — simulate
    // sendClientContent throwing by simply never calling acknowledgeDelivery for this one.
    const failed = reg.recordDelivery({ projectId: "proj-a", sessionId: "sess-1", ...BASE_DELIVERY }); // v1
    assert.strictEqual(reg.currentAcknowledgedVersion("proj-a", "sess-1"), null);

    // The NEXT delivery attempt (the retry — same trigger, same still-changed world) mints a
    // STRICTLY newer version; it never reuses v1's number even though v1 never landed.
    const retry = reg.recordDelivery({ projectId: "proj-a", sessionId: "sess-1", ...BASE_DELIVERY }); // v2
    assert.ok(Number(retry.contextVersion) > Number(failed.contextVersion), "the retry's version is strictly newer than the failed attempt's");
    assert.strictEqual(reg.acknowledgeDelivery(retry.deliveryId), true);
    assert.strictEqual(reg.currentAcknowledgedVersion("proj-a", "sess-1"), retry.contextVersion);

    // The failed row is durably distinguishable from the retry: same pair, different delivery ids,
    // only the retry ever got acknowledged.
    const rows = s.listContextDeliveries("sess-1");
    const failedRow = rows.find(r => r.delivery_id === failed.deliveryId)!;
    const retryRow = rows.find(r => r.delivery_id === retry.deliveryId)!;
    assert.strictEqual(failedRow.acknowledged_at, null, "the failed attempt's row NEVER gets acknowledged, not even retroactively by the retry's success");
    assert.ok(retryRow.acknowledged_at, "the retry's own row is acknowledged");

    s.close();
  });

  it("journey 5 companion: a browser reconnect mints a FRESH (project, NEW session) pair; the OLD session's acknowledged delivery stays durably readable in the store", () => {
    const s = freshStore();
    // Phase 2 Step 2.2: ContextVersionRegistry is SERVER-scoped in production (one shared instance
    // across every WS connection — src/voice/index.ts constructs it once, outside attachVoiceSession's
    // per-connection closure) — a browser reconnect reuses the SAME registry instance. What changes on
    // reconnect is the CONNECTION's own voice_session_id (Phase 2 Step 2.2: minted once per WS
    // connection, including across bounded auto-reconnects, but NOT across a fresh browser
    // reconnect, which is a brand-new WS connection with its own mintVoiceSessionId() call).
    const reg = new ContextVersionRegistry(s);
    const oldSession = "vsess-OLD";
    const newSession = "vsess-NEW";

    const d = reg.recordDelivery({ projectId: "proj-a", sessionId: oldSession, ...BASE_DELIVERY });
    reg.acknowledgeDelivery(d.deliveryId);
    assert.strictEqual(reg.currentAcknowledgedVersion("proj-a", oldSession), "1");

    // The reconnect: a genuinely NEW (project, session) pair. Versioning starts fresh for it — by
    // design (one voice_session_id per WS connection) — but this is NOT data loss: the OLD session's
    // own acknowledged row is untouched and durably readable. "acknowledged versions survive (from
    // store)" means the audit trail survives, not that the new connection inherits the old number.
    assert.strictEqual(reg.currentAcknowledgedVersion("proj-a", newSession), null, "a new connection's session pair starts with no acknowledged version of its own");
    assert.strictEqual(reg.nextVersionFor("proj-a", newSession), "1", "the new pair's counter starts at 1, independent of the old session's v1");

    const oldRows = s.listContextDeliveries(oldSession);
    assert.strictEqual(oldRows.length, 1);
    assert.ok(oldRows[0].acknowledged_at, "the pre-reconnect session's acknowledged delivery is still durably readable after the reconnect");
    assert.strictEqual(oldRows[0].context_version, "1");
    assert.strictEqual(oldRows[0].project_id, "proj-a");

    // The two sessions' rows never intermingle.
    const newD = reg.recordDelivery({ projectId: "proj-a", sessionId: newSession, ...BASE_DELIVERY });
    reg.acknowledgeDelivery(newD.deliveryId);
    const newRows = s.listContextDeliveries(newSession);
    assert.strictEqual(newRows.length, 1);
    assert.notStrictEqual(newRows[0].delivery_id, oldRows[0].delivery_id);

    s.close();
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
