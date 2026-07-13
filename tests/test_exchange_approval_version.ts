// tests/test_exchange_approval_version.ts
//
// AgentExchange spine — focused regression suite for the draft-version / approval CAS binding
// (Phase 1, Step 1.3; spec docs/superpowers/specs/2026-07-09-agent-exchange-spine.md §3).
//
// tests/test_exchange_lifecycle.ts already covers the full transition matrix and the general
// shape of this binding; this suite pins the narrower incidents called out explicitly in the
// step 1.3 task brief so a future refactor of src/exchanges/lifecycle.ts can't silently regress
// them: (1) an edit while a review is outstanding invalidates that review, permanently; (2)
// approving a stale version is rejected even when the approval id itself is still "the same
// approval slot" conceptually re-requested; (3) approval is exactly-once even under a duplicate
// (replayed) confirm call.

import { describe, it } from "node:test";
import assert from "node:assert";

import { ExchangeMachine } from "../src/exchanges/lifecycle";

function draft(m: InstanceType<typeof ExchangeMachine>) {
  return m.create({
    projectId: "proj-1",
    paneId: "pane-1",
    operatorUtterance: "run the tests",
    distilledInstruction: "run the unit test suite",
  }).exchangeId;
}

describe("exchange approval-version binding: edit invalidates approval", () => {
  it("reviseDraft while awaiting_approval clears approvalId/approvalDraftVersion and reverts to draft", () => {
    const m = new ExchangeMachine();
    const id = draft(m);
    m.requestApproval(id, "appr-1");
    assert.equal(m.get(id)!.state, "awaiting_approval");

    const r = m.reviseDraft(id, "run only the store tests");
    assert.ok(r.ok);
    assert.equal(r.snapshot!.state, "draft");
    assert.equal(r.snapshot!.approvalId, null);
    assert.equal(r.snapshot!.approvalDraftVersion, null);
    assert.equal(r.snapshot!.draftVersion, 2);
  });

  it("the invalidated approval can never confirm, even immediately after the edit", () => {
    const m = new ExchangeMachine();
    const id = draft(m);
    m.requestApproval(id, "appr-1"); // bound @ v1
    m.reviseDraft(id, "edited");     // -> draft, v2, binding cleared

    const stale = m.confirmApproval(id, "appr-1", 1);
    assert.equal(stale.ok, false, "the old (approvalId, version) pair must never confirm again");
    assert.equal(m.get(id)!.state, "draft");
    assert.equal(m.get(id)!.deliveryAttempt, 0, "no delivery must ever result from a stale confirm");
  });

  it("a fresh approval requested after the edit binds the NEW version, and only it confirms", () => {
    const m = new ExchangeMachine();
    const id = draft(m);
    m.requestApproval(id, "appr-1");
    m.reviseDraft(id, "edited");
    const reReq = m.requestApproval(id, "appr-2");
    assert.ok(reReq.ok);
    assert.equal(reReq.snapshot!.approvalId, "appr-2");
    assert.equal(reReq.snapshot!.approvalDraftVersion, 2);

    assert.equal(m.confirmApproval(id, "appr-1", 1).ok, false, "the old id/version is dead forever");
    const win = m.confirmApproval(id, "appr-2", 2);
    assert.ok(win.ok);
    assert.equal(win.snapshot!.state, "staged");
  });
});

describe("exchange approval-version binding: approve-old-version is rejected", () => {
  it("confirming with the right approvalId but a stale draftVersion is refused", () => {
    const m = new ExchangeMachine();
    const id = draft(m);
    m.requestApproval(id, "appr-1"); // bound @ v1 -- but suppose the operator had already moved on
    // Simulate a caller racing a confirm at an old version number by asking for v0 (never valid).
    const r = m.confirmApproval(id, "appr-1", 0);
    assert.equal(r.ok, false);
    assert.equal(m.get(id)!.state, "awaiting_approval", "the exchange stays put on a version mismatch");
  });

  it("two sequential edits: only the LATEST (approvalId, version) pair can ever confirm", () => {
    const m = new ExchangeMachine();
    const id = draft(m);
    m.requestApproval(id, "appr-1");   // v1
    m.reviseDraft(id, "edit one");     // -> draft v2, binding cleared
    m.requestApproval(id, "appr-2");   // v2
    m.reviseDraft(id, "edit two");     // -> draft v3, binding cleared
    m.requestApproval(id, "appr-3");   // v3

    assert.equal(m.confirmApproval(id, "appr-1", 1).ok, false, "v1 binding is long dead");
    assert.equal(m.confirmApproval(id, "appr-2", 2).ok, false, "v2 binding is dead too");
    assert.equal(m.confirmApproval(id, "appr-3", 1).ok, false, "right id, wrong version still refused");
    const r = m.confirmApproval(id, "appr-3", 3);
    assert.ok(r.ok, "only the exact current pair confirms");
    assert.equal(r.snapshot!.state, "staged");
  });
});

describe("exchange approval-version binding: approval is exactly-once", () => {
  it("a replayed confirmApproval call (same args, called twice) only delivers once", () => {
    const m = new ExchangeMachine();
    const id = draft(m);
    m.requestApproval(id, "appr-1");

    const first = m.confirmApproval(id, "appr-1", 1);
    assert.ok(first.ok);
    assert.equal(first.snapshot!.state, "staged");

    const replay = m.confirmApproval(id, "appr-1", 1);
    assert.equal(replay.ok, false, "a replayed confirm after the CAS already won must be a no-op");
    assert.equal(m.get(id)!.state, "staged", "state does not move again");
  });

  it("exactly-once holds across an intervening delivery: a late replay cannot re-stage or re-attempt", () => {
    const m = new ExchangeMachine();
    const id = draft(m);
    m.requestApproval(id, "appr-1");
    m.confirmApproval(id, "appr-1", 1); // -> staged
    m.markDeliveryAttempted(id);
    m.markDelivered(id);                // -> delivered

    const lateReplay = m.confirmApproval(id, "appr-1", 1);
    assert.equal(lateReplay.ok, false, "confirm after delivery must not resurrect the approval leg");
    assert.equal(m.get(id)!.state, "delivered", "the delivered exchange is untouched by the replay");
    assert.equal(m.get(id)!.deliveryAttempt, 1, "no extra delivery attempt is recorded");
  });
});
