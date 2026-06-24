/**
 * tests/test_pane_input.ts — unit tests for applyPaneInputFrame (src/voice/paneInputFrame.ts).
 *
 * This module is the OPERATOR-DIRECT pane-typing path: keystrokes flow from the focused xterm
 * (TerminalView onInput → term.onData) to the server as { type:"pane_input", paneId, data } WS
 * frames, and `applyPaneInputFrame` writes the bytes VERBATIM to the target pane via writeRaw.
 *
 * The path is INTENTIONALLY UNGATED — no capability gate, no allowlist, no approval, no log — but it
 * IS scoped: to the single active pane (isPaneActiveForWrite, like the raw-input control-key route)
 * and to existing panes. These tests cover:
 *   (a) happy-path write with explicit paneId that is the active pane
 *   (b) paneId absent → falls back to coreState.activePaneId
 *   (c) single-active-pane guard: an explicit paneId that is NOT the active pane is dropped
 *   (d) unknown / dead paneId → no throw, no write (safe no-op)
 *   (e) empty / non-string data → no write (safe no-op)
 *   (f) gate-absence assertion: the module's import graph touches NO gate object
 *
 * NOTE on scope: (f) proves the HELPER is ungated at the module level; it cannot prove the dispatch
 * site in src/voice/index.ts doesn't wrap it in a gate — that end-to-end ungated guarantee is covered
 * by the live e2e (e2e/live_pane_typing.spec.ts).
 *
 * Conventions follow tests/test_approvals_wse.ts: node:test + node:assert, fake-term idiom with a
 * simple writeRaw spy.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { applyPaneInputFrame } from "../src/voice/paneInputFrame";
import type { PaneInputManager, PaneInputCoreState, PaneInputTerminal } from "../src/voice/paneInputFrame";

// ---------------------------------------------------------------------------
// Fake terminal — a minimal spy that satisfies PaneInputTerminal.
// Mirrors the FakeTerm idiom in test_approvals_wse.ts (writeInput → writeRaw here).
// ---------------------------------------------------------------------------
class FakeTerm implements PaneInputTerminal {
  public writes: string[] = [];
  writeRaw(s: string) { this.writes.push(s); }
}

// ---------------------------------------------------------------------------
// Helper: build a manager and coreState pair quickly.
// ---------------------------------------------------------------------------
function makeCtx(
  paneMap: Record<string, FakeTerm>,
  activePaneId: string | null = null,
): { manager: PaneInputManager; coreState: PaneInputCoreState } {
  return {
    manager: { terminals: paneMap },
    coreState: { activePaneId },
  };
}

// ---------------------------------------------------------------------------
// (a) Happy path: explicit paneId that is the active pane, well-formed data
// ---------------------------------------------------------------------------
describe("applyPaneInputFrame — happy path (explicit active paneId)", () => {
  it('writes msg.data verbatim to the named terminal (case: "echo hi\\r")', () => {
    const p1 = new FakeTerm();
    const { manager, coreState } = makeCtx({ p1 }, "p1");

    applyPaneInputFrame(
      { type: "pane_input", paneId: "p1", data: "echo hi\r" },
      manager,
      coreState,
    );

    assert.deepStrictEqual(p1.writes, ["echo hi\r"]);
  });

  it("writes the data in a single call to writeRaw (no split, no extra CR)", () => {
    const p1 = new FakeTerm();
    const { manager, coreState } = makeCtx({ p1 }, "p1");

    applyPaneInputFrame({ type: "pane_input", paneId: "p1", data: "ls -la\r" }, manager, coreState);

    assert.strictEqual(p1.writes.length, 1, "exactly one writeRaw call per frame");
    assert.strictEqual(p1.writes[0], "ls -la\r", "bytes are passed through verbatim");
  });
});

// ---------------------------------------------------------------------------
// (b) paneId absent → fallback to coreState.activePaneId (which is trivially "active")
// ---------------------------------------------------------------------------
describe("applyPaneInputFrame — activePaneId fallback", () => {
  it("resolves the terminal via coreState.activePaneId when paneId is absent from the frame", () => {
    const p2 = new FakeTerm();
    const { manager, coreState } = makeCtx({ p2 }, "p2");

    // paneId intentionally omitted from the frame
    applyPaneInputFrame({ type: "pane_input", data: "hello" }, manager, coreState);

    assert.deepStrictEqual(p2.writes, ["hello"]);
  });

  it("falls back to activePaneId even when paneId is undefined", () => {
    const p3 = new FakeTerm();
    const { manager, coreState } = makeCtx({ p3 }, "p3");

    applyPaneInputFrame({ type: "pane_input", paneId: undefined, data: "pwd\r" }, manager, coreState);

    assert.deepStrictEqual(p3.writes, ["pwd\r"]);
  });

  it("no-ops (does not throw) when paneId absent AND activePaneId is null", () => {
    const orphan = new FakeTerm();
    const { manager, coreState } = makeCtx({ orphan }, null);

    assert.doesNotThrow(() =>
      applyPaneInputFrame({ type: "pane_input", data: "echo hi\r" }, manager, coreState),
    );
    assert.deepStrictEqual(orphan.writes, [], "no pane resolved → nothing written anywhere");
  });
});

// ---------------------------------------------------------------------------
// (c) Single-active-pane guard: an explicit paneId that is NOT the active pane is dropped,
//     EVEN IF that pane exists. Mirrors the raw-input route's isPaneActiveForWrite scoping.
// ---------------------------------------------------------------------------
describe("applyPaneInputFrame — single-active-pane guard", () => {
  it("drops a frame whose explicit paneId is not the active pane (even though the pane exists)", () => {
    const focused = new FakeTerm();
    const other = new FakeTerm();
    // activePaneId is "focused"; the frame addresses "other" — a stale/hand-crafted/raced target.
    const { manager, coreState } = makeCtx({ focused, other }, "focused");

    applyPaneInputFrame({ type: "pane_input", paneId: "other", data: "rm -rf /\r" }, manager, coreState);

    assert.deepStrictEqual(other.writes, [], "the non-active pane received NO write");
    assert.deepStrictEqual(focused.writes, [], "and nothing leaked into the active pane either");
  });

  it("writes when the explicit paneId equals the active pane", () => {
    const focused = new FakeTerm();
    const { manager, coreState } = makeCtx({ focused }, "focused");

    applyPaneInputFrame({ type: "pane_input", paneId: "focused", data: "ok\r" }, manager, coreState);

    assert.deepStrictEqual(focused.writes, ["ok\r"]);
  });
});

// ---------------------------------------------------------------------------
// (d) Unknown / dead paneId (active, but not in manager.terminals) → safe no-op, no throw.
//     activePaneId is set to the addressed pane so the active-pane guard passes and we exercise the
//     terminal-lookup-miss path specifically.
// ---------------------------------------------------------------------------
describe("applyPaneInputFrame — unknown/dead pane is a safe no-op", () => {
  it("does not throw when the (active) pane is not in manager.terminals", () => {
    const { manager, coreState } = makeCtx({}, "nope");

    assert.doesNotThrow(() =>
      applyPaneInputFrame({ type: "pane_input", paneId: "nope", data: "echo hi\r" }, manager, coreState),
    );
  });

  it("leaves sibling terminals untouched when the addressed pane is missing", () => {
    const other = new FakeTerm();
    const { manager, coreState } = makeCtx({ other }, "nope");

    applyPaneInputFrame({ type: "pane_input", paneId: "nope", data: "whoami\r" }, manager, coreState);

    assert.deepStrictEqual(other.writes, [], "the sibling terminal received no write");
  });

  it("no-ops when paneId is absent and the active pane itself is not in terminals", () => {
    // Intersection of the fallback and unknown-pane paths: activePaneId resolves but has no terminal.
    const { manager, coreState } = makeCtx({}, "ghost");

    assert.doesNotThrow(() => applyPaneInputFrame({ type: "pane_input", data: "x" }, manager, coreState));
  });
});

// ---------------------------------------------------------------------------
// (e) Empty / non-string data → safe no-op, no write
// ---------------------------------------------------------------------------
describe("applyPaneInputFrame — empty or non-string data is a safe no-op", () => {
  it('empty string data "" → no write', () => {
    const p1 = new FakeTerm();
    const { manager, coreState } = makeCtx({ p1 }, "p1");

    applyPaneInputFrame({ type: "pane_input", paneId: "p1", data: "" }, manager, coreState);

    assert.deepStrictEqual(p1.writes, []);
  });

  it("undefined data → no write", () => {
    const p1 = new FakeTerm();
    const { manager, coreState } = makeCtx({ p1 }, "p1");

    applyPaneInputFrame({ type: "pane_input", paneId: "p1", data: undefined }, manager, coreState);

    assert.deepStrictEqual(p1.writes, []);
  });

  it("numeric data (wrong type) → no write, no throw", () => {
    const p1 = new FakeTerm();
    const { manager, coreState } = makeCtx({ p1 }, "p1");

    assert.doesNotThrow(() =>
      applyPaneInputFrame({ type: "pane_input", paneId: "p1", data: 42 as unknown as string }, manager, coreState),
    );
    assert.deepStrictEqual(p1.writes, []);
  });

  it("null data → no write, no throw", () => {
    const p1 = new FakeTerm();
    const { manager, coreState } = makeCtx({ p1 }, "p1");

    assert.doesNotThrow(() =>
      applyPaneInputFrame({ type: "pane_input", paneId: "p1", data: null as unknown as string }, manager, coreState),
    );
    assert.deepStrictEqual(p1.writes, []);
  });
});

// ---------------------------------------------------------------------------
// (f) Gate-absence assertion — the helper is UNGATED at the module level by design.
//
// The module under test (src/voice/paneInputFrame.ts) imports NO capability-gate / allowlist / approval
// module (only the pure isPaneActiveForWrite leaf). We verify structurally that the helper writes an
// arbitrary command — including one the capability gate would normally hold for approval ("rm -rf /") —
// directly to the ACTIVE terminal with zero gate setup, zero pending stores, zero approval flow in
// scope. SCOPE: this proves the helper is ungated; the dispatch site's end-to-end ungated behavior is
// covered by the live e2e, not here.
// ---------------------------------------------------------------------------
describe("applyPaneInputFrame — UNGATED: writes arbitrary bytes without any gate object", () => {
  it("writes a capability-sensitive command verbatim with NO gate object in scope", () => {
    const dangerous = new FakeTerm();
    const manager: PaneInputManager = { terminals: { dangerous } };
    const coreState: PaneInputCoreState = { activePaneId: "dangerous" };

    applyPaneInputFrame(
      { type: "pane_input", paneId: "dangerous", data: "rm -rf /\r" },
      manager,
      coreState,
    );

    // The write landed immediately and verbatim — the gate is not in the call path.
    assert.deepStrictEqual(dangerous.writes, ["rm -rf /\r"]);
  });

  it("writes an Enter keystroke (\\r) verbatim — the operator's Enter, not an injected extra CR", () => {
    // The feature contract forbids writeInput (which appends its own \r). The FakeTerm spy confirms the
    // received byte is exactly what the operator typed: one \r, not two.
    const p1 = new FakeTerm();
    const { manager, coreState } = makeCtx({ p1 }, "p1");

    applyPaneInputFrame({ type: "pane_input", paneId: "p1", data: "\r" }, manager, coreState);

    assert.deepStrictEqual(p1.writes, ["\r"], "exactly one \\r — no appended second \\r (contrast writeInput)");
  });
});
