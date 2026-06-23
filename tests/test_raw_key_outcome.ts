// tests/test_raw_key_outcome.ts — CHARACTERIZATION tests for classifyRawKeyOutcome, the raw-key
// POST status -> (earcon + toast) decision extracted out of App.writeControlKey (bead dbt4 —
// App.tsx decomposition). The 202/403/409 branch ladder (each: an earcon token + a transient
// toast with a byte-exact tone/title/detail) was relocated VERBATIM into src/appHelpers.ts so the
// per-status outcome is independently testable. writeControlKey now calls the helper and applies
// the returned earcon/toast; 2xx (and any other status) -> null (no feedback), exactly as before.
//
// Runner: npx tsx --test --test-force-exit tests/test_raw_key_outcome.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import { classifyRawKeyOutcome } from "../src/appHelpers";

describe("appHelpers — classifyRawKeyOutcome", () => {
  it("202 -> execute earcon + deferred toast (byte-exact detail uses paneId)", () => {
    const o = classifyRawKeyOutcome(202, "P7", "");
    assert.deepStrictEqual(o, {
      earcon: "execute",
      toast: {
        tone: "deferred",
        title: "Key Deferred — Awaiting Confirm",
        detail: "Pane P7: the key is queued behind a permission check. Confirm it in the pending tray.",
      },
    });
  });

  it("403 -> alert earcon + blocked toast", () => {
    const o = classifyRawKeyOutcome(403, "P7", "");
    assert.deepStrictEqual(o, {
      earcon: "alert",
      toast: {
        tone: "blocked",
        title: "Key Blocked by Policy",
        detail: "Pane P7: this key is gated Off and was not sent.",
      },
    });
  });

  it("409 with a server reason -> alert earcon + refused toast using that reason", () => {
    const o = classifyRawKeyOutcome(409, "P7", "pane is busy");
    assert.deepStrictEqual(o, {
      earcon: "alert",
      toast: { tone: "refused", title: "Key Not Delivered", detail: "pane is busy" },
    });
  });

  it("409 with an empty reason -> falls back to the default 'not the active pane' detail", () => {
    const o = classifyRawKeyOutcome(409, "P7", "");
    assert.deepStrictEqual(o, {
      earcon: "alert",
      toast: {
        tone: "refused",
        title: "Key Not Delivered",
        detail: "Pane P7 is not the active pane (or has no live process). Open it first.",
      },
    });
  });

  it("200 (and any non-202/403/409 status) -> null (silent success, no feedback)", () => {
    assert.strictEqual(classifyRawKeyOutcome(200, "P7", ""), null);
    assert.strictEqual(classifyRawKeyOutcome(204, "P7", ""), null);
    assert.strictEqual(classifyRawKeyOutcome(500, "P7", "boom"), null);
  });
});
