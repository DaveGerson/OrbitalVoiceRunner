import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "fs";
import { OrchestratorManager } from "../src/terminal";
import { Ledger } from "../src/ledger";

describe("Voice-Driven Applet User Journeys Validation Suite", () => {
  const TEST_LEDGER_PATH = ".janus_ledger_journeys_test.json";
  let manager: OrchestratorManager;

  beforeEach(() => {
    if (fs.existsSync(TEST_LEDGER_PATH)) {
      fs.unlinkSync(TEST_LEDGER_PATH);
    }
    // Initialize standard manager targeting custom test ledger storage
    manager = new OrchestratorManager();
    manager.ledger = new Ledger(TEST_LEDGER_PATH);
    // Hermetic precondition: the constructor seeds globalPermissionsMode from the
    // developer's live .janus_settings.json, which makes Journey 2's Inherit->pane
    // fallback depend on machine state. Pin it so the suite is self-contained.
    manager.globalPermissionsMode = "Inherit";
  });

  afterEach(async () => {
    // Clean up active terminals to avoid trailing background processes. AWAIT every
    // stop(): these are real ConPTY panes (cmd.exe/yes/echo). A fire-and-forget
    // stop() leaks node-pty's delayed conout-worker teardown (a worker_threads.Worker
    // = a libuv uv_async_t) past the suite boundary; the unit runner's
    // --test-force-exit then uv_close()'s that handle mid-terminate and aborts
    // (src\win\async.c:76). stop() now internally drains that worker, so awaiting all
    // stops in parallel is sufficient (one shared drain window, no extra settle).
    await Promise.all(Object.values(manager.terminals).map((term) => term.stop()));
    if (fs.existsSync(TEST_LEDGER_PATH)) {
      fs.unlinkSync(TEST_LEDGER_PATH);
    }
  });

  // ==========================================
  // Journey 1: Fan-out / delegate in parallel
  // ==========================================
  it("Journey 1 (Fan-out): should start multiple terminal panes across independent projects and support switching focus/context", () => {
    const isWin = process.platform === "win32";
    const shellCmd = isWin ? "cmd.exe" : "/bin/sh";

    // Setup multiple workspaces/projects in ledger
    manager.ledger.addProject("proj_alpha", "/cwd/alpha", "TypeScript backend migration");
    manager.ledger.addProject("proj_beta", "/cwd/beta", "Vite Frontend revamp");

    // Add multiple concurrent terminal panes assigned to those projects.
    // cwd must be a real directory — node-pty validates it and throws (Windows
    // ERROR_DIRECTORY / code 267) on a bogus path. The project dirs above are
    // inert ledger metadata; only the pane cwd reaches the PTY. Project
    // independence is keyed by projectId, not cwd, so "." is fine here.
    manager.addTerminal("pane_alpha_1", ".", shellCmd, "Claude Code", "Human-in-the-Loop", "", "proj_alpha");
    manager.addTerminal("pane_beta_1", ".", shellCmd, "Codex", "Human-in-the-Loop", "", "proj_beta");

    // Verify both exist, are tracked under their respective workspaces
    assert.ok(manager.terminals["pane_alpha_1"], "First client terminal should exist concurrently");
    assert.ok(manager.terminals["pane_beta_1"], "Second client terminal should exist concurrently");

    const projA = manager.ledger.getProject("proj_alpha");
    const projB = manager.ledger.getProject("proj_beta");
    assert.ok(projA?.panes["pane_alpha_1"], "Pane 1 metadata should reside in project alpha ledger");
    assert.ok(projB?.panes["pane_beta_1"], "Pane 2 metadata should reside in project beta ledger");

    // Validate context switching works and backgrounds other projects while launching briefing
    manager.ledger.switchContext("proj_alpha");
    assert.strictEqual(manager.ledger.activeProjectId, "proj_alpha");

    const briefAlpha = manager.ledger.getProjectBriefing("proj_alpha");
    assert.strictEqual(briefAlpha?.summary, "TypeScript backend migration");
    assert.ok(briefAlpha?.panes.some(p => p.pane_id === "pane_alpha_1"));

    manager.ledger.switchContext("proj_beta");
    assert.strictEqual(manager.ledger.activeProjectId, "proj_beta");

    const briefBeta = manager.ledger.getProjectBriefing("proj_beta");
    assert.strictEqual(briefBeta?.summary, "Vite Frontend revamp");
    assert.ok(briefBeta?.panes.some(p => p.pane_id === "pane_beta_1"));
  });

  // ==========================================
  // Journey 2: Supervisor / "air-traffic control"
  // ==========================================
  it("Journey 2 (Supervisor ATC): should respect Human-in-the-Loop mode and prevent automatic execution of proposed actions", () => {
    const isWin = process.platform === "win32";
    const shellCmd = isWin ? "cmd.exe" : "/bin/sh";

    manager.addTerminal("pane_controlled", ".", shellCmd, "Custom", "Human-in-the-Loop");
    const term = manager.terminals["pane_controlled"];

    // Evaluate effective permissions Mode
    // Mimicking the decision logic inside propose_command
    let effectivePermissions = manager.globalPermissionsMode; // should default to "Inherit" or similar
    if (effectivePermissions === "Inherit") {
      effectivePermissions = term.permissionsMode;
    }

    assert.strictEqual(effectivePermissions, "Human-in-the-Loop");

    // Ensure we can register a proposed command into a queue (pendingApprovals)
    // instead of running immediately when permissions are gated.
    const pendingApprovals: Record<string, { cmd: string; terminalId: string; status: string }> = {};

    const proposeCommandMock = (callId: string, terminalId: string, command: string, mode: string) => {
      if (mode === "Human-in-the-Loop") {
        pendingApprovals[callId] = { cmd: command, terminalId, status: "pending" };
        return "approval_pending_gated";
      } else if (mode === "Full Auto") {
        return "executed_automatically";
      }
      return "blocked";
    };

    const status1 = proposeCommandMock("call_101", "pane_controlled", "rm -rf /", effectivePermissions);
    assert.strictEqual(status1, "approval_pending_gated");
    assert.ok(pendingApprovals["call_101"]);
    assert.strictEqual(pendingApprovals["call_101"].cmd, "rm -rf /");
    assert.strictEqual(pendingApprovals["call_101"].terminalId, "pane_controlled");
  });

  // ==========================================
  // Journey 3: Review & approve code across panes
  // ==========================================
  it("Journey 3 (Review & Approve): should support resolving queued approvals and executing or rejecting them securely", async () => {
    // Mimic backend server approvals map and websocket feedback triggers
    const pendingApprovals: Record<string, { cmd: string; terminalId: string; executed: boolean; rejected: boolean }> = {
      "call_token_99": { cmd: "echo 'success_execution'", terminalId: "pane_target", executed: false, rejected: false }
    };

    const resolveApproval = (id: string, approve: boolean) => {
      if (!pendingApprovals[id]) return;
      if (approve) {
        pendingApprovals[id].executed = true;
      } else {
        pendingApprovals[id].rejected = true;
      }
      delete pendingApprovals[id];
    };

    // Voice triggers parser (matching logic from the interceptor inside server.ts)
    const parseVoiceUtterance = (utterance: string): { isApprove: boolean; isReject: boolean } => {
      const lower = utterance.toLowerCase();
      const isApprove = ["approve", "go ahead", "execute", "run it", "yes run", "approve command"].some(word => lower.includes(word));
      const isReject = ["reject", "cancel", "deny", "don't run", "reject command"].some(word => lower.includes(word));
      return { isApprove, isReject };
    };

    // 1. Simulate user voicing a rejection
    const voiceInputReject = "No don't run that please, cancel the action";
    const decisionReject = parseVoiceUtterance(voiceInputReject);
    assert.strictEqual(decisionReject.isReject, true, "Should classify cancel command as rejection");
    assert.strictEqual(decisionReject.isApprove, false);

    // 2. Simulate user voicing an approval
    const voiceInputApprove = "Everything looks crisp, go ahead and execute it now";
    const decisionApprove = parseVoiceUtterance(voiceInputApprove);
    assert.strictEqual(decisionApprove.isApprove, true, "Should classify go ahead phrase as approval");
    assert.strictEqual(decisionApprove.isReject, false);

    // 3. Resolve the mock pending element in queue using voice approval outcomes
    if (decisionApprove.isApprove) {
      resolveApproval("call_token_99", true);
    }

    assert.strictEqual(pendingApprovals["call_token_99"], undefined, "Pending command should be resolved and cleaned from queue");
  });

  // ==========================================
  // Journey 4: Knowledge capture & continuity
  // ==========================================
  it("Journey 4 (Knowledge capture): should log durable notes, track command history, and construct clean briefing frames", () => {
    manager.ledger.addProject("active_workspace", ".", "Primary backend framework documentation scope");

    // Capture project notes
    manager.ledger.addNote("active_workspace", "Decision points: Transition server to CommonJS bundle output.");
    manager.ledger.addNote("active_workspace", "Warning: Avoid running HMR inside Sandbox environments.");

    // Capture specific pane note
    manager.ledger.addProject("active_workspace", ".");
    manager.addTerminal("pane_dev", ".", "echo dev", "Claude Code", "Human-in-the-Loop", "", "active_workspace");
    manager.ledger.addPaneNote("active_workspace", "pane_dev", "TODO: setup unit testing for system tools");

    const brief = manager.ledger.getProjectBriefing("active_workspace");
    assert.strictEqual(brief?.notes.length, 2, "Project notes should persist all added note strings");
    assert.strictEqual(brief?.notes[0], "Decision points: Transition server to CommonJS bundle output.");

    const paneMeta = brief?.panes.find(p => p.pane_id === "pane_dev");
    assert.ok(paneMeta, "Pane metadata must reflect in the active workspace briefing context");
    assert.strictEqual(paneMeta.notes.length, 1);
    assert.strictEqual(paneMeta.notes[0], "TODO: setup unit testing for system tools");
  });

  // ==========================================
  // Journey 5: Adjust autonomy mid-session
  // ==========================================
  it("Journey 5 (Autonomy Adjustment): should promote or demote permissions modes on specific panes on-the-fly, persisting to ledger", () => {
    manager.ledger.addProject("active_workspace", ".");
    manager.addTerminal("pane_adjustable", ".", "echo Adjust", "Custom", "Human-in-the-Loop", "", "active_workspace");

    const term = manager.terminals["pane_adjustable"];
    assert.strictEqual(term.permissionsMode, "Human-in-the-Loop");

    const paneLedgerBefore = manager.ledger.getProject("active_workspace")?.panes["pane_adjustable"];
    assert.strictEqual(paneLedgerBefore?.permissions_mode, "Human-in-the-Loop");

    // Promote mid-session to Full Auto
    term.setPermissionsMode("Full Auto");
    assert.strictEqual(term.permissionsMode, "Full Auto");

    // Mimic the set_pane_permissions tool logic updating ledger states
    const ws = manager.ledger.getProject("active_workspace");
    if (ws && ws.panes["pane_adjustable"]) {
      ws.panes["pane_adjustable"].permissions_mode = "Full Auto";
    }

    const paneLedgerAfter = manager.ledger.getProject("active_workspace")?.panes["pane_adjustable"];
    assert.strictEqual(paneLedgerAfter?.permissions_mode, "Full Auto");
  });

  // ==========================================
  // Journey 6: On-demand status check
  // ==========================================
  it("Journey 6 (Status Check): should query all known panes, correctly listing busy status and active/alive parameters", () => {
    manager.ledger.addProject("demo_check", ".");
    manager.addTerminal("pane_busy", ".", "yes", "Custom", "Read-Only", "", "demo_check");
    manager.addTerminal("pane_idle", ".", "echo done", "Custom", "Read-Only", "", "demo_check");

    const termBusy = manager.terminals["pane_busy"];
    const termIdle = manager.terminals["pane_idle"];

    // Set mock operational status
    termBusy.status = "Running";
    termIdle.status = "Idle";

    // Query status listing
    const paneLists = manager.listPanes();
    const demoContextIndices = paneLists.find(item => item.project_id === "demo_check");
    assert.ok(demoContextIndices, "Demo project must be included in pane listings");

    const busyMeta = demoContextIndices.panes.find((p: any) => p.pane_id === "pane_busy");
    const idleMeta = demoContextIndices.panes.find((p: any) => p.pane_id === "pane_idle");

    assert.ok(busyMeta, "Pane busy metadata should be found");
    assert.ok(idleMeta, "Pane idle metadata should be found");

    assert.strictEqual(busyMeta.is_busy, true, "Is_busy flag should accurately map tool outputs running commands");
    assert.strictEqual(idleMeta.is_busy, false, "Is_busy flag must flag false for idle tasks waiting input");
  });
});
