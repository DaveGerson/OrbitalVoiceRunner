// c55.15 — APPROVALS/PENDING HiTL convergence tests.
//
// Task 1 (this file, initial): the ActionContext SHAPE extension. The 5 converged approvals/pending
// REST defs (Task 2) reference `ctx.pendingActions` (the non-PTY deferred-action store) and
// `ctx.pendingApprovals.all()` — neither was on ActionContext before c55.15. This suite asserts the
// ADDITIVE extension is in place: a ctx can carry a real PendingActionStore exposing all/has/
// confirm/cancel, and pendingApprovals exposes all(). Task 2 extends this file with the toHttp
// status-contract coverage (the real behavior tests).
//
// Runner: npx tsx --test --test-force-exit tests/test_c55_15_approvals.ts

import { describe, it } from "node:test";
import assert from "node:assert";

import type { ActionContext } from "../src/actions/types";
import { PendingActionStore } from "../src/pendingActions";
import { PendingApprovalStore } from "../src/pendingApprovals";

// A minimal ctx slice carrying ONLY the two surfaces this task extends. Typed against the real
// ActionContext (via Pick) so it fails to typecheck until the fields are additively declared.
function ctxShape(): Pick<ActionContext, "pendingActions" | "pendingApprovals"> {
  return {
    pendingActions: new PendingActionStore(null),
    pendingApprovals: new PendingApprovalStore(null),
  };
}

describe("c55.15 — ActionContext extension (pendingActions + pendingApprovals.all)", () => {
  it("exposes pendingActions with all/has/confirm/cancel", () => {
    const ctx = ctxShape();
    assert.strictEqual(typeof ctx.pendingActions.all, "function", "pendingActions.all()");
    assert.strictEqual(typeof ctx.pendingActions.has, "function", "pendingActions.has()");
    assert.strictEqual(typeof ctx.pendingActions.confirm, "function", "pendingActions.confirm()");
    assert.strictEqual(typeof ctx.pendingActions.cancel, "function", "pendingActions.cancel()");
    // all() on an empty store is the [] the GET /api/actions/pending def maps over.
    assert.deepStrictEqual(ctx.pendingActions.all(), [], "empty pendingActions.all() -> []");
    assert.strictEqual(ctx.pendingActions.has("nope"), false, "unknown id -> not present");
  });

  it("exposes pendingApprovals.all() for the GET /api/commands/pending def", () => {
    const ctx = ctxShape();
    assert.strictEqual(typeof ctx.pendingApprovals.all, "function", "pendingApprovals.all()");
    assert.deepStrictEqual(ctx.pendingApprovals.all(), [], "empty pendingApprovals.all() -> []");
  });
});
