// tests/test_respawn_owning_project.ts — respawn_pane (POST /api/terminals/:id/restart) respawns a
// LEDGER-ONLY pane into its OWNING project, not the active one (review-fix A).
//
// THE BUG (review of core-user-journeys-coverage): the ledger-only respawn branch in
// src/actions/defs/panes_rest.ts resolved the pane via ledger.getActiveProject()?.panes[id] and then
// spawned with `activeProject.directory` and NO project id. So respawning a ledger-only pane that
// belongs to a NON-active project either missed it entirely (active project doesn't own it) or, when
// found, landed the respawned PTY in the WRONG project/cwd (the active one).
//
// THE FIX under test: resolve the pane via findPaneOwningProject (src/paneOwnership.ts) and spawn into
// THAT project's directory, passing its project id as the 7th addTerminal arg — mirroring archive.ts
// Restore. Asserts term.projectId === owning project and term.cwd === owning project's directory, with
// a DIFFERENT project set active. Fails against the un-fixed code (lands in the active project).

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import type { MockLiveHandle } from "./helpers/mockLive";
import { teardownServerSuite } from "./helpers/teardown";
import type { RunningServer } from "../server";

describe("respawn_pane respawns a ledger-only pane into its OWNING project, not the active one", () => {
  let startServer: (opts?: any) => Promise<RunningServer>;
  let apiToken: string;
  let installMockLive: () => MockLiveHandle;

  let running: RunningServer;
  let base: string;
  let tmpDir: string;
  let ownerDir: string;
  let activeDir: string;
  let prevCwd: string;
  const ownerProjectId = "owner-proj";
  const activeProjectId = "active-proj";

  const api = (pathname: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${base}${pathname}`, {
      ...init,
      headers: { "x-api-token": apiToken, "content-type": "application/json", ...(init.headers || {}) },
    });

  /** Seed one LIVE (alive=false but present) ledger pane in the OWNER project — no live terminal. */
  function seedLedgerPane(paneId: string): void {
    running.manager.ledger.updatePane(ownerProjectId, {
      pane_id: paneId, name: paneId, runtime_type: "shell", tool_preset: "Custom",
      permissions_mode: "Full Auto", session_id: "", last_known_state: "Exited",
      is_busy: false, alive: false, context_size: 0, notes: [],
    } as any, true);
    assert.ok(running.manager.ledger.getProject(ownerProjectId)?.panes?.[paneId], `seed: ${paneId} in owner project`);
    assert.ok(!(running.manager.terminals as any)[paneId], `seed: ${paneId} has no live terminal`);
  }

  function setRestartGate(gate: "Auto" | "Ask" | "Off"): void {
    if (!running.manager.settings.advanced.capabilityGates) running.manager.settings.advanced.capabilityGates = {};
    (running.manager.settings.advanced.capabilityGates as any).restart_pane = gate;
  }

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";

    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-respawn-owning-"));
    process.chdir(tmpDir);
    ownerDir = fs.mkdtempSync(path.join(tmpDir, "owner-"));
    activeDir = fs.mkdtempSync(path.join(tmpDir, "active-"));

    ({ installMockLive } = await import("./helpers/mockLive"));
    const serverMod = await import("../server");
    startServer = serverMod.startServer;
    apiToken = serverMod.API_AUTH_TOKEN;

    installMockLive();
    running = await startServer({ port: 0, enableVite: false });
    base = `http://127.0.0.1:${running.port}`;

    // Two real projects with distinct directories; make the OTHER one active.
    running.manager.ledger.addProject(ownerProjectId, ownerDir, "respawn owning suite — owner");
    running.manager.ledger.addProject(activeProjectId, activeDir, "respawn owning suite — active");
    running.manager.ledger.switchContext(activeProjectId);
    assert.strictEqual(running.manager.ledger.getActiveProject()?.id, activeProjectId, "active project is the NON-owner");
  });

  after(async () => {
    try {
      await (running.manager as any).flushPendingSpawns?.();
      for (const id of Object.keys(running.manager.terminals)) {
        if (id.startsWith("ro-")) { await (running.manager.terminals as any)[id].stop(); delete (running.manager.terminals as any)[id]; }
      }
    } catch { /* best-effort */ }
    await teardownServerSuite(running);
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("gate Auto: respawns into the pane's owning (non-active) project directory + project id", async () => {
    seedLedgerPane("ro-auto");
    setRestartGate("Auto");

    const res = await api("/api/terminals/ro-auto/restart", { method: "POST" });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.match(String(body.output), /restored and started|restarted/i, "narration confirms the respawn");

    const term = (running.manager.terminals as any)["ro-auto"];
    assert.ok(term, "pane respawned into manager.terminals");
    assert.strictEqual(term.projectId, ownerProjectId, "respawn lands in the pane's OWNING project, NOT the active one");
    assert.strictEqual(term.cwd, ownerDir, "respawn uses the OWNING project's directory as cwd, NOT the active one");
    assert.strictEqual(term.toolPreset, "Custom", "respawn uses the persisted tool_preset");
    assert.strictEqual(term.permissionsMode, "Full Auto", "respawn uses the persisted permissions_mode");
  });
});
