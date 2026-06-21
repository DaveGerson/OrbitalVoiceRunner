// tests/test_smokehandoff_complexity_refactor.ts — CHARACTERIZATION tests for the cyclomatic-
// complexity burndown refactor of scripts/smoke-handoff.ts (CC 36 → ≤10).
//
// These pin the PURE helpers extracted from main() so that the behavior-preserving refactor is
// verified without needing a live PTY, a real Claude binary, or a running server.
//
// What is characterized here:
//   - stripAnsi:             ANSI CSI and charset-sequence stripping (pure string transform)
//   - assertPtyDelivery:     zero-bytes check + sentinel presence check (pure assertion)
//   - assertTransitionOrder: ordered event-trail assertion (pure assertion)
//   - assertPersistence:     store-query + row-check + trail-order (uses a structural fake store)
//
// What CANNOT be characterized in unit tests (live process boundaries):
//   - The PTY startup wait loop (waitForStartup) — calls term.start() / real node-pty
//   - The gate + effect check (assertGateAndEffect) — calls decideProposal + deliverOutcomeToHandoff
//     with real module state; tested indirectly through integration (smoke:handoff run)
//   - deliverAndFlip — needs a real JanusStore DB and a live UniversalTerminal
//   These functions are thin orchestration wrappers and don't contain logic beyond what their
//   callees already test; the CC gate (eslint complexity <= 10) verifies their size is bounded.
//
// Runner: npx tsx --test --test-force-exit tests/test_smokehandoff_complexity_refactor.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  stripAnsi,
  assertPtyDelivery,
  assertTransitionOrder,
  assertPersistence,
} from "../scripts/smoke-handoff";

// ---------------------------------------------------------------------------
// 1. stripAnsi — pure string transform
// ---------------------------------------------------------------------------
describe("smoke-handoff helpers — stripAnsi", () => {
  it("passes a plain string through unchanged", () => {
    assert.strictEqual(stripAnsi("hello world"), "hello world");
  });

  it("strips CSI sequences like \\x1B[0m (color reset)", () => {
    assert.strictEqual(stripAnsi("\x1B[0mhello\x1B[0m"), "hello");
  });

  it("strips CSI sequences with multi-digit parameters", () => {
    assert.strictEqual(stripAnsi("\x1B[32;1mgreen bold\x1B[0m"), "green bold");
  });

  it("strips cursor-movement CSI sequences", () => {
    assert.strictEqual(stripAnsi("\x1B[2J\x1B[H"), "");
  });

  it("strips CSI sequences with ? parameter (private modes like ?25h)", () => {
    assert.strictEqual(stripAnsi("\x1B[?25htext\x1B[?25l"), "text");
  });

  it("strips ESC charset-designation sequences \\x1B(B etc.", () => {
    assert.strictEqual(stripAnsi("\x1B(Bhello\x1B(0"), "hello");
  });

  it("strips interleaved ANSI and returns only printable content", () => {
    const raw = "\x1B[2KJANUS_SMOKE_XQ7\x1B[0m end";
    assert.ok(stripAnsi(raw).includes("JANUS_SMOKE_XQ7"));
    assert.ok(!stripAnsi(raw).includes("\x1B"));
  });

  it("handles empty string", () => {
    assert.strictEqual(stripAnsi(""), "");
  });
});

// ---------------------------------------------------------------------------
// 2. assertPtyDelivery — pure assertion (throws Error on failure)
// ---------------------------------------------------------------------------
describe("smoke-handoff helpers — assertPtyDelivery", () => {
  it("does NOT throw when bytesAfter > 0 and sentinel is present (plain text)", () => {
    assert.doesNotThrow(() => {
      assertPtyDelivery("some output JANUS_SMOKE_XQ7 more", 40, "JANUS_SMOKE_XQ7");
    });
  });

  it("does NOT throw when sentinel is present after ANSI stripping", () => {
    const rawWithAnsi = "\x1B[32mJANUS_SMOKE_XQ7\x1B[0m";
    assert.doesNotThrow(() => {
      assertPtyDelivery(rawWithAnsi, rawWithAnsi.length, "JANUS_SMOKE_XQ7");
    });
  });

  it("throws when bytesAfter === 0 (nothing came back from PTY)", () => {
    assert.throws(
      () => assertPtyDelivery("", 0, "JANUS_SMOKE_XQ7"),
      /zero PTY output/,
    );
  });

  it("throws when sentinel is absent from the post-delivery stream", () => {
    assert.throws(
      () => assertPtyDelivery("unrelated PTY output, no sentinel here", 38, "JANUS_SMOKE_XQ7"),
      /delivery NOT confirmed/,
    );
  });

  it("throws when sentinel is absent even after ANSI stripping (different content)", () => {
    const rawNoSentinel = "\x1B[32mwrong content\x1B[0m";
    assert.throws(
      () => assertPtyDelivery(rawNoSentinel, rawNoSentinel.length, "JANUS_SMOKE_XQ7"),
      /delivery NOT confirmed/,
    );
  });

  it("error message for missing sentinel includes byte count and sentinel text", () => {
    try {
      assertPtyDelivery("x".repeat(100), 100, "MY_TOKEN");
      assert.fail("expected throw");
    } catch (e: any) {
      assert.ok(e.message.includes("100"), "error should mention byte count");
      assert.ok(e.message.includes("MY_TOKEN"), "error should mention sentinel");
    }
  });
});

// ---------------------------------------------------------------------------
// 3. assertTransitionOrder — pure assertion
// ---------------------------------------------------------------------------
describe("smoke-handoff helpers — assertTransitionOrder", () => {
  it("does NOT throw for the correct ordered trail", () => {
    assert.doesNotThrow(() => {
      assertTransitionOrder(["composing", "revising", "staged", "delivered"], "h-1");
    });
  });

  it("throws when a required transition is missing", () => {
    assert.throws(
      () => assertTransitionOrder(["composing", "staged", "delivered"], "h-2"),
      /missing transition event to 'revising'/,
    );
  });

  it("throws when transitions are out of order (revising before composing)", () => {
    assert.throws(
      () => assertTransitionOrder(["revising", "composing", "staged", "delivered"], "h-3"),
      /out of order/,
    );
  });

  it("throws when delivered comes before staged", () => {
    assert.throws(
      () => assertTransitionOrder(["composing", "revising", "delivered", "staged"], "h-4"),
      /out of order/,
    );
  });

  it("extra transitions between required ones are allowed (ordered superset)", () => {
    // indexOf finds FIRST occurrence; extras between required states are fine.
    assert.doesNotThrow(() => {
      assertTransitionOrder(
        ["composing", "extra_state", "revising", "staged", "delivered"],
        "h-5",
      );
    });
  });

  it("error message includes the hId (handoff_id context) indirectly via transitions", () => {
    try {
      assertTransitionOrder(["composing", "revising", "staged"], "h-6");
      assert.fail("expected throw");
    } catch (e: any) {
      assert.ok(e.message.includes("delivered"), "error names the missing state");
    }
  });
});

// ---------------------------------------------------------------------------
// 4. assertPersistence — uses a minimal structural fake of JanusStore
// ---------------------------------------------------------------------------

/**
 * Build a minimal fake JanusStore sufficient for assertPersistence.
 * Mirrors only the surface that assertPersistence touches:
 *   store.getHandoff(id) -> StoredHandoff | null
 *   store.getEvents({ type: 'handoff' }) -> Event[]
 */
function fakeStore(opts: {
  handoff?: {
    id: string;
    state: string;
    delivered_at: number | null;
    revision_count: number;
  } | null;
  events?: Array<{
    id: string;
    payload: { handoff_id: string; to: string };
    handoff_id: string;
  }>;
}) {
  return {
    getHandoff(_id: string) { return opts.handoff ?? null; },
    getEvents(_filter: { type: string }) { return opts.events ?? []; },
  } as any;
}

/** Build a well-formed set of events for handoff hId. */
function goodEvents(hId: string) {
  return [
    { id: "e1", payload: { handoff_id: hId, to: "composing" }, handoff_id: hId },
    { id: "e2", payload: { handoff_id: hId, to: "revising" }, handoff_id: hId },
    { id: "e3", payload: { handoff_id: hId, to: "staged" }, handoff_id: hId },
    { id: "e4", payload: { handoff_id: hId, to: "delivered" }, handoff_id: hId },
  ];
}

describe("smoke-handoff helpers — assertPersistence", () => {
  it("does NOT throw for a well-formed delivered handoff with correct trail", () => {
    const store = fakeStore({
      handoff: { id: "h-ok", state: "delivered", delivered_at: 1000, revision_count: 1 },
      events: goodEvents("h-ok"),
    });
    assert.doesNotThrow(() => assertPersistence(store, "h-ok"));
  });

  it("throws when handoff row is missing from the store", () => {
    const store = fakeStore({ handoff: null });
    assert.throws(
      () => assertPersistence(store, "h-missing"),
      /handoff row missing/,
    );
  });

  it("throws when final state is not 'delivered'", () => {
    const store = fakeStore({
      handoff: { id: "h-1", state: "staged", delivered_at: null, revision_count: 1 },
      events: goodEvents("h-1"),
    });
    assert.throws(
      () => assertPersistence(store, "h-1"),
      /'delivered'/,
    );
  });

  it("throws when delivered_at is null", () => {
    const store = fakeStore({
      handoff: { id: "h-2", state: "delivered", delivered_at: null, revision_count: 1 },
      events: goodEvents("h-2"),
    });
    assert.throws(
      () => assertPersistence(store, "h-2"),
      /delivered_at not set/,
    );
  });

  it("throws when revision_count is not 1", () => {
    const store = fakeStore({
      handoff: { id: "h-3", state: "delivered", delivered_at: 999, revision_count: 0 },
      events: goodEvents("h-3"),
    });
    assert.throws(
      () => assertPersistence(store, "h-3"),
      /revision_count.*expected 1/,
    );
  });

  it("throws when a required transition event is missing from the store", () => {
    const incompleteEvents = goodEvents("h-4").filter(e => e.payload.to !== "staged");
    const store = fakeStore({
      handoff: { id: "h-4", state: "delivered", delivered_at: 1, revision_count: 1 },
      events: incompleteEvents,
    });
    assert.throws(
      () => assertPersistence(store, "h-4"),
      /missing transition event to 'staged'/,
    );
  });

  it("throws when an event's handoff_id does not match the expected id", () => {
    const mismatchedEvents = [
      ...goodEvents("h-5"),
      { id: "e-bad", payload: { handoff_id: "h-5", to: "composing" }, handoff_id: "WRONG-ID" },
    ];
    const store = fakeStore({
      handoff: { id: "h-5", state: "delivered", delivered_at: 1, revision_count: 1 },
      events: mismatchedEvents,
    });
    assert.throws(
      () => assertPersistence(store, "h-5"),
      /has handoff_id='WRONG-ID'/,
    );
  });

  it("filters events by payload.handoff_id so unrelated events don't cause false positives", () => {
    // Events from a DIFFERENT handoff are present but should be filtered out by assertPersistence.
    const mixedEvents = [
      ...goodEvents("h-target"),
      // These belong to a different handoff and should be filtered out.
      { id: "ex1", payload: { handoff_id: "h-other", to: "composing" }, handoff_id: "h-other" },
      { id: "ex2", payload: { handoff_id: "h-other", to: "delivered" }, handoff_id: "h-other" },
    ];
    const store = fakeStore({
      handoff: { id: "h-target", state: "delivered", delivered_at: 1, revision_count: 1 },
      events: mixedEvents,
    });
    assert.doesNotThrow(() => assertPersistence(store, "h-target"));
  });
});
