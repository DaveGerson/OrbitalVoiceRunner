// tests/test_composer_logic.ts — CHARACTERIZATION tests for the pure WS-vs-REST draft-routing gate
// extracted out of src/App.tsx (bead dbt4 — App.tsx decomposition). The REST/WS I/O in useComposer
// (src/classic/hooks/useComposer.ts) is App/DOM-coupled and is exercised by the e2e classic net; this
// pins the ONE pure decision the former handlePromptBufferChange ran inline:
//   wsRef.current && wsRef.current.readyState === WebSocket.OPEN
//
// Runner: npx tsx --test --test-force-exit tests/test_composer_logic.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import { shouldSendDraftOverWs } from "../src/classic/helpers/composerLogic";

// WebSocket.OPEN is 1 in the DOM spec; the helper is fed the constant explicitly so it stays
// Node-runnable. We mirror that value here.
const OPEN = 1;

describe("composerLogic — shouldSendDraftOverWs", () => {
  it("true only when the socket exists AND is OPEN", () => {
    assert.strictEqual(shouldSendDraftOverWs({ readyState: OPEN }, OPEN), true);
  });

  it("false when the socket is null (no live session)", () => {
    assert.strictEqual(shouldSendDraftOverWs(null, OPEN), false);
  });

  it("false when the socket is CONNECTING (readyState 0)", () => {
    assert.strictEqual(shouldSendDraftOverWs({ readyState: 0 }, OPEN), false);
  });

  it("false when the socket is CLOSING/CLOSED (readyState 2/3)", () => {
    assert.strictEqual(shouldSendDraftOverWs({ readyState: 2 }, OPEN), false);
    assert.strictEqual(shouldSendDraftOverWs({ readyState: 3 }, OPEN), false);
  });
});
