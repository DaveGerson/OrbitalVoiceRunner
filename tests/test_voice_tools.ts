// Voice-tool backend suite (bead 8sq BACKEND slice).
//
// Boots the REAL server in-process via the ce7 harness (no Gemini API key, no
// microphone): JANUS_NO_AUTOSTART=1, installMockLive() swaps the injectable
// liveConnector for a fake session that records what the server sends it and lets
// us push synthetic tool calls into the real onmessage dispatch, and
// startServer({ port: 0, enableVite: false }) yields an ephemeral headless server.
//
// This suite OWNS its own boot scaffolding + WS client + message collector + api()
// helper — ce7's tests/test_live_harness.ts keeps those LOCAL and does not export
// shared fixtures, so we do not depend on them.
//
// Covers:
//   (A) stop_all — the emergency kill switch (voice + REST + WS), including the
//       safety-critical assertion that it BYPASSES the capability gate (an Off gate
//       can never forbid an emergency halt).
//   (B) voice tool surface PARITY guard — the set of onmessage dispatch handler
//       names must equal the set of FunctionDeclaration names (both must now contain
//       stop_all), so a future gated handler can't silently ship without a voice tool.
//
// FIXTURE NOTE: stop_all only reads `term.status` and calls `term.writeInput("\x03")`
// (transport-null-safe). We register lightweight stub terminals directly into
// manager.terminals rather than spawning real ConPTY shells: on Windows, repeatedly
// spawn+kill of cmd.exe trips node-pty's "AttachConsole failed" agent crash, which
// destabilizes the unit runner. The stub exercises the genuine stopAllPanes / REST /
// WS / voice / broadcast / gate-bypass code paths deterministically, and lets us set
// an "Exited" pane without killing an OS process. The real-PTY interrupt write is
// already proven by the live smoke (npm run smoke:claude) + create_pane handler.

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";
import type { MockLiveHandle, MockLiveSession } from "./helpers/mockLive";
import { teardownServerSuite } from "./helpers/teardown";
import type { RunningServer } from "../server";

// Minimal stand-in for a UniversalTerminal, covering the surface stopAllPanes uses.
class StubTerminal {
  status: "Running" | "Exited" | "Idle";
  lastCommand = "";
  writeInputCount = 0;
  stopCount = 0;
  constructor(public terminalId: string, status: "Running" | "Exited" | "Idle" = "Running") {
    this.status = status;
  }
  // Mirrors UniversalTerminal.writeInput's relevant side effects: record the command
  // and optimistically mark the pane Running (an interrupt is still "alive", design §5).
  writeInput(command: string) {
    this.lastCommand = command;
    this.writeInputCount++;
    if (this.status !== "Exited") this.status = "Running";
  }
  async stop() { this.stopCount++; this.status = "Exited"; }
}

describe("8sq voice-tools backend (headless, no API key, no mic)", () => {
  let startServer: (opts?: any) => Promise<RunningServer>;
  let apiToken: string;
  let installMockLive: () => MockLiveHandle;
  let waitFor: <T>(p: () => T | undefined | false, t?: number, i?: number) => Promise<T>;

  let mock: MockLiveHandle;
  let running: RunningServer;
  let session: MockLiveSession;
  let client: WebSocket;
  let clientMessages: any[];
  let base: string;
  let tmpDir: string;
  let prevCwd: string;

  // Authenticated REST helper against the ephemeral server.
  const api = (pathname: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${base}${pathname}`, {
      ...init,
      headers: { "x-api-token": apiToken, "content-type": "application/json", ...(init.headers || {}) },
    });

  // Register a live (or exited) stub pane directly into the manager. stop_all keys
  // purely off term.status / term.writeInput, so this exercises the real code path.
  function addPane(paneId: string, status: "Running" | "Exited" | "Idle" = "Running"): StubTerminal {
    const t = new StubTerminal(paneId, status);
    (running.manager.terminals as any)[paneId] = t;
    return t;
  }

  // Drop every stub pane so each test starts from a known-empty terminal set.
  function clearPanes() {
    for (const id of Object.keys(running.manager.terminals)) {
      delete (running.manager.terminals as any)[id];
    }
  }

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";

    // Isolate the .janus_* ledger/scrollback files into a temp cwd BEFORE importing
    // ../server (its boot-time store restore reads the cwd).
    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-vt-"));
    process.chdir(tmpDir);

    ({ installMockLive, waitFor } = await import("./helpers/mockLive"));
    const serverMod = await import("../server");
    startServer = serverMod.startServer;
    apiToken = serverMod.API_AUTH_TOKEN;

    mock = installMockLive();
    running = await startServer({ port: 0, enableVite: false });
    base = `http://127.0.0.1:${running.port}`;

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

    session = await waitFor(() => mock.latest());
  });

  after(async () => {
    // Clear any leftover Stage-1 freeze so the persisted `frozen` kv flag never leaks across suites.
    try { await api("/api/stop-all/release", { method: "POST" }); } catch {}
    clearPanes();
    // Drain the client socket BEFORE closing the server (Windows libuv double-close).
    if (client && client.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        client.once("close", () => resolve());
        try { client.terminate(); } catch { resolve(); }
      });
    }
    // Deterministic teardown: close server + global fetch pool, then drain libuv so
    // --test-force-exit can't abort on a half-closed async handle (src\win\async.c:76).
    await teardownServerSuite(running);
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  // Release the freeze between tests so the two-stage state never leaks across cases.
  async function releaseFreeze() {
    await api("/api/stop-all/release", { method: "POST" });
  }

  // TWO-STAGE STOP-ALL (spec §2.C). This SUPERSEDES the interim one-stage Ctrl-C behavior:
  //   stop_all          = Stage 1 (freeze + cancel in-flight; PANES KEEP RUNNING).
  //   confirm_stop_all  = Stage 2 (kill running PTYs; only valid while frozen).
  //   release_stop_all  = clear the freeze.
  // The dedicated two-stage detail suite is tests/test_stop_all_two_stage.ts; here we keep the
  // always-allowed gate-bypass + voice-surface-parity pins (still valid under the new design).
  describe("stop_all emergency brake (two-stage)", () => {
    it("voice stop_all freezes (Stage 1) and does NOT touch the panes", async () => {
      clearPanes();
      const a = addPane("vt-stop-a");
      addPane("vt-stop-b");

      const callId = session.emitToolCall("stop_all");
      const out = String(await waitFor(() => mock.responseFor(callId)));

      // Stage 1 is a freeze, not an interrupt: no Ctrl-C, no kill, panes survive.
      assert.strictEqual(a.writeInputCount, 0, "no Ctrl-C written in Stage 1");
      assert.notStrictEqual(running.manager.terminals["vt-stop-a"].status, "Exited", "pane survives Stage 1");
      assert.ok(/froze|frozen|freeze/i.test(out), `read-back says it froze: ${out}`);
      assert.ok(/kill|confirm|release/i.test(out), `read-back offers Stage-2 / release: ${out}`);
      await releaseFreeze();
    });

    it("voice confirm_stop_all (Stage 2) kills running PTYs via term.stop()", async () => {
      clearPanes();
      const a = addPane("vt-kill-a");
      const froze = session.emitToolCall("stop_all");
      await waitFor(() => mock.responseFor(froze));

      const kill = session.emitToolCall("confirm_stop_all");
      const out = String(await waitFor(() => mock.responseFor(kill)));
      assert.strictEqual(a.status, "Exited", "Stage 2 stopped the pane PTY");
      assert.ok(out.includes("vt-kill-a"), "kill read-back names the pane");
      await releaseFreeze();
    });

    it("voice confirm_stop_all with no panes still reports nothing-to-kill (Stage 2 no-op)", async () => {
      clearPanes();
      const froze = session.emitToolCall("stop_all");
      await waitFor(() => mock.responseFor(froze));
      const kill = session.emitToolCall("confirm_stop_all");
      const out = String(await waitFor(() => mock.responseFor(kill)));
      assert.ok(/no running panes|nothing/i.test(out), `nothing-to-kill read-back: ${out}`);
      await releaseFreeze();
    });

    it("voice release_stop_all clears the freeze", async () => {
      clearPanes();
      const froze = session.emitToolCall("stop_all");
      await waitFor(() => mock.responseFor(froze));
      const rel = session.emitToolCall("release_stop_all");
      const out = String(await waitFor(() => mock.responseFor(rel)));
      assert.ok(/released|resume|un-?frozen/i.test(out), `release read-back: ${out}`);
    });

    it("GATE BYPASS: an Off global write_to_pane gate cannot forbid stop_all", async () => {
      clearPanes();
      addPane("vt-bypass-a");

      // Tighten write_to_pane to Off by voice (tightening is allowed by set_capability_gate).
      const gateCall = session.emitToolCall("set_capability_gate", { capability: "write_to_pane", gate: "Off" });
      await waitFor(() => mock.responseFor(gateCall));

      // stop_all MUST still freeze — it does not route through gateOrDefer.
      const callId = session.emitToolCall("stop_all");
      const out = String(await waitFor(() => mock.responseFor(callId)));
      assert.ok(out.includes("vt-bypass-a"), "stop_all still names the still-running pane despite write_to_pane=Off");
      assert.ok(!/forbidden|gated/i.test(out), `stop_all output never mentions a gate refusal: ${out}`);

      await releaseFreeze();
      // Reset the global gate so later tests/suites aren't polluted.
      if (running.manager.settings.advanced.capabilityGates) {
        delete (running.manager.settings.advanced.capabilityGates as any).write_to_pane;
      }
    });

    it("GATE BYPASS 2: a per-pane Off gate cannot forbid stop_all for that pane", async () => {
      clearPanes();
      addPane("vt-bypass2-a");

      // Set per-pane close_pane + write_to_pane = Off on the live pane. The pane must
      // exist in the active project ledger for a per-pane gate to attach, so register it.
      const proj = running.manager.ledger.getActiveProject();
      if (proj) {
        proj.panes["vt-bypass2-a"] = { ...(proj.panes["vt-bypass2-a"] || {}), id: "vt-bypass2-a", name: "vt-bypass2-a" } as any;
      }
      const g1 = session.emitToolCall("set_capability_gate", { pane_id: "vt-bypass2-a", capability: "write_to_pane", gate: "Off" });
      await waitFor(() => mock.responseFor(g1));
      const g2 = session.emitToolCall("set_capability_gate", { pane_id: "vt-bypass2-a", capability: "close_pane", gate: "Off" });
      await waitFor(() => mock.responseFor(g2));

      const callId = session.emitToolCall("stop_all");
      const out = String(await waitFor(() => mock.responseFor(callId)));
      assert.ok(out.includes("vt-bypass2-a"), "stop_all still includes the pane despite its per-pane Off gates");
      assert.ok(!/forbidden/i.test(out), "no 'forbidden' response is ever produced for stop_all");

      await releaseFreeze();
      if (proj) delete proj.panes["vt-bypass2-a"];
    });

    it("REST: POST /api/stop-all (Stage 1) returns 200 + the converged { output } narration naming the still-running set", async () => {
      // c55 Batch A: POST /api/stop-all is now the registry twin stop_all (mountRestRoutes). The
      // converged REST body is the SAME { output } narration the voice path returns (the client
      // ignores the body and repaints off the broadcast `frozen` frame). We pin status 200 and assert
      // the narration both confirms the freeze AND names the still-running panes (proving the brake
      // closure ran and surfaced the running set), plus that the panes were NOT killed in Stage 1.
      clearPanes();
      const a = addPane("vt-rest-a");
      const b = addPane("vt-rest-b");

      const res = await api("/api/stop-all", { method: "POST" });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(typeof body.output, "string", "converged Stage-1 body is { output: string }");
      assert.ok(/froze|frozen|freeze/i.test(body.output), `narration confirms the freeze: ${body.output}`);
      assert.ok(
        body.output.includes("vt-rest-a") && body.output.includes("vt-rest-b"),
        `narration names the still-running panes: ${body.output}`
      );
      // Stage 1 freezes but never kills.
      assert.strictEqual(a.stopCount, 0, "pane a not killed in Stage 1");
      assert.strictEqual(b.stopCount, 0, "pane b not killed in Stage 1");
      await releaseFreeze();
    });

    it("REST: POST /api/stop-all without a token returns 401 and freezes nothing", async () => {
      clearPanes();
      const a = addPane("vt-auth-a");
      const res = await fetch(`${base}/api/stop-all`, { method: "POST" });
      assert.strictEqual(res.status, 401, "missing token -> 401");
      // The unauthorized request never reached the handler, so the pane is untouched.
      assert.strictEqual(a.writeInputCount, 0, "no interrupt written by the 401 request");
      assert.strictEqual(a.stopCount, 0, "no kill from the 401 request");
    });

    it("WS control: {type:'stop_all'} (Stage 1) yields a stop_all_done ack with the running set", async () => {
      clearPanes();
      addPane("vt-ws-a");
      const seen = clientMessages.length;

      client.send(JSON.stringify({ type: "stop_all" }));
      const ack = await waitFor(() =>
        clientMessages.slice(seen).find((m) => m.type === "stop_all_done" && m.stage === 1)
      );
      assert.strictEqual(ack.frozen, true, "ack reports frozen:true");
      assert.ok(Array.isArray(ack.running), "ack carries a running array");
      assert.ok(ack.running.includes("vt-ws-a"), "ack running includes vt-ws-a");
      await releaseFreeze();
    });

    it("BROADCAST: Stage 1 emits {type:'frozen', frozen:true} + {type:'terminals_updated'}", async () => {
      clearPanes();
      addPane("vt-bcast-a");
      const seen = clientMessages.length;

      await api("/api/stop-all", { method: "POST" });

      const bcast = await waitFor(() =>
        clientMessages.slice(seen).find((m) => m.type === "frozen" && m.frozen === true)
      );
      assert.ok(Array.isArray(bcast.running), "frozen broadcast carries the running list");
      assert.ok(bcast.running.includes("vt-bcast-a"), "frozen broadcast names vt-bcast-a");
      const updated = clientMessages.slice(seen).find((m) => m.type === "terminals_updated");
      assert.ok(updated, "a terminals_updated frame was broadcast");
      await releaseFreeze();
    });

    it("DECLARATION shape: stop_all is declared as an empty-params EMERGENCY tool", () => {
      const decls = session.params?.config?.tools?.[0]?.functionDeclarations;
      const decl = decls.find((d: any) => d.name === "stop_all");
      assert.ok(decl, "stop_all is in the live FunctionDeclarations");
      assert.deepStrictEqual(decl.parameters?.properties ?? {}, {}, "stop_all has an empty properties object");
      assert.ok(
        /EMERGENCY|always/i.test(decl.description),
        `stop_all description flags it as emergency/always-allowed: ${decl.description}`
      );
    });
  });

  // REG1 phase-C: the "voice tool surface parity guard" describe block was REMOVED here. It
  // regex-scraped server.ts to assert the functionDeclarations names matched the dispatch
  // `name === "X"` branches. After the registry swap, BOTH the declarations
  // (toGeminiDeclarations(REGISTRY)) and the dispatch (runAction(REGISTRY, ...)) derive from the
  // SAME REGISTRY, so the guard is obsolete — structural parity is covered by
  // test_action_registry.ts §8.2.

  // U4 (wsm-e2e-pinned-ckf): the voice create_pane tool is DETERMINISTIC. The schema no
  // longer exposes a free-form `command`; the server derives the command from the
  // (normalized) tool_preset. The misclassification bug was: command='claude' + tool_preset
  // arriving as the preset .id 'claudeCode' (not the union) misclassified runtimeType as
  // "shell" and dropped --dangerously-skip-permissions. These cases pin the fix end-to-end
  // through the real voice -> gate -> addTerminal -> constructor path.
  //
  // Spawn note: create_pane runs the genuine addTerminal -> term.start() (a real ConPTY).
  // We assert on constructor-set fields (shellCmd/runtimeType/toolPreset), which are decided
  // BEFORE the spawn, then deterministically tear each pane down via term.stop() (drains the
  // ConPTY conout worker so --test-force-exit can't abort, src\win\async.c:76).
  describe("U4: deterministic create_pane (preset-derived command)", () => {
    const created: string[] = [];

    // Force create_pane to resolve Auto so the gated effect runs inline. We set the global
    // matrix DIRECTLY (not via the set_capability_gate VOICE tool): create_pane defaults to
    // Ask, and voice LOOSENING (Ask->Auto) is intentionally REFUSED (server.ts:3216). The
    // director loosens via the Settings UI; in-test we mirror that by writing the matrix.
    function setCreatePaneAuto() {
      if (!running.manager.settings.advanced.capabilityGates) {
        running.manager.settings.advanced.capabilityGates = {} as any;
      }
      (running.manager.settings.advanced.capabilityGates as any).create_pane = "Auto";
    }

    async function teardownCreated() {
      for (const id of created.splice(0)) {
        const t = (running.manager.terminals as any)[id];
        if (t && typeof t.stop === "function") {
          try { await t.stop(); } catch { /* already gone */ }
        }
        delete (running.manager.terminals as any)[id];
      }
    }

    // Create a pane by voice and wait for the tool response, tracking it for teardown.
    async function createPaneByVoice(args: Record<string, any>): Promise<void> {
      created.push(args.pane_id);
      const call = session.emitToolCall("create_pane", args);
      await waitFor(() => mock.responseFor(call));
    }

    after(async () => {
      await teardownCreated();
      if (running.manager.settings.advanced.capabilityGates) {
        delete (running.manager.settings.advanced.capabilityGates as any).create_pane;
      }
    });

    it("Claude preset (sent as the .id 'claudeCode') derives 'claude', persists 'Claude Code', keeps --dangerously-skip-permissions under Full Auto", async () => {
      clearPanes();
      setCreatePaneAuto();
      await createPaneByVoice({
        project_id: "u4_proj",
        pane_id: "u4-claude",
        tool_preset: "claudeCode", // the misclassification case: model echoes the preset .id
        permissions_mode: "Full Auto",
      });
      const term = (running.manager.terminals as any)["u4-claude"];
      assert.ok(term, "pane was created");
      assert.strictEqual(term.toolPreset, "Claude Code", "persisted the union, not the raw id");
      assert.strictEqual(term.runtimeType, "interactive_cli", "agent runtime, NOT shell");
      assert.ok(term.shellCmd.startsWith("claude"), `derived the claude command: ${term.shellCmd}`);
      assert.ok(
        term.shellCmd.includes("--dangerously-skip-permissions"),
        `Full Auto keeps the skip flag: ${term.shellCmd}`
      );
      await teardownCreated();
    });

    it("restart of a Claude pane rebuilds the 'claude' command via presetCommand (from the persisted union)", async () => {
      clearPanes();
      setCreatePaneAuto();
      // The restart-restore branch reads the ACTIVE project's ledger pane, so create under
      // (and pin active to) u4_proj.
      running.manager.ledger.activeProjectId = "u4_proj";
      await createPaneByVoice({
        project_id: "u4_proj",
        pane_id: "u4-restart",
        tool_preset: "Claude Code",
        permissions_mode: "Full Auto",
      });
      assert.strictEqual(
        running.manager.ledger.getActiveProject()?.id ?? running.manager.ledger.activeProjectId,
        "u4_proj",
        "active project is u4_proj so the restart-restore branch finds the pane"
      );
      // Simulate the persisted-but-not-live restore path: drop the live term (await its
      // teardown), keep the ledger pane, then hit the restart REST endpoint -> server.ts:867
      // branch (manager.terminals[id] absent -> rebuild cmd via presetCommand).
      const live = (running.manager.terminals as any)["u4-restart"];
      if (live && typeof live.stop === "function") { try { await live.stop(); } catch {} }
      delete (running.manager.terminals as any)["u4-restart"];

      const res = await api("/api/terminals/u4-restart/restart", { method: "POST" });
      assert.strictEqual(res.status, 200, "restart endpoint accepted the restore");
      const term = (running.manager.terminals as any)["u4-restart"];
      assert.ok(term, "restart re-created the pane");
      assert.ok(term.shellCmd.startsWith("claude"), `restart derived claude: ${term.shellCmd}`);
      assert.strictEqual(term.toolPreset, "Claude Code", "restart kept the union");
      await teardownCreated();
    });

    it("Custom derives defaultShellCommand, stays shell runtime, never carries the skip flag (even Full Auto)", async () => {
      clearPanes();
      setCreatePaneAuto();
      await createPaneByVoice({
        project_id: "u4_proj",
        pane_id: "u4-custom",
        tool_preset: "Custom",
        permissions_mode: "Full Auto",
      });
      const term = (running.manager.terminals as any)["u4-custom"];
      assert.ok(term, "pane was created");
      const expectedShell =
        (running.manager.settings.advanced.defaultShellCommand || "").trim() ||
        (process.platform === "win32" ? "cmd.exe" : "bash");
      assert.strictEqual(term.runtimeType, "shell", "Custom -> shell runtime");
      assert.strictEqual(term.shellCmd, expectedShell, "Custom -> bare shell command");
      assert.ok(
        !term.shellCmd.includes("--dangerously-skip-permissions"),
        `no skip flag on a Custom shell even under Full Auto: ${term.shellCmd}`
      );
      await teardownCreated();
    });
  });
});
