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
  // wsm-e2e-pinned-ztd: writeRaw now buffers pre-spawn-ready bytes; this harness injects the
  // transport directly (bypassing start()/markSpawnReady), so mark the pane already spawn-ready to
  // model a real "live PTY" pane, matching what "un-spawned" (409, tested separately) is NOT.
  (term as any).spawnReady = true;
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

    // Pin the GLOBAL write_to_pane gate to Ask. NOTE (active-pane guard reconciliation): raw input can
    // now ONLY reach the active pane — the guard 409s every off-active-pane key BEFORE the capability
    // gate — and the active pane is BY DEFINITION on-spotlight. Since write_to_pane is a spotlight-
    // loosened capability ("trust follows focus"), it resolves Auto on the active pane regardless of the
    // global Ask. So the "off-spotlight => 202 defer" path is now UNREACHABLE through this REST surface;
    // the gated Shift+Tab on the active pane resolves Auto and writes (asserted below).
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
    running._testSetActivePane?.("ri-nav"); // active-pane guard: the target must be the open pane
    const res = await api("/api/terminals/ri-nav/raw-input", {
      method: "POST",
      body: JSON.stringify({ bytes: ARROW_UP }),
    });
    assert.strictEqual(res.status, 200, "always-allowed key runs immediately => 200");
    assert.deepStrictEqual(writes, [ARROW_UP], "the arrow bytes are written verbatim, exactly once, no CR");
    running._testSetActivePane?.(null);
    delete running.manager.terminals["ri-nav"];
  });

  it("Ctrl+C is an always-allowed emergency brake — delivered immediately, NOT gated (200)", async () => {
    const { term, writes } = spawnedPane("ri-ctrlc");
    running.manager.terminals["ri-ctrlc"] = term;
    running._testSetActivePane?.("ri-ctrlc"); // active-pane guard: Ctrl+C still only on the open pane
    const res = await api("/api/terminals/ri-ctrlc/raw-input", {
      method: "POST",
      body: JSON.stringify({ bytes: "\x03" }),
    });
    assert.strictEqual(res.status, 200, "Ctrl+C is never gated (emergency brake)");
    assert.deepStrictEqual(writes, ["\x03"], "0x03 reaches the pane verbatim");
    running._testSetActivePane?.(null);
    delete running.manager.terminals["ri-ctrlc"];
  });

  it("Shift+Tab routes through the capability gate on the ACTIVE pane — spotlight resolves Auto => 200, written", async () => {
    // The active pane is on-spotlight, and write_to_pane is spotlight-loosened, so the global Ask
    // resolves to Auto here: the gated branch's Auto disposition runs and the bytes ARE written.
    const { term, writes } = spawnedPane("ri-shifttab");
    running.manager.terminals["ri-shifttab"] = term;
    running._testSetActivePane?.("ri-shifttab"); // active-pane guard passes; spotlight loosens the gate to Auto
    const res = await api("/api/terminals/ri-shifttab/raw-input", {
      method: "POST",
      body: JSON.stringify({ bytes: SHIFT_TAB }),
    });
    assert.strictEqual(res.status, 200, "gated Shift+Tab on the on-spotlight active pane resolves Auto => 200");
    assert.deepStrictEqual(writes, [SHIFT_TAB], "the Shift+Tab bytes reach the active pane (Auto disposition ran)");
    running._testSetActivePane?.(null);
    delete running.manager.terminals["ri-shifttab"];
  });

  // ── bead ym3: the raw-input ALLOWLIST (close the denylist-of-one) ──────────────────────────────
  // A payload that is NOT one of the 11 vetted canonical keys must be REJECTED with 400 BEFORE any
  // writeRaw — nothing reaches the transport. This is asserted AFTER the 400/404/409 checks: the
  // pane is active + spawned, so the only thing stopping the write is the unrecognized-sequence guard.
  for (const [label, bytes] of [
    ["leading-space Ctrl+C (NOT canonical)", " \x03"],
    ["doubled Ctrl+C", "\x03\x03"],
    ["a full shell line", "rm -rf ~\r"],
    ["Shift+Tab with trailing junk", "\x1b[Z "],
  ] as Array<[string, string]>) {
    it(`400 + NOTHING written for an unrecognized raw-key sequence: ${label}`, async () => {
      const { term, writes } = spawnedPane("ri-unknown");
      running.manager.terminals["ri-unknown"] = term;
      running._testSetActivePane?.("ri-unknown"); // active + spawned: only the allowlist guard can stop it
      const res = await api("/api/terminals/ri-unknown/raw-input", {
        method: "POST",
        body: JSON.stringify({ bytes }),
      });
      assert.strictEqual(res.status, 400, `${label} => 400 (unrecognized sequence)`);
      const body = await res.json();
      assert.strictEqual(body.error, "Unrecognized raw-key sequence", "exact error message");
      assert.deepStrictEqual(writes, [], "the transport received NOTHING — the gate was never reached");
      running._testSetActivePane?.(null);
      delete running.manager.terminals["ri-unknown"];
    });
  }

  // The flip side of the allowlist: each of the 11 canonical keys is still ACCEPTED. The always-
  // allowed ones (everything but Shift+Tab) write verbatim and 200; Shift+Tab is gated (Auto on the
  // active pane) and is exercised separately above. CRITICAL: the EXACT \x03 Ctrl+C must still pass.
  for (const [label, bytes] of [
    ["Up arrow", "\x1b[A"],
    ["Down arrow", "\x1b[B"],
    ["Right arrow", "\x1b[C"],
    ["Left arrow", "\x1b[D"],
    ["Enter", "\r"],
    ["Tab", "\t"],
    ["Esc", "\x1b"],
    ["PgUp", "\x1b[5~"],
    ["PgDn", "\x1b[6~"],
    ["Ctrl+C (emergency brake — must STILL pass)", "\x03"],
  ] as Array<[string, string]>) {
    it(`canonical always-allowed key still passes verbatim (200): ${label}`, async () => {
      const { term, writes } = spawnedPane("ri-canon");
      running.manager.terminals["ri-canon"] = term;
      running._testSetActivePane?.("ri-canon");
      const res = await api("/api/terminals/ri-canon/raw-input", {
        method: "POST",
        body: JSON.stringify({ bytes }),
      });
      assert.strictEqual(res.status, 200, `${label} => 200 (still allowlisted)`);
      assert.deepStrictEqual(writes, [bytes], `${label} bytes written verbatim, exactly once`);
      running._testSetActivePane?.(null);
      delete running.manager.terminals["ri-canon"];
    });
  }
});
