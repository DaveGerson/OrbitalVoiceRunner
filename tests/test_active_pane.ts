import { describe, it } from "node:test";
import assert from "node:assert";
import { isPaneActiveForWrite, inactivePaneClarify } from "../src/activePane";

describe("single-active-pane write guard (step 5)", () => {
  it("permits a write only to the pane the operator has open", () => {
    assert.strictEqual(isPaneActiveForWrite("pane_a", "pane_a"), true);
  });

  it("refuses a write to any pane other than the active one", () => {
    assert.strictEqual(isPaneActiveForWrite("pane_a", "pane_b"), false);
  });

  it("refuses every write when no pane is open (no source of truth)", () => {
    assert.strictEqual(isPaneActiveForWrite(null, "pane_a"), false);
  });

  it("explains how to switch when a non-active pane is targeted", () => {
    const msg = inactivePaneClarify("pane_a", "pane_b");
    assert.match(msg, /pane_a/);
    assert.match(msg, /switch to 'pane_b'/);
  });

  it("explains there is nowhere to write when no pane is open", () => {
    const msg = inactivePaneClarify(null, "pane_b");
    assert.match(msg, /No pane is open/i);
  });
});
