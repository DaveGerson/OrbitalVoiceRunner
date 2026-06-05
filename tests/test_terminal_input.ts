import { test, mock } from "node:test";
import assert from "node:assert";
import { UniversalTerminal } from "../src/terminal";
import type { PtyTransport } from "../src/ptyTransport";

// Issue B: writeInput now delivers the BODY and the submit ENTER as TWO writes (the CR after a
// brief gap) so a ConPTY-hosted Ink TUI registers the CR as a discrete Enter keypress rather than
// absorbing `body + "\r"` as a paste burst (which left long prompts staged-but-unsubmitted). These
// byte-shape tests force the gap to 0 (submitEnterDelayMs) for deterministic SYNCHRONOUS assertions;
// the paced (gap > 0) behavior is covered by its own test below and end-to-end by smoke:claude.

// Minimal fake transport: capture every write, no real process. Mirrors the
// (term as any).<private> seam already used across the suite (test_status_gating,
// smoke-handoff) to reach UniversalTerminal internals in tests.
function makeFakeTransport() {
  const writes: string[] = [];
  const transport: PtyTransport = {
    pid: 4242,
    onData() {},
    onExit() {},
    write(data: string) { writes.push(data); },
    resize() {},
    kill() {},
  };
  return { transport, writes };
}

test("writeInput submits the BODY then a SEPARATE CR (\\r), not a combined paste chunk and not LF", () => {
  const term = new UniversalTerminal("test-input-cr", ".", "cmd");
  const { transport, writes } = makeFakeTransport();
  (term as any).transport = transport;   // inject fake; never start() a real PTY
  (term as any).spawnReady = true;       // G3: model a child that has attached its stdin (post-ready wire contract)
  (term as any).submitEnterDelayMs = 0;  // synchronous two-write for a deterministic byte assertion

  term.writeInput("ls");

  assert.deepStrictEqual(writes, ["ls", "\r"], "body and the submit CR are two DISCRETE writes (not 'ls\\r' in one chunk)");
  assert.ok(!writes.join("").includes("\n"), "submit terminator must be CR, never LF");
});

test("writeInput preserves the command body verbatim and submits with a separate CR", () => {
  const term = new UniversalTerminal("test-input-body", ".", "cmd");
  const { transport, writes } = makeFakeTransport();
  (term as any).transport = transport;
  (term as any).spawnReady = true;       // G3: post-ready wire contract (see CR test above)
  (term as any).submitEnterDelayMs = 0;

  const prompt = "Reply with PONG. token=JANUS_XQ7";
  term.writeInput(prompt);

  assert.deepStrictEqual(writes, [prompt, "\r"], "body verbatim, then a separate CR");
  assert.ok(!writes.join("").includes("\n"), "no stray LF anywhere in the submitted bytes");
});

test("writeInput (paced, gap > 0) writes the body immediately and the submit CR after the gap (Issue B)", async () => {
  // The gap is what makes the CR land in a SEPARATE ConPTY read so the TUI reads it as a discrete
  // Enter — a synchronous two-write alone is coalesced by ConPTY into one paste burst (proven by
  // smoke:claude failing at delay=0 and passing at the default gap).
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const term = new UniversalTerminal("test-input-paced", ".", "cmd");
    const { transport, writes } = makeFakeTransport();
    (term as any).transport = transport;
    (term as any).spawnReady = true;
    (term as any).submitEnterDelayMs = 20; // force the paced path

    term.writeInput("go");
    await Promise.resolve(); await Promise.resolve(); // let the serialized submit microtask write the body
    assert.deepStrictEqual(writes, ["go"], "body written immediately; the CR is deferred by the gap");
    mock.timers.tick(20);                              // the gap elapses -> the Enter is delivered
    assert.deepStrictEqual(writes, ["go", "\r"], "the submit CR arrives as a SEPARATE write after the gap");
  } finally {
    mock.timers.reset();
  }
});

test("writeInput records lastCommand even before asserting the wire bytes", () => {
  const term = new UniversalTerminal("test-input-last", ".", "cmd");
  const { transport } = makeFakeTransport();
  (term as any).transport = transport;
  term.writeInput("echo hi");
  assert.strictEqual(term.lastCommand, "echo hi");
});
