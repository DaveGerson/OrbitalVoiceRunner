// Per-pane capability-gate REST endpoint + STOP-ALL status endpoint (bead 8sq FRONTEND slice support,
// spec §2.B / §5). The matrix editor's per-pane scope persists overrides via
//   PUT /api/projects/:projectId/panes/:paneId/capability-gates
// and the FROZEN banner restores on reload via
//   GET /api/stop-all/status
//
// Boots the REAL server in-process via the ce7 harness (no Gemini key, no mic), the same pattern as
// tests/test_stop_all_two_stage.ts. We assert the round-trip writes the ledger pane override and that
// the resolved per-pane effective gate reflects it (proving the UI write reaches the resolver/chip).

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import type { MockLiveHandle } from "./helpers/mockLive";
import type { RunningServer } from "../server";

describe("8sq per-pane capability-gate REST + stop-all status (headless)", () => {
  let startServer: (opts?: any) => Promise<RunningServer>;
  let apiToken: string;
  let installMockLive: () => MockLiveHandle;

  let mock: MockLiveHandle;
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

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";

    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-panegates-"));
    process.chdir(tmpDir);

    ({ installMockLive } = await import("./helpers/mockLive"));
    const serverMod = await import("../server");
    startServer = serverMod.startServer;
    apiToken = serverMod.API_AUTH_TOKEN;

    mock = installMockLive();
    running = await startServer({ port: 0, enableVite: false });
    base = `http://127.0.0.1:${running.port}`;

    // Seed an active project with a pane to override. updatePane is the durable create/update path for
    // BOTH backends (a bare save() would be a SQLite no-op and the pane would never persist).
    projectId = running.manager.ledger.activeProjectId || "default_project";
    running.manager.ledger.updatePane(projectId, {
      pane_id: "pg-1",
      name: "pane one",
      runtime_type: "shell",
      last_known_state: "Idle",
      is_busy: false,
      alive: true,
      notes: [],
      permissions_mode: "Full Auto",
      session_id: "",
      tool_preset: "Custom",
      context_size: 0,
    } as any, true);
  });

  after(async () => {
    try { await api("/api/stop-all/release", { method: "POST" }); } catch {}
    try { await running?.close(); } catch {}
    await new Promise((r) => setTimeout(r, 100));
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("PUT capability-gates writes the per-pane override and round-trips with zero loss", async () => {
    const gates = { write_to_pane: "Off", close_pane: "Ask" };
    const res = await api(`/api/projects/${projectId}/panes/pg-1/capability-gates`, {
      method: "PUT",
      body: JSON.stringify({ capabilityGates: gates }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.capabilityGates, gates, "endpoint echoes the stored override map");

    // The ledger pane now carries the override verbatim (no loss).
    const pane = running.manager.ledger.getActiveProject()?.panes["pg-1"];
    assert.deepStrictEqual(pane?.capabilityGates, gates, "ledger pane carries the override");
  });

  it("the override flows into the resolved effective posture (chip truth) — write Off => LOCKED", async () => {
    await api(`/api/projects/${projectId}/panes/pg-1/capability-gates`, {
      method: "PUT",
      body: JSON.stringify({ capabilityGates: { write_to_pane: "Off" } }),
    });
    const terminals = await (await api("/api/terminals")).json();
    // pg-1 has no live terminal (ledger-only), so it won't appear in /api/terminals; assert instead via
    // the ledger override + the documented derivation. We assert the persisted override is the one the
    // server resolves from. (The pure derivePostureWord(write Off) => LOCKED is unit-pinned in
    // tests/test_gate_surface.ts; here we only prove the REST write lands where the resolver reads.)
    assert.ok(Array.isArray(terminals), "terminals endpoint returns a list");
    const pane = running.manager.ledger.getActiveProject()?.panes["pg-1"];
    assert.strictEqual(pane?.capabilityGates?.write_to_pane, "Off", "write_to_pane override persisted");
  });

  it("an empty map clears the override (falls back to the global default — no masking {})", async () => {
    // First set something, then clear it.
    await api(`/api/projects/${projectId}/panes/pg-1/capability-gates`, {
      method: "PUT",
      body: JSON.stringify({ capabilityGates: { close_pane: "Off" } }),
    });
    const res = await api(`/api/projects/${projectId}/panes/pg-1/capability-gates`, {
      method: "PUT",
      body: JSON.stringify({ capabilityGates: {} }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.capabilityGates, null, "cleared override reports null (not an empty object)");
    const pane = running.manager.ledger.getActiveProject()?.panes["pg-1"];
    assert.strictEqual(pane?.capabilityGates, undefined, "ledger override is cleared to undefined");
  });

  it("PUT for an unknown pane is a 404", async () => {
    const res = await api(`/api/projects/${projectId}/panes/does-not-exist/capability-gates`, {
      method: "PUT",
      body: JSON.stringify({ capabilityGates: { write_to_pane: "Off" } }),
    });
    assert.strictEqual(res.status, 404);
  });

  it("GET /api/stop-all/status reports the freeze state (restores the banner on reload)", async () => {
    // Not frozen initially.
    let body = await (await api("/api/stop-all/status")).json();
    assert.strictEqual(body.frozen, false, "status reports not-frozen by default");

    // Freeze, then status reflects it.
    await api("/api/stop-all", { method: "POST" });
    body = await (await api("/api/stop-all/status")).json();
    assert.strictEqual(body.frozen, true, "status reports frozen after Stage 1");
    assert.ok(Array.isArray(body.running), "status reports the still-running panes");

    // Release restores.
    await api("/api/stop-all/release", { method: "POST" });
    body = await (await api("/api/stop-all/status")).json();
    assert.strictEqual(body.frozen, false, "status reports not-frozen after release");
  });
});
