// create_pane LAUNCH-DERIVATION keystone suite (Wave B KS, acceptance 17a–17f / §5.4).
//
// THE KEYSTONE PROOF (17d): the voice surface and the REST surface must derive an
// IDENTICAL launch command (and cwd) from the SAME single home — presetCommand()
// keyed on a normalizePreset()'d tool_preset. Most of the home shipped in 253e9a3
// (the voice path + restart-restore already derive). This suite pins that home, and
// drives REST POST /api/terminals to prove it derives server-side too (GOAL 1), so a
// client can no longer smuggle a divergent command for a non-Custom preset.
//
// Boots the REAL server in-process via the ce7 harness (no Gemini key, no mic):
// JANUS_NO_AUTOSTART=1, installMockLive() swaps the injectable liveConnector for a
// fake session, startServer({port:0,enableVite:false}) yields a headless server.
//
// SPY, DON'T SPAWN: create_pane normally runs the genuine addTerminal -> term.start()
// (a real ConPTY — flaky to spawn+kill repeatedly on Windows). Instead we replace
// running.manager.addTerminal with a wrapper that RECORDS (terminalId, cwd, command,
// toolPreset, ...) and returns a fake id WITHOUT calling through, so no PTY spawns.
// We then drive each surface and compare the captured command+cwd. (17f is the one
// case that needs the real env-hygiene logic, so it constructs a UniversalTerminal
// directly and inspects the spawned child env via an injected transport factory.)

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";
import type { MockLiveHandle, MockLiveSession } from "./helpers/mockLive";
import { teardownServerSuite } from "./helpers/teardown";
import { normalizePreset, presetCommand, UniversalTerminal } from "../src/terminal";
import type { RunningServer } from "../server";

interface AddTerminalCall {
  terminalId: string;
  cwd: string;
  command: string;
  toolPreset: string;
  permissionsMode?: string;
  sessionId?: string;
  projectId?: string;
}

describe("KS create_pane launch-derivation (headless, no API key, no mic)", () => {
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
  let projDir: string;
  let prevCwd: string;

  // The addTerminal spy: captures every call and returns a fake id WITHOUT spawning.
  let realAddTerminal: typeof running.manager.addTerminal;
  let captured: AddTerminalCall[];

  const api = (pathname: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${base}${pathname}`, {
      ...init,
      headers: { "x-api-token": apiToken, "content-type": "application/json", ...(init.headers || {}) },
    });

  // create_pane is Ask-gated by default and voice CANNOT loosen it (Ask->Auto is
  // refused at the voice boundary). We set the global matrix DIRECTLY to Auto so the
  // gated effect runs inline on BOTH surfaces; reverted in after().
  function setCreatePaneAuto() {
    if (!running.manager.settings.advanced.capabilityGates) {
      running.manager.settings.advanced.capabilityGates = {} as any;
    }
    (running.manager.settings.advanced.capabilityGates as any).create_pane = "Auto";
  }

  function installSpy() {
    captured = [];
    realAddTerminal = running.manager.addTerminal.bind(running.manager);
    (running.manager as any).addTerminal = (
      terminalId: string,
      cwd: string,
      command: string,
      toolPreset?: string,
      permissionsMode?: string,
      sessionId?: string,
      projectId?: string,
    ): string => {
      captured.push({ terminalId, cwd, command, toolPreset: toolPreset ?? "", permissionsMode, sessionId, projectId });
      // Return a fake "created" string WITHOUT spawning a PTY.
      return `Created terminal '${terminalId}' executing '${command}' at '${cwd}'.`;
    };
  }

  function lastCapture(): AddTerminalCall {
    assert.ok(captured.length > 0, "addTerminal was captured at least once");
    return captured[captured.length - 1];
  }

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";

    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-createpane-"));
    process.chdir(tmpDir);
    // A real on-disk project directory so REST's existsSync(cwd) validation passes and
    // both surfaces resolve to the SAME absolute dir (17d/17e).
    projDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-cp-proj-"));

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

    // Register the shared project with a real directory and pin it active so both the
    // voice path (workspaces[project_id].directory) and the REST path (active-project
    // fallback) resolve to projDir.
    running.manager.ledger.addProject("cp_proj", projDir, "create_pane keystone proj");
    running.manager.ledger.activeProjectId = "cp_proj";

    installSpy();
    setCreatePaneAuto();
  });

  after(async () => {
    // Restore the real addTerminal + revert the matrix override.
    if (realAddTerminal) (running.manager as any).addTerminal = realAddTerminal;
    if (running.manager.settings.advanced.capabilityGates) {
      delete (running.manager.settings.advanced.capabilityGates as any).create_pane;
    }
    if (client && client.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        client.once("close", () => resolve());
        try { client.terminate(); } catch { resolve(); }
      });
    }
    await teardownServerSuite(running);
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(projDir, { recursive: true, force: true }); } catch {}
  });

  // Drive voice create_pane and wait for the tool response; returns the captured call.
  async function voiceCreatePane(args: Record<string, any>): Promise<AddTerminalCall> {
    const before = captured.length;
    const call = session.emitToolCall("create_pane", args);
    await waitFor(() => mock.responseFor(call));
    await waitFor(() => captured.length > before);
    return lastCapture();
  }

  // Drive REST POST /api/terminals (Auto -> spawnEffect runs inline) and return the capture.
  async function restCreatePane(body: Record<string, any>): Promise<{ res: Response; call?: AddTerminalCall }> {
    const before = captured.length;
    const res = await api("/api/terminals", { method: "POST", body: JSON.stringify(body) });
    const call = captured.length > before ? lastCapture() : undefined;
    return { res, call };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 17a — the single home. Pure-function assertions (pins the existing home).
  // ──────────────────────────────────────────────────────────────────────────
  it("17a preset->command derivation has exactly one home", () => {
    const presets = running.manager.settings.presets;
    const def = running.manager.settings.advanced?.defaultShellCommand;

    assert.strictEqual(presetCommand(normalizePreset("Claude Code"), presets, def), "claude", "Claude Code -> claude");
    assert.strictEqual(presetCommand(normalizePreset("Codex"), presets, def), "codex", "Codex -> codex");
    assert.strictEqual(presetCommand(normalizePreset("Antigravity"), presets, def), "antigravity", "Antigravity -> antigravity");

    // Preset .ids collapse onto the same union -> same command (the misclassification surface).
    assert.strictEqual(presetCommand(normalizePreset("claudeCode"), presets, def), "claude", ".id 'claudeCode' -> claude");
    assert.strictEqual(presetCommand(normalizePreset("codex"), presets, def), "codex", ".id 'codex' -> codex");

    // Custom -> the configured shell (or the platform default when unset).
    const expectedShell = (def || "").trim() || (process.platform === "win32" ? "cmd.exe" : "bash");
    assert.strictEqual(presetCommand(normalizePreset("Custom"), presets, def), expectedShell, "Custom -> default shell");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 17b — voice derives; the model cannot supply a command (pins existing voice behavior).
  // ──────────────────────────────────────────────────────────────────────────
  it("17b voice create_pane derives the launch command — the model cannot supply one", async () => {
    const call = await voiceCreatePane({
      project_id: "cp_proj",
      pane_id: "cp-voice-b",
      tool_preset: "Claude Code",
      permissions_mode: "Human-in-the-Loop",
    });
    assert.ok(call.command.startsWith("claude"), `voice derived the claude command: ${call.command}`);
    assert.strictEqual(call.toolPreset, "Claude Code", "voice normalized to the union");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 17d — THE KEYSTONE PROOF. Voice and REST produce an IDENTICAL launch.
  // RED FIRST: today REST trusts the client `command` (and 400s when absent), so it
  // cannot match the server-derived voice command. GREEN after GOAL 1 derives server-side.
  // ──────────────────────────────────────────────────────────────────────────
  it("17d voice and REST create_pane produce an identical launch", async () => {
    const voiceCall = await voiceCreatePane({
      project_id: "cp_proj",
      pane_id: "cp-voice-d",
      tool_preset: "Claude Code",
      permissions_mode: "Human-in-the-Loop",
    });

    // REST: SAME preset, SAME resolved cwd target (empty cwd -> active project dir),
    // NO client command (must be derived server-side). The model-equivalent client could
    // also send a bogus command for a non-Custom preset; the server must ignore it.
    const { res, call: restCall } = await restCreatePane({
      terminalId: "cp-rest-d",
      projectId: "cp_proj",
      toolPreset: "Claude Code",
      permissionsMode: "Human-in-the-Loop",
      command: "totally-bogus-client-command", // must be IGNORED for a non-Custom preset
    });

    assert.strictEqual(res.status, 200, "REST create accepted (non-Custom no longer requires a client command)");
    assert.ok(restCall, "REST drove addTerminal (Auto ran the spawn effect inline)");

    assert.strictEqual(
      restCall!.command,
      voiceCall.command,
      `REST and voice derived the IDENTICAL command (voice='${voiceCall.command}', rest='${restCall!.command}')`,
    );
    assert.ok(restCall!.command.startsWith("claude"), `derived command is the agent binary, not the client string: ${restCall!.command}`);
    assert.strictEqual(restCall!.cwd, voiceCall.cwd, `REST and voice resolved the IDENTICAL cwd (voice='${voiceCall.cwd}', rest='${restCall!.cwd}')`);
    assert.strictEqual(restCall!.toolPreset, voiceCall.toolPreset, "REST and voice persist the same normalized preset");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 17e — cwd resolution matches the UI route on both surfaces.
  // ──────────────────────────────────────────────────────────────────────────
  it("17e cwd resolution matches the UI route", async () => {
    // Voice resolves workspaces[project_id].directory (== projDir).
    const voiceCall = await voiceCreatePane({
      project_id: "cp_proj",
      pane_id: "cp-voice-e",
      tool_preset: "Claude Code",
      permissions_mode: "Human-in-the-Loop",
    });
    assert.strictEqual(voiceCall.cwd, projDir, "voice resolves the active project directory");

    // REST: empty / "." / missing cwd all fall back to the active project directory.
    for (const cwd of ["", ".", undefined]) {
      const body: Record<string, any> = {
        terminalId: `cp-rest-e-${cwd === undefined ? "missing" : cwd === "" ? "empty" : "dot"}`,
        projectId: "cp_proj",
        toolPreset: "Claude Code",
        permissionsMode: "Human-in-the-Loop",
      };
      if (cwd !== undefined) body.cwd = cwd;
      const { res, call } = await restCreatePane(body);
      assert.strictEqual(res.status, 200, `REST accepted cwd=${JSON.stringify(cwd)}`);
      assert.ok(call, "REST drove addTerminal");
      assert.strictEqual(call!.cwd, projDir, `cwd=${JSON.stringify(cwd)} falls back to the active project directory`);
      assert.strictEqual(call!.cwd, voiceCall.cwd, `cwd=${JSON.stringify(cwd)} matches the voice-resolved cwd`);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 17f — shared env hygiene preserved (characterization; guards the refactor, no code change).
  // ──────────────────────────────────────────────────────────────────────────
  it("17f shared env hygiene preserved", () => {
    // Inject a transport factory so start() never spawns a real PTY — it captures the
    // env + final command the constructor/start() built.
    let capturedEnv: NodeJS.ProcessEnv = {};
    let capturedCmd = "";
    const fakeFactory: any = (command: string, opts: any) => {
      capturedCmd = command;
      capturedEnv = opts.env || {};
      const transport: any = {
        pid: 12345,
        onData: () => {},
        onExit: () => {},
        write: () => {},
        resize: () => {},
        kill: () => {},
      };
      return { transport, usingNodePty: false };
    };

    // Seed the nested-agent markers on process.env; start() must strip them from the child.
    const prev = {
      CLAUDECODE: process.env.CLAUDECODE,
      CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT,
    };
    process.env.CLAUDECODE = "1";
    process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
    try {
      // Full Auto agent pane: env stripped + --dangerously-skip-permissions applied.
      const fullAuto = new UniversalTerminal(
        "cp-env-fa", projDir, "claude", "Claude Code", "Full Auto", "", "cp_proj", undefined, fakeFactory,
      );
      fullAuto.start();
      assert.strictEqual(capturedEnv.CLAUDECODE, undefined, "CLAUDECODE stripped from child env");
      assert.strictEqual(capturedEnv.CLAUDE_CODE_ENTRYPOINT, undefined, "CLAUDE_CODE_ENTRYPOINT stripped from child env");
      assert.ok(capturedCmd.includes("--dangerously-skip-permissions"), `Full Auto applies the skip flag: ${capturedCmd}`);

      // Human-in-the-Loop agent pane: NO skip flag.
      const hitl = new UniversalTerminal(
        "cp-env-hitl", projDir, "claude", "Claude Code", "Human-in-the-Loop", "", "cp_proj", undefined, fakeFactory,
      );
      hitl.start();
      assert.ok(!capturedCmd.includes("--dangerously-skip-permissions"), `HiTL does NOT apply the skip flag: ${capturedCmd}`);
      assert.strictEqual(capturedEnv.CLAUDECODE, undefined, "CLAUDECODE stripped on the HiTL pane too");
    } finally {
      if (prev.CLAUDECODE === undefined) delete process.env.CLAUDECODE; else process.env.CLAUDECODE = prev.CLAUDECODE;
      if (prev.CLAUDE_CODE_ENTRYPOINT === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT; else process.env.CLAUDE_CODE_ENTRYPOINT = prev.CLAUDE_CODE_ENTRYPOINT;
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 17c — Custom preset still honors a free-form command.
  // REST honors a client command ONLY for a Custom preset (GOAL 1).
  //
  // DEFERRAL NOTE (REG1): the VOICE side of 17c — restoring a free-form `command` FIELD
  // to the create_pane voice schema, guarded by a zod .refine that only permits it when
  // tool_preset === "Custom" — is INTENTIONALLY DEFERRED to REG1, where create_pane gets
  // its zod ActionDef schema. We do NOT add a voice command field now; the voice schema
  // still has no command field (server.ts create_pane FunctionDeclaration), so a voice
  // Custom-command assertion cannot pass without REG1 and is .skip'd below.
  // ──────────────────────────────────────────────────────────────────────────
  it("17c Custom preset still honors a free-form command (REST)", async () => {
    const { res, call } = await restCreatePane({
      terminalId: "cp-rest-c-custom",
      projectId: "cp_proj",
      toolPreset: "Custom",
      permissionsMode: "Human-in-the-Loop",
      command: "htop",
    });
    assert.strictEqual(res.status, 200, "REST accepted the Custom create");
    assert.ok(call, "REST drove addTerminal");
    assert.strictEqual(call!.command, "htop", "Custom preset honors the client free-form command verbatim");
    assert.strictEqual(call!.toolPreset, "Custom", "preset stays Custom");
  });

  // Voice Custom free-form command is DEFERRED to REG1 (no command field on the voice
  // schema yet). Skipped rather than failed so the suite stays green; REG1 will add the
  // zod-guarded field and flip this to an active assertion.
  it.skip("17c (voice) Custom preset honors a free-form command — DEFERRED to REG1 (zod ActionDef command field + .refine)", async () => {
    // Intentionally empty: see the DEFERRAL NOTE above. REG1 adds a `command` field to the
    // create_pane voice schema guarded by a zod .refine(tool_preset === "Custom").
  });
});
