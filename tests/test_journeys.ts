import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "fs";
import { OrchestratorManager, UniversalTerminal } from "../src/terminal";
import { JanusStore } from "../src/store/sqliteStore";

// dbt3 — SQLite (JanusStore) is the only ledger backend. A real on-disk db (not
// :memory:) so Journey 7's "survives a restart" step can reopen a FRESH store over the
// SAME file, the same way it used to reload a fresh legacy `Ledger`.
function deleteLedgerDb(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(`${dbPath}${suffix}`); } catch { /* already gone */ }
  }
}

describe("Voice-Driven Applet User Journeys Validation Suite", () => {
  const TEST_LEDGER_DB = ".janus_ledger_journeys_test.db";
  let manager: OrchestratorManager;
  let store: JanusStore;

  beforeEach(() => {
    deleteLedgerDb(TEST_LEDGER_DB);
    // Initialize standard manager targeting custom test ledger storage
    store = new JanusStore(TEST_LEDGER_DB);
    store.init();
    manager = new OrchestratorManager({ ledger: store });
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
    try { store.close(); } catch { /* best-effort */ }
    deleteLedgerDb(TEST_LEDGER_DB);
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
    // Membership, not position: two notes added back-to-back can land in the same millisecond, and
    // JanusStore orders by created_at (ms resolution) — a same-tick tie is not guaranteed to
    // preserve add order (unlike the legacy Ledger's plain array push).
    assert.ok(
      brief?.notes.includes("Decision points: Transition server to CommonJS bundle output."),
      "the first dictated note must be present",
    );

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

    // Mimic the set_pane_permissions tool logic updating ledger states. updatePane() (not a direct
    // mutation of the getProject() result) is the backend-agnostic write path: JanusStore's
    // getProject() rebuilds a fresh Workspace from SQL on every call (it is not a live reference
    // into mutable state the way the legacy Ledger's plain object graph was), so a direct mutation
    // of the returned object silently does not persist against the SQLite backend.
    const ws = manager.ledger.getProject("active_workspace");
    const pane = ws?.panes["pane_adjustable"];
    if (pane) {
      manager.ledger.updatePane("active_workspace", { ...pane, permissions_mode: "Full Auto" }, true);
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

  // ==========================================
  // Journey 7: Dictate a specification
  // ==========================================
  it("Journey 7 (Dictate Spec): should durably capture dictated spec notes, surface them for same-session recall, and survive a restart", () => {
    manager.ledger.addProject("spec_project", ".", "OAuth hardening specification");
    manager.addTerminal("pane_spec", ".", "echo spec", "Claude Code", "Human-in-the-Loop", "", "spec_project");

    // 1. Dictated fragments land as durable notes (the add_project_note / add_pane_note tool path)
    assert.ok(
      manager.ledger.addNote("spec_project", "Spec: the auth service must support PKCE, not implicit flow."),
      "Project-level dictation must report success"
    );
    assert.ok(manager.ledger.addNote("spec_project", "Spec: refresh-token window is 30 days."));
    assert.ok(
      manager.ledger.addPaneNote("spec_project", "pane_spec", "Spec: token endpoint must reject grant_type=password."),
      "Pane-level dictation must report success"
    );

    // A mis-addressed dictation must be signalled to the model, not silently dropped (J8-G10 class).
    // Falsy-on-failure, not strictEqual(false): the LedgerLike contract is truthy-on-success
    // (JanusStore returns null on failure), and this test should hold across that contract.
    assert.ok(!manager.ledger.addPaneNote("spec_project", "pane_ghost", "lost"),
      "Note to a nonexistent pane must report failure");
    assert.ok(!manager.ledger.addNote("ghost_project", "lost"),
      "Note to a nonexistent project must report failure");

    // 2. Same-session recall ("Janus, what did I note?") via the notes-recall surface
    const rows = manager.ledger.getNotes({ projectId: "spec_project" });
    assert.strictEqual(rows.length, 3, "All three dictated notes must be retrievable without a context switch");
    assert.ok(rows.some(r => r.pane_id === "pane_spec"), "Pane-scoped note must carry its pane attribution");

    // { source: "note" } matches the real notes-recall voice tool's call pattern: search() also
    // indexes the NOTE_ADDED activity event each addNote() emits, so an unscoped search would
    // double-count (the note row + its own audit-trail event both mention "PKCE").
    const hits = manager.ledger.search("PKCE", { source: "note" });
    assert.strictEqual(hits.length, 1, "Keyword recall must find exactly the matching spec fragment");
    assert.ok(hits[0].snippet.includes("PKCE"));

    // 3. Continuity: a fresh JanusStore over the same db file (server restart) keeps everything.
    // The live `store` must be closed first — SQLite's single-writer model means a second
    // connection reopening the same file while the first is still open races the WAL.
    store.close();
    const reloaded = new JanusStore(TEST_LEDGER_DB);
    reloaded.init();
    try {
      const brief = reloaded.getProjectBriefing("spec_project");
      assert.strictEqual(brief?.notes.length, 2, "Project spec notes must survive a restart");
      // Membership, not position — see the same-millisecond-tie note on Journey 4 above.
      assert.ok(
        brief?.notes.includes("Spec: the auth service must support PKCE, not implicit flow."),
        "the PKCE spec note must survive a restart",
      );

      const paneMeta = brief?.panes.find(p => p.pane_id === "pane_spec");
      assert.strictEqual(paneMeta?.notes.length, 1, "Pane spec note must survive a restart");
      assert.strictEqual(paneMeta?.notes[0], "Spec: token endpoint must reject grant_type=password.");
    } finally {
      // afterEach still calls store.close() on the ORIGINAL (now-closed) store — harmless double
      // close is guarded there with try/catch, so close the reload handle here explicitly.
      reloaded.close();
    }
  });

  // ==========================================
  // Journey 8: Narrate a terminal walk-through
  // ==========================================
  it("Journey 8 (Narrate Walkthrough): should read back the redacted recent pane tail, stay stable across repeated reads, error on missing panes, and capture the dictated note", () => {
    manager.ledger.addProject("walkthrough_proj", ".", "Build pipeline triage");

    // Spawn-free pane: the UniversalTerminal constructor does NOT start a PTY, so the
    // ring buffer contents are deterministic. Register it with the manager + ledger the
    // way a live pane would be.
    const term: any = new UniversalTerminal("pane_build", ".", "npm run build", "Custom", "Read-Only", "", "walkthrough_proj");
    manager.terminals["pane_build"] = term;
    manager.ledger.updatePane("walkthrough_proj", {
      pane_id: "pane_build",
      name: "pane_build",
      runtime_type: "shell",
      last_known_state: "Idle",
      is_busy: false,
      alive: true,
      notes: [],
      permissions_mode: "Read-Only",
      session_id: "",
      tool_preset: "Custom",
      context_size: 0,
    }, false);

    // An untouched pane narrates the explicit no-output sentinel, not an empty fence
    assert.ok(manager.getPaneSummary("pane_build").includes("[No new output]"),
      "Quiet pane must read back the no-output sentinel");

    // Build output that scrolls past the default 20-line window, with a secret-shaped
    // token inside the visible tail.
    const lines = Array.from({ length: 30 }, (_, i) => `build step ${i + 1} ok`);
    lines.push("warning: AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE leaked to stdout");
    lines.push("Build finished with exit code 0");
    // Feed the model lane the way onData does, including the buffer-cap splice, so the
    // buffer state cannot drift from the production path (cf. feed() in test_pane_delta.ts).
    term.outputBuffer.push(...lines);
    if (term.outputBuffer.length > term.maxBufferLines) {
      term.outputBuffer.splice(0, term.outputBuffer.length - term.maxBufferLines);
    }
    term.totalLines += lines.length;

    // 1. Narration source: fenced, last-20-line tail of the model-lane buffer
    const summary = manager.getPaneSummary("pane_build");
    assert.ok(summary.startsWith("```\n") && summary.endsWith("\n```"), "Summary must be markdown-fenced");
    assert.ok(summary.includes("Build finished with exit code 0"), "Most recent line must be read back");
    assert.ok(summary.includes("build step 30 ok"), "Recent lines inside the window must be read back");
    assert.ok(!summary.includes("build step 5 ok"), "Lines that scrolled past the 20-line window must not be re-read");

    // 2. Redaction (WS-B / J8-G1): secrets never reach the narration channel
    assert.match(summary, /\[REDACTED/, "Secret-shaped tokens must be scrubbed before narration");
    assert.ok(!summary.includes("AKIAIOSFODNN7EXAMPLE"), "The raw AWS key must never appear in the summary");

    // 3. The operator can ask for a tighter slice
    const tail = manager.getPaneSummary("pane_build", 2);
    assert.ok(tail.includes("Build finished with exit code 0"), "Custom limit must keep the newest line");
    assert.ok(!tail.includes("build step 30 ok"), "Custom limit must drop lines beyond the requested window");

    // 4. Repeated reads with no new output are stable (tail read, not a consuming delta)
    assert.strictEqual(manager.getPaneSummary("pane_build"), summary,
      "Re-asking for the walkthrough without new output must narrate the same content");

    // 5. A missing pane is an explicit spoken error, not a silent empty narration
    assert.strictEqual(manager.getPaneSummary("pane_ghost"), "Error: Pane pane_ghost does not exist.");

    // 6. Close the loop: the operator dictates a note about what was just narrated
    assert.ok(manager.ledger.addPaneNote("walkthrough_proj", "pane_build",
      "Walkthrough: build green; rotate the AWS key that leaked to stdout."));
    const brief = manager.ledger.getProjectBriefing("walkthrough_proj");
    const paneMeta = brief?.panes.find(p => p.pane_id === "pane_build");
    assert.strictEqual(paneMeta?.notes.length, 1, "Dictated walkthrough note must persist on the narrated pane");
    assert.strictEqual(paneMeta?.notes[0], "Walkthrough: build green; rotate the AWS key that leaked to stdout.");
  });
});
