// Read-only OBSERVE socket proof (Orbital Kitchen P4 — The Burner).
//
// The kitchen streams live PTY output + board updates over /live WITHOUT starting
// a Gemini voice session, by connecting with `?observe=1`. This pins the two
// halves of that contract against the REAL server (no API key, no mic):
//   1. an observe connect joins the broadcast set (receives settings_updated), and
//   2. an observe connect does NOT create a Live session, while a plain /live
//      connect DOES — proving the gate is specifically the observe flag, not the
//      absence of a key.
//
// Boots the same headless harness as test_live_harness.ts (installMockLive records
// every session the server opens; JANUS_NO_AUTOSTART + port:0 keep it ephemeral).

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";
import type { MockLiveHandle } from "./helpers/mockLive";
import { teardownServerSuite } from "./helpers/teardown";
import type { RunningServer } from "../server";

describe("observe-only /live socket (kitchen burner read lane)", () => {
  let startServer: (opts?: any) => Promise<RunningServer>;
  let apiToken: string;
  let installMockLive: () => MockLiveHandle;
  let waitFor: <T>(p: () => T | undefined | false, t?: number, i?: number) => Promise<T>;

  let mock: MockLiveHandle;
  let running: RunningServer;
  let base: string;
  let wsBase: string;
  let tmpDir: string;
  let prevCwd: string;
  const sockets: WebSocket[] = [];

  const connect = async (query = ""): Promise<WebSocket> => {
    const ws = new WebSocket(`${wsBase}/live${query}`, { headers: { Cookie: `auth_token=${apiToken}` } });
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    return ws;
  };

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";

    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-obs-"));
    process.chdir(tmpDir);

    ({ installMockLive, waitFor } = await import("./helpers/mockLive"));
    const serverMod = await import("../server");
    startServer = serverMod.startServer;
    apiToken = serverMod.API_AUTH_TOKEN;

    mock = installMockLive();
    running = await startServer({ port: 0, enableVite: false });
    base = `http://127.0.0.1:${running.port}`;
    wsBase = `ws://127.0.0.1:${running.port}`;
  });

  after(async () => {
    for (const ws of sockets) {
      if (ws.readyState !== WebSocket.CLOSED) {
        await new Promise<void>((resolve) => {
          ws.once("close", () => resolve());
          try { ws.terminate(); } catch { resolve(); }
        });
      }
    }
    await teardownServerSuite(running);
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("an observe-only connect does NOT start a Gemini Live session", async () => {
    const before = mock.sessions.length;
    await connect("?observe=1");
    // Give the (suppressed) connectLiveSession path ample time to NOT fire.
    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(
      mock.sessions.length,
      before,
      "observe-only connect must not open a Live session (no mic, no model, no cost)"
    );
  });

  it("an observe-only socket receives broadcast frames (settings_updated)", async () => {
    const ws = await connect("?observe=1");
    const received: any[] = [];
    ws.on("message", (d) => { try { received.push(JSON.parse(d.toString())); } catch { /* skip */ } });

    // Round-trip the settings so the PUT broadcasts settings_updated to ALL clients.
    const get = await fetch(`${base}/api/settings`, { headers: { "x-api-token": apiToken } });
    assert.strictEqual(get.status, 200);
    const settings = await get.json();
    const put = await fetch(`${base}/api/settings`, {
      method: "PUT",
      headers: { "x-api-token": apiToken, "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
    assert.strictEqual(put.status, 200);

    const frame = await waitFor(() => received.find((m) => m.type === "settings_updated"));
    assert.ok(frame, "observe socket joined the broadcast set and received settings_updated");
  });

  it("a PLAIN /live connect DOES start a Live session (the gate is the observe flag)", async () => {
    const before = mock.sessions.length;
    await connect();
    await waitFor(() => mock.sessions.length > before);
    assert.ok(mock.sessions.length > before, "plain /live connect opens a Live session");
  });
});
