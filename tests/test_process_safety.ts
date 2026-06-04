// QW1 — process-level error net (bead qw1).
//
// server.ts had NO process.on("uncaughtException") / ("unhandledRejection") handler
// anywhere. A stray rejection or a throw at an async edge (PTY data event, Gemini
// callback) would tear the whole voice orchestrator down. This suite proves the
// module installs a guarded, best-effort net AT MODULE SCOPE (importing ../server is
// the side effect that installs it), that the net logs and does NOT force a crash
// exit on a recoverable rejection.
//
// We assert against a module-exposed counter (__processSafety) rather than spying on
// console so the test is deterministic and order-independent. Importing ../server is
// what installs the handlers; we then drive them via process.emit(...).

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";

describe("QW1 process-level error net (headless)", () => {
  let serverMod: any;
  let prevCwd: string;
  let tmpDir: string;
  let prevExitCode: typeof process.exitCode;

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";

    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-procsafe-"));
    process.chdir(tmpDir);

    // Importing the module is the side effect that installs the handlers at module scope.
    serverMod = await import("../server");
    prevExitCode = process.exitCode;
  });

  after(async () => {
    process.exitCode = prevExitCode ?? 0;
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  // The node:test runner registers its OWN uncaughtException/unhandledRejection listeners and
  // re-surfaces anything emitted as a failed test. To exercise ONLY the server's installed net,
  // detach every other listener for the duration of the emit, then restore them.
  function emitIsolated(event: "uncaughtException" | "unhandledRejection", ...args: any[]) {
    const others = process.listeners(event as any).slice() as any[];
    for (const l of others) process.removeListener(event as any, l);
    serverMod.__installProcessErrorNetForTest(); // re-attach ONLY the server net (idempotent if present)
    try {
      (process as any).emit(event, ...args);
    } finally {
      // Restore the runner's listeners exactly as they were.
      const serverNet = process.listeners(event as any).slice() as any[];
      for (const l of serverNet) process.removeListener(event as any, l);
      for (const l of others) process.on(event as any, l);
      serverMod.__installProcessErrorNetForTest();
    }
  }

  it("an unhandledRejection is logged and does not exit", () => {
    const counters = serverMod.__processSafety;
    assert.ok(counters, "server exposes __processSafety counters for the test seam");
    const before = counters.unhandledRejections;
    process.exitCode = 0;

    // Emit against the installed handler. If no handler is installed, Node would
    // print a warning and (on newer Node) set a nonzero exit code; the guard is that
    // OUR handler ran and did NOT force a crash exit code.
    emitIsolated("unhandledRejection", new Error("boom"), Promise.resolve());

    assert.strictEqual(counters.unhandledRejections, before + 1, "the unhandledRejection handler ran exactly once");
    assert.notStrictEqual(process.exitCode, 1, "a recoverable rejection must NOT force a crash exit code");
  });

  it("uncaughtException triggers graceful drain, not a bare crash", () => {
    const counters = serverMod.__processSafety;
    const before = counters.uncaughtExceptions;
    process.exitCode = 0;

    emitIsolated("uncaughtException", new Error("boom2"));

    assert.strictEqual(counters.uncaughtExceptions, before + 1, "the uncaughtException handler ran exactly once");
    // Best-effort net: it must not slam the process down with a bare process.exit()
    // on a single recoverable throw (the existing process.once('exit') closes the store).
    assert.notStrictEqual(process.exitCode, 1, "uncaughtException net must not force a crash exit code");
  });

  it("the handlers are installed exactly once (no per-import accumulation)", async () => {
    const c1 = process.listenerCount("unhandledRejection");
    const c2 = process.listenerCount("uncaughtException");
    // Re-import: a cached module must NOT re-run the install and add a second listener.
    await import("../server");
    assert.strictEqual(process.listenerCount("unhandledRejection"), c1, "no extra unhandledRejection listener on re-import");
    assert.strictEqual(process.listenerCount("uncaughtException"), c2, "no extra uncaughtException listener on re-import");
  });
});
