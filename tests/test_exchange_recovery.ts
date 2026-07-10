// tests/test_exchange_recovery.ts
//
// AgentExchange spine — STORE-BACKED boot recovery (Phase 1, Step 1.4; spec
// docs/superpowers/specs/2026-07-09-agent-exchange-spine.md §4 "Restart behavior: durable state,
// recovery, quarantine").
//
// `tests/test_exchange_lifecycle.ts` already pins the PURE classification rule
// (`recoveryDisposition`) and `ExchangeMachine.recoverOnBoot`'s in-memory contract. This suite pins
// the missing bridge — `src/exchanges/recovery.ts`'s `recoverExchangesOnBoot`, which walks the
// DURABLE `agent_exchanges` rows a real process restart actually starts with (a fresh boot's
// ExchangeMachine is empty; the truth lives in SQLite) and applies the SAME disposition through the
// store's own guarded CAS — so a lost race is a no-op, never a second write, never invented history.

import { describe, it } from "node:test";
import assert from "node:assert";

import { JanusStore } from "../src/store/sqliteStore";
import { recoverExchangesOnBoot } from "../src/exchanges/recovery";
import type { ExchangeState } from "../src/exchanges/lifecycle";

function freshStore(): JanusStore {
  const s = new JanusStore(":memory:");
  s.init();
  return s;
}

function insertPendingApprovalRow(s: JanusStore, id: string, paneId: string): void {
  s.insertPendingApproval({
    id, session_id: "sess-1", workspace_id: "w1", pane_id: paneId,
    command: "do it", kind: "agent_instruction", rationale: null,
    claimed: false, timestamp: Date.now(), expires_at: Date.now() + 100000,
    exchange_id: null,
  });
}

describe("AgentExchange spine: boot recovery — restart BEFORE approval", () => {
  it("draft / awaiting_clarification are pure durable text — kept untouched, no event appended", () => {
    const s = freshStore();
    const draft = s.insertExchange({ project_id: "p1", pane_id: "pane-1", state: "draft" });
    const clarifying = s.insertExchange({ project_id: "p1", pane_id: "pane-1", state: "awaiting_clarification" });

    const report = recoverExchangesOnBoot(s);

    assert.ok(report.kept.includes(draft.exchange_id));
    assert.ok(report.kept.includes(clarifying.exchange_id));
    assert.strictEqual(s.getExchange(draft.exchange_id)!.state, "draft");
    assert.strictEqual(s.getExchange(clarifying.exchange_id)!.state, "awaiting_clarification");
    assert.deepStrictEqual(s.listExchangeEvents(draft.exchange_id), [], "a kept row gets no recovery event");
    s.close();
  });

  it("awaiting_approval: KEPT when the durable pending_approvals row survives the crash", () => {
    const s = freshStore();
    insertPendingApprovalRow(s, "appr-1", "pane-1");
    const row = s.insertExchange({
      project_id: "p1", pane_id: "pane-1", state: "awaiting_approval",
      approval_id: "appr-1", approval_draft_version: 1,
    });

    const report = recoverExchangesOnBoot(s);

    assert.ok(report.kept.includes(row.exchange_id));
    assert.ok(!report.reverted.includes(row.exchange_id));
    const after = s.getExchange(row.exchange_id)!;
    assert.strictEqual(after.state, "awaiting_approval");
    assert.strictEqual(after.approval_id, "appr-1", "the binding survives — never assumed lost");
    s.close();
  });

  it("awaiting_approval: REVERTED to draft (never resent, never assumed confirmed) when the approval row is gone", () => {
    const s = freshStore();
    // No matching pending_approvals row inserted — simulates claimed+deleted or TTL-swept mid-crash.
    const row = s.insertExchange({
      project_id: "p1", pane_id: "pane-1", state: "awaiting_approval",
      approval_id: "appr-GONE", approval_draft_version: 3,
    });

    const report = recoverExchangesOnBoot(s);

    assert.ok(report.reverted.includes(row.exchange_id));
    assert.ok(!report.kept.includes(row.exchange_id));
    const after = s.getExchange(row.exchange_id)!;
    assert.strictEqual(after.state, "draft", "reverted, not left dangling in awaiting_approval");
    assert.strictEqual(after.approval_id, null, "the stale binding is cleared");
    assert.strictEqual(after.approval_draft_version, null);
    assert.strictEqual(after.delivery_attempt, 0, "recovery never delivers");

    const events = s.listExchangeEvents(row.exchange_id);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].event_type, "exchange_recovered");
    assert.strictEqual(JSON.parse(events[0].payload_redacted_json).disposition, "reverted_missing_approval");
    s.close();
  });
});

describe("AgentExchange spine: boot recovery — restart AFTER delivery-attempt, before confirmation", () => {
  it("staged with a recorded delivery attempt quarantines to interrupted — the uncertain-delivery signature", () => {
    const s = freshStore();
    const row = s.insertExchange({ project_id: "p1", pane_id: "pane-1", state: "staged", delivery_attempt: 1 });

    const report = recoverExchangesOnBoot(s);

    assert.ok(report.interrupted.includes(row.exchange_id));
    const after = s.getExchange(row.exchange_id)!;
    assert.strictEqual(after.state, "interrupted");
    assert.strictEqual(after.delivery_attempt, 1, "the attempt count is preserved as forensic evidence, not erased");

    const events = s.listExchangeEvents(row.exchange_id);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].event_type, "exchange_recovered");
    const payload = JSON.parse(events[0].payload_redacted_json);
    assert.strictEqual(payload.disposition, "interrupted");
    assert.strictEqual(payload.from_state, "staged");
    s.close();
  });

  it("NO DUPLICATE DELIVERY after recovery: a quarantined exchange can never CAS staged->delivered again", () => {
    const s = freshStore();
    const row = s.insertExchange({ project_id: "p1", pane_id: "pane-1", state: "staged", delivery_attempt: 1 });
    recoverExchangesOnBoot(s);
    assert.strictEqual(s.getExchange(row.exchange_id)!.state, "interrupted");

    // Any code path that still believes the exchange is 'staged' and tries to complete delivery
    // loses the CAS — the interrupted state is a hard wall, never silently resent.
    const resend = s.updateExchange(row.exchange_id, { state: "delivered", delivered_at: Date.now() }, { state: "staged" });
    assert.strictEqual(resend.changed, false, "an interrupted exchange must never be resent as delivered");
    assert.strictEqual(s.getExchange(row.exchange_id)!.state, "interrupted", "state is unchanged by the rejected resend");
    s.close();
  });
});

describe("AgentExchange spine: boot recovery — restart AFTER delivered / observed in-flight", () => {
  for (const state of ["delivered", "running", "needs_input", "terminal_idle"] as ExchangeState[]) {
    it(`${state}: quarantines to interrupted (the observed PTY no longer exists after an inert boot)`, () => {
      const s = freshStore();
      const row = s.insertExchange({ project_id: "p1", pane_id: "pane-1", state, delivery_attempt: 1, delivered_at: 1000 });

      const report = recoverExchangesOnBoot(s);

      assert.ok(report.interrupted.includes(row.exchange_id));
      assert.strictEqual(s.getExchange(row.exchange_id)!.state, "interrupted");
      s.close();
    });
  }

  it("already-settled exchanges (agent_complete/agent_failed/cancelled/interrupted) are kept, untouched, no event", () => {
    const s = freshStore();
    const ids = (["agent_complete", "agent_failed", "cancelled", "interrupted"] as ExchangeState[]).map(
      (state) => s.insertExchange({ project_id: "p1", pane_id: "pane-1", state }).exchange_id
    );

    const report = recoverExchangesOnBoot(s);

    for (const id of ids) {
      assert.ok(report.kept.includes(id), `${id} should be kept`);
      assert.deepStrictEqual(s.listExchangeEvents(id), [], `${id} gets no recovery event — already settled`);
    }
    s.close();
  });
});

describe("AgentExchange spine: boot recovery — ambiguous member quarantine (dispatch-group correlation)", () => {
  it("a dispatch-group member's exchange (envelope carries dispatch_group_id) quarantines exactly like any other in-flight exchange", () => {
    // Step 1.4 does NOT persist DispatchJoinTracker groups (they stay in-memory, session-scoped —
    // see src/dispatch/joinTracker.ts's own module doc). Each member IS an agent_exchanges row, so
    // "ambiguous member correlation cannot be re-established after a restart" reduces to exactly
    // this: the member's own exchange row quarantines via the SAME general rule, no special-casing.
    const s = freshStore();
    const row = s.insertExchange({
      project_id: "p1", pane_id: "pane-1", state: "running",
      instruction_envelope_json: JSON.stringify({ dispatch_group_id: "dg-1" }),
    });

    const report = recoverExchangesOnBoot(s);

    assert.ok(report.interrupted.includes(row.exchange_id));
    const after = s.getExchange(row.exchange_id)!;
    assert.strictEqual(after.state, "interrupted");
    assert.strictEqual(
      JSON.parse(after.instruction_envelope_json).dispatch_group_id, "dg-1",
      "the reporting label survives quarantine for the operator-facing digest"
    );
    s.close();
  });

  it("a group with ONE ambiguous (in-flight) member and one already-settled member: only the ambiguous one is touched", () => {
    const s = freshStore();
    const ambiguous = s.insertExchange({
      project_id: "p1", pane_id: "pane-1", state: "delivered",
      instruction_envelope_json: JSON.stringify({ dispatch_group_id: "dg-2" }),
    });
    const settled = s.insertExchange({
      project_id: "p1", pane_id: "pane-2", state: "agent_complete",
      instruction_envelope_json: JSON.stringify({ dispatch_group_id: "dg-2" }),
    });

    const report = recoverExchangesOnBoot(s);

    assert.ok(report.interrupted.includes(ambiguous.exchange_id));
    assert.ok(report.kept.includes(settled.exchange_id));
    assert.strictEqual(s.getExchange(settled.exchange_id)!.state, "agent_complete", "settled member is immutable");
    s.close();
  });
});

describe("AgentExchange spine: boot recovery — idempotent, never-throws", () => {
  it("running recovery twice is a harmless no-op the second time (already-interrupted rows are kept, not re-quarantined)", () => {
    const s = freshStore();
    const row = s.insertExchange({ project_id: "p1", pane_id: "pane-1", state: "delivered" });

    const first = recoverExchangesOnBoot(s);
    assert.ok(first.interrupted.includes(row.exchange_id));

    const second = recoverExchangesOnBoot(s);
    assert.ok(!second.interrupted.includes(row.exchange_id), "already interrupted -> classified as kept, not re-interrupted");
    assert.ok(second.kept.includes(row.exchange_id));
    assert.strictEqual(s.getExchange(row.exchange_id)!.state, "interrupted");
    s.close();
  });

  it("an empty store recovers cleanly (no rows, no throw, empty report)", () => {
    const s = freshStore();
    const report = recoverExchangesOnBoot(s);
    assert.deepStrictEqual(report, { kept: [], interrupted: [], reverted: [] });
    s.close();
  });
});
