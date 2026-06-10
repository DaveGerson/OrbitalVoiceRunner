// CARD 1C.3 (Phase 1 Track C): STOP-ALL must be AUDIBLE on the voice channel.
//
// AUDIT FINDING: stopAll/releaseStopAll in src/gating/index.ts broadcast `frozen` / `stop_all`
// frames to the UI but never narrated into the live voice session — Janus kept chatting unaware
// the whole line was gated Off, and the Stage-2 kill + the release were silent to the model.
//
// FIX under test: the gating brake paths push a short narration line through the SAME injected
// seam the approval/sweep narration uses (pushApprovalNarration + coreState.activeLiveSession):
//   Stage 1 freeze:  "Stop-all engaged — the whole line is frozen until you release."
//   Stage 2 kill:    "Stage two — running panes are being killed."
//   Release:         "Stop-all released — the kitchen is back."
//
// Harness: SAME in-process ce7 harness as tests/test_stop_all_two_stage.ts (that file is owned by
// another concurrent track, so these assertions live here — see the Phase 1 Track C card). The
// mock live session records every sendClientContent push in `clientContents`, so the narration is
// asserted off the genuine voice egress.

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";
import type { MockLiveHandle, MockLiveSession } from "./helpers/mockLive";
import { teardownServerSuite } from "./helpers/teardown";
import type { RunningServer } from "../server";

class StubTerminal {
  status: "Running" | "Exited" | "Idle";
  lastCommand = "";
  stopCount = 0;
  constructor(public terminalId: string, status: "Running" | "Exited" | "Idle" = "Running") {
    this.status = status;
  }
  writeInput(command: string) {
    this.lastCommand = command;
  }
  async stop() { this.stopCount++; this.status = "Exited"; }
}

describe("1C.3 STOP-ALL narration on the voice channel (headless)", () => {
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
  let base: string;

  const api = (pathname: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${base}${pathname}`, {
      ...init,
      headers: { "x-api-token": apiToken, "content-type": "application/json", ...(init.headers || {}) },
    });

  /** All narration texts pushed to the live session so far. */
  const narrations = (): string[] =>
    session.clientContents
      .map((c: any) => c?.turns?.[0]?.parts?.[0]?.text)
      .filter((t: any): t is string => typeof t === "string");

  function addPane(paneId: string): StubTerminal {
    const t = new StubTerminal(paneId);
    (running.manager.terminals as any)[paneId] = t;
    return t;
  }

  function clearPanes() {
    for (const id of Object.keys(running.manager.terminals)) {
      delete (running.manager.terminals as any)[id];
    }
  }

  async function release() {
    await api("/api/stop-all/release", { method: "POST" });
  }

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";

    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-stopall-narration-"));
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

    session = await waitFor(() => mock.latest());
    // The narration seam targets coreState.activeLiveSession, which is assigned only after the
    // async connect resolves — wait for the server to actually hoist the session.
    await waitFor(() => running._testActiveLiveSession?.() === session || undefined);
  });

  after(async () => {
    await release();
    clearPanes();
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

  it("Stage 1 freeze narrates 'Stop-all engaged' into the live session", async () => {
    clearPanes();
    addPane("nar-s1");
    const seen = session.clientContents.length;

    const callId = session.emitToolCall("stop_all");
    await waitFor(() => mock.responseFor(callId));

    const line = await waitFor(() =>
      narrations().slice(seen).find((t) => t.includes("Stop-all engaged — the whole line is frozen until you release."))
    );
    assert.ok(line, "freeze narration reached the voice channel");
    await release();
  });

  it("Stage 2 kill narrates 'Stage two — running panes are being killed.'", async () => {
    clearPanes();
    const a = addPane("nar-s2");

    const froze = session.emitToolCall("stop_all");
    await waitFor(() => mock.responseFor(froze));
    const seen = session.clientContents.length;

    const kill = session.emitToolCall("confirm_stop_all");
    await waitFor(() => mock.responseFor(kill));

    const line = await waitFor(() =>
      narrations().slice(seen).find((t) => t.includes("Stage two — running panes are being killed."))
    );
    assert.ok(line, "kill narration reached the voice channel");
    assert.strictEqual(a.stopCount, 1, "the kill side effect is unchanged");
    await release();
  });

  it("Release narrates 'Stop-all released — the kitchen is back.'", async () => {
    clearPanes();
    const froze = session.emitToolCall("stop_all");
    await waitFor(() => mock.responseFor(froze));
    const seen = session.clientContents.length;

    const rel = session.emitToolCall("release_stop_all");
    await waitFor(() => mock.responseFor(rel));

    const line = await waitFor(() =>
      narrations().slice(seen).find((t) => t.includes("Stop-all released — the kitchen is back."))
    );
    assert.ok(line, "release narration reached the voice channel");
  });

  it("the REST brake narrates too (same shared stopAll closure)", async () => {
    clearPanes();
    addPane("nar-rest");
    const seen = session.clientContents.length;

    const res = await api("/api/stop-all", { method: "POST" });
    assert.strictEqual(res.status, 200);

    const line = await waitFor(() =>
      narrations().slice(seen).find((t) => t.includes("Stop-all engaged — the whole line is frozen until you release."))
    );
    assert.ok(line, "the REST-triggered freeze still narrates to the model");
    await release();
  });
});
