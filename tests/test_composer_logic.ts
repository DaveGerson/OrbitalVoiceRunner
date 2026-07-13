// tests/test_composer_logic.ts — CHARACTERIZATION tests for the pure WS-vs-REST draft-routing gate
// extracted out of src/App.tsx (bead dbt4 — App.tsx decomposition). The REST/WS I/O in useComposer
// (src/classic/hooks/useComposer.ts) is App/DOM-coupled and is exercised by the e2e classic net; this
// pins the ONE pure decision the former handlePromptBufferChange ran inline:
//   wsRef.current && wsRef.current.readyState === WebSocket.OPEN
//
// Runner: npx tsx --test --test-force-exit tests/test_composer_logic.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  shouldSendDraftOverWs,
  deriveExchangeApprovalState,
  exchangeReadinessSummary,
} from "../src/classic/helpers/composerLogic";

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

// Phase 3, Step 3.3 — instruction-envelope exchange draft pure derivations (src/types.ts's
// ExchangeDraftView surfacing in the Kitchen Workbench / InstructionWorkbench).
describe("composerLogic — deriveExchangeApprovalState", () => {
  it("'none' when nothing has ever been recorded as sent", () => {
    assert.strictEqual(deriveExchangeApprovalState(1, []), "none");
    assert.strictEqual(deriveExchangeApprovalState(1, [], null), "none");
    assert.strictEqual(deriveExchangeApprovalState(1, [], undefined), "none");
  });

  it("'sent' when the current draft_version is the most recently delivered one", () => {
    assert.strictEqual(deriveExchangeApprovalState(1, [1]), "sent");
    assert.strictEqual(deriveExchangeApprovalState(3, [1, 2, 3]), "sent");
  });

  it("'stale' when the draft was revised after its last delivered version", () => {
    assert.strictEqual(deriveExchangeApprovalState(2, [1]), "stale");
    assert.strictEqual(deriveExchangeApprovalState(5, [1, 3]), "stale");
  });

  it("an optimistic (client-local) delivered version counts toward 'sent'/'stale' exactly like a real sentVersions entry", () => {
    assert.strictEqual(deriveExchangeApprovalState(1, [], 1), "sent");
    assert.strictEqual(deriveExchangeApprovalState(2, [], 1), "stale");
  });

  it("takes the HIGHEST of sentVersions and the optimistic marker", () => {
    assert.strictEqual(deriveExchangeApprovalState(2, [2], 1), "sent");
    assert.strictEqual(deriveExchangeApprovalState(2, [1], 2), "sent");
  });

  // Step 3.5 (BUG-B fix follow-through): a version parked as a pending operator approval is IN
  // MOTION, not delivered — the chip must say "awaiting approval", never "delivered".
  it("'pending' when the CURRENT version is parked as a pending approval — even though it is in sentVersions (the idempotency key)", () => {
    assert.strictEqual(deriveExchangeApprovalState(1, [1], null, 1), "pending");
    assert.strictEqual(deriveExchangeApprovalState(3, [1, 3], null, 3), "pending");
  });

  it("a pending marker for an OLDER version does not shadow the live draft's state (the revise invalidates it server-side; the view degrades to stale/none)", () => {
    assert.strictEqual(deriveExchangeApprovalState(2, [1], null, 1), "stale");
    assert.strictEqual(deriveExchangeApprovalState(2, [], null, 1), "none");
  });

  it("absent/null pendingApprovalVersion changes nothing for the existing three states", () => {
    assert.strictEqual(deriveExchangeApprovalState(1, [], null, null), "none");
    assert.strictEqual(deriveExchangeApprovalState(1, [1], null, null), "sent");
    assert.strictEqual(deriveExchangeApprovalState(2, [1], null, undefined), "stale");
  });
});

describe("composerLogic — exchangeReadinessSummary", () => {
  it("'Ready to send' when ready", () => {
    assert.strictEqual(exchangeReadinessSummary({ ready: true }), "Ready to send");
  });

  it("names the single missing field's clarification when not ready", () => {
    assert.strictEqual(
      exchangeReadinessSummary({ ready: false, missing: "target", clarification: "Which pane should this go to?" }),
      "Not ready — Which pane should this go to?",
    );
    assert.strictEqual(
      exchangeReadinessSummary({ ready: false, missing: "objective", clarification: "What should I ask it to do?" }),
      "Not ready — What should I ask it to do?",
    );
  });
});
