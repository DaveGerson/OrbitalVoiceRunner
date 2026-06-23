// tests/test_useorbitaldata_earcon.ts
//
// velocity-mech: the pure frame→earcon mapping the observe-lane handlers use for hands-free
// feedback. `approval_pending` (a pane needs you) → "alert"; `pane_exited` (a pane finished) →
// "completion". Every other frame type → null (no tone). PURE — no React/DOM/fetch.
//
// Runner: npx tsx --test --test-force-exit tests/test_useorbitaldata_earcon.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import { earconForFrame } from "../src/orbital/useOrbitalDataHelpers";
import { isEarconType } from "../src/utils/earcon";

describe("earconForFrame", () => {
  it("approval_pending → alert (a pane needs you, eyes-off)", () => {
    assert.strictEqual(earconForFrame("approval_pending"), "alert");
  });

  it("pane_exited → completion (a pane finished)", () => {
    assert.strictEqual(earconForFrame("pane_exited"), "completion");
  });

  it("any other frame type → null (no tone)", () => {
    assert.strictEqual(earconForFrame("stdout_chunk"), null);
    assert.strictEqual(earconForFrame("pane_status"), null);
    assert.strictEqual(earconForFrame("ledger_updated"), null);
    assert.strictEqual(earconForFrame(""), null);
    assert.strictEqual(earconForFrame("unknown_frame"), null);
  });

  it("every non-null result is a real EarconType the player accepts", () => {
    for (const type of ["approval_pending", "pane_exited"]) {
      const e = earconForFrame(type);
      assert.ok(e !== null && isEarconType(e), `${type} must map to a valid earcon`);
    }
  });
});
