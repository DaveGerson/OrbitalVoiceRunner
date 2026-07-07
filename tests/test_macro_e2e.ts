// tests/test_macro_e2e.ts — VOICE MACROS end-to-end through the REAL server (8fz.6).
//
// Runner: npx tsx --test --test-force-exit tests/test_macro_e2e.ts
//
// The spec calls for a "playwright e2e (mock): define a macro via REST, speak-inject its phrase,
// assert N pending approvals + one dispatch group appear on the board." The MOCK playwright lane is
// client-only (no backend, no REST, no voice session — see playwright.config.ts), so it CANNOT drive
// a server-side voice feature. The genuine end-to-end for a voice feature in this codebase is the
// mock-LIVE server harness (installMockLive — the same one tests/test_voice_tool_goldens.ts uses):
// it boots the REAL server, swaps in a fake Gemini session, and lets us POST /api/macros (real REST)
// and inject an operator ASR transcript (serverContent.inputTranscription) so the genuine
// utterance -> match -> fireMacro -> forceStage staging path runs with no API key and no mic.
//
// This asserts the acceptance shape: a phrase spoken after approval routing declines fires the macro
// into N pending approvals JOINED by ONE dispatch group, and nothing auto-executes.

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";
import type { MockLiveHandle, MockLiveSession } from "./helpers/mockLive";
import { teardownServerSuite } from "./helpers/teardown";
import type { RunningServer } from "../server";
import { dispatchJoinTracker } from "../src/dispatch/joinTracker";

// Minimal UniversalTerminal stand-in (mirrors tests/test_voice_tool_goldens.ts StubTerminal): enough
// surface for syncLedger + the pane-write choke-point, no real ConPTY.
class StubTerminal {
  status: "Running" | "Exited" | "Idle" = "Running";
  lastCommand = "stub";
  projectId = "macro_proj";
  cwd = "/stub/cwd";
  runtimeType: "interactive_cli" | "shell" = "interactive_cli";
  permissionsMode: "Full Auto" | "Human-in-the-Loop" | "Read-Only" = "Human-in-the-Loop";
  toolPreset = "Claude Code";
  sessionId = "stub-session";
  contextSize = 0;
  lastStatusChangeAt = 1_700_000_000_000;
  constructor(public terminalId: string) {}
  writeInput(command: string) { this.lastCommand = command; this.status = "Running"; }
  getRecentOutput(_lines = 10): string { return "stub"; }
  async stop() { this.status = "Exited"; }
}

describe("voice macros — end-to-end through the real server (define via REST, fire by voice)", () => {
  let running: RunningServer;
  let mock: MockLiveHandle;
  let session: MockLiveSession;
  let client: WebSocket;
  let base: string;
  let apiToken: string;
  let installMockLive: () => MockLiveHandle;
  let waitFor: <T>(p: () => T | undefined | false, t?: number, i?: number) => Promise<T>;
  let tmpDir: string;
  let prevCwd: string;

  const api = (pathname: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${base}${pathname}`, {
      ...init,
      headers: { "x-api-token": apiToken, "content-type": "application/json", ...(init.headers || {}) },
    });

  function registerPane(paneId: string) {
    (running.manager.terminals as Record<string, unknown>)[paneId] = new StubTerminal(paneId);
    running.manager.ledger.activeProjectId = "macro_proj";
    if (!running.manager.ledger.getProject("macro_proj")) {
      running.manager.ledger.addProject("macro_proj", "/stub/cwd", "macro fixture project");
    }
    running.manager.ledger.updatePane("macro_proj", {
      pane_id: paneId, name: paneId, runtime_type: "interactive_cli",
      last_known_state: "Running active command", is_busy: true, alive: true,
      notes: [], permissions_mode: "Human-in-the-Loop", session_id: "stub-session",
      tool_preset: "Claude Code", context_size: 0,
    } as never, true);
  }

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";
    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-macro-e2e-"));
    process.chdir(tmpDir);

    ({ installMockLive, waitFor } = await import("./helpers/mockLive"));
    const serverMod = await import("../server");
    apiToken = serverMod.API_AUTH_TOKEN;
    mock = installMockLive();
    running = await serverMod.startServer({ port: 0, enableVite: false });
    base = `http://127.0.0.1:${running.port}`;

    client = new WebSocket(`ws://127.0.0.1:${running.port}/live`, { headers: { Cookie: `auth_token=${apiToken}` } });
    await new Promise<void>((resolve, reject) => { client.on("open", () => resolve()); client.on("error", reject); });
    session = await waitFor(() => mock.latest());
  });

  after(async () => {
    if (client && client.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => { client.once("close", () => resolve()); try { client.terminate(); } catch { resolve(); } });
    }
    await teardownServerSuite(running);
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("define a macro via REST, speak its phrase → N staged approvals joined by ONE dispatch group", async () => {
    registerPane("alpha");
    registerPane("beta");

    // 1) Define the macro via the REAL REST surface (POST /api/macros).
    const res = await api("/api/macros", {
      method: "POST",
      body: JSON.stringify({
        name: "Morning rounds",
        phrase: "morning rounds",
        steps: [
          { pane_name: "alpha", instruction: "npm run build" },
          { pane_name: "beta", instruction: "npm test" },
        ],
      }),
    });
    assert.strictEqual(res.status, 200, `define_macro should 200 (got ${res.status})`);

    // 2) Speak the phrase — inject an operator ASR transcript on the REAL channel (inputTranscription).
    const before = dispatchJoinTracker.list().length;
    session.emit({ serverContent: { inputTranscription: { text: "morning rounds" } } });

    // 3) The macro fires: ONE new dispatch group with TWO staged members (nothing auto-executed).
    const group = await waitFor(() => {
      const list = dispatchJoinTracker.list();
      if (list.length <= before) return undefined;
      const g = list[list.length - 1];
      return g.members.length === 2 ? g : undefined;
    }, 4000);

    assert.strictEqual(group.name, "Morning rounds", "the join group is named after the macro");
    assert.deepStrictEqual(
      group.members.map((m) => m.status).sort(),
      ["staged", "staged"],
      "both steps are STAGED as pending approvals — never auto-executed",
    );

    // 4) The spoken read-back was pushed to the operator (staged tally narrated).
    const narration = await waitFor(() => {
      const said = session.clientContents.map((c) => JSON.stringify(c)).join(" ");
      return said.includes("staged 2 approval(s)") ? said : undefined;
    }, 4000);
    assert.ok(narration.includes("Morning rounds"), "the narration names the macro");
  });

  it("a phrase that parses as an approval intent is refused at creation (never a shadowing macro)", async () => {
    const res = await api("/api/macros", {
      method: "POST",
      body: JSON.stringify({ name: "bad", phrase: "yes", steps: [{ pane_name: "alpha", instruction: "go" }] }),
    });
    assert.strictEqual(res.status, 403, "a phrase that parses as an approval intent is forbidden (403)");
  });
});
