// Phase 2 Track S — CARD 2S.4: freeze means FROZEN for the non-brake ALWAYS_ALLOWED REST mutators.
//
// PINS: clear_history / clear_exited / restore_archived_pane / delete_archived_pane / update_project
// are ALWAYS_ALLOWED (they never route through effectiveCapabilityGateFor, where the STOP-ALL frozen
// short-circuit lives at src/gating/index.ts), so they used to run their side effects WHILE FROZEN.
// Now each refuses with "Stop-all is engaged" and has NO side effect. The brake surface (stop_all /
// confirm / release, and the stop_pane de-escalation) stays EXEMPT — the brake must always work.
//
// Boots the REAL server in-process (ce7 harness, same pattern as tests/test_stop_all_two_stage.ts).

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import type { MockLiveHandle } from "./helpers/mockLive";
import { teardownServerSuite } from "./helpers/teardown";
import type { RunningServer } from "../server";

class StubTerminal {
  status: "Running" | "Exited" | "Idle";
  stopCount = 0;
  // Fields manager.syncLedger reads when stopAndArchivePane persists the live facts.
  projectId = "";
  cwd = ".";
  runtimeType = "shell";
  permissionsMode = "Human-in-the-Loop";
  toolPreset = "Custom";
  sessionId = "";
  contextSize = 0;
  lastStatusChangeAt = Date.now();
  lastCommand = "";
  constructor(public terminalId: string, status: "Running" | "Exited" | "Idle" = "Running") {
    this.status = status;
  }
  writeInput(_command: string) { this.status = "Running"; }
  async stop() { this.stopCount++; this.status = "Exited"; }
}

describe("2S.4 frozen guards on non-brake ALWAYS_ALLOWED REST mutators (headless)", () => {
  let startServer: (opts?: any) => Promise<RunningServer>;
  let apiToken: string;
  let installMockLive: () => MockLiveHandle;

  let running: RunningServer;
  let base: string;
  let tmpDir: string;
  let prevCwd: string;
  let projectId: string;

  const api = (pathname: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${base}${pathname}`, {
      ...init,
      headers: { "x-api-token": apiToken, "content-type": "application/json", ...(init.headers || {}) },
    });

  const freeze = async () => { await api("/api/stop-all", { method: "POST" }); };
  const release = async () => { await api("/api/stop-all/release", { method: "POST" }); };

  /** Assert a frozen refusal: a non-2xx answer whose error/output names the engaged stop-all. */
  async function assertFrozenRefusal(res: Response, what: string) {
    assert.ok(res.status >= 400, `${what}: refused while frozen (got HTTP ${res.status})`);
    const body = await res.json().catch(() => ({}));
    assert.match(
      String(body.error ?? body.output ?? ""),
      /stop-?all/i,
      `${what}: the refusal names the engaged stop-all`,
    );
  }

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";

    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-frozen-aa-"));
    process.chdir(tmpDir);

    ({ installMockLive } = await import("./helpers/mockLive"));
    const serverMod = await import("../server");
    startServer = serverMod.startServer;
    apiToken = serverMod.API_AUTH_TOKEN;

    installMockLive();
    running = await startServer({ port: 0, enableVite: false });
    base = `http://127.0.0.1:${running.port}`;

    projectId = running.manager.ledger.activeProjectId || "default_project";
  });

  after(async () => {
    await release();
    await teardownServerSuite(running);
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("clear_history while frozen: refused, the on-disk history survives", async () => {
    // Seed the SAME .janus_history.json the handler writes (cwd-relative in this tmp dir).
    const hist = path.join(tmpDir, ".janus_history.json");
    fs.writeFileSync(hist, JSON.stringify({ "fz-hist": [{ command: "echo keep-me", timestamp: "t", output: "" }] }), "utf-8");

    await freeze();
    const res = await api("/api/terminals/fz-hist/history/clear", { method: "POST" });
    await assertFrozenRefusal(res, "clear_history");
    const after = JSON.parse(fs.readFileSync(hist, "utf-8"));
    assert.strictEqual(after["fz-hist"]?.length, 1, "the pane's history was NOT cleared while frozen");
    await release();
  });

  it("clear_exited while frozen: refused, no terminal stopped/dropped, nothing archived", async () => {
    // A dead pane with a lingering live terminal object — exactly what clear_exited reaps.
    running.manager.ledger.updatePane(projectId, {
      pane_id: "fz-dead", name: "fz-dead", runtime_type: "shell", tool_preset: "Custom",
      permissions_mode: "Human-in-the-Loop", session_id: "", last_known_state: "Exited",
      is_busy: false, alive: false, context_size: 0, notes: [],
    } as any, true);
    const stub = new StubTerminal("fz-dead", "Exited");
    (running.manager.terminals as any)["fz-dead"] = stub;
    const archivedBefore = running.manager.ledger.listArchived().length;

    await freeze();
    const res = await api("/api/terminals/clear-exited", { method: "POST" });
    await assertFrozenRefusal(res, "clear_exited");
    assert.strictEqual(stub.stopCount, 0, "no lingering terminal was stopped while frozen");
    assert.ok((running.manager.terminals as any)["fz-dead"], "the terminal object was not dropped while frozen");
    assert.strictEqual(running.manager.ledger.listArchived().length, archivedBefore, "nothing was archived while frozen");
    await release();

    delete (running.manager.terminals as any)["fz-dead"];
  });

  it("restore_archived_pane while frozen: refused, the pane stays archived", async () => {
    running.manager.ledger.updatePane(projectId, {
      pane_id: "fz-arch", name: "fz-arch", runtime_type: "shell", tool_preset: "Custom",
      permissions_mode: "Human-in-the-Loop", session_id: "", last_known_state: "Exited",
      is_busy: false, alive: false, context_size: 0, notes: [],
    } as any, true);
    (running.manager.ledger as any).archivePane("fz-arch", projectId, "2S.4 seed");
    assert.ok(
      running.manager.ledger.listArchived().some((a: any) => a.pane.pane_id === "fz-arch"),
      "seed: the pane is archived",
    );

    await freeze();
    const res = await api("/api/archive/fz-arch/restore", { method: "POST" });
    await assertFrozenRefusal(res, "restore_archived_pane");
    assert.ok(
      running.manager.ledger.listArchived().some((a: any) => a.pane.pane_id === "fz-arch"),
      "the pane is STILL archived (no restore while frozen)",
    );
    const proj = running.manager.ledger.getProject(projectId);
    assert.ok(!proj?.panes?.["fz-arch"], "the pane did NOT reappear live while frozen");
    await release();
  });

  it("delete_archived_pane while frozen: refused, the archived record survives", async () => {
    await freeze();
    const res = await api("/api/archive/fz-arch", { method: "DELETE" });
    await assertFrozenRefusal(res, "delete_archived_pane");
    assert.ok(
      running.manager.ledger.listArchived().some((a: any) => a.pane.pane_id === "fz-arch"),
      "the archived record was NOT deleted while frozen",
    );
    await release();
  });

  it("update_project while frozen: refused, the project metadata is unchanged", async () => {
    const ws = running.manager.ledger.getProject(projectId)!;
    const summaryBefore = ws.summary;

    await freeze();
    const res = await api(`/api/projects/${projectId}`, {
      method: "PUT",
      body: JSON.stringify({ summary: "frozen-write-should-not-land" }),
    });
    await assertFrozenRefusal(res, "update_project");
    assert.strictEqual(
      running.manager.ledger.getProject(projectId)!.summary,
      summaryBefore,
      "the project summary is unchanged while frozen",
    );
    await release();
  });

  it("the BRAKE surface stays exempt: stop_all, stop_pane and release all work while frozen", async () => {
    await freeze();
    // Re-freezing while frozen is still answered (the brake never refuses).
    const again = await api("/api/stop-all", { method: "POST" });
    assert.strictEqual(again.status, 200, "stop_all still answers 200 while frozen");

    // stop_pane is a DE-ESCALATION — it must keep working while frozen.
    const stub = new StubTerminal("fz-brake", "Running");
    stub.projectId = projectId;
    (running.manager.terminals as any)["fz-brake"] = stub;
    running.manager.ledger.updatePane(projectId, {
      pane_id: "fz-brake", name: "fz-brake", runtime_type: "shell", tool_preset: "Custom",
      permissions_mode: "Human-in-the-Loop", session_id: "", last_known_state: "Running",
      is_busy: false, alive: true, context_size: 0, notes: [],
    } as any, true);
    const stop = await api(`/api/projects/${projectId}/panes/fz-brake/stop`, { method: "POST" });
    assert.strictEqual(stop.status, 200, "stop_pane (de-escalation) still answers 200 while frozen");
    assert.strictEqual(stub.stopCount, 1, "stop_pane actually stopped the pane while frozen");

    // And release clears the freeze.
    const rel = await api("/api/stop-all/release", { method: "POST" });
    assert.strictEqual(rel.status, 200, "release_stop_all answers 200 while frozen");

    // Post-release, a previously-guarded mutator works again (the guard is the freeze, not a gate):
    // clear_history now answers 200 AND its side effect lands (the on-disk history empties).
    // PR #68 review fix: the clear routes through the HistoryManager's dirty cache (the truth in a
    // running server) and reaches the FILE on the debounced flush — await flushAll() so the durable
    // convergence is asserted without timing sensitivity.
    const hist = path.join(tmpDir, ".janus_history.json");
    fs.writeFileSync(hist, JSON.stringify({ "fz-hist": [{ command: "echo keep-me", timestamp: "t", output: "" }] }), "utf-8");
    const clear = await api("/api/terminals/fz-hist/history/clear", { method: "POST" });
    assert.strictEqual(clear.status, 200, "clear_history works again after release");
    await (await import("../server")).HistoryManager.getInstance().flushAll();
    const after = JSON.parse(fs.readFileSync(hist, "utf-8"));
    assert.strictEqual(after["fz-hist"]?.length, 0, "the clear actually landed after release");
    delete (running.manager.terminals as any)["fz-brake"];
  });
});
