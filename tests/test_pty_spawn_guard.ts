// QW2 — guard PTY spawn (bead qw2): a spawn failure must DEGRADE, not crash.
//
// The spawn path (terminal.start -> transportFactory -> createPtyTransport ->
// new NodePtyTransport -> pty.spawn) throws SYNCHRONOUSLY on native/ENOENT
// failures. start() had NO try/catch, so a spawn throw propagated out as an
// uncaught exception and crashed the process. The fix wraps the
// transportFactory(...) call so a failure surfaces as a clean degraded teardown:
// status="Exited", transport=null, shellPid=undefined, timers cleared — never a
// rethrow. There is NO "Error" status; we reuse the existing "Exited" member,
// mirroring the transport.onExit teardown.
//
// This is a PURE unit test: UniversalTerminal is constructed directly with an
// injected transportFactory (constructor arg #9), so no real PTY is ever spawned
// and no server boot is needed. We chdir into a tmpdir first because start()
// reads/writes a .janus_scrollback_<id>.log in cwd.

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { UniversalTerminal } from "../src/terminal";
import type { PtyTransport, createPtyTransport } from "../src/ptyTransport";

// A minimal fake transport satisfying the PtyTransport interface. Callbacks are
// captured but never invoked, so the happy-path terminal simply sits "Running".
function makeFakeTransport(pid = 4242): PtyTransport {
  return {
    pid,
    onData(_cb: (data: string) => void) {},
    onExit(_cb: (info: { exitCode: number; signal?: number }) => void) {},
    write(_data: string) {},
    resize(_cols: number, _rows: number) {},
    kill(_signal?: string) {},
  };
}

// Happy-path factory: returns a fake node-pty transport, never throws.
const okFactory: typeof createPtyTransport = (_finalCommand, _opts) => ({
  transport: makeFakeTransport(),
  usingNodePty: true,
});

// Failing factory: simulates pty.spawn throwing ENOENT synchronously.
const throwingFactory: typeof createPtyTransport = (_finalCommand, _opts) => {
  const err: any = new Error("spawn cmd.exe ENOENT");
  err.code = "ENOENT";
  throw err;
};

describe("qw2 PTY spawn guard (degrade, not crash)", () => {
  let prevCwd: string;
  let tmpDir: string;

  before(() => {
    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qw2-spawn-guard-"));
    process.chdir(tmpDir);
  });

  after(() => {
    process.chdir(prevCwd);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it("a spawn failure surfaces as a clean error, not an uncaught throw", () => {
    // ctor args: terminalId, cwd, shellCmd, toolPreset, permissionsMode,
    //            sessionId, projectId, statusProbe, transportFactory
    const term = new UniversalTerminal(
      "qw2-fail",
      tmpDir,
      "echo hi",
      "Custom",
      "Human-in-the-Loop",
      "",
      "default_project",
      undefined,
      throwingFactory
    );

    let threw: unknown = null;
    try {
      term.start();
    } catch (e) {
      threw = e;
    }
    assert.strictEqual(threw, null, "start() must not let a spawn throw escape");

    assert.strictEqual(term.status, "Exited", "a failed spawn must degrade to Exited");
    assert.strictEqual(
      (term as any).transport,
      null,
      "transport must be reset to null on spawn failure"
    );
    assert.strictEqual(
      (term as any).shellPid,
      undefined,
      "shellPid must be reset to undefined on spawn failure"
    );

    // Happy path unchanged: a normal factory leaves the pane Running with a live transport.
    const okTerm = new UniversalTerminal(
      "qw2-ok",
      tmpDir,
      "echo hi",
      "Custom",
      "Human-in-the-Loop",
      "",
      "default_project",
      undefined,
      okFactory
    );
    okTerm.start();
    assert.strictEqual(okTerm.status, "Running", "happy-path spawn must stay Running");
    assert.notStrictEqual(
      (okTerm as any).transport,
      null,
      "happy-path transport must be assigned"
    );
  });
});
