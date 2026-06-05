// POST /api/terminals/:id/raw-input — the raw control-byte endpoint (multi-cli adapter spec §7, §10).
//
// Mirrors the existing input endpoint but (a) routes through writeRaw (no Enter-append, no history)
// and (b) bifurcates the capability gate: navigation keys + Ctrl+C are ALWAYS-ALLOWED; the disruptive
// Shift+Tab (ESC[Z) routes through gateOrDefer("write_to_pane", …) — Ask off-spotlight => 202 defer.
//
// Boots the REAL server in-process (no Gemini key, no mic), the same ce7 harness pattern as
// tests/test_pane_gates_rest.ts. A pane's "live transport" is modeled by injecting a fake transport
// onto a UniversalTerminal placed in manager.terminals[id]; an un-spawned pane has transport === null.

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

const SHIFT_TAB = "\x1b\x5b\x5a"; // ESC[Z — 0x1b 0x5b 0x5a (the ONE gated raw key)
const ARROW_UP = "\x1b\x5b\x41";  // ESC[A — always-allowed nav

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
  return { term, writes };
}

describe("POST /api/terminals/:id/raw-input (headless real server)", () => {
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-rawinput-"));
    process.chdir(tmpDir);

    ({ installMockLive } = await import("./helpers/mockLive"));
    const serverMod = await import("../server");
    startServer = serverMod.startServer;
    apiToken = serverMod.API_AUTH_TOKEN;

    mock = installMockLive();
    running = await startServer({ port: 0, enableVite: false });
    base = `http://127.0.0.1:${running.port}`;

    // Pin the GLOBAL write_to_pane gate to Ask so an off-spotlight pane DEFERS deterministically
    // (the resolver falls back to globalGate ?? "Auto"; without this an unset gate would resolve Auto).
    running.manager.settings.advanced = running.manager.settings.advanced || ({} as any);
    (running.manager.settings.advanced as any).capabilityGates = { write_to_pane: "Ask" };
  });

  after(async () => {
    try { await api("/api/stop-all/release", { method: "POST" }); } catch {}
    await teardownServerSuite(running);
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("404 when the pane does not exist", async () => {
    const res = await api("/api/terminals/no-such-pane/raw-input", {
      method: "POST",
      body: JSON.stringify({ bytes: ARROW_UP }),
    });
    assert.strictEqual(res.status, 404, "missing pane => 404");
  });

  it("409 when the pane exists but has no live transport (un-spawned)", async () => {
    // A ledger/UniversalTerminal with NO transport models an inert (un-spawned) pane.
    const inert = new UniversalTerminal("ri-inert", ".", "cmd");
    assert.strictEqual((inert as any).transport, null, "precondition: inert pane has no transport");
    running.manager.terminals["ri-inert"] = inert;
    const res = await api("/api/terminals/ri-inert/raw-input", {
      method: "POST",
      body: JSON.stringify({ bytes: ARROW_UP }),
    });
    assert.strictEqual(res.status, 409, "un-spawned pane => 409 (no live PTY)");
    delete running.manager.terminals["ri-inert"];
  });

  it("400 when bytes is missing", async () => {
    const { term } = spawnedPane("ri-400");
    running.manager.terminals["ri-400"] = term;
    const res = await api("/api/terminals/ri-400/raw-input", {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.strictEqual(res.status, 400, "missing bytes => 400");
    delete running.manager.terminals["ri-400"];
  });

  it("an always-allowed nav key (arrow) delivers the EXACT bytes to the spawned pane (200)", async () => {
    const { term, writes } = spawnedPane("ri-nav");
    running.manager.terminals["ri-nav"] = term;
    const res = await api("/api/terminals/ri-nav/raw-input", {
      method: "POST",
      body: JSON.stringify({ bytes: ARROW_UP }),
    });
    assert.strictEqual(res.status, 200, "always-allowed key runs immediately => 200");
    assert.deepStrictEqual(writes, [ARROW_UP], "the arrow bytes are written verbatim, exactly once, no CR");
    delete running.manager.terminals["ri-nav"];
  });

  it("Ctrl+C is an always-allowed emergency brake — delivered immediately, NOT gated (200)", async () => {
    const { term, writes } = spawnedPane("ri-ctrlc");
    running.manager.terminals["ri-ctrlc"] = term;
    const res = await api("/api/terminals/ri-ctrlc/raw-input", {
      method: "POST",
      body: JSON.stringify({ bytes: "\x03" }),
    });
    assert.strictEqual(res.status, 200, "Ctrl+C is never gated (emergency brake)");
    assert.deepStrictEqual(writes, ["\x03"], "0x03 reaches the pane verbatim");
    delete running.manager.terminals["ri-ctrlc"];
  });

  it("Shift+Tab on an off-spotlight HITL pane is GATED — write_to_pane Ask => 202 deferred, NOT yet written", async () => {
    const { term, writes } = spawnedPane("ri-shifttab");
    running.manager.terminals["ri-shifttab"] = term;
    const res = await api("/api/terminals/ri-shifttab/raw-input", {
      method: "POST",
      body: JSON.stringify({ bytes: SHIFT_TAB }),
    });
    assert.strictEqual(res.status, 202, "gated Shift+Tab off-spotlight => 202 deferred (awaiting confirm)");
    const body = await res.json();
    assert.ok(body.deferred, "body flags the deferral");
    assert.ok(typeof body.actionId === "string" && body.actionId.length > 0, "a pending actionId is returned");
    assert.deepStrictEqual(writes, [], "no bytes reach the pane until the operator confirms");
    delete running.manager.terminals["ri-shifttab"];
  });
});
