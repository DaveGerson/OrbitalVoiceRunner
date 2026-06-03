import { test, mock } from "node:test";
import assert from "node:assert";
import { UniversalTerminal } from "../src/terminal";
import type { PtyTransport } from "../src/ptyTransport";

// --- G3: stdin/TTY readiness gate -------------------------------------------
// A freshly spawned ConPTY child has not yet attached its stdin reader, so the
// earliest writeInput() bytes are dropped on the floor — the agent CLI then
// prints "Warning: no stdin data received in 3s" and may exit. The fix buffers
// input into a pendingInput[] queue until the child proves itself ready (first
// onData) or a ~750ms fallback timer fires, then flushes IN ORDER.
//
// These tests inject a FakeTransport via the new (optional, last) constructor
// param `transportFactory`, exercising the contract without spawning a real PTY
// (matching the seam style in tests/test_terminal_resize.ts).

class FakeTransport implements PtyTransport {
  writes: string[] = [];
  private dataCb: ((d: string) => void) | null = null;
  private exitCb: ((e: { exitCode: number; signal?: number }) => void) | null = null;
  pid: number | undefined = 4242;
  onData(cb: (d: string) => void) {
    this.dataCb = cb;
  }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void) {
    this.exitCb = cb;
  }
  write(d: string) {
    this.writes.push(d);
  }
  resize() {}
  kill() {}
  /** test drives "child produced output" (the natural readiness edge). */
  emitData(d: string) {
    this.dataCb?.(d);
  }
  emitExit() {
    this.exitCb?.({ exitCode: 0 });
  }
}

function makeTerm(id: string, fake: FakeTransport): UniversalTerminal {
  return new UniversalTerminal(
    id,
    ".",
    "cmd",
    "Custom",
    "Human-in-the-Loop",
    "",
    "p",
    undefined,
    () => ({ transport: fake, usingNodePty: true })
  );
}

// THE FAILING TEST (write/run this FIRST — on pre-fix code writeInput writes
// immediately, so fake.writes is non-empty before any emitData).
test("writeInput before ready queues, then flushes in order on first onData", () => {
  const fake = new FakeTransport();
  const term = makeTerm("g3a", fake);
  term.start(); // spawns fake; spawnReady starts false

  term.writeInput("first"); // pre-ready -> queued, NOT written
  term.writeInput("second"); // pre-ready -> queued, NOT written
  assert.deepStrictEqual(fake.writes, [], "no input written before child is ready");

  fake.emitData("welcome\n"); // first data == child attached -> flush

  assert.deepStrictEqual(
    fake.writes,
    ["first\r", "second\r"], // flushed IN ORDER, CR-terminated (Enter submit, G1)
    "queued input flushed in submission order once ready"
  );
});

test("writeInput after ready passes straight through (no queue residue)", () => {
  const fake = new FakeTransport();
  const term = makeTerm("g3b", fake);
  term.start();

  fake.emitData("ready\n"); // child attaches before any input
  term.writeInput("third"); // post-ready -> immediate

  assert.deepStrictEqual(fake.writes, ["third\r"], "post-ready write is immediate, no residue");
});

test("silent child still drains the queue via the ~750ms fallback timer", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const fake = new FakeTransport();
    const term = makeTerm("g3c", fake);
    term.start();

    term.writeInput("a");
    term.writeInput("b");
    assert.deepStrictEqual(fake.writes, [], "queued while not ready");

    mock.timers.tick(750); // no emitData — the belt path drains it

    assert.deepStrictEqual(
      fake.writes,
      ["a\r", "b\r"],
      "fallback timer flushes queued input in order without any child output"
    );
  } finally {
    mock.timers.reset();
  }
});

test("markSpawnReady is idempotent — a second onData does not double-write", () => {
  const fake = new FakeTransport();
  const term = makeTerm("g3d", fake);
  term.start();

  term.writeInput("once");
  fake.emitData("first chunk\n"); // flush
  fake.emitData("second chunk\n"); // must NOT re-flush

  assert.deepStrictEqual(fake.writes, ["once\r"], "queued command written exactly once");
});

test("empty queue on first data is a harmless no-op", () => {
  const fake = new FakeTransport();
  const term = makeTerm("g3e", fake);
  term.start();

  assert.doesNotThrow(() => fake.emitData("hello\n"));
  assert.deepStrictEqual(fake.writes, [], "nothing queued -> nothing written");
});

test("exit before ready does not flush queued input into a dead transport", () => {
  const fake = new FakeTransport();
  const term = makeTerm("g3f", fake);
  term.start();

  term.writeInput("stranded"); // queued, never ready
  fake.emitExit(); // child dies before first data

  assert.deepStrictEqual(fake.writes, [], "no late flush into a dead transport");
});
