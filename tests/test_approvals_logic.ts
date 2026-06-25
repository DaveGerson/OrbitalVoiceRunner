// tests/test_approvals_logic.ts — CHARACTERIZATION tests for the pure optimistic-update filters
// extracted out of src/App.tsx (bead dbt4 — App.tsx decomposition). The REST/WS I/O in
// useApprovalsQueue (src/classic/hooks/useApprovalsQueue.ts) is App-coupled and is exercised by the
// e2e classic net (approval.spec / action.spec); this pins the two pure decisions the four handlers
// ran inline — the "drop the just-resolved item" filters:
//   handleApprove/handleReject : prev.filter(item => item.messageId !== messageId)
//   handleConfirmAction/handleCancelAction : prev.filter(a => a.actionId !== actionId)
//
// Runner: npx tsx --test --test-force-exit tests/test_approvals_logic.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import { removeByMessageId, removeByActionId } from "../src/classic/helpers/approvalsLogic";

describe("approvalsLogic — removeByMessageId", () => {
  const list = [{ messageId: "a" }, { messageId: "b" }, { messageId: "c" }];

  it("drops exactly the matching messageId", () => {
    assert.deepStrictEqual(removeByMessageId(list, "b"), [{ messageId: "a" }, { messageId: "c" }]);
  });

  it("leaves the list unchanged when no id matches", () => {
    assert.deepStrictEqual(removeByMessageId(list, "z"), [{ messageId: "a" }, { messageId: "b" }, { messageId: "c" }]);
  });

  it("does not mutate the input list", () => {
    const input = [{ messageId: "x" }, { messageId: "y" }];
    removeByMessageId(input, "x");
    assert.strictEqual(input.length, 2);
  });
});

describe("approvalsLogic — removeByActionId", () => {
  const list = [{ actionId: "1" }, { actionId: "2" }, { actionId: "3" }];

  it("drops exactly the matching actionId", () => {
    assert.deepStrictEqual(removeByActionId(list, "2"), [{ actionId: "1" }, { actionId: "3" }]);
  });

  it("leaves the list unchanged when no id matches", () => {
    assert.deepStrictEqual(removeByActionId(list, "9"), [{ actionId: "1" }, { actionId: "2" }, { actionId: "3" }]);
  });

  it("does not mutate the input list", () => {
    const input = [{ actionId: "p" }, { actionId: "q" }];
    removeByActionId(input, "q");
    assert.strictEqual(input.length, 2);
  });
});
