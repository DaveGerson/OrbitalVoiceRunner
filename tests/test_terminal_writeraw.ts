// UniversalTerminal.writeRaw — the RAW control-byte primitive (multi-cli adapter spec §7).
//
// Unlike writeInput/deliverSubmit (SUBMIT semantics: body + a SEPARATE CR, paste-burst split,
// optimistic Running, history), writeRaw is a single unbuffered passthrough to transport.write:
//   - writes the bytes VERBATIM (no appended \r, no LF, no split, no second write)
//   - is a no-op when there is no live transport (inert / un-spawned pane)
// It is the sole primitive behind the raw-input endpoint and the GUI control-key bar (a Shift+Tab
// button writes ESC[Z verbatim). These byte-shape tests reuse the fake-transport spy pattern from
// tests/test_terminal_input.ts.

import { test } from "node:test";
import assert from "node:assert";
import { UniversalTerminal } from "../src/terminal";
import type { PtyTransport } from "../src/ptyTransport";

// Capture every write; no real process. Same seam as test_terminal_input.ts.
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

// Shift+Tab = ESC [ Z = 0x1b 0x5b 0x5a (the live mode-cycle key on Claude).
const SHIFT_TAB = "\x1b\x5b\x5a";

test("writeRaw writes the EXACT bytes (ESC[Z => 0x1b 0x5b 0x5a) as ONE write, with NO appended CR/LF", () => {
  const term = new UniversalTerminal("test-raw-shifttab", ".", "cmd");
  const { transport, writes } = makeFakeTransport();
  (term as any).transport = transport;
  // wsm-e2e-pinned-ztd: writeRaw now buffers pre-spawn-ready bytes (see
  // tests/test_terminal_writeraw_buffering.ts); this test injects transport directly (bypassing
  // start()/markSpawnReady), so mark the pane already spawn-ready to exercise the passthrough path.
  (term as any).spawnReady = true;

  term.writeRaw(SHIFT_TAB);

  assert.strictEqual(writes.length, 1, "exactly one passthrough write — no separate CR write");
  assert.strictEqual(writes[0], SHIFT_TAB, "bytes are passed through verbatim");
  assert.deepStrictEqual(
    [...writes[0]].map((c) => c.charCodeAt(0)),
    [0x1b, 0x5b, 0x5a],
    "the three raw bytes are 0x1b 0x5b 0x5a — Shift+Tab",
  );
  const joined = writes.join("");
  assert.ok(!joined.includes("\r"), "writeRaw must NOT append a carriage return (contrast deliverSubmit)");
  assert.ok(!joined.includes("\n"), "writeRaw must NOT append a line feed");
});

test("writeRaw passes through a single control byte (Ctrl+C = 0x03) unchanged", () => {
  const term = new UniversalTerminal("test-raw-ctrlc", ".", "cmd");
  const { transport, writes } = makeFakeTransport();
  (term as any).transport = transport;
  (term as any).spawnReady = true; // see note above — simulate an already-spawn-ready pane

  term.writeRaw("\x03");

  assert.deepStrictEqual(writes, ["\x03"], "0x03 (ETX/Ctrl+C) is written verbatim as the only write");
});

test("writeRaw is a no-op when there is no live transport (inert / un-spawned pane)", () => {
  const term = new UniversalTerminal("test-raw-inert", ".", "cmd");
  // No transport injected: an un-spawned pane has transport === null.
  assert.strictEqual((term as any).transport, null, "precondition: pane has no transport");
  // Must not throw and must not record any command/history side effect.
  assert.doesNotThrow(() => term.writeRaw(SHIFT_TAB));
  assert.strictEqual(term.lastCommand, "", "writeRaw never records lastCommand (not a submit)");
});
