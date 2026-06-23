// tests/test_use_live_session.ts — CHARACTERIZATION tests for the live voice-session lifecycle
// helpers extracted out of src/App.tsx (bead dbt4 — App.tsx decomposition, mirroring the DBT5
// server.ts strangler-fig). The live-session machinery (ws + audio refs, connect/start/stop/cleanup
// + the auto-reconnect-on-unexpected-close decision) was relocated VERBATIM into
// src/hooks/useLiveSession.ts. The pure, browser-API-free pieces are pinned here so the
// behavior-preserving extraction changes nothing observable:
//
//   * disposeRefs   — the guarded teardown/null-out loop (cleanupSocketOnly's body).
//   * planReconnect — the onclose/catch reconnect decision (desiredLive -> live+reconnecting+timer,
//                     else -> not-live). This is the EXACT branch the closure ran inline before.
//
// The React hook itself (useLiveSession) is irreducibly browser-coupled (WebSocket/AudioContext/
// navigator.mediaDevices) and is exercised by the e2e voice journeys; these unit pins lock the
// decision logic the hook delegates to.
//
// Runner: npx tsx --test --test-force-exit tests/test_use_live_session.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import { disposeRefs, planReconnect } from "../src/hooks/liveSessionLogic";

// ═════════════════════════════════════════════════════════════════════════════
// 1. disposeRefs — guarded close + null-out for each ref, swallowing close errors.
// ═════════════════════════════════════════════════════════════════════════════
describe("liveSessionLogic — disposeRefs", () => {
  it("closes each non-null ref in order and nulls it out", () => {
    const order: string[] = [];
    const a = { current: "A" as string | null };
    const b = { current: "B" as string | null };
    disposeRefs([
      [a, (v) => order.push(`close:${v}`)],
      [b, (v) => order.push(`close:${v}`)],
    ]);
    assert.deepStrictEqual(order, ["close:A", "close:B"]);
    assert.strictEqual(a.current, null);
    assert.strictEqual(b.current, null);
  });

  it("skips a null ref (no close call, stays null)", () => {
    let called = false;
    const a = { current: null as string | null };
    disposeRefs([[a, () => { called = true; }]]);
    assert.strictEqual(called, false);
    assert.strictEqual(a.current, null);
  });

  it("swallows a throwing close() but STILL nulls the ref out", () => {
    const a = { current: "X" as string | null };
    disposeRefs([[a, () => { throw new Error("boom"); }]]);
    assert.strictEqual(a.current, null); // nulled despite the throw
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. planReconnect — the onclose/catch reconnect decision.
// ═════════════════════════════════════════════════════════════════════════════
describe("liveSessionLogic — planReconnect", () => {
  it("desiredLive=true -> stays live, marks reconnecting, schedules a retry", () => {
    const p = planReconnect(true);
    assert.deepStrictEqual(p, { live: true, reconnecting: true, scheduleRetry: true });
  });

  it("desiredLive=false -> drops live, clears reconnecting, no retry", () => {
    const p = planReconnect(false);
    assert.deepStrictEqual(p, { live: false, reconnecting: false, scheduleRetry: false });
  });
});
