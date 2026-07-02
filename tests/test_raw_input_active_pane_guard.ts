// Active-pane guard on POST /api/terminals/:id/raw-input (raw-key controls nit #1).
//
// The voice write path (src/voice/index.ts) refuses to write to any pane that is NOT the single
// active pane the operator has open (coreState.activePaneId), in ALL gate modes, via the shared
// isPaneActiveForWrite() predicate (src/activePane.ts). The raw-input REST surface MUST mirror that
// refusal: raw keystrokes may only ever reach the focused pane. A keystroke aimed at a non-active
// pane is refused with 409 and the pane's transport receives NOTHING — even an "always-allowed"
// nav key or the Ctrl+C brake, because the guard is about WHICH pane, not which key.
//
// Boots the REAL server in-process (the same ce7 harness as tests/test_raw_input_endpoint.ts). A
// pane's live transport is modeled by a fake transport that records every write; the active pane is
// pinned through the _testSetActivePane seam (mirrors how the UI's set_active_pane WS message sets
// coreState.activePaneId server-side).

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import type { MockLiveHandle } from "./helpers/mockLive";
import { teardownServerSuite } from "./helpers/teardown";
import type { RunningServer } from "../server";
import { UniversalTerminal } from "../src/terminal";
import type { PtyTransport } from "../src/ptyTransport";

const SHIFT_TAB = "\x1b\x5b\x5a"; // ESC[Z — the ONE gated raw key
const ARROW_UP = "\x1b\x5b\x41";  // ESC[A — always-allowed nav
const CTRL_C = "\x03";            // always-allowed emergency brake

// A spawned pane: a UniversalTerminal with an injected fake transport that records every write.
function spawnedPane(id: string): { term: UniversalTerminal; writes: string[] } {
  const writes: string[] = [];
  const transport: PtyTransport = {
    pid: 7777,
    onData() {},
    onExit() {},
    write(data: string) { writes.push(data); },
    resize() {},
    kill() {},
  };
  const term = new UniversalTerminal(id, ".", "cmd");
  (term as any).transport = transport;
  // wsm-e2e-pinned-ztd: writeRaw now buffers pre-spawn-ready bytes; this harness injects the
  // transport directly (bypassing start()/markSpawnReady), so mark the pane already spawn-ready to
  // model a real "live PTY" pane.
  (term as any).spawnReady = true;
  return { term, writes };
}

describe("POST /api/terminals/:id/raw-input — active-pane guard (headless real server)", () => {
  let startServer: (opts?: any) => Promise<RunningServer>;
  let apiToken: string;
  let installMockLive: () => MockLiveHandle;

  let mock: MockLiveHandle;
  let running: RunningServer;
  let base: string;
  let tmpDir: string;
  let prevCwd: string;

  const api = (pathname: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${base}${pathname}`, {
      ...init,
      headers: { "x-api-token": apiToken, "content-type": "application/json", ...(init.headers || {}) },
    });

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";

    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-rawguard-"));
    process.chdir(tmpDir);

    ({ installMockLive } = await import("./helpers/mockLive"));
    const serverMod = await import("../server");
    startServer = serverMod.startServer;
    apiToken = serverMod.API_AUTH_TOKEN;

    mock = installMockLive();
    running = await startServer({ port: 0, enableVite: false });
    base = `http://127.0.0.1:${running.port}`;

    // Auto on-spotlight so the gated Shift+Tab would otherwise RUN — proving the active-pane guard
    // (not the capability gate) is what refuses a non-active target.
    running.manager.settings.advanced = running.manager.settings.advanced || ({} as any);
    (running.manager.settings.advanced as any).capabilityGates = { write_to_pane: "Auto" };
  });

  after(async () => {
    try { await api("/api/stop-all/release", { method: "POST" }); } catch {}
    running._testSetActivePane?.(null);
    await teardownServerSuite(running);
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("raw input to the ACTIVE pane proceeds (nav key delivered, 200)", async () => {
    const { term, writes } = spawnedPane("g-active");
    running.manager.terminals["g-active"] = term;
    running._testSetActivePane?.("g-active");

    const res = await api("/api/terminals/g-active/raw-input", {
      method: "POST",
      body: JSON.stringify({ bytes: ARROW_UP }),
    });
    assert.strictEqual(res.status, 200, "active pane => raw key proceeds (200)");
    assert.deepStrictEqual(writes, [ARROW_UP], "the arrow bytes reach the active pane verbatim");

    running._testSetActivePane?.(null);
    delete running.manager.terminals["g-active"];
  });

  it("raw input to a NON-active pane is refused (409) and the transport receives NOTHING", async () => {
    const { term: active } = spawnedPane("g-on");
    const { term: other, writes: otherWrites } = spawnedPane("g-off");
    running.manager.terminals["g-on"] = active;
    running.manager.terminals["g-off"] = other;
    // Operator has 'g-on' open; 'g-off' is a background pane.
    running._testSetActivePane?.("g-on");

    const res = await api("/api/terminals/g-off/raw-input", {
      method: "POST",
      body: JSON.stringify({ bytes: ARROW_UP }),
    });
    assert.strictEqual(res.status, 409, "non-active target => 409 refused");
    const body = await res.json();
    assert.ok(typeof body.error === "string" && body.error.length > 0, "409 carries an explanatory error");
    assert.deepStrictEqual(otherWrites, [], "NOTHING is written to the non-active pane's transport");

    running._testSetActivePane?.(null);
    delete running.manager.terminals["g-on"];
    delete running.manager.terminals["g-off"];
  });

  it("even Ctrl+C (the always-allowed brake) is refused on a NON-active pane — transport untouched", async () => {
    const { term, writes } = spawnedPane("g-ctrlc-off");
    running.manager.terminals["g-ctrlc-off"] = term;
    // No pane is active at all (null) => no write target => every key refused.
    running._testSetActivePane?.(null);

    const res = await api("/api/terminals/g-ctrlc-off/raw-input", {
      method: "POST",
      body: JSON.stringify({ bytes: CTRL_C }),
    });
    assert.strictEqual(res.status, 409, "Ctrl+C to a non-active pane is still refused by the pane guard");
    assert.deepStrictEqual(writes, [], "no bytes reach a non-active pane, not even Ctrl+C");
    delete running.manager.terminals["g-ctrlc-off"];
  });

  it("the gated Shift+Tab on a NON-active pane is refused by the pane guard BEFORE the capability gate", async () => {
    const { term, writes } = spawnedPane("g-shifttab-off");
    running.manager.terminals["g-shifttab-off"] = term;
    running._testSetActivePane?.("some-other-active-pane");

    const res = await api("/api/terminals/g-shifttab-off/raw-input", {
      method: "POST",
      body: JSON.stringify({ bytes: SHIFT_TAB }),
    });
    assert.strictEqual(res.status, 409, "Shift+Tab to a non-active pane => 409 (pane guard precedes the gate)");
    assert.deepStrictEqual(writes, [], "no deferred/queued write reaches a non-active pane");

    running._testSetActivePane?.(null);
    delete running.manager.terminals["g-shifttab-off"];
  });
});
