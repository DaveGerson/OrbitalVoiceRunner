// tests/test_status_summary_journey.ts — get_status_summary END-TO-END through the REAL server
// pipeline (voice-UX wave 3). Sole owner: hwu1.
//
// Boots the real server in-process (no Gemini API key, no microphone) via the ce7 harness
// (JANUS_NO_AUTOSTART=1, installMockLive() swaps the injectable liveConnector, startServer({port:0})
// gives an ephemeral headless server) and drives the get_status_summary tool call through the REAL
// onmessage dispatch (registry runAction -> src/actions/defs/voice_ux.ts -> runStatusSummary), so a
// pass proves the whole spoken round-trip, not just the pure renderer unit-tested in
// tests/test_status_summary.ts.
//
// Runner: npx tsx --test --test-force-exit tests/test_status_summary_journey.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";
import type { MockLiveHandle, MockLiveSession } from "./helpers/mockLive";
import { teardownServerSuite } from "./helpers/teardown";
import type { RunningServer } from "../server";

// Minimal stand-in for a UniversalTerminal (mirrors tests/test_voice_tools.ts's StubTerminal) —
// avoids spawning a real ConPTY shell just to exercise the SITREP composer's pane-gather branch.
class StubTerminal {
  status: "Running" | "Exited" | "Idle";
  lastCommand = "";
  projectId: string;
  lastStatusChangeAt = Date.now();
  constructor(public terminalId: string, projectId: string, status: "Running" | "Exited" | "Idle" = "Running") {
    this.projectId = projectId;
    this.status = status;
  }
}

describe("get_status_summary journey (real server, real registry dispatch, no API key, no mic)", () => {
  let startServer: (opts?: any) => Promise<RunningServer>;
  let apiToken: string;
  let installMockLive: () => MockLiveHandle;
  let waitFor: <T>(p: () => T | undefined | false, t?: number, i?: number) => Promise<T>;

  let mock: MockLiveHandle;
  let running: RunningServer;
  let session: MockLiveSession;
  let client: WebSocket;
  let tmpDir: string;
  let prevCwd: string;

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";

    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-ss-"));
    process.chdir(tmpDir);

    ({ installMockLive, waitFor } = await import("./helpers/mockLive"));
    const serverMod = await import("../server");
    startServer = serverMod.startServer;
    apiToken = serverMod.API_AUTH_TOKEN;

    mock = installMockLive();
    running = await startServer({ port: 0, enableVite: false });

    client = new WebSocket(`ws://127.0.0.1:${running.port}/live`, {
      headers: { Cookie: `auth_token=${apiToken}` },
    });
    await new Promise<void>((resolve, reject) => {
      client.on("open", () => resolve());
      client.on("error", reject);
    });

    session = await waitFor(() => mock.latest());
  });

  after(async () => {
    for (const id of Object.keys(running.manager.terminals)) delete (running.manager.terminals as any)[id];
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

  it("empty world -> spoken round-trip carries the fixed empty-state sentence", async () => {
    for (const id of Object.keys(running.manager.terminals)) delete (running.manager.terminals as any)[id];
    const callId = session.emitToolCall("get_status_summary");
    const out = String(await waitFor(() => mock.responseFor(callId)));
    assert.strictEqual(
      out,
      "Nothing needs your attention: no pending approvals, no alerts, and no panes are busy.",
    );
  });

  it("a busy pane -> the spoken digest names it", async () => {
    for (const id of Object.keys(running.manager.terminals)) delete (running.manager.terminals as any)[id];
    (running.manager.terminals as any)["ss-busy"] = new StubTerminal("ss-busy", "ss_proj", "Running");

    const callId = session.emitToolCall("get_status_summary");
    const out = String(await waitFor(() => mock.responseFor(callId)));
    assert.ok(out.includes("1 busy"), `digest mentions the busy pane: ${out}`);
    assert.ok(out.includes("ss-busy"), `digest names the pane id: ${out}`);
  });

  it("is a no-argument, always-allowed voice tool (never blocked by a gate)", async () => {
    for (const id of Object.keys(running.manager.terminals)) delete (running.manager.terminals as any)[id];
    // Tighten every capability to Off — get_status_summary must still answer (ALWAYS_ALLOWED, rm4).
    const prevGates = running.manager.settings.advanced.capabilityGates;
    running.manager.settings.advanced.capabilityGates = { read_pane: "Off", read_notes: "Off", write_to_pane: "Off" } as any;
    try {
      const callId = session.emitToolCall("get_status_summary");
      const out = String(await waitFor(() => mock.responseFor(callId)));
      assert.ok(!/forbidden|gated/i.test(out), `never gate-blocked: ${out}`);
    } finally {
      running.manager.settings.advanced.capabilityGates = prevGates;
    }
  });
});
