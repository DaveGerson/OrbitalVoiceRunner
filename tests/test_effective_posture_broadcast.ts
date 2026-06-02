// Effective-posture broadcast suite (bead 8sq BACKEND slice, spec §3 item 1 / §5).
//
// The chip + popover render from SERVER TRUTH — the server resolves the 16 effective gate values
// + the derived posture word per pane (via the pure gateSurface) and includes them in the pane
// state it already broadcasts. No client re-derivation of policy. This suite pins that the server
// exposes per-pane {effective gate map + posture word} in BOTH /api/terminals and the
// terminals_updated payload, and that the frozen short-circuit is reflected (all LOCKED while frozen).

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";
import type { MockLiveHandle, MockLiveSession } from "./helpers/mockLive";
import type { RunningServer } from "../server";
import { ALL_CAPABILITIES } from "../src/gateSurface";

class StubTerminal {
  status: "Running" | "Exited" | "Idle" = "Running";
  permissionsMode: "Full Auto" | "Human-in-the-Loop" | "Read-Only" = "Full Auto";
  toolPreset = "Custom";
  sessionId = "";
  contextSize = 0;
  cwd = ".";
  shellCmd = "bash";
  constructor(public terminalId: string) {}
  getRawBackfill() { return ""; }
  getRecentOutput() { return ""; }
  writeInput() {}
  async stop() { this.status = "Exited"; }
}

describe("8sq effective-posture broadcast (headless)", () => {
  let startServer: (opts?: any) => Promise<RunningServer>;
  let apiToken: string;
  let installMockLive: () => MockLiveHandle;
  let waitFor: <T>(p: () => T | undefined | false, t?: number, i?: number) => Promise<T>;

  let mock: MockLiveHandle;
  let running: RunningServer;
  let session: MockLiveSession;
  let client: WebSocket;
  let base: string;
  let tmpDir: string;
  let prevCwd: string;

  const api = (pathname: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${base}${pathname}`, {
      ...init,
      headers: { "x-api-token": apiToken, "content-type": "application/json", ...(init.headers || {}) },
    });

  function addPane(paneId: string): StubTerminal {
    const t = new StubTerminal(paneId);
    (running.manager.terminals as any)[paneId] = t;
    return t;
  }
  function clearPanes() {
    for (const id of Object.keys(running.manager.terminals)) delete (running.manager.terminals as any)[id];
  }

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";
    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-posture-"));
    process.chdir(tmpDir);

    ({ installMockLive, waitFor } = await import("./helpers/mockLive"));
    const serverMod = await import("../server");
    startServer = serverMod.startServer;
    apiToken = serverMod.API_AUTH_TOKEN;

    mock = installMockLive();
    running = await startServer({ port: 0, enableVite: false });
    base = `http://127.0.0.1:${running.port}`;
    client = new WebSocket(`ws://127.0.0.1:${running.port}/live`, { headers: { Cookie: `auth_token=${apiToken}` } });
    await new Promise<void>((resolve, reject) => { client.on("open", () => resolve()); client.on("error", reject); });
    session = await waitFor(() => mock.latest());
  });

  after(async () => {
    await api("/api/stop-all/release", { method: "POST" });
    clearPanes();
    if (client && client.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => { client.once("close", () => resolve()); try { client.terminate(); } catch { resolve(); } });
    }
    try { await running?.close(); } catch {}
    await new Promise((r) => setTimeout(r, 100));
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("/api/terminals carries a per-pane effective gate map + posture word", async () => {
    clearPanes();
    addPane("post-a");
    const list = await (await api("/api/terminals")).json();
    const pane = list.find((p: any) => p.id === "post-a");
    assert.ok(pane, "pane present in /api/terminals");
    assert.ok(pane.effective_gates, "pane carries an effective_gates map");
    // Total over all 16 capabilities (server truth — never a sparse map).
    for (const cap of ALL_CAPABILITIES) {
      assert.ok(["Auto", "Ask", "Off"].includes(pane.effective_gates[cap]), `gate ${cap} present + valid`);
    }
    assert.ok(["OPEN", "GUARDED", "LOCKED"].includes(pane.posture), `posture word present: ${pane.posture}`);
  });

  it("a Full-Auto pane with the default matrix reads GUARDED (some Ask gates exist off-spotlight)", async () => {
    clearPanes();
    const p = addPane("post-guarded");
    p.permissionsMode = "Full Auto";
    // Not the active pane => no spotlight; the default matrix has Ask gates => GUARDED.
    const list = await (await api("/api/terminals")).json();
    const pane = list.find((x: any) => x.id === "post-guarded");
    assert.strictEqual(pane.posture, "GUARDED", "default-matrix non-active pane is GUARDED");
  });

  it("a Read-Only pane reads LOCKED", async () => {
    clearPanes();
    const p = addPane("post-ro");
    p.permissionsMode = "Read-Only";
    running.manager.globalPermissionsMode = "Inherit"; // so the pane's own mode wins
    const list = await (await api("/api/terminals")).json();
    const pane = list.find((x: any) => x.id === "post-ro");
    assert.strictEqual(pane.posture, "LOCKED", "Read-Only pane is LOCKED");
  });

  it("while FROZEN every pane reads LOCKED and every effective gate is Off", async () => {
    clearPanes();
    addPane("post-frozen");
    await api("/api/stop-all", { method: "POST" }); // Stage 1 freeze
    const list = await (await api("/api/terminals")).json();
    const pane = list.find((x: any) => x.id === "post-frozen");
    assert.strictEqual(pane.posture, "LOCKED", "frozen pane is LOCKED");
    for (const cap of ALL_CAPABILITIES) {
      assert.strictEqual(pane.effective_gates[cap], "Off", `frozen: ${cap} is Off`);
    }
    await api("/api/stop-all/release", { method: "POST" });
  });

  it("the terminals_updated broadcast carries the per-pane posture payload", async () => {
    clearPanes();
    addPane("post-bcast");
    const messages: any[] = [];
    const onMsg = (data: any) => { try { messages.push(JSON.parse(data.toString())); } catch {} };
    client.on("message", onMsg);
    // Any pane-state mutation broadcasts terminals_updated; use the per-pane gate set path.
    await api("/api/stop-all", { method: "POST" });
    const evt = await waitFor(() => messages.find((m) => m.type === "terminals_updated" && Array.isArray(m.postures)));
    const entry = evt.postures.find((x: any) => x.id === "post-bcast");
    assert.ok(entry, "broadcast postures include the pane");
    assert.strictEqual(entry.posture, "LOCKED", "frozen pane reads LOCKED in the broadcast");
    client.off("message", onMsg);
    await api("/api/stop-all/release", { method: "POST" });
  });
});
