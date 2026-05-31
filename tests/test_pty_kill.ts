import { test } from "node:test";
import assert from "assert";
import { killSignalForPlatform } from "../src/ptyTransport";

// node-pty's Windows backend does not support POSIX signals: passing one to
// proc.kill() throws "Signals not supported on windows" in a deferred context
// (an async uncaughtException that escapes the synchronous try/catch and crashes
// the test runner during UniversalTerminal.stop() teardown). The fix: never pass
// a signal to kill() on win32. killSignalForPlatform encodes that choice purely.

test("killSignalForPlatform drops the signal on win32", () => {
  assert.strictEqual(killSignalForPlatform("win32", "SIGTERM"), undefined);
  assert.strictEqual(killSignalForPlatform("win32", "SIGKILL"), undefined);
  assert.strictEqual(killSignalForPlatform("win32", undefined), undefined);
});

test("killSignalForPlatform preserves the signal on POSIX", () => {
  assert.strictEqual(killSignalForPlatform("linux", "SIGTERM"), "SIGTERM");
  assert.strictEqual(killSignalForPlatform("darwin", "SIGKILL"), "SIGKILL");
  assert.strictEqual(killSignalForPlatform("linux", undefined), undefined);
});
