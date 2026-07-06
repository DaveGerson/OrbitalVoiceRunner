// wsm-e2e-pinned-ztd: writeRaw dropped bytes typed in the pre-spawn-ready ConPTY window (unlike
// writeInput, which buffers onto `pendingInput` and flushes on markSpawnReady). This suite pins the
// fix: pre-ready writeRaw bytes now flush EXACTLY ONCE, VERBATIM (no appended CR), in order relative
// to any queued writeInput entries — and post-ready writeRaw stays a straight, unbuffered passthrough.
//
// Same FakeTransport seam as tests/test_terminal_stdin_readiness.ts.

import { test, mock } from "node:test";
import assert from "node:assert";
import { UniversalTerminal } from "../src/terminal";
import type { PtyTransport } from "../src/ptyTransport";

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
  emitData(d: string) {
    this.dataCb?.(d);
  }
  emitExit() {
    this.exitCb?.({ exitCode: 0 });
  }
}

function makeTerm(id: string, fake: FakeTransport): UniversalTerminal {
  const term = new UniversalTerminal(
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
  (term as any).submitEnterDelayMs = 0;
  return term;
}

const SHIFT_TAB = "\x1b\x5b\x5a";

test("pre-ready writeRaw bytes flush EXACTLY ONCE, verbatim (no CR), on markSpawnReady", () => {
  const fake = new FakeTransport();
  const term = makeTerm("ztd-a", fake);
  term.start();

  term.writeRaw(SHIFT_TAB); // pre-ready -> buffered, NOT written yet
  assert.deepStrictEqual(fake.writes, [], "no raw write before spawn-ready");

  fake.emitData("welcome\n"); // first data -> ready, flush queue

  assert.deepStrictEqual(fake.writes, [SHIFT_TAB], "queued raw bytes flushed verbatim, exactly once");
  const joined = fake.writes.join("");
  assert.ok(!joined.includes("\r"), "flushed raw bytes must NOT gain an appended CR");
});

test("pre-ready writeRaw and writeInput preserve relative submission order", () => {
  const fake = new FakeTransport();
  const term = makeTerm("ztd-b", fake);
  term.start();

  term.writeInput("first"); // submit entry
  term.writeRaw("\x03"); // raw entry (Ctrl+C)
  term.writeInput("second"); // submit entry
  assert.deepStrictEqual(fake.writes, [], "nothing written before ready");

  fake.emitData("ready\n");

  assert.deepStrictEqual(
    fake.writes,
    ["first", "\r", "\x03", "second", "\r"],
    "queue flushes in submission order: submit(body,CR), raw(verbatim), submit(body,CR)"
  );
});

test("fallback timer also flushes a pre-ready writeRaw with no live child output", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const fake = new FakeTransport();
    const term = makeTerm("ztd-c", fake);
    term.start();

    term.writeRaw(SHIFT_TAB);
    assert.deepStrictEqual(fake.writes, [], "queued while not ready");

    mock.timers.tick(750);

    assert.deepStrictEqual(fake.writes, [SHIFT_TAB], "fallback timer flushes queued raw bytes verbatim");
  } finally {
    mock.timers.reset();
  }
});

test("post-ready writeRaw is a straight passthrough — no queue residue, no double-write", () => {
  const fake = new FakeTransport();
  const term = makeTerm("ztd-d", fake);
  term.start();

  fake.emitData("ready\n"); // child attaches before any raw write
  term.writeRaw(SHIFT_TAB); // post-ready -> immediate single write

  assert.deepStrictEqual(fake.writes, [SHIFT_TAB], "post-ready raw write is immediate and verbatim");
});

test("exit before ready does not flush a queued raw write into a dead transport", () => {
  const fake = new FakeTransport();
  const term = makeTerm("ztd-e", fake);
  term.start();

  term.writeRaw(SHIFT_TAB); // queued, never ready
  fake.emitExit(); // child dies before first data

  assert.deepStrictEqual(fake.writes, [], "no late flush of raw bytes into a dead transport");
});
