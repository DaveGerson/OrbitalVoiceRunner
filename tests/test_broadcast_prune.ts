// QW6 — prune broken sockets from the broadcast set (bead qw6).
//
// broadcast() already wrapped client.send(data) in try/catch, but the catch only logged — it left
// the dead socket in the `clients` Set forever. Every subsequent broadcast then re-threw on the
// same corpse (logged, swallowed) and the set leaked. The fix: the catch ALSO removes the client
// (clients.delete(client)). This suite proves a socket that throws on send is removed after a
// single broadcast.
//
// We inject a fake client (readyState OPEN, send() throws) into the broadcast set via the QW6 test
// seam, trigger a real broadcast (POST /api/stop-all -> {type:"frozen"}), and assert the corpse is
// gone. A real (healthy) WS client in the same set must be untouched.

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";
import type { MockLiveHandle } from "./helpers/mockLive";
import { teardownServerSuite } from "./helpers/teardown";
import type { RunningServer } from "../server";

describe("QW6 broadcast dead-socket prune (headless)", () => {
  let startServer: (opts?: any) => Promise<RunningServer>;
  let apiToken: string;
  let installMockLive: () => MockLiveHandle;
  let waitFor: <T>(p: () => T | undefined | false, t?: number, i?: number) => Promise<T>;

  let mock: MockLiveHandle;
  let running: RunningServer;
  let client: WebSocket;
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-prune-"));
    process.chdir(tmpDir);

    ({ installMockLive, waitFor } = await import("./helpers/mockLive"));
    const serverMod = await import("../server");
    startServer = serverMod.startServer;
    apiToken = serverMod.API_AUTH_TOKEN;

    mock = installMockLive();
    running = await startServer({ port: 0, enableVite: false });
    base = `http://127.0.0.1:${running.port}`;

    client = new WebSocket(`ws://127.0.0.1:${running.port}/live`, {
      headers: { Cookie: `auth_token=${apiToken}` },
    });
    await new Promise<void>((resolve, reject) => {
      client.on("open", () => resolve());
      client.on("error", reject);
    });
    await waitFor(() => mock.latest());
  });

  after(async () => {
    await api("/api/stop-all/release", { method: "POST" });
    if (client && client.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        client.once("close", () => resolve());
        try { client.terminate(); } catch { resolve(); }
      });
    }
    await teardownServerSuite(running);
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("a socket that throws on send is removed from the clients set", async () => {
    const clients = running._testClients!();
    assert.ok(clients, "server exposes the broadcast clients set for the test seam");

    let sendAttempts = 0;
    const deadClient = {
      readyState: 1, // OPEN — so broadcast() actually attempts to send and hits the throw.
      send() { sendAttempts++; throw new Error("dead socket"); },
    };
    let healthySends = 0;
    const healthyClient = {
      readyState: 1,
      send() { healthySends++; },
    };
    clients.add(deadClient);
    clients.add(healthyClient);
    assert.ok(clients.has(deadClient), "dead client seeded into the broadcast set");

    // Trigger a real broadcast: Stage-1 stop-all broadcasts {type:"frozen"} to all clients.
    const res = await api("/api/stop-all", { method: "POST" });
    assert.strictEqual(res.status, 200);

    assert.ok(sendAttempts >= 1, "broadcast attempted to send to the dead client (so the throw fired)");
    assert.ok(!clients.has(deadClient), "the throwing socket was PRUNED from the clients set");
    assert.ok(healthySends >= 1, "the healthy client still received the broadcast");
    assert.ok(clients.has(healthyClient), "a healthy client is NOT pruned");

    clients.delete(healthyClient);
    await api("/api/stop-all/release", { method: "POST" });
  });
});
