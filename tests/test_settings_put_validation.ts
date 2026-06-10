// Phase 2 Track S — CARD 2S.2: PUT /api/settings validates the body before applying it.
//
// PINS: the route used to apply `req.body` unvalidated — `advanced.globalPermissionsMode` was
// assigned verbatim and PERSISTED, so a garbage value made every gate decision compare against an
// unknown mode across restarts; a non-object body threw a 500. Now:
//   - invalid advanced.globalPermissionsMode -> 400 naming the field, live mode UNCHANGED;
//   - capabilityGates: invalid values on KNOWN capability keys -> 400; UNKNOWN keys are stripped
//     (forward compat), never a 400;
//   - a non-object body -> 400, not 500;
//   - with 2S.1: a partial gates map merges ON TOP of the defaults (unmentioned caps keep Ask).
//
// Boots the REAL server in-process (ce7 harness pattern: JANUS_NO_AUTOSTART, installMockLive,
// startServer({port:0,enableVite:false})) — same as tests/test_pane_gates_rest.ts.

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import type { MockLiveHandle } from "./helpers/mockLive";
import { teardownServerSuite } from "./helpers/teardown";
import type { RunningServer } from "../server";

describe("2S.2 PUT /api/settings validation (headless)", () => {
  let startServer: (opts?: any) => Promise<RunningServer>;
  let apiToken: string;
  let installMockLive: () => MockLiveHandle;

  let running: RunningServer;
  let base: string;
  let tmpDir: string;
  let prevCwd: string;

  const api = (pathname: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${base}${pathname}`, {
      ...init,
      headers: { "x-api-token": apiToken, "content-type": "application/json", ...(init.headers || {}) },
    });

  const putSettings = (body: unknown): Promise<Response> =>
    api("/api/settings", { method: "PUT", body: JSON.stringify(body) });

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";

    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-settings-put-"));
    process.chdir(tmpDir);

    ({ installMockLive } = await import("./helpers/mockLive"));
    const serverMod = await import("../server");
    startServer = serverMod.startServer;
    apiToken = serverMod.API_AUTH_TOKEN;

    installMockLive();
    running = await startServer({ port: 0, enableVite: false });
    base = `http://127.0.0.1:${running.port}`;
  });

  after(async () => {
    await teardownServerSuite(running);
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("rejects an invalid advanced.globalPermissionsMode with 400 and leaves the live mode unchanged", async () => {
    const modeBefore = running.manager.globalPermissionsMode;
    const res = await putSettings({ advanced: { globalPermissionsMode: "YOLO-Unsupervised" } });
    assert.strictEqual(res.status, 400, "garbage mode answers 400 (was: applied + persisted verbatim)");
    const body = await res.json();
    assert.match(String(body.error), /globalPermissionsMode/, "the 400 names the offending field");
    assert.strictEqual(running.manager.globalPermissionsMode, modeBefore, "the live mode is unchanged");
    assert.strictEqual(
      running.manager.settings.advanced.globalPermissionsMode,
      modeBefore,
      "the persisted settings mode is unchanged",
    );
  });

  it("accepts every REAL mode value", async () => {
    for (const mode of ["Full Auto", "Human-in-the-Loop", "Read-Only", "Inherit"]) {
      const res = await putSettings({ advanced: { globalPermissionsMode: mode } });
      assert.strictEqual(res.status, 200, `mode '${mode}' is accepted`);
      assert.strictEqual(running.manager.globalPermissionsMode, mode, `live mode now '${mode}'`);
    }
    // Restore the default posture for the rest of the suite.
    await putSettings({ advanced: { globalPermissionsMode: "Inherit" } });
  });

  it("rejects an invalid gate VALUE on a KNOWN capability key with 400 naming the key", async () => {
    const before = JSON.stringify(running.manager.settings.advanced.capabilityGates ?? {});
    const res = await putSettings({ advanced: { capabilityGates: { write_to_pane: "Maybe" } } });
    assert.strictEqual(res.status, 400, "an invalid gate value answers 400");
    const body = await res.json();
    assert.match(String(body.error), /write_to_pane/, "the 400 names the offending capability");
    assert.strictEqual(
      JSON.stringify(running.manager.settings.advanced.capabilityGates ?? {}),
      before,
      "the live matrix is unchanged on rejection",
    );
  });

  it("STRIPS unknown capability keys (forward compat — never a 400) and keeps known ones", async () => {
    const res = await putSettings({
      advanced: { capabilityGates: { some_future_capability: "Auto", write_to_pane: "Off" } },
    });
    assert.strictEqual(res.status, 200, "unknown keys are stripped, not rejected");
    const gates = running.manager.settings.advanced.capabilityGates as Record<string, string>;
    assert.strictEqual(gates.write_to_pane, "Off", "the known key landed");
    assert.ok(!("some_future_capability" in gates), "the unknown key was stripped, not persisted");
  });

  it("a PARTIAL gates map merges ON TOP of the defaults (2S.1 through the route)", async () => {
    const res = await putSettings({ advanced: { capabilityGates: { write_to_pane: "Auto" } } });
    assert.strictEqual(res.status, 200);
    const gates = running.manager.settings.advanced.capabilityGates as Record<string, string>;
    assert.strictEqual(gates.write_to_pane, "Auto", "the mentioned gate landed");
    assert.strictEqual(gates.delete_project, "Ask", "unmentioned delete_project still resolves to its Ask default");
    assert.strictEqual(gates.close_pane, "Ask", "unmentioned close_pane still Ask");
    assert.strictEqual(gates.clear_history, "Ask", "clear_history defaults Ask");
  });

  it("a null body answers 400, not 500", async () => {
    const res = await putSettings(null);
    assert.strictEqual(res.status, 400, `null body answers 400 (got ${res.status})`);
  });

  it("an array body answers 400, not 500", async () => {
    const res = await putSettings([1, 2, 3]);
    assert.strictEqual(res.status, 400, `array body answers 400 (got ${res.status})`);
  });

  it("a non-object capabilityGates answers 400 naming the field", async () => {
    const res = await putSettings({ advanced: { capabilityGates: "all-auto-please" } });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.match(String(body.error), /capabilityGates/, "the 400 names the field");
  });

  it("still passes the permissive fields through (settings carry many shapes)", async () => {
    const res = await putSettings({ voiceAi: { voice: "Puck" }, advanced: { maxBufferLines: 777 } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(running.manager.settings.advanced.maxBufferLines, 777, "permissive advanced field landed");
    assert.strictEqual((running.manager.settings.voiceAi as any)?.voice, "Puck", "voiceAi passthrough landed");
  });
});
