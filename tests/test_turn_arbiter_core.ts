// tests/test_turn_arbiter_core.ts — Wave 1 RED: the turn-arbiter PURE decision core.
//
// Pins the W1 contract of src/voice/turnArbiter.ts (spec docs/superpowers/specs/
// 2026-07-29-turn-arbiter-design.md §3.1, §4-W1, §5-T2; audit §2.1/§2.5). The module does NOT
// exist yet — every test here must fail with "Wave-1 feature absent" until it is implemented.
//
// ── Pinned API (the implementer builds EXACTLY this surface) ────────────────────────────────────
//   export const TTL_FLOOR_EXTENSION_CAP_MS = 60_000;                       // D1
//   export const DEFAULT_DELIVERY_MATRIX;   // {0:"forced-turn",2:"forced-turn",3:"steered-digest",
//                                           //  4:"steered-digest",5:"passive-context"} — class 1 undialed
//   export function normalizeDeliveryMatrix(raw: unknown): { matrix; violations: string[] };
//   export function createTurnArbiter(opts?: { matrix?: unknown }): {
//     submit(item: { facts: string; cls: 0|1|2|3|4|5; paneId?: string; coalesceKey?: string;
//                    deadline?: { expiresAt: number; onExpirySwap: string } }): void;
//     evaluate(ctx: { now: number; floorHeld: boolean; turnClear: boolean }):
//         { action: "hold" }
//       | { action: "drain"; digest: Digest; mode: "forced-turn"|"steered-digest"|"passive-context" }
//       | { action: "interrupt-at-phrase-boundary"; digest: Digest };       // D1 cap reached
//     floorPausedMs(coalesceKey: string): number;  // W2's gating sweep consults this per last-call
//   };
//   Digest = {
//     headline: DigestItem;            // the single highest-class (lowest cls number) item, spoken fully
//     tail: DigestItem[];              // severity-ordered (cls ascending, FIFO within a class)
//     tailCount: number;               // === tail.length (post-coalescing)
//     tailGroups: { coalesceKey?: string; count: number }[];  // "three panes finished" grouping (D2)
//   };
//   DigestItem = { facts: string; cls: number; paneId?: string; coalesceKey?: string;
//                  forVisualStack: boolean };  // every TAIL item true — D2 told-more floor
//
// ── Pinned semantics ───────────────────────────────────────────────────────────────────────────
//   • PURE + synchronous: no I/O, no timers, no Date.now — the caller supplies `now` (LOCKED seam:
//     turn timing stays in-process TS). State machine over the evaluate() call sequence is fine.
//   • Coalescing: same (coalesceKey, paneId) → latest-wins single item (resubmission updates facts,
//     never duplicates — the sweep re-fires every tick). Same coalesceKey across DIFFERENT panes →
//     distinct items, ONE counted tailGroup ("pane-completion" ×3).
//   • Class 1 (operator-response) is exempt: never queued — it drains immediately on the next
//     evaluate() regardless of floor/turn state, mode "forced-turn", WITHOUT flushing the classes
//     2–5 queue when the turn is not clear (those wait for turn-clear; told-more: they still drain).
//   • D1 TTL-pause: while floorHeld (observed via the evaluate ctx sequence), a class-2 item's TTL
//     pauses; accumulated pause is capped at TTL_FLOOR_EXTENSION_CAP_MS. Once the cap is consumed
//     and the (extended) deadline is reached with the floor still held, evaluate returns
//     interrupt-at-phrase-boundary carrying the item (delivered, not re-fired). A class-2 item that
//     expires while merely queued (floor NOT held) drains as its deadline.onExpirySwap facts — the
//     honest expiry notice, never the stale last-call.
//   • Drain: at most ONE spoken turn per turn-clear — a single evaluate() flushes ALL pending items
//     into one digest; the next evaluate() holds. Nothing is ever silently dropped in ANY
//     configuration (never-drop, the standing invariant).
//   • D4 floor in the CORE (defense in depth): classes 0–2 never yield a passive-context drain even
//     if a hostile/under-floor matrix is injected raw — clamped up to steered-digest.
//
// Runner: npx tsx --test --test-force-exit tests/test_turn_arbiter_core.ts

import { test } from "node:test";
import assert from "node:assert";

type AnyRec = Record<string, any>;

// Computed specifier: tsc must NOT try to resolve this while the module is unimplemented (lint
// stays green during RED); tsx resolves it at runtime exactly like the static test imports.
const ARBITER_SPEC = ["..", "src", "voice", "turnArbiter"].join("/");

async function loadArbiter(): Promise<AnyRec> {
  try {
    return await import(ARBITER_SPEC);
  } catch (e: any) {
    return assert.fail(
      "Wave-1 feature absent: src/voice/turnArbiter.ts is not implemented yet " +
        `(turn-arbiter spec §3.1) — import failed: ${e?.message ?? e}`,
    );
  }
}

function freshArbiter(mod: AnyRec, opts?: AnyRec): AnyRec {
  assert.strictEqual(typeof mod.createTurnArbiter, "function", "createTurnArbiter must be exported");
  return mod.createTurnArbiter(opts);
}

// ── basics ─────────────────────────────────────────────────────────────────────────────────────

test("module exports the Wave-1 decision surface", async () => {
  const mod = await loadArbiter();
  assert.strictEqual(typeof mod.createTurnArbiter, "function");
  assert.strictEqual(typeof mod.normalizeDeliveryMatrix, "function");
  assert.strictEqual(mod.TTL_FLOOR_EXTENSION_CAP_MS, 60_000, "D1 pause cap is exactly 60s");
  assert.ok(mod.DEFAULT_DELIVERY_MATRIX && typeof mod.DEFAULT_DELIVERY_MATRIX === "object");
  const arb = freshArbiter(mod);
  assert.strictEqual(typeof arb.submit, "function");
  assert.strictEqual(typeof arb.evaluate, "function");
  assert.strictEqual(typeof arb.floorPausedMs, "function", "the W2 gating sweep consults floorPausedMs");
});

test("holds with an empty queue and holds while the turn is not clear", async () => {
  const mod = await loadArbiter();
  const arb = freshArbiter(mod);
  const now = 1_000_000;
  assert.strictEqual(arb.evaluate({ now, floorHeld: false, turnClear: true }).action, "hold");
  arb.submit({ facts: "pane 3 finished the build", cls: 4, paneId: "p3" });
  assert.strictEqual(
    arb.evaluate({ now: now + 100, floorHeld: false, turnClear: false }).action,
    "hold",
    "a class-4 ack must wait for turn-clear",
  );
});

test("single item drains once at turn-clear, then the arbiter holds (no re-drain)", async () => {
  const mod = await loadArbiter();
  const arb = freshArbiter(mod);
  const now = 1_000_000;
  arb.submit({ facts: "pane 3 finished the build", cls: 4, paneId: "p3" });
  const d = arb.evaluate({ now, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain");
  assert.strictEqual(d.digest.headline.facts, "pane 3 finished the build");
  assert.strictEqual(d.digest.headline.cls, 4);
  assert.deepStrictEqual(d.digest.tail, [], "single item → empty tail");
  assert.strictEqual(d.digest.tailCount, 0);
  assert.strictEqual(
    arb.evaluate({ now: now + 1, floorHeld: false, turnClear: true }).action,
    "hold",
    "a drained item must never fire twice",
  );
});

// ── severity ordering + one-turn-per-drain (D2/D3) ─────────────────────────────────────────────

test("one drain flushes ALL pending items severity-ordered: headline = highest class, tail ascending FIFO", async () => {
  const mod = await loadArbiter();
  const arb = freshArbiter(mod);
  const now = 1_000_000;
  arb.submit({ facts: "context: pane 5 printed a warning", cls: 5, paneId: "p5" });
  arb.submit({ facts: "pane 1 finished first", cls: 3, paneId: "p1" });
  arb.submit({ facts: "approve the deploy now or I'll drop it", cls: 2, coalesceKey: "last-call:appr-1" });
  arb.submit({ facts: "pane 2 finished second", cls: 3, paneId: "p2" });
  const d = arb.evaluate({ now, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain");
  assert.strictEqual(d.digest.headline.cls, 2, "headline is the highest class present");
  assert.strictEqual(d.digest.headline.facts, "approve the deploy now or I'll drop it");
  assert.deepStrictEqual(
    d.digest.tail.map((t: AnyRec) => t.facts),
    ["pane 1 finished first", "pane 2 finished second", "context: pane 5 printed a warning"],
    "tail is cls-ascending, FIFO within a class",
  );
  assert.strictEqual(d.digest.tailCount, 3);
  assert.strictEqual(
    arb.evaluate({ now: now + 1, floorHeld: false, turnClear: true }).action,
    "hold",
    "at most ONE spoken turn per turn-clear: everything went out in a single digest",
  );
});

test("D2 told-more floor: every tail fact is flagged for the visual stack", async () => {
  const mod = await loadArbiter();
  const arb = freshArbiter(mod);
  arb.submit({ facts: "restart failed on pane 2", cls: 0, paneId: "p2", coalesceKey: "correction:p2" });
  arb.submit({ facts: "pane 1 finished", cls: 3, paneId: "p1", coalesceKey: "pane-completion" });
  arb.submit({ facts: "context: idle edge", cls: 5, paneId: "p4" });
  const d = arb.evaluate({ now: 1_000_000, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain");
  assert.ok(d.digest.tail.length === 2, "two tail items expected");
  for (const t of d.digest.tail) {
    assert.strictEqual(t.forVisualStack, true, `tail fact "${t.facts}" must be flagged for the visual stack`);
  }
});

// ── coalescing (D2) ────────────────────────────────────────────────────────────────────────────

test("coalescing is latest-wins per (coalesceKey, paneId): resubmission updates, never duplicates", async () => {
  const mod = await loadArbiter();
  const arb = freshArbiter(mod);
  arb.submit({ facts: "approve now — 30s left", cls: 2, coalesceKey: "last-call:appr-9" });
  arb.submit({ facts: "approve now — 10s left", cls: 2, coalesceKey: "last-call:appr-9" });
  const d = arb.evaluate({ now: 1_000_000, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain");
  const all = [d.digest.headline, ...d.digest.tail];
  const hits = all.filter((it: AnyRec) => it.coalesceKey === "last-call:appr-9");
  assert.strictEqual(hits.length, 1, "the sweep re-fires every tick — the same last-call must appear ONCE");
  assert.strictEqual(hits[0].facts, "approve now — 10s left", "latest submission wins");
});

test("a shared coalesceKey across panes groups the tail count ('three panes finished')", async () => {
  const mod = await loadArbiter();
  const arb = freshArbiter(mod);
  arb.submit({ facts: "deploy expires in a minute", cls: 2, coalesceKey: "last-call:appr-2" });
  arb.submit({ facts: "pane 1 finished", cls: 3, paneId: "p1", coalesceKey: "pane-completion" });
  arb.submit({ facts: "pane 2 finished", cls: 3, paneId: "p2", coalesceKey: "pane-completion" });
  arb.submit({ facts: "pane 3 finished", cls: 3, paneId: "p3", coalesceKey: "pane-completion" });
  const d = arb.evaluate({ now: 1_000_000, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain");
  assert.strictEqual(d.digest.headline.cls, 2);
  assert.strictEqual(d.digest.tailCount, 3, "three distinct panes stay three counted items");
  const group = d.digest.tailGroups.find((g: AnyRec) => g.coalesceKey === "pane-completion");
  assert.ok(group, "tailGroups must carry the coalesceKey-grouped summary");
  assert.strictEqual(group.count, 3);
  const total = d.digest.tailGroups.reduce((n: number, g: AnyRec) => n + g.count, 0);
  assert.strictEqual(total, d.digest.tailCount, "group counts partition the tail");
});

// ── class 1: operator-response is exempt (never queued) ────────────────────────────────────────

test("class 1 drains immediately even mid-floor and does NOT flush the waiting queue", async () => {
  const mod = await loadArbiter();
  const arb = freshArbiter(mod);
  const now = 1_000_000;
  arb.submit({ facts: "pane 3 finished the build", cls: 4, paneId: "p3" });
  arb.submit({ facts: "Approved — dispatching now.", cls: 1 });
  const d = arb.evaluate({ now, floorHeld: true, turnClear: false });
  assert.strictEqual(d.action, "drain", "class 1 is exempt: immediate, never queued");
  assert.strictEqual(d.mode, "forced-turn", "class 1 has no dial — always a forced turn");
  assert.strictEqual(d.digest.headline.cls, 1);
  assert.strictEqual(d.digest.headline.facts, "Approved — dispatching now.");
  assert.deepStrictEqual(d.digest.tail, [], "the queued class-4 ack must NOT ride the operator echo mid-turn");
  const later = arb.evaluate({ now: now + 5_000, floorHeld: false, turnClear: true });
  assert.strictEqual(later.action, "drain", "never-drop: the held ack still drains at turn-clear");
  assert.strictEqual(later.digest.headline.facts, "pane 3 finished the build");
  assert.strictEqual(
    arb.evaluate({ now: now + 5_001, floorHeld: false, turnClear: true }).action,
    "hold",
    "the class-1 item must not be delivered twice",
  );
});

// ── D1: the deadline waits for you ─────────────────────────────────────────────────────────────

test("D1 TTL-pause: a floor-held class-2 item defers past raw expiry and drains FIRST, un-swapped, at release", async () => {
  const mod = await loadArbiter();
  const arb = freshArbiter(mod);
  const t0 = 1_000_000;
  arb.submit({
    facts: "approve the deploy now or I'll drop it",
    cls: 2,
    coalesceKey: "last-call:appr-7",
    deadline: { expiresAt: t0 + 30_000, onExpirySwap: "the deploy approval expired — I cancelled it" },
  });
  assert.strictEqual(arb.evaluate({ now: t0, floorHeld: true, turnClear: false }).action, "hold");
  assert.strictEqual(arb.evaluate({ now: t0 + 10_000, floorHeld: true, turnClear: false }).action, "hold");
  assert.strictEqual(arb.floorPausedMs("last-call:appr-7"), 10_000, "pause accrues with the observed floor span");
  // Past the RAW deadline (t0+35s > t0+30s) but the floor has been held the whole time: the
  // deadline waited for the operator — still hold, still the original last-call.
  assert.strictEqual(arb.evaluate({ now: t0 + 35_000, floorHeld: true, turnClear: false }).action, "hold");
  arb.submit({ facts: "pane 1 finished meanwhile", cls: 3, paneId: "p1" });
  const d = arb.evaluate({ now: t0 + 36_000, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain");
  assert.strictEqual(
    d.digest.headline.facts,
    "approve the deploy now or I'll drop it",
    "within the extension the ORIGINAL last-call speaks — not the expiry swap — and drains first (headline)",
  );
  assert.deepStrictEqual(d.digest.tail.map((t: AnyRec) => t.facts), ["pane 1 finished meanwhile"]);
});

test("D1 cap: once the +60s extension is consumed, evaluate returns interrupt-at-phrase-boundary (once)", async () => {
  const mod = await loadArbiter();
  const arb = freshArbiter(mod);
  const t0 = 1_000_000;
  arb.submit({
    facts: "approve the deploy now or I'll drop it",
    cls: 2,
    coalesceKey: "last-call:appr-8",
    deadline: { expiresAt: t0 + 1_000, onExpirySwap: "the deploy approval expired — I cancelled it" },
  });
  assert.strictEqual(arb.evaluate({ now: t0, floorHeld: true, turnClear: false }).action, "hold");
  assert.strictEqual(
    arb.evaluate({ now: t0 + 59_000, floorHeld: true, turnClear: false }).action,
    "hold",
    "under the cap the operator keeps the floor",
  );
  const d = arb.evaluate({ now: t0 + 61_000, floorHeld: true, turnClear: false });
  assert.strictEqual(
    d.action,
    "interrupt-at-phrase-boundary",
    "cap consumed + extended deadline reached with the floor still held → interrupt at the next phrase boundary",
  );
  assert.strictEqual(
    d.digest.headline.facts,
    "approve the deploy now or I'll drop it",
    "the interrupt DELIVERS the last-call before it dies — original facts, not the expiry swap",
  );
  assert.strictEqual(
    arb.evaluate({ now: t0 + 61_100, floorHeld: true, turnClear: false }).action,
    "hold",
    "an interrupt delivers its digest exactly once — never an interrupt storm",
  );
});

test("floorPausedMs is capped at TTL_FLOOR_EXTENSION_CAP_MS and never accrues without the floor", async () => {
  const mod = await loadArbiter();
  const t0 = 1_000_000;
  const held = freshArbiter(mod);
  held.submit({
    facts: "last call", cls: 2, coalesceKey: "last-call:appr-cap",
    deadline: { expiresAt: t0 + 5_000, onExpirySwap: "expired" },
  });
  held.evaluate({ now: t0, floorHeld: true, turnClear: false });
  held.evaluate({ now: t0 + 120_000, floorHeld: true, turnClear: false });
  assert.strictEqual(
    held.floorPausedMs("last-call:appr-cap"),
    mod.TTL_FLOOR_EXTENSION_CAP_MS,
    "pause accrual is clamped at the D1 cap (60s), however long the floor is held",
  );
  const idle = freshArbiter(mod);
  idle.submit({
    facts: "last call", cls: 2, coalesceKey: "last-call:appr-idle",
    deadline: { expiresAt: t0 + 500_000, onExpirySwap: "expired" },
  });
  idle.evaluate({ now: t0, floorHeld: false, turnClear: false });
  idle.evaluate({ now: t0 + 10_000, floorHeld: false, turnClear: false });
  assert.strictEqual(idle.floorPausedMs("last-call:appr-idle"), 0, "only the operator's floor pauses a TTL");
});

test("TTL honesty: a class-2 item that expires while queued (no floor) drains as the expiry swap", async () => {
  const mod = await loadArbiter();
  const arb = freshArbiter(mod);
  const t0 = 1_000_000;
  arb.submit({
    facts: "approve the restart now or I'll drop it",
    cls: 2,
    coalesceKey: "last-call:appr-3",
    deadline: { expiresAt: t0 + 1_000, onExpirySwap: "the restart approval expired — I cancelled it" },
  });
  assert.strictEqual(arb.evaluate({ now: t0, floorHeld: false, turnClear: false }).action, "hold");
  const d = arb.evaluate({ now: t0 + 5_000, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain");
  assert.strictEqual(
    d.digest.headline.facts,
    "the restart approval expired — I cancelled it",
    "a stale last-call must never be spoken as if still actionable — swap to the honest expiry notice",
  );
});

// ── floor-flap stability (T2) ──────────────────────────────────────────────────────────────────

test("floor-flap stability: rapid hold/release never double-drains and never loses items", async () => {
  const mod = await loadArbiter();
  const arb = freshArbiter(mod);
  const t0 = 1_000_000;
  arb.submit({ facts: "correction: pane 2's restart actually failed", cls: 0, coalesceKey: "correction:p2" });
  arb.submit({ facts: "pane 1 finished", cls: 3, paneId: "p1" });
  arb.submit({ facts: "context: pane 4 idle", cls: 5, paneId: "p4" });
  for (let i = 0; i < 40; i++) {
    const d = arb.evaluate({ now: t0 + i * 250, floorHeld: i % 2 === 0, turnClear: false });
    assert.strictEqual(d.action, "hold", `flap step ${i}: no drain may fire while the turn is not clear`);
  }
  const d = arb.evaluate({ now: t0 + 60_000, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain");
  assert.strictEqual(1 + d.digest.tail.length, 3, "all three survived the flapping — nothing lost, nothing duplicated");
  assert.strictEqual(d.digest.headline.cls, 0);
  assert.strictEqual(
    arb.evaluate({ now: t0 + 60_001, floorHeld: false, turnClear: true }).action,
    "hold",
    "exactly one drain after the flap",
  );
});

// ── D4 floor lives in the core too (defense in depth) ──────────────────────────────────────────

test("core floor defense: an under-floor matrix injected raw can never produce a passive drain for classes 0-2", async () => {
  const mod = await loadArbiter();
  const arb = freshArbiter(mod, { matrix: { 0: "passive-context", 2: "passive-context" } });
  arb.submit({ facts: "approve now or I'll drop it", cls: 2, coalesceKey: "last-call:appr-h" });
  const d = arb.evaluate({ now: 1_000_000, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain");
  assert.strictEqual(
    d.mode,
    "steered-digest",
    "classes 0-2 are clamped to the steered-digest floor INSIDE the core, not only at the settings boundary",
  );
});

// ── Use-case validation scenarios (operator reality, not spec sentences) ───────────────────────
// Added by the use-case validator: each test below traces to a named operator experience from the
// wave brief and closes a hole where every existing test would have passed despite the regression.

test("scenario (Maya's collision): three panes finish + a correction lands mid-answer → ONE drain, correction headlined, completions counted", async () => {
  // Regression this pins: tailGroups computed wrongly (or not at all) when a class-0 correction
  // headlines — the existing tailGroups partition assertion only ran under a class-2 headline.
  const mod = await loadArbiter();
  const arb = freshArbiter(mod);
  const t0 = 1_000_000;
  // Maya asks a question; the model starts answering (turn NOT clear). Work lands meanwhile:
  arb.submit({ facts: "pane 1 finished the lint run", cls: 3, paneId: "p1", coalesceKey: "pane-completion" });
  assert.strictEqual(
    arb.evaluate({ now: t0 + 500, floorHeld: false, turnClear: false }).action,
    "hold",
    "nothing may jump over the model's answer",
  );
  arb.submit({ facts: "pane 2 finished the build", cls: 3, paneId: "p2", coalesceKey: "pane-completion" });
  arb.submit({
    facts: "correction: pane 4's deploy actually FAILED after I said it was fine",
    cls: 0, paneId: "p4", coalesceKey: "correction:p4",
  });
  assert.strictEqual(arb.evaluate({ now: t0 + 1_500, floorHeld: false, turnClear: false }).action, "hold");
  arb.submit({ facts: "pane 3 finished the test suite", cls: 3, paneId: "p3", coalesceKey: "pane-completion" });
  // The model finishes its answer → turn-clear: exactly ONE spoken turn carries everything.
  const d = arb.evaluate({ now: t0 + 4_000, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain");
  assert.strictEqual(d.digest.headline.cls, 0, "the correction outranks the completions — it headlines");
  assert.strictEqual(d.digest.headline.facts, "correction: pane 4's deploy actually FAILED after I said it was fine");
  assert.strictEqual(d.digest.tailCount, 3, "the three completions ride the SAME drain as a counted tail");
  const group = d.digest.tailGroups.find((g: AnyRec) => g.coalesceKey === "pane-completion");
  assert.ok(group, "'three panes finished' — the completion group must be counted even when a class-0 correction headlines");
  assert.strictEqual(group.count, 3);
  const total = d.digest.tailGroups.reduce((n: number, g: AnyRec) => n + g.count, 0);
  assert.strictEqual(total, d.digest.tailCount, "group counts partition the tail under a class-0 headline too");
  for (const t of d.digest.tail) {
    assert.strictEqual(t.forVisualStack, true, "completions Maya doesn't hear in full stay on the visual stack");
  }
  assert.strictEqual(
    arb.evaluate({ now: t0 + 4_001, floorHeld: false, turnClear: true }).action,
    "hold",
    "one collision → one spoken turn, never a burst of consecutive topic switches",
  );
});

test("scenario (90s monologue aftermath): the interrupt-delivered last-call must NOT drain again at the next turn-clear", async () => {
  // Regression this pins: double-speak — the operator hears the last-call via the phrase-boundary
  // interrupt AND again when they release the floor. The existing cap test only asserts hold while
  // the floor is STILL held; the property runs never sustain a 60s floor streak, so this exact
  // channel-crossing exactly-once was otherwise unpinned.
  const mod = await loadArbiter();
  const arb = freshArbiter(mod);
  const t0 = 1_000_000;
  arb.submit({
    facts: "approve the deploy now or I'll drop it",
    cls: 2,
    coalesceKey: "last-call:appr-90s",
    deadline: { expiresAt: t0 + 1_000, onExpirySwap: "the deploy approval expired — I cancelled it" },
  });
  // Operator monologue: floor held straight past the raw deadline and through the +60s extension.
  assert.strictEqual(arb.evaluate({ now: t0, floorHeld: true, turnClear: false }).action, "hold");
  assert.strictEqual(arb.evaluate({ now: t0 + 59_000, floorHeld: true, turnClear: false }).action, "hold");
  const intr = arb.evaluate({ now: t0 + 61_000, floorHeld: true, turnClear: false });
  assert.strictEqual(intr.action, "interrupt-at-phrase-boundary", "cap consumed → the deadline stops waiting");
  assert.strictEqual(intr.digest.headline.facts, "approve the deploy now or I'll drop it");
  // The operator finally yields the floor. The last-call was already spoken via the interrupt.
  assert.strictEqual(
    arb.evaluate({ now: t0 + 70_000, floorHeld: false, turnClear: true }).action,
    "hold",
    "exactly-once across delivery channels: an interrupt-delivered item never re-drains at turn-clear",
  );
  assert.ok(
    arb.floorPausedMs("last-call:appr-90s") <= mod.TTL_FLOOR_EXTENSION_CAP_MS,
    "pause accounting stays clamped at the cap after delivery",
  );
});

// ── T2 property surface: seeded randomized invariants ──────────────────────────────────────────

/** Deterministic LCG so CI failures replay exactly (seed printed in every assertion message). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

function collectDigest(decision: AnyRec, counts: Map<string, number>): void {
  if (!decision || !decision.digest) return;
  for (const it of [decision.digest.headline, ...(decision.digest.tail ?? [])]) {
    if (!it) continue;
    const key = it.coalesceKey ?? it.facts;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
}

function assertSeverityOrdered(decision: AnyRec, seed: number): void {
  if (!decision || !decision.digest) return;
  const classes = [decision.digest.headline.cls, ...(decision.digest.tail ?? []).map((t: AnyRec) => t.cls)];
  for (let i = 1; i < classes.length; i++) {
    assert.ok(
      classes[i] >= classes[i - 1],
      `strict priority order violated (seed ${seed}): digest classes [${classes.join(",")}]`,
    );
  }
}

function submitRandomItem(arb: AnyRec, rand: () => number, now: number, id: number, cls2Keys: string[]): string {
  const classes = [0, 1, 2, 3, 4, 5] as const;
  const cls = classes[Math.floor(rand() * classes.length)];
  const key = `k-${id}`;
  const item: AnyRec = { facts: `fact ${key} v0`, cls, coalesceKey: key };
  if (rand() < 0.5) item.paneId = `p-${id}`;
  if (cls === 2) {
    item.deadline = {
      expiresAt: now + (rand() < 0.4 ? 2_000 : 5_000_000),
      onExpirySwap: `expired ${key}`,
    };
    cls2Keys.push(key);
  }
  arb.submit(item);
  return key;
}

function drainRemainder(arb: AnyRec, startNow: number, counts: Map<string, number>, seed: number): void {
  let now = startNow;
  for (let i = 0; i < 40; i++) {
    now += 1_000;
    const d = arb.evaluate({ now, floorHeld: false, turnClear: true });
    if (d.action === "hold") return;
    assertSeverityOrdered(d, seed);
    collectDigest(d, counts);
  }
  assert.fail(`arbiter never settled to hold after 40 turn-clear drains (seed ${seed})`);
}

function runNeverDropScenario(mod: AnyRec, seed: number): void {
  const rand = lcg(seed);
  const arb = freshArbiter(mod);
  const counts = new Map<string, number>();
  const submitted = new Set<string>();
  const cls2Keys: string[] = [];
  let now = 1_000_000;
  let nextId = 0;
  for (let step = 0; step < 160; step++) {
    now += 1 + Math.floor(rand() * 4_000);
    if (rand() < 0.55) {
      submitted.add(submitRandomItem(arb, rand, now, nextId++, cls2Keys));
      continue;
    }
    const d = arb.evaluate({ now, floorHeld: rand() < 0.4, turnClear: rand() < 0.4 });
    assertSeverityOrdered(d, seed);
    collectDigest(d, counts);
    for (const key of cls2Keys) {
      const paused = arb.floorPausedMs(key);
      assert.ok(
        paused >= 0 && paused <= mod.TTL_FLOOR_EXTENSION_CAP_MS,
        `TTL-pause cap bound violated for ${key} (seed ${seed}): ${paused}`,
      );
    }
  }
  drainRemainder(arb, now, counts, seed);
  for (const key of submitted) {
    assert.strictEqual(
      counts.get(key) ?? 0,
      1,
      `never-drop violated (seed ${seed}): ${key} appeared ${counts.get(key) ?? 0} times — ` +
        "every submit must land in exactly one digest (drain, interrupt, or passive rail)",
    );
  }
}

test("property: never-drop + exactly-once + priority order + cap bounds over randomized sequences", async () => {
  const mod = await loadArbiter();
  for (const seed of [7, 1301, 90210]) runNeverDropScenario(mod, seed);
});

test("property: coalescing idempotence — N duplicate submissions ≡ one submission, latest facts win", async () => {
  const mod = await loadArbiter();
  for (const seed of [11, 4242]) {
    const rand = lcg(seed);
    const arb = freshArbiter(mod);
    const identities = 8;
    const expectedLatest = new Map<string, string>();
    for (let i = 0; i < identities; i++) {
      const cls = [3, 4, 5][Math.floor(rand() * 3)];
      const dups = 1 + Math.floor(rand() * 4);
      for (let v = 0; v < dups; v++) {
        arb.submit({ facts: `fact k-${i} v${v}`, cls, coalesceKey: `k-${i}`, paneId: `p-${i}` });
      }
      expectedLatest.set(`k-${i}`, `fact k-${i} v${dups - 1}`);
    }
    const d = arb.evaluate({ now: 2_000_000, floorHeld: false, turnClear: true });
    assert.strictEqual(d.action, "drain", `seed ${seed}: pending items must drain at turn-clear`);
    const all = [d.digest.headline, ...d.digest.tail];
    assert.strictEqual(all.length, identities, `seed ${seed}: duplicates must coalesce to one item per identity`);
    for (const it of all) {
      assert.strictEqual(
        it.facts,
        expectedLatest.get(it.coalesceKey),
        `seed ${seed}: latest submission must win for ${it.coalesceKey}`,
      );
    }
    const keys = new Set(all.map((it: AnyRec) => it.coalesceKey));
    assert.strictEqual(keys.size, identities, `seed ${seed}: every identity appears exactly once`);
  }
});
