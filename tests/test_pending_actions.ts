import { describe, it } from "node:test";
import assert from "node:assert";
import { PendingActionStore } from "../src/pendingActions";

/**
 * G1 — deferred execution for gated NON-PTY mutators. Proves the PendingActionStore runs a staged
 * side effect EXACTLY ONCE on confirm, never on cancel/expire, and that the claim seam prevents a
 * double-run under a confirm/cancel race. Pure, no server.
 */

function stage(store: PendingActionStore, id: string, counter: { n: number }) {
  return store.add({
    id, capability: "create_pane", summary: `create ${id}`, timestamp: Date.now(),
    run: () => { counter.n++; return `ran ${id}`; },
  });
}

describe("PendingActionStore — deferred execution (G1)", () => {
  it("confirm runs the side effect exactly once and returns its output", () => {
    const store = new PendingActionStore();
    const c = { n: 0 };
    stage(store, "a1", c);
    const r = store.confirm("a1");
    assert.strictEqual(r.reason, "confirmed");
    assert.strictEqual(r.output, "ran a1");
    assert.strictEqual(c.n, 1);
    // entry is gone (terminal)
    assert.strictEqual(store.has("a1"), false);
  });

  it("a second confirm after the first is a no-op (not_found), effect not re-run", () => {
    const store = new PendingActionStore();
    const c = { n: 0 };
    stage(store, "a2", c);
    store.confirm("a2");
    const again = store.confirm("a2");
    assert.strictEqual(again.reason, "not_found");
    assert.strictEqual(c.n, 1);
  });

  it("cancel never runs the side effect and removes the entry", () => {
    const store = new PendingActionStore();
    const c = { n: 0 };
    stage(store, "a3", c);
    const r = store.cancel("a3");
    assert.strictEqual(r.reason, "cancelled");
    assert.strictEqual(c.n, 0);
    assert.strictEqual(store.has("a3"), false);
  });

  it("confirm after cancel is not_found (cancel claimed + removed it)", () => {
    const store = new PendingActionStore();
    const c = { n: 0 };
    stage(store, "a4", c);
    store.cancel("a4");
    const r = store.confirm("a4");
    assert.strictEqual(r.reason, "not_found");
    assert.strictEqual(c.n, 0);
  });

  it("expire drops a stale action without running it", () => {
    const store = new PendingActionStore();
    const c = { n: 0 };
    const now = 1_000_000;
    store.add({ id: "a5", capability: "create_pane", summary: "old", timestamp: now - 10_000, run: () => { c.n++; return "x"; } });
    store.add({ id: "a6", capability: "create_pane", summary: "fresh", timestamp: now - 100, run: () => { c.n++; return "y"; } });
    const stale = store.expired(5_000, now);
    assert.deepStrictEqual(stale.map(a => a.id), ["a5"]);
    store.expire("a5");
    assert.strictEqual(store.has("a5"), false);
    assert.strictEqual(store.has("a6"), true);
    assert.strictEqual(c.n, 0);
  });

  it("if run() throws, the entry is still removed (no half-applied lingering) and the error surfaces", () => {
    const store = new PendingActionStore();
    store.add({ id: "a7", capability: "create_pane", summary: "boom", timestamp: Date.now(), run: () => { throw new Error("boom"); } });
    assert.throws(() => store.confirm("a7"), /boom/);
    assert.strictEqual(store.has("a7"), false);
  });

  it("list reflects staged actions and clears on resolve", () => {
    const store = new PendingActionStore();
    const c = { n: 0 };
    stage(store, "b1", c);
    stage(store, "b2", c);
    assert.strictEqual(store.all().length, 2);
    store.confirm("b1");
    assert.deepStrictEqual(store.all().map(a => a.id), ["b2"]);
  });
});
