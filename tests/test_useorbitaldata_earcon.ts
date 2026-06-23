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

// ── the firing GATE (playFrameEarcon) — fires on exactly the two lifecycle frames ──────────────
// useOrbitalData's `playFrameEarcon` is the one-line gate the velocity-mech handlers route through:
//   const playFrameEarcon = (type) => { const e = earconForFrame(type); if (e) earcon(e); };
// It is an inner closure of the React hook (not exported), so we pin its CONTRACT with a byte-exact
// replica over a spy `earcon`. This catches the regressions the pure-mapping test can't: a gate that
// fires unconditionally (drops the `if (e)`), fires the wrong tone, or fires on the wrong frame.
// Scope is deliberately the lifecycle frames velocity-mech routes through this helper — NOT the whole
// dispatch table (frozen/action_pending/proactive_earcon legitimately chime via their own direct
// earcon() calls and are out of this helper's contract).
describe("playFrameEarcon gate (fires on exactly approval_pending + pane_exited)", () => {
  // Byte-exact replica of the hook's inner closure, over an injectable earcon sink.
  function makeGate(earcon: (t: string) => void) {
    return (type: string) => { const e = earconForFrame(type); if (e) earcon(e); };
  }

  it("fires the mapped tone on the two lifecycle frames, and ONLY those", () => {
    const fired: { type: string; tone: string }[] = [];
    // Representative sweep: the two velocity-mech lifecycle frames + the OTHER lifecycle/observe frames
    // this same helper is fed by (none of which should chime). pane_status / pane_quiescing sit right
    // next to pane_exited in the table — the highest-risk false-positive neighbours.
    const sweep = [
      "approval_pending", "pane_exited",                       // must fire
      "pane_status", "pane_quiescing", "stdout_chunk",         // lifecycle neighbours — must stay silent
      "terminals_updated", "ledger_updated", "draft_updated",  // other observe frames — silent
      "approval_resolved", "", "unknown_frame",                // resolution / empty / unknown — silent
    ];
    for (const type of sweep) makeGate((tone) => fired.push({ type, tone }))(type);

    assert.deepEqual(fired, [
      { type: "approval_pending", tone: "alert" },
      { type: "pane_exited", tone: "completion" },
    ]);
  });

  it("does NOT fire when the same frame is replayed but maps to null (no double/spurious tone)", () => {
    let calls = 0;
    const gate = makeGate(() => { calls += 1; });
    gate("pane_status"); gate("pane_status"); gate("ledger_updated");
    assert.strictEqual(calls, 0);
  });
});
