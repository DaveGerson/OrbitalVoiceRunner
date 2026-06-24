// tests/test_earcon_logic.ts — CHARACTERIZATION tests for the pure desktop-notification gate
// extracted out of src/App.tsx (bead dbt4 — App.tsx decomposition). The Web-Audio earcon GRAPH in
// useEarcons (src/classic/hooks/useEarcons.ts) is irreducibly browser-coupled and is exercised by
// the e2e voice journeys; this pins the ONE pure decision the hook delegates to — shouldNotify, the
// exact conjunction the former triggerDesktopNotification ran inline:
//   browserNotificationsEnabled && "Notification" in window && Notification.permission === "granted"
//
// Runner: npx tsx --test --test-force-exit tests/test_earcon_logic.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import { shouldNotify } from "../src/classic/helpers/earconLogic";

describe("earconLogic — shouldNotify", () => {
  it("true only when enabled AND API present AND permission granted", () => {
    assert.strictEqual(shouldNotify(true, true, "granted"), true);
  });

  it("false when the operator toggle is off", () => {
    assert.strictEqual(shouldNotify(false, true, "granted"), false);
  });

  it("false when the host lacks the Notification API", () => {
    assert.strictEqual(shouldNotify(true, false, "granted"), false);
  });

  it("false when permission is not granted (denied / default)", () => {
    assert.strictEqual(shouldNotify(true, true, "denied"), false);
    assert.strictEqual(shouldNotify(true, true, "default"), false);
  });
});
