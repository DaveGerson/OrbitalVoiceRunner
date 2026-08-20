import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";
import type { MockLiveHandle, MockLiveSession } from "./helpers/mockLive";
import { teardownServerSuite } from "./helpers/teardown";
import type { RunningServer } from "../server";

describe("FIX 3 — log the tool result output (bead wsm-e2e-pinned-vprp)", () => {
  let startServer: (opts?: any) => Promise<RunningServer>;
  let apiToken: string;
  let installMockLive: () => MockLiveHandle;
  let waitFor: <T>(p: () => T | undefined | false, t?: number, i?: number) => Promise<T>;

  let mock: MockLiveHandle;
  let running: RunningServer;
  let client: WebSocket;
  let tmpDir: string;
  let prevCwd: string;

  const live = (): MockLiveSession => running._testActiveLiveSession!() as MockLiveSession;

  function logFilePath(): string {
    return path.join(tmpDir, ".janus_interaction_log.jsonl");
  }
  function logSize(): number {
    try { return fs.statSync(logFilePath()).size; } catch { return 0; }
  }
  function readLogSince(offset: number): any[] {
    let raw = "";
    try { raw = fs.readFileSync(logFilePath(), "utf8"); } catch { return []; }
    return raw
      .slice(offset)
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((r): r is any => r != null);
  }

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";

    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-log-ar-"));
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
    await waitFor(() => mock.latest() && running._testActiveLiveSession?.());
  });

  after(async () => {
    if (client && client.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        client.once("close", () => resolve());
        try { client.terminate(); } catch { resolve(); }
      });
    }
    await teardownServerSuite(running);
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("action_result carries redacted, capped output for (a) ok with secret, (b) error, (c) oversized output", async () => {
    const session = live();
    const startOffset = logSize();

    const secretKey = "sk-abc123456789012345678901234567890";
    const hugeProjectName = "x".repeat(9000);

    // (a) dispatch tool returning kind:ok with secret
    session.emit({
      toolCall: {
        functionCalls: [
          { name: "update_project", id: "call-secret", args: { project_id: `proj-${secretKey}` } },
        ],
      },
    });

    // (b) dispatch tool returning kind:error
    session.emit({
      toolCall: {
        functionCalls: [
          { name: "nonexistent_action_boom", id: "call-error", args: {} },
        ],
      },
    });

    // (c) dispatch tool returning oversized output (>8192 bytes — the shared ACTION_ACTIVITY_CAP_BYTES)
    session.emit({
      toolCall: {
        functionCalls: [
          { name: "update_project", id: "call-huge", args: { project_id: hugeProjectName } },
        ],
      },
    });

    await waitFor(() => {
      const logs = readLogSince(startOffset).filter((l) => l.kind === "action_result");
      return logs.length >= 3;
    });

    const actionResults = readLogSince(startOffset).filter((l) => l.kind === "action_result");
    const resA = actionResults.find((l) => l.data?.callId === "call-secret");
    const resB = actionResults.find((l) => l.data?.callId === "call-error");
    const resC = actionResults.find((l) => l.data?.callId === "call-huge");

    assert.ok(resA, "resA action_result log must exist");
    assert.ok(resB, "resB action_result log must exist");
    assert.ok(resC, "resC action_result log must exist");

    // Check (a): secret is redacted, output is present in log data
    assert.ok(resA.data.output, "resA data must carry output object");
    assert.strictEqual(resA.data.output.kind, "ok");
    assert.ok(typeof resA.data.output.output === "string", "resA output.output must be string");
    assert.ok(!resA.data.output.output.includes(secretKey), "secret must be redacted from log output");

    // Check (b): error message is present in output
    assert.ok(resB.data.output, "resB data must carry output object");
    assert.strictEqual(resB.data.output.kind, "error");
    assert.ok(resB.data.output.message?.includes("nonexistent_action_boom"), "error message must be present");

    // Check (c): oversized output is capped at the shared ACTION_ACTIVITY_CAP_BYTES (not the old
    // 512-byte log-only cap) and the marker is informative — it keeps the START of the real
    // payload (an audit trail needs SOME of the record) instead of an all-or-nothing stub, and
    // says how many bytes were dropped.
    assert.ok(resC.data.output, "resC data must carry output object");
    assert.strictEqual(resC.data.output.truncated, true, "oversized payload must be marked truncated");
    assert.ok(
      resC.data.output.output?.startsWith("Project "),
      "truncated output must retain the start of the real payload, not drop it entirely",
    );
    assert.match(
      resC.data.output.output,
      /…\(\+\d+ bytes omitted\)$/,
      "truncated output must end with an informative omitted-byte-count marker",
    );
  });
});
