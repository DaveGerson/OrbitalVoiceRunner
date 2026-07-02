import { test } from "node:test";
import assert from "assert";
import { OrchestratorManager, UniversalTerminal, appendRawCapped } from "../src/terminal";
import { JanusStore } from "../src/store/sqliteStore";

// --- Pure raw-display-backfill buffer ---------------------------------------
// xterm owns the live buffer, but a freshly-opened pane needs a one-shot raw
// backfill (escape sequences intact, NOT ANSI-stripped). appendRawCapped is the
// pure cap: keep the most-recent `max` chars so the buffer can't grow unbounded.

test("appendRawCapped returns the concatenation when under the cap", () => {
  assert.strictEqual(appendRawCapped("abc", "def", 100), "abcdef");
});

test("appendRawCapped keeps the most-recent tail when over the cap", () => {
  // 6 chars of history + 6 new, cap 8 -> keep last 8 chars
  assert.strictEqual(appendRawCapped("123456", "789012", 8), "56789012");
});

test("appendRawCapped preserves raw ANSI escape bytes (no stripping)", () => {
  const esc = "[31mRED[0m";
  assert.strictEqual(appendRawCapped("", esc, 100), esc);
});

// --- Resize plumbing: UniversalTerminal + OrchestratorManager ---------------
// The PTY grid must track the xterm grid. resize() stores the dims (so the next
// start() spawns at the right size) AND, when live, delegates to the transport's
// guarded pty.resize(). The dims are stored even without a live transport, so the
// contract is testable without spawning a real process (the live node-pty
// delegation is verified by running the app, e.g. resizing under htop).

test("UniversalTerminal defaults to an 80x30 grid", () => {
  const term = new UniversalTerminal("rzdef", ".", "cmd");
  assert.strictEqual(term.cols, 80);
  assert.strictEqual(term.rows, 30);
});

test("UniversalTerminal.resize stores the new grid", () => {
  const term = new UniversalTerminal("rzset", ".", "cmd");
  term.resize(120, 40);
  assert.strictEqual(term.cols, 120);
  assert.strictEqual(term.rows, 40);
});

test("UniversalTerminal.resize rejects non-positive / non-finite dims", () => {
  const term = new UniversalTerminal("rzbad", ".", "cmd");
  term.resize(120, 40);
  term.resize(0, 50);          // invalid cols -> ignored
  term.resize(100, -3);        // invalid rows -> ignored
  term.resize(NaN, NaN);       // non-finite -> ignored
  assert.strictEqual(term.cols, 120, "cols unchanged by invalid resize");
  assert.strictEqual(term.rows, 40, "rows unchanged by invalid resize");
});

test("manager.resize delegates to the pane and no-ops on unknown ids", () => {
  const store = new JanusStore(":memory:");
  store.init();
  const manager = new OrchestratorManager({ ledger: store });
  const term = new UniversalTerminal("rzmgr", ".", "cmd");
  manager.terminals["rzmgr"] = term;   // insert without start() — no spawn
  manager.resize("rzmgr", 132, 43);
  assert.strictEqual(term.cols, 132);
  assert.strictEqual(term.rows, 43);
  assert.doesNotThrow(() => manager.resize("nope", 100, 50));
});
