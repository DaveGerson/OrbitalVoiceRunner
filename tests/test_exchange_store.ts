// tests/test_exchange_store.ts
//
// AgentExchange spine — storage-layer round-trip suite (Phase 1, step 1.2; spec
// docs/superpowers/specs/2026-07-09-agent-exchange-spine.md §6). STORAGE ONLY: no lifecycle/state
// machine under test here (that's tests/test_exchange_lifecycle.ts / test_exchange_correlation.ts,
// step 1.3, which stay RED against src/exchanges/lifecycle and src/exchanges/service — neither of
// which exists yet). This suite pins the schema v12 tables + the JanusStore CRUD/CAS methods that
// sit on top of them.

import { describe, it } from "node:test";
import assert from "node:assert";

import { JanusStore } from "../src/store/sqliteStore";
import { SCHEMA_VERSION } from "../src/store/schema";

function freshStore(): JanusStore {
  const s = new JanusStore(":memory:");
  s.init();
  return s;
}

describe("AgentExchange spine: schema", () => {
  it("v12 created the three new tables + indexes (SCHEMA_VERSION has since advanced past 12, e.g. bead 98f2's v13 transcripts table)", () => {
    const s = freshStore();
    assert.ok(SCHEMA_VERSION >= 12);
    const names = (s.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'"
    ).all() as any[]).map((r) => r.name);
    for (const t of ["agent_exchanges", "exchange_events", "context_deliveries"]) {
      assert.ok(names.includes(t), `missing table ${t}`);
    }
    const indexNames = (s.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index'"
    ).all() as any[]).map((r) => r.name);
    for (const idx of [
      "idx_agent_exchanges_state", "idx_agent_exchanges_pane_state",
      "idx_agent_exchanges_project_created", "idx_agent_exchanges_approval",
      "idx_exchange_events_exchange_ts", "idx_exchange_events_type_ts",
      "idx_context_deliveries_session_ts", "idx_context_deliveries_version",
      "idx_action_log_exchange_id", "idx_events_exchange",
    ]) {
      assert.ok(indexNames.includes(idx), `missing index ${idx}`);
    }
    s.close();
  });

  it("adds nullable exchange_id columns to the five existing tables", () => {
    const s = freshStore();
    const cols = (table: string) =>
      (s.db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((c) => c.name);
    for (const t of ["pending_approvals", "action_log", "attention", "context_injections", "events"]) {
      assert.ok(cols(t).includes("exchange_id"), `${t} missing exchange_id column`);
    }
    s.close();
  });
});

describe("AgentExchange spine: agent_exchanges round trip", () => {
  it("insertExchange applies documented defaults for every nullable/omitted field", () => {
    const s = freshStore();
    const row = s.insertExchange({ project_id: "proj-1", pane_id: "pane-1" });
    assert.ok(row.exchange_id.startsWith("exch_"));
    assert.equal(row.project_id, "proj-1");
    assert.equal(row.pane_id, "pane-1");
    assert.equal(row.voice_session_id, null);
    assert.equal(row.interaction_id, null);
    assert.equal(row.operator_utterance, "");
    assert.equal(row.distilled_instruction, "");
    assert.equal(row.instruction_envelope_json, "{}");
    assert.equal(row.draft_version, 1);
    assert.equal(row.context_version, null);
    assert.equal(row.state, "draft");
    assert.equal(row.approval_id, null);
    assert.equal(row.approval_draft_version, null);
    assert.equal(row.delivery_attempt, 0);
    assert.equal(row.terminal_state, null);
    assert.equal(row.result_summary, null);
    assert.equal(row.result_envelope_json, null);
    assert.equal(row.delivered_at, null);
    assert.equal(row.completed_at, null);
    assert.ok(row.created_at > 0 && row.updated_at > 0);

    const fetched = s.getExchange(row.exchange_id);
    assert.deepEqual(fetched, row);
    s.close();
  });

  it("insertExchange round-trips every field when explicitly set (both null and non-null)", () => {
    const s = freshStore();
    const row = s.insertExchange({
      project_id: "proj-1",
      pane_id: "pane-1",
      voice_session_id: "sess-1",
      interaction_id: "ixn_1",
      operator_utterance: "tell claude to run the tests",
      distilled_instruction: "run npm test",
      instruction_envelope_json: JSON.stringify({ dispatch_group_id: "dg-1" }),
      draft_version: 3,
      context_version: "ctx-7",
      state: "awaiting_approval",
      approval_id: "appr-1",
      approval_draft_version: 3,
      delivery_attempt: 2,
      terminal_state: "Idle",
      result_summary: "done",
      result_envelope_json: JSON.stringify({ ok: true }),
      delivered_at: 1234,
      completed_at: 5678,
    });
    const fetched = s.getExchange(row.exchange_id)!;
    assert.equal(fetched.voice_session_id, "sess-1");
    assert.equal(fetched.interaction_id, "ixn_1");
    assert.equal(fetched.operator_utterance, "tell claude to run the tests");
    assert.equal(fetched.distilled_instruction, "run npm test");
    assert.equal(fetched.instruction_envelope_json, JSON.stringify({ dispatch_group_id: "dg-1" }));
    assert.equal(fetched.draft_version, 3);
    assert.equal(fetched.context_version, "ctx-7");
    assert.equal(fetched.state, "awaiting_approval");
    assert.equal(fetched.approval_id, "appr-1");
    assert.equal(fetched.approval_draft_version, 3);
    assert.equal(fetched.delivery_attempt, 2);
    assert.equal(fetched.terminal_state, "Idle");
    assert.equal(fetched.result_summary, "done");
    assert.equal(fetched.result_envelope_json, JSON.stringify({ ok: true }));
    assert.equal(fetched.delivered_at, 1234);
    assert.equal(fetched.completed_at, 5678);
    s.close();
  });

  it("getExchange returns null for an unknown id", () => {
    const s = freshStore();
    assert.equal(s.getExchange("exch_nope"), null);
    s.close();
  });

  it("listExchangesByState / listExchangesByPane are index-backed and ordered by created_at", () => {
    const s = freshStore();
    const a = s.insertExchange({ project_id: "p1", pane_id: "pane-1", created_at: 100, updated_at: 100 });
    const b = s.insertExchange({ project_id: "p1", pane_id: "pane-1", created_at: 200, updated_at: 200 });
    const c = s.insertExchange({ project_id: "p1", pane_id: "pane-2", state: "awaiting_approval", created_at: 150, updated_at: 150 });

    const drafts = s.listExchangesByState("draft").map((r) => r.exchange_id);
    assert.deepEqual(drafts, [a.exchange_id, b.exchange_id]);

    const awaiting = s.listExchangesByState("awaiting_approval").map((r) => r.exchange_id);
    assert.deepEqual(awaiting, [c.exchange_id]);

    const onPane1 = s.listExchangesByPane("pane-1").map((r) => r.exchange_id);
    assert.deepEqual(onPane1, [a.exchange_id, b.exchange_id]);
    assert.deepEqual(s.listExchangesByPane("pane-ghost"), []);
    s.close();
  });
});

describe("AgentExchange spine: updateExchange CAS", () => {
  it("CAS succeeds when state (and approval binding) matches, and applies the patch", () => {
    const s = freshStore();
    const row = s.insertExchange({
      project_id: "p1", pane_id: "pane-1", state: "awaiting_approval",
      approval_id: "appr-1", approval_draft_version: 1,
    });
    const res = s.updateExchange(
      row.exchange_id,
      { state: "staged" },
      { state: "awaiting_approval", approvalId: "appr-1", approvalDraftVersion: 1 },
    );
    assert.equal(res.changed, true);
    assert.equal(res.exchange!.state, "staged");
    assert.ok(res.exchange!.updated_at >= row.updated_at);
    s.close();
  });

  it("CAS fails on a stale `state` and leaves the row untouched", () => {
    const s = freshStore();
    const row = s.insertExchange({ project_id: "p1", pane_id: "pane-1", state: "draft" });
    const res = s.updateExchange(
      row.exchange_id,
      { state: "staged" },
      { state: "awaiting_approval" }, // wrong `from` state
    );
    assert.equal(res.changed, false);
    assert.equal(res.exchange!.state, "draft", "no partial write on a lost CAS");
    s.close();
  });

  it("CAS fails on a mismatched approval_id or approval_draft_version (spec §3 exact-pair binding)", () => {
    const s = freshStore();
    const row = s.insertExchange({
      project_id: "p1", pane_id: "pane-1", state: "awaiting_approval",
      approval_id: "appr-1", approval_draft_version: 1,
    });
    const wrongVersion = s.updateExchange(
      row.exchange_id, { state: "staged" },
      { state: "awaiting_approval", approvalId: "appr-1", approvalDraftVersion: 2 },
    );
    assert.equal(wrongVersion.changed, false);

    const wrongApprovalId = s.updateExchange(
      row.exchange_id, { state: "staged" },
      { state: "awaiting_approval", approvalId: "appr-OTHER", approvalDraftVersion: 1 },
    );
    assert.equal(wrongApprovalId.changed, false);
    assert.equal(s.getExchange(row.exchange_id)!.state, "awaiting_approval");
    s.close();
  });

  it("a second CAS against an already-applied transition is a no-op (repeated event, spec §2a)", () => {
    const s = freshStore();
    const row = s.insertExchange({ project_id: "p1", pane_id: "pane-1", state: "staged" });
    const first = s.updateExchange(row.exchange_id, { state: "delivered", delivered_at: 999 }, { state: "staged" });
    assert.equal(first.changed, true);
    const second = s.updateExchange(row.exchange_id, { state: "delivered", delivered_at: 12345 }, { state: "staged" });
    assert.equal(second.changed, false, "the exchange is no longer in `staged` — stale no-op");
    assert.equal(s.getExchange(row.exchange_id)!.delivered_at, 999, "the winning write's stamp must not move");
    s.close();
  });

  it("CAS against an unknown exchange id is a harmless no-op, never throws", () => {
    const s = freshStore();
    const res = s.updateExchange("exch_nope", { state: "staged" }, { state: "draft" });
    assert.equal(res.changed, false);
    assert.equal(res.exchange, null);
    s.close();
  });
});

describe("AgentExchange spine: exchange_events (append-only)", () => {
  it("appendExchangeEvent applies documented defaults and returns the minted event_id", () => {
    const s = freshStore();
    const ev = s.appendExchangeEvent({ exchange_id: "exch_1", event_type: "exchange_created" });
    assert.ok(Number.isInteger(ev.event_id) && ev.event_id > 0);
    assert.equal(ev.project_id, null);
    assert.equal(ev.pane_id, null);
    assert.equal(ev.payload_redacted_json, "{}");
    assert.equal(ev.source, "system");
    assert.equal(ev.interaction_id, null);
    assert.ok(ev.ts > 0);
    s.close();
  });

  it("appendExchangeEvent round-trips explicit fields", () => {
    const s = freshStore();
    const ev = s.appendExchangeEvent({
      exchange_id: "exch_1",
      event_type: "approval_requested",
      project_id: "p1",
      pane_id: "pane-1",
      payload_redacted_json: JSON.stringify({ approval_id: "appr-1" }),
      source: "voice",
      interaction_id: "ixn_1",
      ts: 42,
    });
    assert.equal(ev.project_id, "p1");
    assert.equal(ev.pane_id, "pane-1");
    assert.equal(ev.payload_redacted_json, JSON.stringify({ approval_id: "appr-1" }));
    assert.equal(ev.source, "voice");
    assert.equal(ev.interaction_id, "ixn_1");
    assert.equal(ev.ts, 42);
    s.close();
  });

  it("listExchangeEvents returns the timeline ordered ts ASC, event_id ASC (deterministic tiebreak)", () => {
    const s = freshStore();
    const e1 = s.appendExchangeEvent({ exchange_id: "exch_1", event_type: "exchange_created", ts: 100 });
    const e2 = s.appendExchangeEvent({ exchange_id: "exch_1", event_type: "approval_requested", ts: 100 });
    const e3 = s.appendExchangeEvent({ exchange_id: "exch_1", event_type: "approval_confirmed", ts: 50 });
    s.appendExchangeEvent({ exchange_id: "exch_OTHER", event_type: "exchange_created", ts: 10 });

    const timeline = s.listExchangeEvents("exch_1").map((e) => e.event_id);
    assert.deepEqual(timeline, [e3.event_id, e1.event_id, e2.event_id]);
    s.close();
  });

  it("listExchangeEvents for an unknown exchange id returns an empty array", () => {
    const s = freshStore();
    assert.deepEqual(s.listExchangeEvents("exch_nope"), []);
    s.close();
  });
});

describe("AgentExchange spine: context_deliveries", () => {
  it("insertContextDelivery applies documented defaults and mints a delivery_id", () => {
    const s = freshStore();
    const d = s.insertContextDelivery({ context_version: "ctx-1", trigger: "session_start" });
    assert.ok(d.delivery_id.startsWith("ctxdel-"));
    assert.equal(d.project_id, null);
    assert.equal(d.voice_session_id, null);
    assert.equal(d.snapshot_hash, null);
    assert.equal(d.brief_hash, null);
    assert.equal(d.included_sources_json, "[]");
    assert.equal(d.dropped_sources_json, "[]");
    assert.equal(d.acknowledged_at, null);
    assert.ok(d.ts > 0);
    s.close();
  });

  it("insertContextDelivery round-trips explicit fields", () => {
    const s = freshStore();
    const d = s.insertContextDelivery({
      project_id: "p1",
      voice_session_id: "sess-1",
      context_version: "ctx-2",
      trigger: "pane_switch",
      snapshot_hash: "abc123",
      brief_hash: "def456",
      included_sources_json: JSON.stringify(["notes"]),
      dropped_sources_json: JSON.stringify(["stale"]),
      ts: 777,
    });
    assert.equal(d.project_id, "p1");
    assert.equal(d.voice_session_id, "sess-1");
    assert.equal(d.snapshot_hash, "abc123");
    assert.equal(d.brief_hash, "def456");
    assert.equal(d.included_sources_json, JSON.stringify(["notes"]));
    assert.equal(d.dropped_sources_json, JSON.stringify(["stale"]));
    assert.equal(d.ts, 777);
    s.close();
  });

  it("acknowledgeContextDelivery stamps acknowledged_at exactly once (idempotent)", () => {
    const s = freshStore();
    const d = s.insertContextDelivery({ voice_session_id: "sess-1", context_version: "ctx-1", trigger: "session_start" });
    const first = s.acknowledgeContextDelivery(d.delivery_id, 999);
    assert.equal(first, true);
    const [got] = s.listContextDeliveries("sess-1");
    assert.equal(got.acknowledged_at, 999);

    const second = s.acknowledgeContextDelivery(d.delivery_id, 111111);
    assert.equal(second, false, "already acknowledged — no re-stamp");
    const [gotAgain] = s.listContextDeliveries("sess-1");
    assert.equal(gotAgain.acknowledged_at, 999, "the first ack timestamp must not move");
    s.close();
  });

  it("acknowledgeContextDelivery on an unknown id is a harmless false, never throws", () => {
    const s = freshStore();
    assert.equal(s.acknowledgeContextDelivery("ctxdel-nope"), false);
    s.close();
  });

  it("listContextDeliveries is scoped to voice_session_id and ordered by ts ASC (index-backed)", () => {
    const s = freshStore();
    const a = s.insertContextDelivery({ voice_session_id: "sess-1", context_version: "v1", trigger: "session_start", ts: 200 });
    const b = s.insertContextDelivery({ voice_session_id: "sess-1", context_version: "v2", trigger: "pane_switch", ts: 100 });
    s.insertContextDelivery({ voice_session_id: "sess-OTHER", context_version: "v3", trigger: "session_start", ts: 50 });

    const forSess1 = s.listContextDeliveries("sess-1").map((r) => r.delivery_id);
    assert.deepEqual(forSess1, [b.delivery_id, a.delivery_id]);
    assert.deepEqual(s.listContextDeliveries("sess-ghost"), []);
    s.close();
  });
});

describe("AgentExchange spine: retention (exchange_events)", () => {
  it("pruneOnBoot (bootMaintenance) sweeps old exchange_events, keeps recent ones", () => {
    const s = freshStore();
    const now = 1_000_000_000_000;
    const day = 86_400_000;
    s.appendExchangeEvent({ exchange_id: "exch_1", event_type: "exchange_created", ts: now - 100 * day });
    s.appendExchangeEvent({ exchange_id: "exch_1", event_type: "terminal_idle", ts: now - 1 * day });

    s.bootMaintenance({ now, eventsTtlDays: 90, archiveTtlDays: 30, scrollbackDirs: [], exchangeEventsTtlDays: 30 });

    const remaining = s.listExchangeEvents("exch_1");
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].event_type, "terminal_idle");
    s.close();
  });

  it("sweepMaintenance (pruneIncremental) batches exchange_events deletes and reports `more`", () => {
    const s = freshStore();
    const now = 1_000_000_000_000;
    const day = 86_400_000;
    for (let i = 0; i < 5; i++) {
      s.appendExchangeEvent({ exchange_id: "exch_1", event_type: "exchange_created", ts: now - 100 * day - i });
    }
    s.appendExchangeEvent({ exchange_id: "exch_1", event_type: "terminal_idle", ts: now - 1 * day });

    const result = s.sweepMaintenance({
      now, eventsTtlDays: 90, archiveTtlDays: 30, exchangeEventsTtlDays: 30, batchLimit: 2,
    });
    assert.equal(result.deleted.exchange_events, 2, "one batch's worth deleted this tick");
    assert.equal(result.more, true, "backlog remains (5 stale rows, batchLimit 2)");

    // Drain the rest.
    s.sweepMaintenance({ now, eventsTtlDays: 90, archiveTtlDays: 30, exchangeEventsTtlDays: 30, batchLimit: 100 });
    const remaining = s.listExchangeEvents("exch_1");
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].event_type, "terminal_idle");
    s.close();
  });
});
