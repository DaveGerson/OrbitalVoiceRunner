// P3 — deterministic session capture (multi-cli adapter spec §9, bug B3).
//
// The B3 bug: a fresh Claude pane was given a SYNTHETIC "claude-code-session-<hex>"
// id (never a real UUID), so the launch carried NEITHER --session-id NOR --resume,
// and checkForSessionId() then scraped stdout for an id that Claude NEVER prints —
// leaving --resume to almost never fire. The fix (spec §9):
//   - Claude pins a GENERATED UUID via adapter.generateSessionId(), fed into
//     --session-id at FIRST launch. Resume re-launches with --resume <same-uuid>.
//   - The stdout scrape must NOT clobber a pinned UUID (Claude never prints it):
//     capture routes through adapter.captureSessionId — Claude returns the pinned id.
//   - Custom (no session model) gets neither --session-id nor --resume.
//
// PURE unit test: UniversalTerminal is constructed with an injected transportFactory
// (ctor arg #9) so no real PTY is spawned. The factory's FIRST argument is exactly
// the launch string start() builds (the same seam as tests/test_pty_spawn_guard.ts),
// so we capture it and assert on the flags. We chdir into a tmpdir because start()
// reads/writes a .janus_scrollback_<id>.log in cwd.

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { UniversalTerminal } from "../src/terminal";
import type { PtyTransport, createPtyTransport } from "../src/ptyTransport";

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const ANCHORED_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIXED_UUID = "0f9e8d7c-6b5a-4321-9876-543210fedcba";

// Captures every PTY launch string handed to the transport factory.
function makeCapturingFactory(sink: string[]): typeof createPtyTransport {
  const transport: PtyTransport = {
    pid: 4242,
    onData(_cb: (data: string) => void) {},
    onExit(_cb: (info: { exitCode: number; signal?: number }) => void) {},
    write(_data: string) {},
    resize(_cols: number, _rows: number) {},
    kill(_signal?: string) {},
  };
  return (finalCommand, _opts) => {
    sink.push(finalCommand);
    return { transport, usingNodePty: true };
  };
}

describe("P3 session pinning (spec §9 / bug B3)", () => {
  let prevCwd: string;
  let tmpDir: string;

  before(() => {
    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p3-session-pinning-"));
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

  // ctor args: terminalId, cwd, shellCmd, toolPreset, permissionsMode,
  //            sessionId, projectId, statusProbe, transportFactory
  const make = (
    id: string,
    preset: "Claude Code" | "Codex" | "Antigravity" | "Custom",
    cmd: string,
    sessionId: string,
    sink: string[]
  ) =>
    new UniversalTerminal(
      id,
      tmpDir,
      cmd,
      preset,
      "Human-in-the-Loop",
      sessionId,
      "default_project",
      undefined,
      makeCapturingFactory(sink)
    );

  it("a fresh Claude pane (no sessionId) is assigned a real UUID, not a synthetic id", () => {
    const term = make("p3-claude-fresh", "Claude Code", "claude", "", []);
    assert.ok(
      ANCHORED_UUID_RE.test(term.sessionId),
      `expected a real UUID, got '${term.sessionId}'`
    );
    assert.ok(
      !term.sessionId.includes("-session-"),
      `must NOT be a synthetic '<tool>-session-<hex>' id: '${term.sessionId}'`
    );
  });

  it("a fresh Claude pane launches with --session-id <uuid> (pin, not --resume)", () => {
    const sink: string[] = [];
    const term = make("p3-claude-launch", "Claude Code", "claude", "", sink);
    term.start();
    assert.strictEqual(sink.length, 1, "exactly one spawn");
    const launch = sink[0];
    assert.ok(launch.includes("--session-id"), `fresh launch pins via --session-id: ${launch}`);
    assert.ok(launch.includes(term.sessionId), `pins the generated uuid: ${launch}`);
    assert.ok(
      !/--resume\b/.test(launch),
      `a FIRST launch must NOT --resume (the session does not exist yet): ${launch}`
    );
  });

  it("a resumed Claude pane (sessionId supplied) launches with --resume <same-uuid>", () => {
    const sink: string[] = [];
    const term = make("p3-claude-resume", "Claude Code", "claude", FIXED_UUID, sink);
    assert.strictEqual(term.sessionId, FIXED_UUID, "carries the supplied uuid verbatim");
    term.start();
    const launch = sink[0];
    assert.ok(launch.includes("--resume"), `resume launches with --resume: ${launch}`);
    assert.ok(launch.includes(FIXED_UUID), `resumes the exact uuid: ${launch}`);
    assert.ok(
      !/--session-id\b/.test(launch),
      `resume must NOT also pin a fresh --session-id: ${launch}`
    );
  });

  it("a Custom pane gets neither a uuid nor --session-id / --resume", () => {
    const sink: string[] = [];
    const term = make("p3-custom", "Custom", "bash", "", sink);
    assert.strictEqual(term.sessionId, "", "Custom has no session id");
    term.start();
    const launch = sink[0];
    assert.ok(!UUID_RE.test(launch), `Custom launch carries no uuid: ${launch}`);
    assert.ok(!/--session-id\b/.test(launch), `no --session-id on Custom: ${launch}`);
    assert.ok(!/--resume\b/.test(launch), `no --resume on Custom: ${launch}`);
  });

  it("the stdout scrape never clobbers a Claude pane's pinned UUID (Claude never prints it)", () => {
    const term = make("p3-claude-noclobber", "Claude Code", "claude", "", []);
    const pinned = term.sessionId;
    assert.ok(ANCHORED_UUID_RE.test(pinned), "precondition: pinned UUID");
    // Feed exactly the kind of stdout noise the old scrape would have matched.
    (term as any).checkForSessionId("Session ID: deadbeefcafef00d\n");
    (term as any).checkForSessionId('session_id="not-the-real-one"\n');
    assert.strictEqual(
      term.sessionId,
      pinned,
      "a pinned-session (Claude) pane must keep its UUID — the scrape must not overwrite it"
    );
  });
});
