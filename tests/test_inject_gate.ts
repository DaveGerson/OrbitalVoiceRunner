// tests/test_inject_gate.ts — Wave 4 D2: the InjectGate unit tests. `now`/`debounceMs` are plain
// numbers threaded explicitly through InjectGate's API (it never reads Date.now()/setTimeout
// itself), so these are fake-clock tests by construction — no real timer or mock library needed.
// Every branch of the pre-cortex choke point is covered: unchanged-hash skip, debounce skip,
// changed-hash inject, session-start bypass, and the noteInjected-only-on-send state discipline
// (evaluate is PURE — state advances only when the caller explicitly confirms the brief reached
// Gemini). Spec: docs/superpowers/specs/2026-07-02-cortex-cutover-design.md D2.
import { test } from "node:test";
import assert from "node:assert/strict";
import { InjectGate } from "../src/memory/injectGate";

const DEBOUNCE_MS = 3000;
// An arbitrary large epoch-ms base, matching production Date.now() scale — the gate's default
// lastInjectedAt=0 relies on this being astronomically larger than any debounce floor.
const T0 = 1_700_000_000_000;

function gate(debounceMs: number = DEBOUNCE_MS): InjectGate {
  return new InjectGate(() => debounceMs);
}

test("first-ever evaluate (non-session-start, no prior injection): changed-hash inject", () => {
  const g = gate();
  const d = g.evaluate("hashA", "catch-up", T0);
  assert.deepEqual(d, { inject: true, skip: null });
});

test("session-start bypasses BOTH checks, even with an unchanged hash inside the debounce window", () => {
  const g = gate();
  g.noteInjected("hashA", T0);
  const d = g.evaluate("hashA", "session-start", T0 + 1); // same hash, 1ms later
  assert.deepEqual(d, { inject: true, skip: null });
});

test("unchanged-brief: same hash as the last INJECTED brief skips, even after the debounce floor elapses", () => {
  const g = gate();
  g.noteInjected("hashA", T0);
  const d = g.evaluate("hashA", "pane-switch", T0 + DEBOUNCE_MS + 1);
  assert.deepEqual(d, { inject: false, skip: "unchanged-brief" });
});

test("debounce: a changed hash inside the debounce floor skips", () => {
  const g = gate();
  g.noteInjected("hashA", T0);
  const d = g.evaluate("hashB", "pane-switch", T0 + DEBOUNCE_MS - 1);
  assert.deepEqual(d, { inject: false, skip: "debounce" });
});

test("a changed hash AFTER the debounce floor elapses injects", () => {
  const g = gate();
  g.noteInjected("hashA", T0);
  const d = g.evaluate("hashB", "pane-switch", T0 + DEBOUNCE_MS);
  assert.deepEqual(d, { inject: true, skip: null });
});

test("hash equality is checked BEFORE the debounce floor: unchanged hash wins even mid-window", () => {
  const g = gate();
  g.noteInjected("hashA", T0);
  const d = g.evaluate("hashA", "catch-up", T0 + 1); // unchanged hash, well inside the debounce floor
  assert.equal(d.skip, "unchanged-brief", "hash equality must win over the debounce check");
});

test("evaluate is PURE: repeated calls with the same inputs return the same decision (no hidden state write)", () => {
  const g = gate();
  g.noteInjected("hashA", T0);
  const d1 = g.evaluate("hashB", "pane-switch", T0 + DEBOUNCE_MS - 1);
  const d2 = g.evaluate("hashB", "pane-switch", T0 + DEBOUNCE_MS - 1);
  assert.deepEqual(d1, { inject: false, skip: "debounce" });
  assert.deepEqual(d2, d1, "evaluate must not mutate gate state — identical inputs, identical outputs");
});

test("noteInjected-only-on-send: a caller that never calls noteInjected never advances the gate", () => {
  const g = gate();
  g.noteInjected("hashA", T0);
  // Simulate a downstream drop (e.g. a stale/empty brief) AFTER the gate said "inject": the caller
  // never calls noteInjected for hashB. Re-evaluating later with the SAME hashB must behave as if
  // nothing happened — proving the gate's state didn't advance from evaluate() alone.
  const first = g.evaluate("hashB", "catch-up", T0 + DEBOUNCE_MS + 100);
  assert.equal(first.inject, true);
  const second = g.evaluate("hashB", "catch-up", T0 + DEBOUNCE_MS + 200);
  assert.deepEqual(second, first, "without noteInjected, the gate re-derives the identical decision");
});

test("noteInjected advances BOTH the hash and the timestamp for subsequent evaluations", () => {
  const g = gate();
  g.noteInjected("hashA", T0);
  g.noteInjected("hashB", T0 + 500); // a later, distinct confirmed injection
  // hashB is now the last-injected hash — re-presenting it skips as unchanged, not debounce.
  const d = g.evaluate("hashB", "pane-switch", T0 + 500 + 1);
  assert.deepEqual(d, { inject: false, skip: "unchanged-brief" });
});

test("debounceMs is read dynamically on every evaluate call, not cached at construction", () => {
  let floor = 1000;
  const g = new InjectGate(() => floor);
  g.noteInjected("hashA", T0);
  // 500ms later, still inside the 1000ms floor: debounce.
  assert.equal(g.evaluate("hashB", "catch-up", T0 + 500).skip, "debounce");
  // Shrink the floor at runtime (e.g. an operator settings PUT) — the SAME 500ms gap now clears it.
  floor = 100;
  assert.equal(g.evaluate("hashB", "catch-up", T0 + 500).inject, true);
});

test("a differently-shaped skip never mixes: unchanged-brief and debounce are mutually exclusive outcomes", () => {
  const g = gate();
  g.noteInjected("hashA", T0);
  // Unchanged hash, mid-window ⇒ unchanged-brief (not debounce), regardless of elapsed time.
  assert.equal(g.evaluate("hashA", "pane-switch", T0 + 1).skip, "unchanged-brief");
  // Changed hash, mid-window ⇒ debounce (not unchanged-brief).
  assert.equal(g.evaluate("hashZ", "pane-switch", T0 + 1).skip, "debounce");
  // Changed hash, past the window ⇒ neither — inject.
  assert.equal(g.evaluate("hashZ", "pane-switch", T0 + DEBOUNCE_MS).skip, null);
});
