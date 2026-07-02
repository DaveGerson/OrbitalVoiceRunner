// tests/test_spoken_confirm.ts — f09.1: the spoken destructive-confirm protocol state machine
// (idle / awaiting_phrase / reprompted), driven under a fully deterministic fake clock (no real
// timers). See docs/superpowers/specs/2026-07-02-voice-ux-trio-design.md §D5 for the frozen design.
//
// Runner: npx tsx --test --test-force-exit tests/test_spoken_confirm.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSpokenConfirm, CONFIRM_PHRASES, type SpokenConfirmDeps } from "../src/voice/spokenConfirm";
import type { TargetableEntry } from "../src/approvalIntent";

// ── fake clock: setTimer/clearTimer/nowMs entirely deterministic, no real setTimeout ──────────────
function fakeClock(start = 0) {
  let now = start;
  let nextId = 1;
  const timers = new Map<number, { fn: () => void; at: number }>();
  return {
    nowMs: () => now,
    setTimer: (fn: () => void, ms: number): unknown => {
      const id = nextId++;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimer: (t: unknown): void => {
      timers.delete(t as number);
    },
    /** Advance the clock and fire every timer whose deadline has now passed (oldest first). */
    advance: (ms: number): void => {
      now += ms;
      for (const [id, t] of [...timers.entries()].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now && timers.has(id)) {
          timers.delete(id);
          t.fn();
        }
      }
    },
    pendingTimerCount: () => timers.size,
  };
}

// ── fake PendingActionStore-shaped store ────────────────────────────────────────────────────────
interface FakeAction { id: string; capability?: string; summary: string; claimed?: boolean }

function makeStore(actions: FakeAction[]) {
  const map = new Map(actions.map((a) => [a.id, { ...a }]));
  const confirmCalls: string[] = [];
  const cancelCalls: string[] = [];
  let confirmImpl: (id: string) => { reason: string; output?: string } = (id) => {
    if (!map.has(id)) return { reason: "not_found" };
    map.delete(id);
    return { reason: "confirmed", output: "ok" };
  };
  return {
    all: () => Array.from(map.values()),
    confirm: (id: string): { reason: string; output?: string } => {
      confirmCalls.push(id);
      return confirmImpl(id);
    },
    cancel: (id: string): { reason: string } => {
      cancelCalls.push(id);
      if (!map.has(id)) return { reason: "not_found" };
      map.delete(id);
      return { reason: "cancelled" };
    },
    has: (id: string) => map.has(id),
    confirmCalls,
    cancelCalls,
    setConfirmImpl: (fn: (id: string) => { reason: string; output?: string }) => {
      confirmImpl = fn;
    },
  };
}

function makeDeps(opts: {
  store: ReturnType<typeof makeStore>;
  clock: ReturnType<typeof fakeClock>;
  held?: TargetableEntry[];
  confirmTimeoutMs?: number;
}) {
  const narrations: string[] = [];
  const broadcasts: unknown[] = [];
  const deps: SpokenConfirmDeps = {
    narrate: (t: string) => narrations.push(t),
    redact: (s: string) => s,
    nowMs: opts.clock.nowMs,
    setTimer: opts.clock.setTimer,
    clearTimer: opts.clock.clearTimer,
    confirmTimeoutMs: () => opts.confirmTimeoutMs ?? 10_000,
    pendingActions: opts.store,
    heldEntries: () => opts.held ?? [],
    broadcast: (m: unknown) => broadcasts.push(m),
  };
  return { deps, narrations, broadcasts };
}

describe("CONFIRM_PHRASES — the static destructive-class table", () => {
  it("delete_pane and delete_project both require 'confirm delete'; clear_history requires 'confirm clear'", () => {
    assert.equal(CONFIRM_PHRASES.delete_pane, "confirm delete");
    assert.equal(CONFIRM_PHRASES.delete_project, "confirm delete");
    assert.equal(CONFIRM_PHRASES.clear_history, "confirm clear");
  });
});

describe("spoken confirm — happy path (two-turn: arm, then the exact phrase)", () => {
  it("stages a destructive action, arms on 'yes' with a verbatim read-back, resolves on 'confirm delete'", () => {
    const clock = fakeClock(1_000_000);
    const store = makeStore([{ id: "act_1", capability: "delete_pane", summary: "Delete pane 3" }]);
    const { deps, narrations, broadcasts } = makeDeps({ store, clock });
    const sc = createSpokenConfirm(deps);

    assert.equal(sc.intercept("yes"), true, "the approve intent is consumed to arm the window");
    assert.equal(store.confirmCalls.length, 0, "not resolved yet — only armed");
    const armNarration = narrations.at(-1) ?? "";
    assert.match(armNarration, /Delete pane 3/, "the VERBATIM summary is read back");
    assert.match(armNarration, /confirm delete/, "the required phrase is named");
    assert.match(armNarration, /10 seconds/, "the window duration is named");

    assert.equal(sc.intercept("confirm delete"), true);
    assert.deepEqual(store.confirmCalls, ["act_1"], "resolved through the EXISTING confirm() machinery");
    assert.deepEqual(broadcasts, [{ type: "action_resolved", actionId: "act_1", outcome: "confirmed" }]);
    assert.match(narrations.at(-1) ?? "", /Done/);
    assert.equal(store.has("act_1"), false);
  });

  it("front-loaded phrase: the FIRST utterance already being the exact phrase resolves in one turn (no arm)", () => {
    const clock = fakeClock();
    const store = makeStore([{ id: "act_1", capability: "delete_pane", summary: "Delete pane 3" }]);
    const { deps, narrations } = makeDeps({ store, clock });
    const sc = createSpokenConfirm(deps);

    assert.equal(sc.intercept("confirm delete"), true);
    assert.deepEqual(store.confirmCalls, ["act_1"]);
    assert.match(narrations.at(-1) ?? "", /Done/);
    // No arm narration was ever produced (only one narration total: the Done).
    assert.equal(narrations.length, 1);
  });

  it("phrase matching is case-insensitive and trims surrounding whitespace/punctuation", () => {
    const clock = fakeClock();
    const store = makeStore([{ id: "act_1", capability: "delete_pane", summary: "Delete pane 3" }]);
    const { deps } = makeDeps({ store, clock });
    const sc = createSpokenConfirm(deps);

    assert.equal(sc.intercept("  Confirm Delete.  "), true);
    assert.deepEqual(store.confirmCalls, ["act_1"]);
  });
});

describe("spoken confirm — wrong phrase (window stays open)", () => {
  it("an unrelated utterance inside the window is ignored (not consumed); the exact phrase still works after", () => {
    const clock = fakeClock();
    const store = makeStore([{ id: "act_1", capability: "delete_pane", summary: "Delete pane 3" }]);
    const { deps, narrations } = makeDeps({ store, clock });
    const sc = createSpokenConfirm(deps);

    sc.intercept("yes"); // arm
    const afterArm = narrations.length;

    assert.equal(sc.intercept("what's the weather"), false, "ambient speech falls through untouched");
    assert.equal(narrations.length, afterArm, "no new narration for ambient speech");
    assert.equal(store.confirmCalls.length, 0);
    assert.equal(store.has("act_1"), true, "the window is still open, action still pending");

    // The window survived the wrong utterance — the exact phrase still resolves it.
    assert.equal(sc.intercept("confirm delete"), true);
    assert.deepEqual(store.confirmCalls, ["act_1"]);
  });
});

describe("spoken confirm — bare yes/affirmative is REJECTED with exactly one re-prompt", () => {
  it("a bare yes inside the window re-prompts once instead of resolving", () => {
    const clock = fakeClock();
    const store = makeStore([{ id: "act_1", capability: "delete_pane", summary: "Delete pane 3" }]);
    const { deps, narrations } = makeDeps({ store, clock });
    const sc = createSpokenConfirm(deps);

    sc.intercept("yes"); // arm
    assert.equal(sc.intercept("yes"), true, "the bare yes is consumed (not left to fall through)");
    assert.equal(store.confirmCalls.length, 0, "a bare yes never resolves the destructive class");
    assert.match(narrations.at(-1) ?? "", /A yes isn't enough/);
    assert.match(narrations.at(-1) ?? "", /confirm delete/);
    assert.equal(store.has("act_1"), true);
  });

  it("single re-prompt then cancel: a SECOND bare yes cancels the spoken prompt only (record survives)", () => {
    const clock = fakeClock();
    const store = makeStore([{ id: "act_1", capability: "delete_pane", summary: "Delete pane 3" }]);
    const { deps, narrations, broadcasts } = makeDeps({ store, clock });
    const sc = createSpokenConfirm(deps);

    sc.intercept("yes"); // arm
    sc.intercept("yes"); // first bare yes -> re-prompt
    assert.equal(sc.intercept("yes"), true, "second bare yes is consumed");
    assert.match(narrations.at(-1) ?? "", /Cancelled/);
    assert.equal(store.confirmCalls.length, 0);
    assert.equal(store.cancelCalls.length, 0, "the underlying record is NEVER cancelled by us");
    assert.equal(broadcasts.length, 0, "no action_resolved frame — nothing was actually resolved");
    assert.equal(store.has("act_1"), true, "the pendingActions record survives, still resolvable elsewhere");

    // The window is now closed — a THIRD "yes" re-arms fresh from idle (not a 3rd re-prompt).
    assert.equal(sc.intercept("yes"), true);
    assert.match(narrations.at(-1) ?? "", /Heads up/, "back to idle -> arms a brand-new window");
  });
});

describe("spoken confirm — timeout cancels the spoken prompt only", () => {
  it("the window auto-cancels at confirmTimeoutMs; the record keeps its own TTL and survives", () => {
    const clock = fakeClock();
    const store = makeStore([{ id: "act_1", capability: "delete_pane", summary: "Delete pane 3" }]);
    const { deps, narrations } = makeDeps({ store, clock, confirmTimeoutMs: 10_000 });
    const sc = createSpokenConfirm(deps);

    sc.intercept("yes"); // arm
    assert.equal(clock.pendingTimerCount(), 1);

    clock.advance(9_999);
    assert.equal(store.confirmCalls.length, 0, "not yet expired");

    clock.advance(1);
    assert.equal(clock.pendingTimerCount(), 0, "the timer fired and was consumed");
    assert.match(narrations.at(-1) ?? "", /window closed/);
    assert.match(narrations.at(-1) ?? "", /Delete pane 3/);
    assert.equal(store.confirmCalls.length, 0);
    assert.equal(store.cancelCalls.length, 0, "expiry never cancels the underlying record");
    assert.equal(store.has("act_1"), true);

    // A fresh utterance after expiry re-arms from idle, proving the window is truly closed.
    assert.equal(sc.intercept("yes"), true);
    assert.match(narrations.at(-1) ?? "", /Heads up/);
  });

  it("a re-prompt does NOT reset the timer — it keeps counting from the original arm", () => {
    const clock = fakeClock();
    const store = makeStore([{ id: "act_1", capability: "delete_pane", summary: "Delete pane 3" }]);
    const { deps, narrations } = makeDeps({ store, clock, confirmTimeoutMs: 10_000 });
    const sc = createSpokenConfirm(deps);

    sc.intercept("yes"); // arm at t=0
    clock.advance(6_000);
    sc.intercept("yes"); // re-prompt at t=6000 (armed 6s ago)
    clock.advance(4_000); // t=10000: the ORIGINAL 10s deadline, not a fresh one from the re-prompt
    assert.match(narrations.at(-1) ?? "", /window closed/, "the original deadline still governs");
  });
});

describe("spoken confirm — explicit cancel words close the spoken prompt only", () => {
  for (const word of ["cancel", "never mind", "nevermind", "  Cancel  "]) {
    it(`"${word}" inside the window cancels the prompt; the record survives`, () => {
      const clock = fakeClock();
      const store = makeStore([{ id: "act_1", capability: "delete_pane", summary: "Delete pane 3" }]);
      const { deps, narrations } = makeDeps({ store, clock });
      const sc = createSpokenConfirm(deps);

      sc.intercept("yes"); // arm
      assert.equal(sc.intercept(word), true);
      assert.match(narrations.at(-1) ?? "", /Cancelled/);
      assert.equal(store.confirmCalls.length, 0);
      assert.equal(store.cancelCalls.length, 0);
      assert.equal(store.has("act_1"), true);
    });
  }
});

describe("spoken confirm — explicit reject falls through to the normal cancel routing", () => {
  it("a paired reject verb closes our window and returns false (does not itself cancel the record)", () => {
    const clock = fakeClock();
    const store = makeStore([{ id: "act_1", capability: "delete_pane", summary: "Delete pane 3" }]);
    const { deps } = makeDeps({ store, clock });
    const sc = createSpokenConfirm(deps);

    sc.intercept("yes"); // arm
    assert.equal(sc.intercept("reject it"), false, "falls through so the caller's normal reject routing runs");
    assert.equal(store.confirmCalls.length, 0);
    assert.equal(store.cancelCalls.length, 0, "we never call cancel() ourselves — the fallthrough does");
    assert.equal(store.has("act_1"), true);

    // The window is closed (idle) — a subsequent utterance re-evaluates from scratch.
    assert.equal(sc.intercept("confirm delete"), true, "back to idle -> the front-loaded phrase resolves fresh");
    assert.deepEqual(store.confirmCalls, ["act_1"]);
  });
});

describe("spoken confirm — held pane-write approvals keep their existing precedence", () => {
  it("a non-empty heldEntries() makes the destructive class untouchable — intercept is a pure no-op", () => {
    const clock = fakeClock();
    const store = makeStore([{ id: "act_1", capability: "delete_pane", summary: "Delete pane 3" }]);
    const held: TargetableEntry[] = [{ messageId: "msg_1", instruction: "rm -rf build", terminalId: "pane_1" }];
    const { deps, narrations, broadcasts } = makeDeps({ store, clock, held });
    const sc = createSpokenConfirm(deps);

    assert.equal(sc.intercept("yes"), false, "held approvals win; we never arm");
    assert.equal(narrations.length, 0);
    assert.equal(broadcasts.length, 0);
    assert.equal(store.confirmCalls.length, 0);
    assert.equal(store.has("act_1"), true);
  });
});

describe("spoken confirm — non-destructive staged actions are never touched", () => {
  it("a unique non-destructive target passes through (return false) untouched by us", () => {
    const clock = fakeClock();
    const store = makeStore([{ id: "act_1", capability: "create_pane", summary: "Create pane claude_new" }]);
    const { deps, narrations, broadcasts } = makeDeps({ store, clock });
    const sc = createSpokenConfirm(deps);

    assert.equal(sc.intercept("yes"), false, "not destructive -> normal routing owns this");
    assert.equal(narrations.length, 0);
    assert.equal(broadcasts.length, 0);
    assert.equal(store.confirmCalls.length, 0);
    assert.equal(store.has("act_1"), true);
  });
});

describe("spoken confirm — a throwing confirm() is caught, never crashes the caller", () => {
  it("front-loaded phrase whose confirm() throws surfaces action_resolved/failed + a spoken failure", () => {
    const clock = fakeClock();
    const store = makeStore([{ id: "act_1", capability: "delete_pane", summary: "Delete pane 3" }]);
    store.setConfirmImpl((id) => {
      throw new Error("boom");
    });
    const { deps, narrations, broadcasts } = makeDeps({ store, clock });
    const sc = createSpokenConfirm(deps);

    assert.doesNotThrow(() => {
      assert.equal(sc.intercept("confirm delete"), true);
    });
    assert.deepEqual(broadcasts, [{ type: "action_resolved", actionId: "act_1", outcome: "failed", error: "boom" }]);
    const last = narrations.at(-1) ?? "";
    assert.match(last, /failed/);
    assert.match(last, /boom/);
  });

  it("armed-window phrase whose confirm() throws also does not crash and closes the window", () => {
    const clock = fakeClock();
    const store = makeStore([{ id: "act_1", capability: "delete_pane", summary: "Delete pane 3" }]);
    store.setConfirmImpl(() => {
      throw new Error("kaboom");
    });
    const { deps, narrations, broadcasts } = makeDeps({ store, clock });
    const sc = createSpokenConfirm(deps);

    sc.intercept("yes"); // arm
    assert.doesNotThrow(() => sc.intercept("confirm delete"));
    assert.deepEqual(broadcasts, [{ type: "action_resolved", actionId: "act_1", outcome: "failed", error: "kaboom" }]);
    assert.match(narrations.at(-1) ?? "", /failed/);

    // The window is closed, not stuck — a fresh arm works normally afterward is out of scope here
    // (the record is gone in this fixture); the key assertion is the caller never sees an exception.
  });
});

describe("spoken confirm — session drop mid-window (dispose): the approval survives", () => {
  it("dispose() clears the timer and drops our window WITHOUT touching the underlying record", () => {
    const clock = fakeClock();
    const store = makeStore([{ id: "act_1", capability: "delete_pane", summary: "Delete pane 3" }]);
    const { deps, narrations } = makeDeps({ store, clock, confirmTimeoutMs: 10_000 });
    const sc = createSpokenConfirm(deps);

    sc.intercept("yes"); // arm
    assert.equal(clock.pendingTimerCount(), 1);

    sc.dispose();
    assert.equal(clock.pendingTimerCount(), 0, "the timer was cleared, not merely orphaned");
    assert.equal(store.confirmCalls.length, 0);
    assert.equal(store.cancelCalls.length, 0);
    assert.equal(store.has("act_1"), true, "the pendingActions record survives a session drop");

    // Advancing the clock past the original deadline must NOT fire the (already-cleared) timeout.
    const narrationsBefore = narrations.length;
    clock.advance(20_000);
    assert.equal(narrations.length, narrationsBefore, "no timeout narration after dispose");

    // A later utterance on this same controller starts fresh from idle.
    assert.equal(sc.intercept("confirm delete"), true, "back to idle -> resolves fresh");
    assert.deepEqual(store.confirmCalls, ["act_1"]);
  });

  it("dispose() on an already-idle controller is a harmless no-op", () => {
    const clock = fakeClock();
    const store = makeStore([{ id: "act_1", capability: "delete_pane", summary: "Delete pane 3" }]);
    const { deps } = makeDeps({ store, clock });
    const sc = createSpokenConfirm(deps);

    assert.doesNotThrow(() => sc.dispose());
    assert.equal(store.confirmCalls.length, 0);
    assert.equal(store.cancelCalls.length, 0);
  });
});

describe("spoken confirm — ambiguous multi-destructive targets never auto-arm", () => {
  it("two destructive actions with no disambiguating hint -> intercept returns false (no arm)", () => {
    const clock = fakeClock();
    const store = makeStore([
      { id: "act_1", capability: "delete_pane", summary: "Delete pane 1" },
      { id: "act_2", capability: "delete_pane", summary: "Delete pane 2" },
    ]);
    const { deps, narrations } = makeDeps({ store, clock });
    const sc = createSpokenConfirm(deps);

    assert.equal(sc.intercept("yes"), false, "ambiguous target -> let normal routing clarify");
    assert.equal(narrations.length, 0);
    assert.equal(store.confirmCalls.length, 0);
  });
});
