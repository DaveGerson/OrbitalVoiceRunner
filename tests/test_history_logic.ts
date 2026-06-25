// tests/test_history_logic.ts — CHARACTERIZATION tests for the pure history-poll gate extracted out
// of src/App.tsx (bead dbt4 — App.tsx decomposition). The fetch/clear I/O and the 5s poll timer in
// useTerminalHistory (src/classic/hooks/useTerminalHistory.ts) are App/DOM-coupled and are exercised
// by the e2e classic net; this pins the ONE pure decision the hook delegates to — shouldPollHistory,
// the exact conjunction the former poll effect ran inline:
//   showHistoryPanel && activeTerminalId
//
// Runner: npx tsx --test --test-force-exit tests/test_history_logic.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import { shouldPollHistory, HISTORY_POLL_INTERVAL_MS } from "../src/classic/helpers/historyLogic";

describe("historyLogic — shouldPollHistory", () => {
  it("true only when the panel is open AND an active terminal id is present", () => {
    assert.strictEqual(shouldPollHistory(true, "t-1"), true);
  });

  it("false when the history panel is closed", () => {
    assert.strictEqual(shouldPollHistory(false, "t-1"), false);
  });

  it("false when there is no active terminal id", () => {
    assert.strictEqual(shouldPollHistory(true, null), false);
  });

  it("false when both are absent", () => {
    assert.strictEqual(shouldPollHistory(false, null), false);
  });
});

describe("historyLogic — poll cadence", () => {
  it("polls every 5000ms (VERBATIM from the original setInterval)", () => {
    assert.strictEqual(HISTORY_POLL_INTERVAL_MS, 5000);
  });
});
