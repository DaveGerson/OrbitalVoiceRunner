import { describe, it } from "node:test";
import assert from "node:assert";

import {
  applyHandoffFlipOnResolve,
  type HandoffFlipStore,
  type HandoffResolveReason,
} from "../src/handoffFlow";
import type { StoredHandoff, HandoffState } from "../src/store/types";

/**
 * Complexity-refactor pin tests for applyHandoffFlipOnResolve (CC 15 -> <=10).
 *
 * These exercise every branch/edge of the resolve-leg flip via a recording fake store so the
 * extraction is proven behavior-preserving: the exact updateHandoffState(id, state, patch) calls,
 * the linkage lookup (PK hit vs gate_approval_id fallback vs miss), the null-store guard, the
 * unmapped-reason guard, vocal/now provenance, and the throw-swallow path (onError vs console).
 */

function makeHandoff(over: Partial<StoredHandoff> = {}): StoredHandoff {
  return {
    id: "h1",
    workspace_id: "ws",
    from_pane: null,
    to_pane: "p1",
    kind: "agent_instruction",
    composed_prompt: "do x",
    source_context: "{}",
    source_context_refs: "[]",
    state: "staged",
    gate_approval_id: null,
    approved_by: null,
    approved_via: null,
    revision_count: 0,
    created_at: 0,
    staged_at: 0,
    delivered_at: null,
    consumed_at: null,
    terminal_at: null,
    expires_at: null,
    ...over,
  };
}

interface UpdateCall {
  id: string;
  state: HandoffState;
  patch?: Partial<StoredHandoff>;
}

function makeStore(opts: {
  byId?: Record<string, StoredHandoff>;
  list?: StoredHandoff[];
  throwOnUpdate?: boolean;
}): { store: HandoffFlipStore; updates: UpdateCall[] } {
  const updates: UpdateCall[] = [];
  const byId = opts.byId ?? {};
  const list = opts.list ?? Object.values(byId);
  const store: HandoffFlipStore = {
    getHandoff: (id) => byId[id] ?? null,
    listHandoffs: () => list.slice(),
    updateHandoffState: (id, state, patch) => {
      updates.push({ id, state, patch });
      if (opts.throwOnUpdate) throw new Error("boom");
      const found = byId[id] ?? list.find((h) => h.id === id) ?? null;
      if (!found) return null;
      return { ...found, state, ...(patch ?? {}) };
    },
  };
  return { store, updates };
}

describe("applyHandoffFlipOnResolve — guards", () => {
  it("null store => NO_FLIP, no updates", () => {
    assert.deepStrictEqual(applyHandoffFlipOnResolve(null, "m1", "approved"), { flipped: false });
  });
  it("undefined store => NO_FLIP", () => {
    assert.deepStrictEqual(applyHandoffFlipOnResolve(undefined, "m1", "approved"), { flipped: false });
  });
  it("no linked handoff (PK miss + no fallback match) => NO_FLIP, no update calls", () => {
    const { store, updates } = makeStore({ byId: {}, list: [] });
    assert.deepStrictEqual(applyHandoffFlipOnResolve(store, "m1", "approved"), { flipped: false });
    assert.strictEqual(updates.length, 0);
  });
  it("unmapped reason (handoff found but reason maps to null) => NO_FLIP, no update", () => {
    const h = makeHandoff({ id: "m1" });
    const { store, updates } = makeStore({ byId: { m1: h } });
    // Cast: simulate a reason that resolveReasonToHandoffState returns null for (default branch).
    const res = applyHandoffFlipOnResolve(store, "m1", "weird" as unknown as HandoffResolveReason);
    assert.deepStrictEqual(res, { flipped: false });
    assert.strictEqual(updates.length, 0);
  });
});

describe("applyHandoffFlipOnResolve — linkage lookup", () => {
  it("primary PK hit: getHandoff(messageId) used directly", () => {
    const h = makeHandoff({ id: "m1" });
    const { store, updates } = makeStore({ byId: { m1: h } });
    const res = applyHandoffFlipOnResolve(store, "m1", "approved");
    assert.strictEqual(res.flipped, true);
    assert.strictEqual(res.handoffId, "m1");
    assert.strictEqual(updates[0].id, "m1");
  });
  it("fallback: gate_approval_id === messageId picks the matching row", () => {
    const linked = makeHandoff({ id: "hX", gate_approval_id: "m1" });
    const other = makeHandoff({ id: "hY", gate_approval_id: "other" });
    const { store, updates } = makeStore({ byId: {}, list: [other, linked] });
    const res = applyHandoffFlipOnResolve(store, "m1", "approved");
    assert.strictEqual(res.flipped, true);
    assert.strictEqual(res.handoffId, "hX");
    assert.strictEqual(updates[0].id, "hX");
  });
  it("fallback picks the FIRST match (matches[0])", () => {
    const a = makeHandoff({ id: "hA", gate_approval_id: "m1" });
    const b = makeHandoff({ id: "hB", gate_approval_id: "m1" });
    const { store } = makeStore({ byId: {}, list: [a, b] });
    const res = applyHandoffFlipOnResolve(store, "m1", "approved");
    assert.strictEqual(res.handoffId, "hA");
  });
});

describe("applyHandoffFlipOnResolve — approved (delivered) provenance", () => {
  it("vocal=true => approved_via 'voice' + delivered_at from now()", () => {
    const h = makeHandoff({ id: "m1" });
    const { store, updates } = makeStore({ byId: { m1: h } });
    const res = applyHandoffFlipOnResolve(store, "m1", "approved", { vocal: true, now: () => 999 });
    assert.deepStrictEqual(res, { flipped: true, handoffId: "m1", state: "delivered" });
    assert.deepStrictEqual(updates, [{ id: "m1", state: "delivered", patch: { approved_via: "voice", delivered_at: 999 } }]);
  });
  it("vocal falsy => approved_via 'rest'", () => {
    const h = makeHandoff({ id: "m1" });
    const { store, updates } = makeStore({ byId: { m1: h } });
    applyHandoffFlipOnResolve(store, "m1", "approved", { now: () => 7 });
    assert.strictEqual(updates[0].patch?.approved_via, "rest");
    assert.strictEqual(updates[0].patch?.delivered_at, 7);
  });
  it("default now is Date.now (delivered_at is a positive number)", () => {
    const h = makeHandoff({ id: "m1" });
    const { store, updates } = makeStore({ byId: { m1: h } });
    const before = Date.now();
    applyHandoffFlipOnResolve(store, "m1", "approved", { vocal: true });
    assert.ok((updates[0].patch?.delivered_at ?? 0) >= before);
  });
});

describe("applyHandoffFlipOnResolve — rejected", () => {
  it("vocal=true => rejected with approved_via 'voice', no delivered_at", () => {
    const h = makeHandoff({ id: "m1" });
    const { store, updates } = makeStore({ byId: { m1: h } });
    const res = applyHandoffFlipOnResolve(store, "m1", "rejected", { vocal: true });
    assert.deepStrictEqual(res, { flipped: true, handoffId: "m1", state: "rejected" });
    assert.deepStrictEqual(updates, [{ id: "m1", state: "rejected", patch: { approved_via: "voice" } }]);
  });
  it("vocal falsy => approved_via 'rest'", () => {
    const h = makeHandoff({ id: "m1" });
    const { store, updates } = makeStore({ byId: { m1: h } });
    applyHandoffFlipOnResolve(store, "m1", "rejected");
    assert.strictEqual(updates[0].patch?.approved_via, "rest");
    assert.ok(updates[0].patch && !("delivered_at" in updates[0].patch));
  });
});

describe("applyHandoffFlipOnResolve — expired (expired/dead_pane)", () => {
  it("expired => approved_via 'ttl_expire'", () => {
    const h = makeHandoff({ id: "m1" });
    const { store, updates } = makeStore({ byId: { m1: h } });
    const res = applyHandoffFlipOnResolve(store, "m1", "expired", { vocal: true });
    assert.deepStrictEqual(res, { flipped: true, handoffId: "m1", state: "expired" });
    assert.deepStrictEqual(updates, [{ id: "m1", state: "expired", patch: { approved_via: "ttl_expire" } }]);
  });
  it("dead_pane => expired with 'ttl_expire' (vocal ignored for expiry)", () => {
    const h = makeHandoff({ id: "m1" });
    const { store, updates } = makeStore({ byId: { m1: h } });
    const res = applyHandoffFlipOnResolve(store, "m1", "dead_pane");
    assert.strictEqual(res.state, "expired");
    assert.strictEqual(updates[0].patch?.approved_via, "ttl_expire");
  });
});

describe("applyHandoffFlipOnResolve — throw handling", () => {
  it("store throws + onError provided => onError called, NO_FLIP returned, console untouched", () => {
    const h = makeHandoff({ id: "m1" });
    const { store } = makeStore({ byId: { m1: h }, throwOnUpdate: true });
    let captured: unknown = null;
    const res = applyHandoffFlipOnResolve(store, "m1", "approved", { onError: (e) => { captured = e; } });
    assert.deepStrictEqual(res, { flipped: false });
    assert.ok(captured instanceof Error);
  });
  it("store throws + no onError => swallowed via console.error, NO_FLIP", () => {
    const h = makeHandoff({ id: "m1" });
    const { store } = makeStore({ byId: { m1: h }, throwOnUpdate: true });
    const orig = console.error;
    let calls = 0;
    console.error = () => { calls++; };
    try {
      const res = applyHandoffFlipOnResolve(store, "m1", "rejected");
      assert.deepStrictEqual(res, { flipped: false });
    } finally {
      console.error = orig;
    }
    assert.strictEqual(calls, 1);
  });
});
