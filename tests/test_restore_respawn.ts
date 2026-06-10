// tests/test_restore_respawn.ts — restore_archived_pane RESPAWNS the pane (core-journeys gap fix).
//
// THE GAP (surfaced by e2e/live_journeys.spec.ts): restore_archived_pane only reinstated the LEDGER
// row (ledger.restoreArchivedPane) — no PTY respawn. The kitchen board derives stations from
// GET /api/terminals (live manager.terminals only), so a restored pane showed NO card anywhere:
// "Restore" looked like a no-op to the operator.
//
// THE FIX under test: restore reinstates the ledger row (plumbing, ungated — unchanged) AND routes a
// PTY respawn from the pane's PERSISTED identity (project directory as cwd, preset-derived launch
// command — NEVER last_command — persisted permissions_mode + session_id) through the SAME
// `restart_pane` gate the burner's Re-fire (respawn_pane) rides:
//   - Auto → spawn now: the pane is in manager.terminals and on GET /api/terminals (the card feed).
//   - Ask  → the LEDGER restore still lands (row back in the project); the spawn is STAGED to the
//            action dialog (pendingActions); confirming it spawns the pane.
//   - Off  → the LEDGER restore still lands; the spawn is refused (narrated); nothing staged.
//   - frozen → refused entirely (pinned separately in tests/test_frozen_always_allowed.ts).
//   - missing id → unchanged "not found" narration, no spawn, nothing staged.
//
// Boots the REAL server in-process (ce7 harness, same pattern as tests/test_frozen_always_allowed.ts)
// so the gate resolution, pendingActions staging, REST mount, and manager spawn path are all genuine.

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import type { MockLiveHandle } from "./helpers/mockLive";
import { teardownServerSuite } from "./helpers/teardown";
import type { RunningServer } from "../server";

describe("restore_archived_pane respawns through the restart_pane gate", () => {
  let startServer: (opts?: any) => Promise<RunningServer>;
  let apiToken: string;
  let installMockLive: () => MockLiveHandle;

  let running: RunningServer;
  let base: string;
  let tmpDir: string;
  let projDir: string;
  let prevCwd: string;
  const projectId = "restore-proj";

  const api = (pathname: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${base}${pathname}`, {
      ...init,
      headers: { "x-api-token": apiToken, "content-type": "application/json", ...(init.headers || {}) },
    });

  /** Seed one ARCHIVED pane with a distinctive persisted identity, under our own project. */
  function seedArchived(paneId: string): void {
    running.manager.ledger.updatePane(projectId, {
      pane_id: paneId, name: paneId, runtime_type: "shell", tool_preset: "Custom",
      permissions_mode: "Full Auto", session_id: "", last_known_state: "Exited",
      is_busy: false, alive: false, context_size: 0, notes: [],
    } as any, true);
    // Default backend is the SQLite JanusStore: archivePane(paneId, workspaceId, reason).
    (running.manager.ledger as any).archivePane(paneId, projectId, "restore-respawn seed");
    assert.ok(
      running.manager.ledger.listArchived().some((a: any) => a.pane.pane_id === paneId),
      `seed: ${paneId} is archived`,
    );
    assert.ok(!running.manager.ledger.getProject(projectId)?.panes?.[paneId], `seed: ${paneId} left the project`);
  }

  function setRestartGate(gate: "Auto" | "Ask" | "Off"): void {
    if (!running.manager.settings.advanced.capabilityGates) running.manager.settings.advanced.capabilityGates = {};
    (running.manager.settings.advanced.capabilityGates as any).restart_pane = gate;
  }

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";

    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-restore-respawn-"));
    process.chdir(tmpDir);
    projDir = fs.mkdtempSync(path.join(tmpDir, "proj-"));

    ({ installMockLive } = await import("./helpers/mockLive"));
    const serverMod = await import("../server");
    startServer = serverMod.startServer;
    apiToken = serverMod.API_AUTH_TOKEN;

    installMockLive();
    running = await startServer({ port: 0, enableVite: false });
    base = `http://127.0.0.1:${running.port}`;

    // Our own project with a REAL directory — the respawned pane must inherit it as cwd.
    running.manager.ledger.addProject(projectId, projDir, "restore-respawn suite");
  });

  after(async () => {
    // Stop any pane this suite spawned before the server close (idempotent stop()).
    try {
      await (running.manager as any).flushPendingSpawns?.();
      for (const id of Object.keys(running.manager.terminals)) {
        if (id.startsWith("rr-")) { await (running.manager.terminals as any)[id].stop(); delete (running.manager.terminals as any)[id]; }
      }
    } catch { /* best-effort */ }
    await teardownServerSuite(running);
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("gate Auto: restore reinstates the ledger row AND respawns the pane from its persisted identity", async () => {
    seedArchived("rr-auto");
    setRestartGate("Auto");

    const res = await api("/api/archive/rr-auto/restore", { method: "POST" });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.match(String(body.output), /respawned/i, "the narration says the terminal came back");

    // Ledger truth: the row is back in OUR project (not archived anymore).
    assert.ok(running.manager.ledger.getProject(projectId)?.panes?.["rr-auto"], "ledger row restored");
    assert.ok(!running.manager.ledger.listArchived().some((a: any) => a.pane.pane_id === "rr-auto"), "no longer archived");

    // Live truth: the pane EXISTS in manager.terminals with the PERSISTED identity.
    const term = (running.manager.terminals as any)["rr-auto"];
    assert.ok(term, "pane respawned into manager.terminals");
    assert.strictEqual(term.cwd, projDir, "respawn uses the project's persisted directory as cwd");
    assert.strictEqual(term.toolPreset, "Custom", "respawn uses the persisted tool_preset");
    assert.strictEqual(term.permissionsMode, "Full Auto", "respawn uses the persisted permissions_mode");
    assert.strictEqual(term.projectId, projectId, "respawn lands in the archived row's project, not the active one");

    // Card feed truth: GET /api/terminals (the kitchen board's station source) now lists it.
    const terminals = await (await api("/api/terminals")).json();
    assert.ok(Array.isArray(terminals));
    assert.ok((terminals as { id: string }[]).some((t) => t.id === "rr-auto"), "GET /api/terminals includes the restored pane");
  });

  it("gate Ask: the ledger restore lands NOW; the spawn is deferred and the confirm spawns it", async () => {
    seedArchived("rr-ask");
    setRestartGate("Ask");

    const res = await api("/api/archive/rr-ask/restore", { method: "POST" });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.match(String(body.output), /confirm/i, "the narration says the spawn awaits confirmation");

    // The ledger restore landed even though the spawn deferred.
    assert.ok(running.manager.ledger.getProject(projectId)?.panes?.["rr-ask"], "ledger row restored despite Ask");
    assert.ok(!(running.manager.terminals as any)["rr-ask"], "spawn DEFERRED — no live terminal yet");

    // The spawn is staged as a pending restart_pane action; confirming it spawns the pane.
    const pending = await (await api("/api/actions/pending")).json() as Array<{ id: string; capability: string; summary: string }>;
    const staged = pending.find((p) => p.capability === "restart_pane" && p.summary.includes("rr-ask"));
    assert.ok(staged, "the deferred spawn is staged under the restart_pane capability");
    const confirm = await api(`/api/actions/${staged!.id}/confirm`, { method: "POST" });
    assert.strictEqual(confirm.status, 200);
    assert.ok((running.manager.terminals as any)["rr-ask"], "confirming the pending action spawned the pane");
  });

  it("gate Off: the ledger restore lands; the spawn is refused and nothing is staged", async () => {
    seedArchived("rr-off");
    setRestartGate("Off");

    const res = await api("/api/archive/rr-off/restore", { method: "POST" });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.match(String(body.output), /gated Off|forbidden by policy/i, "the narration names the Off gate");

    assert.ok(running.manager.ledger.getProject(projectId)?.panes?.["rr-off"], "ledger row restored despite Off");
    assert.ok(!(running.manager.terminals as any)["rr-off"], "no spawn while Off");
    const pending = await (await api("/api/actions/pending")).json() as Array<{ summary: string }>;
    assert.ok(!pending.some((p) => p.summary.includes("rr-off")), "nothing staged while Off");

    setRestartGate("Ask"); // restore the default for any later suite state
  });

  it("missing id: unchanged not-found narration, no spawn, nothing staged", async () => {
    setRestartGate("Auto");
    const before = Object.keys(running.manager.terminals).length;
    const res = await api("/api/archive/rr-ghost/restore", { method: "POST" });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.output, "Archived pane rr-ghost not found.");
    assert.strictEqual(Object.keys(running.manager.terminals).length, before, "no spawn for a missing id");
  });
});

// ── backend parity: restoring into a DELETED project ─────────────────────────────────────────────
// The legacy JSON Ledger recreates a missing destination project on restore (src/ledger.ts:440-443,
// "Restored workspace"). The SQLite JanusStore previously did NOT — panes.workspace_id carries a
// REFERENCES projects(id) FK with foreign_keys=ON, so the pane re-insert THREW where legacy quietly
// succeeded. Pin the recreate-on-restore parity directly against the store.
describe("restoreArchivedPane backend parity — deleted destination project is recreated", () => {
  it("JanusStore recreates the missing project and restores the pane (legacy Ledger parity)", async () => {
    const { JanusStore } = await import("../src/store/sqliteStore");
    const s = new JanusStore(":memory:");
    s.init();
    s.saveWorkspace({ id: "gone-proj", name: "gone-proj", directory: "", summary: "", key_terms: [], created_at: 0, updated_at: 0 });
    s.savePane({
      pane_id: "rr-orphan", workspace_id: "gone-proj", name: "rr-orphan", runtime_type: "shell",
      tool_preset: "Custom", permissions_mode: "Human-in-the-Loop", session_id: "",
      last_known_state: "Exited", is_busy: false, alive: false, context_size: 0,
      last_status_change_at: null, last_command: null, scrollback_path: null, created_at: 0, updated_at: 0,
    } as any);
    s.archivePane("rr-orphan", "gone-proj", "parity seed");
    // Delete the destination project AFTER archiving (panes_archive deliberately has no FK).
    (s as any).db.prepare("DELETE FROM projects WHERE id=?").run("gone-proj");
    assert.ok(!s.getProject("gone-proj"), "seed: the destination project is gone");

    const entry = s.restoreArchivedPane("rr-orphan");
    assert.ok(entry, "restore succeeds instead of throwing on the panes FK");
    assert.strictEqual(entry!.pane.pane_id, "rr-orphan");
    const proj = s.getProject("gone-proj");
    assert.ok(proj, "the destination project was recreated (legacy 'Restored workspace' semantics)");
    assert.ok(proj!.panes["rr-orphan"], "the pane row landed back in the recreated project");
    assert.strictEqual(s.listArchived().length, 0, "the archive entry was consumed");
    s.close();
  });
});
