// tests/test_approval_waiting_signal.ts
//
// bead 8fz.2 — the conversational pill's "waiting" signal (OrbitalData.approvalWaiting).
//
// useOrbitalData.ts derives `approvalWaiting` as `pendingApprovalBadgeCount(attentionQueue) > 0` —
// the SAME pure, already-pinned helper the attention-inbox badge uses (attentionResolveTarget:
// only "approval"/"confirmation" items carrying a non-empty messageId count). This test pins that
// exact derivation under the "waiting" framing: true only when an undismissed item carries a
// resolvable approval target, false for plain FYI/triage attention items (idle completions, dead
// stations, errors) that have nothing for the operator to resolve.
//
// Runner: npx tsx --test --test-force-exit tests/test_approval_waiting_signal.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pendingApprovalBadgeCount } from "../src/orbital/useOrbitalDataHelpers";
import type { AttentionItem } from "../src/types";

function item(over: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: "a1", type: "idle", terminalId: "t1", projectId: "p1",
    message: "done", timestamp: "0", dismissed: false,
    ...over,
  };
}

// The exact expression useOrbitalData.ts uses for OrbitalData.approvalWaiting.
function approvalWaiting(queue: AttentionItem[]): boolean {
  return pendingApprovalBadgeCount(queue) > 0;
}

describe("approvalWaiting — the conversational pill's 'waiting' signal", () => {
  it("empty queue → false", () => {
    assert.equal(approvalWaiting([]), false);
  });

  it("a plain FYI item (idle completion) → false, even though the queue is non-empty", () => {
    assert.equal(approvalWaiting([item({ type: "idle" })]), false);
  });

  it("a triage-only item (exited/error/build-failed, no messageId) → false", () => {
    assert.equal(approvalWaiting([item({ type: "exited" }), item({ type: "error" }), item({ type: "build-failed" })]), false);
  });

  it("an approval item WITHOUT a messageId (no real held request) → false", () => {
    assert.equal(approvalWaiting([item({ type: "approval", messageId: undefined })]), false);
  });

  it("an approval item carrying a resolvable messageId → true", () => {
    assert.equal(approvalWaiting([item({ type: "approval", messageId: "m1" })]), true);
  });

  it("a confirmation item carrying a resolvable messageId → true", () => {
    assert.equal(approvalWaiting([item({ type: "confirmation", messageId: "m2" })]), true);
  });

  it("a DISMISSED approval item does not count — waiting goes false once cleared", () => {
    assert.equal(approvalWaiting([item({ type: "approval", messageId: "m1", dismissed: true })]), false);
  });

  it("a resolvable item mixed in with FYI noise still flips waiting true", () => {
    const q = [item({ type: "idle" }), item({ type: "approval", messageId: "m1" }), item({ type: "exited" })];
    assert.equal(approvalWaiting(q), true);
  });
});
