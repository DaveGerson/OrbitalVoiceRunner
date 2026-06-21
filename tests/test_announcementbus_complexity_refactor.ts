/**
 * Complexity-refactor pin test for src/announcementBus.ts :: pruneAttentionQueue.
 *
 * This file exhaustively pins the CURRENT observable behavior of pruneAttentionQueue
 * (the only complexity violator, CC 12) so a behavior-preserving extraction can be
 * verified GREEN before and after. It intentionally exercises EVERY branch:
 *   - TTL eviction (active item past ttlMs)
 *   - dismissed-TTL eviction (dismissed item past dismissedTtlMs but under ttlMs)
 *   - dismissed item under dismissedTtlMs survives
 *   - NaN/unparseable timestamp treated as Infinitely old (always evicts)
 *   - cap eviction dropping oldest DISMISSED first
 *   - cap eviction dropping oldest overall when none dismissed
 *   - default cap / ttlMs / dismissedTtlMs (via the exported constants)
 *   - in-place mutation + same-reference return
 *
 * Do NOT edit tests/test_announcement_bus.ts (existing coverage) — this is additive.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  pruneAttentionQueue,
  ATTENTION_QUEUE_CAP,
  ATTENTION_TTL_MS,
  ATTENTION_DISMISSED_TTL_MS,
} from "../src/announcementBus";
import type { AttentionItem } from "../src/types";

const NOW = 1_000_000_000_000;

function item(
  id: string,
  ageMs: number,
  dismissed = false,
  badTs = false
): AttentionItem {
  return {
    id,
    type: "error",
    terminalId: "t",
    projectId: "p",
    message: "m",
    timestamp: badTs ? "not-a-date" : new Date(NOW - ageMs).toISOString(),
    dismissed,
  };
}

describe("pruneAttentionQueue — pinned behavior (complexity refactor)", () => {
  it("evicts active items strictly older than ttlMs; keeps items within ttlMs", () => {
    const q: AttentionItem[] = [
      item("fresh", 1_000),
      item("stale", ATTENTION_TTL_MS + 1),
    ];
    const ret = pruneAttentionQueue(q, NOW);
    assert.deepEqual(q.map((i) => i.id), ["fresh"]);
    assert.equal(ret, q, "returns the same array reference");
  });

  it("does NOT evict an item exactly at the ttl boundary (age === ttlMs)", () => {
    // age > ttlMs is the eviction predicate; equality must survive.
    const q: AttentionItem[] = [item("edge", ATTENTION_TTL_MS)];
    pruneAttentionQueue(q, NOW);
    assert.deepEqual(q.map((i) => i.id), ["edge"]);
  });

  it("evicts a dismissed item past the dismissed-TTL while a same-age active sibling survives", () => {
    const age = ATTENTION_DISMISSED_TTL_MS + 30_000; // past dismissed TTL, under active TTL
    const q: AttentionItem[] = [
      item("d", age, true),
      item("a", age, false),
    ];
    pruneAttentionQueue(q, NOW);
    assert.deepEqual(q.map((i) => i.id), ["a"]);
  });

  it("keeps a dismissed item that is within the dismissed-TTL", () => {
    const q: AttentionItem[] = [item("d", 1_000, true)];
    pruneAttentionQueue(q, NOW);
    assert.deepEqual(q.map((i) => i.id), ["d"]);
  });

  it("does NOT evict a dismissed item exactly at the dismissed-TTL boundary", () => {
    const q: AttentionItem[] = [item("d", ATTENTION_DISMISSED_TTL_MS, true)];
    pruneAttentionQueue(q, NOW);
    assert.deepEqual(q.map((i) => i.id), ["d"]);
  });

  it("evicts an item with a NaN/unparseable timestamp (treated as infinitely old)", () => {
    const q: AttentionItem[] = [
      item("bad", 0, false, true),
      item("fresh", 1_000),
    ];
    pruneAttentionQueue(q, NOW);
    assert.deepEqual(q.map((i) => i.id), ["fresh"]);
  });

  it("caps length, dropping the oldest DISMISSED first", () => {
    const q: AttentionItem[] = [];
    // 55 fresh items, all within TTL so none TTL-evicts; index 3 dismissed (fresh).
    for (let i = 0; i < 55; i++) q.push(item("i" + i, 1_000));
    q[3].dismissed = true;
    pruneAttentionQueue(q, NOW, { cap: 50, dismissedTtlMs: 60_000 });
    assert.ok(q.length <= 50);
    assert.ok(!q.find((i) => i.id === "i3"), "dismissed item dropped first under cap");
  });

  it("caps by dropping oldest overall (index 0) when none are dismissed", () => {
    const q: AttentionItem[] = [];
    for (let i = 0; i < 53; i++) q.push(item("i" + i, 1_000));
    pruneAttentionQueue(q, NOW, { cap: 50 });
    assert.equal(q.length, 50);
    // The three oldest (front of the array: i0,i1,i2) are removed.
    assert.ok(!q.find((i) => i.id === "i0"));
    assert.ok(!q.find((i) => i.id === "i1"));
    assert.ok(!q.find((i) => i.id === "i2"));
    assert.equal(q[0].id, "i3");
    assert.equal(q[q.length - 1].id, "i52");
  });

  it("removes multiple dismissed-then-oldest in order when far over cap", () => {
    const q: AttentionItem[] = [];
    for (let i = 0; i < 54; i++) q.push(item("i" + i, 1_000));
    q[10].dismissed = true;
    q[20].dismissed = true;
    pruneAttentionQueue(q, NOW, { cap: 50 });
    assert.equal(q.length, 50);
    // Both dismissed dropped first (findIndex picks lowest index each loop),
    // then the oldest overall (i0, i1) to reach cap=50 (54 -> 50 = 4 removed).
    assert.ok(!q.find((i) => i.id === "i10"));
    assert.ok(!q.find((i) => i.id === "i20"));
    assert.ok(!q.find((i) => i.id === "i0"));
    assert.ok(!q.find((i) => i.id === "i1"));
  });

  it("uses exported defaults when opts is omitted", () => {
    assert.equal(ATTENTION_QUEUE_CAP, 50);
    assert.equal(ATTENTION_TTL_MS, 10 * 60 * 1000);
    assert.equal(ATTENTION_DISMISSED_TTL_MS, 60 * 1000);
    const q: AttentionItem[] = [
      item("keep", 1_000),
      item("ttlGone", ATTENTION_TTL_MS + 1),
      item("dismGone", ATTENTION_DISMISSED_TTL_MS + 1, true),
    ];
    pruneAttentionQueue(q, NOW);
    assert.deepEqual(q.map((i) => i.id), ["keep"]);
  });

  it("is a no-op on an empty queue and returns the same reference", () => {
    const q: AttentionItem[] = [];
    const ret = pruneAttentionQueue(q, NOW);
    assert.equal(ret, q);
    assert.equal(q.length, 0);
  });

  it("TTL eviction runs before cap (stale items gone, then cap applied)", () => {
    const q: AttentionItem[] = [];
    // 50 fresh + 5 stale = 55 entries; stale TTL-evict to 50, so cap (50) does nothing.
    for (let i = 0; i < 50; i++) q.push(item("f" + i, 1_000));
    for (let i = 0; i < 5; i++) q.push(item("s" + i, ATTENTION_TTL_MS + 1));
    pruneAttentionQueue(q, NOW, { cap: 50 });
    assert.equal(q.length, 50);
    assert.ok(q.every((i) => i.id.startsWith("f")), "only fresh items remain");
  });
});
