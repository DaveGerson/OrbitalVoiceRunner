import { test } from "node:test";
import assert from "node:assert";
import { UniversalTerminal } from "../src/terminal";
import type { PtyTransport } from "../src/ptyTransport";

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

test("writeInput submits with CR (\\r), not LF — ConPTY Enter is carriage return", () => {
  const term = new UniversalTerminal("test-input-cr", ".", "cmd");
  const { transport, writes } = makeFakeTransport();
  (term as any).transport = transport;   // inject fake; never start() a real PTY

  term.writeInput("ls");

  assert.strictEqual(writes.length, 1, "writeInput should emit exactly one write");
  assert.strictEqual(writes[0], "ls\r", `expected "ls\\r", got ${JSON.stringify(writes[0])}`);
  assert.ok(!writes[0].endsWith("\n"), "submit terminator must NOT be LF");
});

test("writeInput preserves the command body verbatim and appends a single CR", () => {
  const term = new UniversalTerminal("test-input-body", ".", "cmd");
  const { transport, writes } = makeFakeTransport();
  (term as any).transport = transport;

  const prompt = "Reply with PONG. token=JANUS_XQ7";
  term.writeInput(prompt);

  assert.strictEqual(writes[0], prompt + "\r");
  assert.ok(!writes[0].includes("\n"), "no stray LF anywhere in the submitted bytes");
});

test("writeInput records lastCommand even before asserting the wire bytes", () => {
  const term = new UniversalTerminal("test-input-last", ".", "cmd");
  const { transport } = makeFakeTransport();
  (term as any).transport = transport;
  term.writeInput("echo hi");
  assert.strictEqual(term.lastCommand, "echo hi");
});
