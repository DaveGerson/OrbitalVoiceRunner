// tests/test_useorbitaldata_earcon.ts
//
// velocity-mech: the hands-free observe-frame earcon routing the orbital live-data hook uses. A
// finished pane does NOT broadcast a `pane_exited` frame (there is none) — the server emits
// `pane_transition` with transition:"exited" (src/observe/index.ts ~580). These tests drive the
// REAL exported decision + firing helpers the hook routes every observe frame through — NOT a
// byte-copy replica of the inner closure — so a re-keying / wiring regression is actually caught:
//   • earconForObserveFrame — the raw-frame → tone decision (approval_pending → "alert";
//     pane_transition{exited} → "completion"; everything else null).
//   • playObserveEarcon     — the decide-AND-FIRE gate (resolve, then ring, skipping null). This is
//     the function the hook's `playFrameEarcon` delegates to, so a spy `earcon` over it pins the
//     production firing behaviour: completion ONLY on pane_transition(exited), silence on neighbours.
//   • isPaneExitedFrame     — the guard the pane_transition arm uses to fire the in-place
//     status:"Exited" patch.
//
// PURE — no React/DOM/fetch. Imports the REAL ../src/orbital/useOrbitalDataHelpers (the same module
// the hook imports), never a local copy.
//
// Runner: npx tsx --test --test-force-exit tests/test_useorbitaldata_earcon.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  earconForObserveFrame,
  playObserveEarcon,
  isPaneExitedFrame,
} from "../src/orbital/useOrbitalDataHelpers";
import { isEarconType, type EarconType } from "../src/utils/earcon";

// The EXACT shapes src/observe/index.ts broadcasts (verified at ~580): a real pane exit, and its
// non-exit transition siblings off the SAME frame type — the highest-risk false positives.
const PANE_EXITED = { type: "pane_transition", terminalId: "t1", transition: "exited", message: "Pane t1 is now exited." };
const PANE_IDLE = { type: "pane_transition", terminalId: "t1", transition: "idle", message: "Pane t1 is now idle." };
const PANE_ERROR = { type: "pane_transition", terminalId: "t1", transition: "error", message: "Pane t1 is now error." };

describe("earconForObserveFrame — the raw-frame → tone decision", () => {
  it("approval_pending (a pane needs you) → alert", () => {
    assert.strictEqual(earconForObserveFrame({ type: "approval_pending", terminalId: "t1", cmd: "rm -rf" }), "alert");
  });

  it("pane_transition{exited} (a pane finished) → completion — keyed on the transition, not a frame type", () => {
    assert.strictEqual(earconForObserveFrame(PANE_EXITED), "completion");
  });

  it("a NON-exit pane_transition (idle/prompt/error/build-failed) → null (no tone)", () => {
    assert.strictEqual(earconForObserveFrame(PANE_IDLE), null);
    assert.strictEqual(earconForObserveFrame(PANE_ERROR), null);
    assert.strictEqual(earconForObserveFrame({ type: "pane_transition", transition: "prompt" }), null);
    assert.strictEqual(earconForObserveFrame({ type: "pane_transition", transition: "build-failed" }), null);
  });

  it("the DEAD `pane_exited` frame the server never emits → null (regression guard)", () => {
    // If anyone re-introduces a `pane_exited`-keyed handler, this stays null: there is no such frame.
    assert.strictEqual(earconForObserveFrame({ type: "pane_exited", terminalId: "t1" }), null);
  });

  it("neighbour observe frames → null (no tone)", () => {
    for (const type of ["pane_status", "pane_quiescing", "stdout_chunk", "ledger_updated", "draft_updated", "approval_resolved", "", "unknown_frame"]) {
      assert.strictEqual(earconForObserveFrame({ type }), null, `${type || "(empty)"} must be silent`);
    }
    assert.strictEqual(earconForObserveFrame({}), null);          // no type
    assert.strictEqual(earconForObserveFrame(undefined as never), null);
  });

  it("every non-null result is a real EarconType the player accepts", () => {
    for (const frame of [{ type: "approval_pending" }, PANE_EXITED]) {
      const e = earconForObserveFrame(frame);
      assert.ok(e !== null && isEarconType(e), `${frame.type} must map to a valid earcon`);
    }
  });
});

describe("isPaneExitedFrame — the in-place status:'Exited' patch guard", () => {
  it("TRUE only for pane_transition{exited}", () => {
    assert.strictEqual(isPaneExitedFrame(PANE_EXITED), true);
    assert.strictEqual(isPaneExitedFrame(PANE_IDLE), false);
    assert.strictEqual(isPaneExitedFrame(PANE_ERROR), false);
    assert.strictEqual(isPaneExitedFrame({ type: "pane_status", status: "Exited" }), false); // a status patch, not the exit edge
    assert.strictEqual(isPaneExitedFrame({ type: "pane_exited" }), false);                   // the frame that never exists
    assert.strictEqual(isPaneExitedFrame({}), false);
  });
});

// ── the firing GATE (playObserveEarcon) — the REAL decide-and-fire the hook delegates to ─────────
// useOrbitalData's `playFrameEarcon` is `() => playObserveEarcon(msg, earcon)`. We drive that SAME
// exported function over a spy `earcon`, so this catches the regressions a pure-mapping test can't: a
// gate that drops the `if (e)` and fires unconditionally, fires the wrong tone, or — the bug this
// whole change fixes — fires on a dead `pane_exited` type instead of the real pane_transition(exited).
describe("playObserveEarcon gate (fires completion on the REAL pane_transition(exited), silent on neighbours)", () => {
  it("rings the completion tone on a genuine pane_transition(exited) frame", () => {
    const fired: EarconType[] = [];
    playObserveEarcon(PANE_EXITED, (t) => fired.push(t));
    assert.deepEqual(fired, ["completion"]);
  });

  it("rings the alert tone on approval_pending", () => {
    const fired: EarconType[] = [];
    playObserveEarcon({ type: "approval_pending", terminalId: "t1", cmd: "git push" }, (t) => fired.push(t));
    assert.deepEqual(fired, ["alert"]);
  });

  it("stays SILENT on the neighbour frames sitting next to the exit edge", () => {
    let calls = 0;
    const spy = () => { calls += 1; };
    // The pane_transition siblings + the per-status/quiescing frames + a replayed exit's neighbours.
    playObserveEarcon(PANE_IDLE, spy);
    playObserveEarcon(PANE_ERROR, spy);
    playObserveEarcon({ type: "pane_transition", transition: "prompt" }, spy);
    playObserveEarcon({ type: "pane_status", terminalId: "t1", status: "Exited" }, spy);
    playObserveEarcon({ type: "pane_quiescing", terminalId: "t1" }, spy);
    playObserveEarcon({ type: "pane_exited", terminalId: "t1" }, spy); // the dead frame — must not chime
    playObserveEarcon({ type: "ledger_updated" }, spy);
    playObserveEarcon({ type: "" }, spy);
    assert.strictEqual(calls, 0);
  });

  it("does NOT double-fire when an exit frame is replayed (one tone per call, no spurious extra)", () => {
    const fired: EarconType[] = [];
    const spy = (t: EarconType) => fired.push(t);
    playObserveEarcon(PANE_EXITED, spy);
    playObserveEarcon(PANE_IDLE, spy);   // neighbour between — silent
    playObserveEarcon(PANE_EXITED, spy);
    assert.deepEqual(fired, ["completion", "completion"]);
  });
});
