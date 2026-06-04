// QW5 — guard the onOutput chain (bead qw5).
//
// manager.onOutput ran an UNGUARDED chain on every PTY data chunk:
//   classifyPaneOutput -> paneSignalBus.publish -> HistoryManager.appendOutputToLastCommand
//   -> detectAndTriggerTransitions
// A throw in ANY of these (one bad chunk, a regex blow-up, a history bug) propagated straight
// out of the PTY data event — it could crash the process AND it blinded the pane, because the
// buffering/broadcast tail that ships the chunk to the UI never ran.
//
// This suite proves each step is independently guarded: a throw in one step neither kills the
// others nor blinds the output stream — the very next chunk is still buffered and broadcast.
// We inject the throw at HistoryManager.appendOutputToLastCommand (the one chain step reachable
// from the test, since paneSignalBus is a closure-private instance).

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";
import type { MockLiveHandle } from "./helpers/mockLive";
import { teardownServerSuite } from "./helpers/teardown";
import type { RunningServer } from "../server";

class StubTerminal {
  status: "Running" | "Exited" | "Idle";
  lastCommand = "";
  writeInputCount = 0;
  stopCount = 0;
  constructor(public terminalId: string, status: "Running" | "Exited" | "Idle" = "Running") {
    this.status = status;
  }
  writeInput(command: string) {
    this.lastCommand = command;
    this.writeInputCount++;
    if (this.status !== "Exited") this.status = "Running";
  }
  async stop() { this.stopCount++; this.status = "Exited"; }
}

describe("QW5 onOutput chain guard (headless)", () => {
  let startServer: (opts?: any) => Promise<RunningServer>;
  let apiToken: string;
  let installMockLive: () => MockLiveHandle;
  let waitFor: <T>(p: () => T | undefined | false, t?: number, i?: number) => Promise<T>;
  let HistoryManager: any;

  let mock: MockLiveHandle;
  let running: RunningServer;
  let client: WebSocket;
  let clientMessages: any[];
  let tmpDir: string;
  let prevCwd: string;

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";

    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-outguard-"));
    process.chdir(tmpDir);

    ({ installMockLive, waitFor } = await import("./helpers/mockLive"));
    const serverMod = await import("../server");
    startServer = serverMod.startServer;
    apiToken = serverMod.API_AUTH_TOKEN;
    HistoryManager = serverMod.HistoryManager;

    mock = installMockLive();
    running = await startServer({ port: 0, enableVite: false });

    clientMessages = [];
    client = new WebSocket(`ws://127.0.0.1:${running.port}/live`, {
      headers: { Cookie: `auth_token=${apiToken}` },
    });
    client.on("message", (data) => {
      try { clientMessages.push(JSON.parse(data.toString())); } catch { /* non-JSON */ }
    });
    await new Promise<void>((resolve, reject) => {
      client.on("open", () => resolve());
      client.on("error", reject);
    });
    await waitFor(() => mock.latest());
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
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("a throw in a pane-signal/history/transition step does not blind the output stream", async () => {
    const paneId = "qw5-pane";
    (running.manager.terminals as any)[paneId] = new StubTerminal(paneId, "Running");

    // Inject a throw into the history step (the chain step reachable from the test). It throws on
    // the FIRST chunk only — modeling one bad chunk — then behaves normally.
    const hm = HistoryManager.getInstance();
    const original = hm.appendOutputToLastCommand.bind(hm);
    let threw = false;
    hm.appendOutputToLastCommand = (tid: string, chunk: string) => {
      if (!threw) { threw = true; throw new Error("history step blew up on a bad chunk"); }
      return original(tid, chunk);
    };

    try {
      const seen = clientMessages.length;
      // Chunk 1 hits the throwing history step. Pre-fix this propagates out of onOutput AND the
      // buffering tail never runs; post-fix it is caught and the tail still buffers the chunk.
      assert.doesNotThrow(() => running.manager.onOutput!(paneId, "FIRST-CHUNK\n"), "onOutput must not propagate a chain-step throw");
      assert.ok(threw, "the injected history throw actually fired on the first chunk");
      // Chunk 2 must still flow all the way to the UI broadcast.
      running.manager.onOutput!(paneId, "SECOND-CHUNK\n");

      const frame = await waitFor(() =>
        clientMessages.slice(seen).find(
          (m) => m.type === "stdout_chunk" && m.terminalId === paneId && String(m.chunk).includes("SECOND-CHUNK"),
        ),
      );
      assert.ok(frame, "the chunk after the throwing step is still broadcast (stream not blinded)");
      // The FIRST chunk's buffering tail also ran despite the throw (guard wraps the chain, not the tail).
      assert.ok(String(frame.chunk).includes("FIRST-CHUNK"), "the chunk whose chain step threw is still buffered/broadcast");
    } finally {
      hm.appendOutputToLastCommand = original;
      delete (running.manager.terminals as any)[paneId];
    }
  });
});
