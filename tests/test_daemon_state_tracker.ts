import { test } from "node:test";
import assert from "node:assert/strict";
import { createDaemonStateTracker } from "../src/memory/daemonStateTracker";

/** A fully deterministic fake clock — no real timers, so msInFallback assertions are exact. */
function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

test("boot -> python (no prior fallback) reports {0,0,false}", () => {
  const tracker = createDaemonStateTracker(() => 1000);
  tracker.onTransition("python");
  assert.deepEqual(tracker.stats(), { transitions: 0, msInFallback: 0, currentlyFallback: false });
});

test("a python -> fallback -> python cycle reports transitions=1 and the exact fallback duration", () => {
  const clk = fakeClock(1_000_000);
  const tracker = createDaemonStateTracker(clk.now);
  tracker.onTransition("python");   // first up
  clk.advance(500);
  tracker.onTransition("fallback"); // degrade at t=500
  clk.advance(250);                 // 250ms degraded
  tracker.onTransition("python");   // recover at t=750
  const s = tracker.stats();
  assert.equal(s.transitions, 1);
  assert.equal(s.msInFallback, 250); // exactly the closed fallback window
  assert.equal(s.currentlyFallback, false);
});

test("WARM-UP IMMUNITY: a 'fallback' before any 'python' reports transitions=0", () => {
  // This is the lock that MUST fail if the firstUp gating is removed: a boot-time fallback is
  // warm-up, not a degradation.
  const clk = fakeClock(1_000_000);
  const tracker = createDaemonStateTracker(clk.now);
  tracker.onTransition("fallback"); // boot warm-up — must be ignored
  clk.advance(1000);
  const s = tracker.stats();
  assert.equal(s.transitions, 0);
  assert.equal(s.msInFallback, 0);          // no counted window opened
  assert.equal(s.currentlyFallback, false); // boot fallback did NOT open a counted window
  // and a subsequent real cold-start completion still reports a clean 0-degradation daemon
  tracker.onTransition("python");
  assert.deepEqual(tracker.stats(), { transitions: 0, msInFallback: 0, currentlyFallback: false });
});

test("currentlyFallback reflects an OPEN window and stats() accrues live time via the fake clock", () => {
  const clk = fakeClock(1_000_000);
  const tracker = createDaemonStateTracker(clk.now);
  tracker.onTransition("python");   // first up
  tracker.onTransition("fallback"); // open a degradation window at t=0
  assert.equal(tracker.stats().currentlyFallback, true);
  assert.equal(tracker.stats().msInFallback, 0); // window just opened
  clk.advance(400);
  // live accrual: the open window contributes now()-inFallbackSince WITHOUT a recover transition
  const s = tracker.stats();
  assert.equal(s.currentlyFallback, true);
  assert.equal(s.msInFallback, 400);
  assert.equal(s.transitions, 1);
});

test("multiple drops increment transitions and sum every fallback window", () => {
  const clk = fakeClock(1_000_000);
  const tracker = createDaemonStateTracker(clk.now);
  tracker.onTransition("python"); // first up
  // drop #1: 100ms degraded
  tracker.onTransition("fallback");
  clk.advance(100);
  tracker.onTransition("python");
  // drop #2: 300ms degraded
  tracker.onTransition("fallback");
  clk.advance(300);
  tracker.onTransition("python");
  const s = tracker.stats();
  assert.equal(s.transitions, 2);
  assert.equal(s.msInFallback, 400); // 100 + 300
  assert.equal(s.currentlyFallback, false);
});

test("repeated 'python' transitions are idempotent and do not double-close a window", () => {
  const clk = fakeClock(1_000_000);
  const tracker = createDaemonStateTracker(clk.now);
  tracker.onTransition("python");
  tracker.onTransition("fallback");
  clk.advance(200);
  tracker.onTransition("python"); // recover, closes the 200ms window
  clk.advance(1000);
  tracker.onTransition("python"); // redundant up — must not change anything
  const s = tracker.stats();
  assert.equal(s.transitions, 1);
  assert.equal(s.msInFallback, 200);
  assert.equal(s.currentlyFallback, false);
});

test("default clock (Date.now) is wired when no clock is injected", () => {
  // Smoke that the default param is the real millisecond clock: an open window accrues > 0 across a
  // tiny real wait without an injected clock.
  const tracker = createDaemonStateTracker();
  tracker.onTransition("python");
  tracker.onTransition("fallback");
  const before = tracker.stats().msInFallback;
  // busy-wait a hair so wall-clock advances deterministically without a timer
  const target = Date.now() + 2;
  while (Date.now() < target) { /* spin briefly */ }
  assert.ok(tracker.stats().msInFallback >= before);
});
