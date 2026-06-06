// tests/test_settings_key_reconnect_nudge.ts — bead 9fz (part 2): a settings PUT that sets a
// NON-EMPTY geminiApiKey nudges the live voice session to (re)connect, so the operator who just
// pasted a key in Settings gets voice back WITHOUT a reload.
//
// We boot the REAL server in-process (no mic, no Gemini key) and register a SPY reconnect-nudge via a
// test seam, then assert:
//   - a PUT with a real non-empty key      => the nudge fires;
//   - a PUT with the masked echo value     => the nudge does NOT fire (the handler restores the stored
//     key; it is not a new credential);
//   - a PUT with no secrets at all          => the nudge does NOT fire.
// SECRET INVARIANT: the response is the masked settings; we never assert on a raw key value.
//
// Runner: npx tsx --test --test-force-exit tests/test_settings_key_reconnect_nudge.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { teardownServerSuite } from "./helpers/teardown";
import type { RunningServer } from "../server";

describe("PUT /api/settings reconnect-nudge on a non-empty Gemini key (headless real server)", () => {
  let running: RunningServer;
  let base: string;
  let apiToken: string;
  let tmpDir: string;
  let prevCwd: string;
  let nudgeCalls: number;

  const api = (pathname: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${base}${pathname}`, {
      ...init,
      headers: { "x-api-token": apiToken, "content-type": "application/json", ...(init.headers || {}) },
    });

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";
    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-nudge-"));
    process.chdir(tmpDir);

    const serverMod = await import("../server");
    apiToken = serverMod.API_AUTH_TOKEN;
    running = await serverMod.startServer({ port: 0, enableVite: false });
    base = `http://127.0.0.1:${running.port}`;

    // Register a spy nudge through the test seam so we can observe the settings-PUT trigger without a
    // live Gemini socket.
    nudgeCalls = 0;
    running._testSetReconnectNudge?.(() => { nudgeCalls++; });
  });

  after(async () => {
    running._testSetReconnectNudge?.(null);
    await teardownServerSuite(running);
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("a real non-empty geminiApiKey TRIGGERS the reconnect nudge", async () => {
    const before = nudgeCalls;
    const res = await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ secrets: { geminiApiKey: "AIzaSy-real-looking-key-0123456789" } }),
    });
    assert.strictEqual(res.status, 200, "settings PUT succeeds");
    assert.strictEqual(nudgeCalls, before + 1, "a non-empty key nudged the voice session to reconnect exactly once");
  });

  it("a MASKED key echo does NOT trigger the nudge (not a new credential)", async () => {
    const before = nudgeCalls;
    const res = await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ secrets: { geminiApiKey: "AIzaSy••••••••6789" } }),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(nudgeCalls, before, "the masked echo must NOT nudge a reconnect");
  });

  it("a PUT with no secrets at all does NOT trigger the nudge", async () => {
    const before = nudgeCalls;
    const res = await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ voiceAi: { voice: "Charon" } }),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(nudgeCalls, before, "an unrelated settings change must NOT nudge a reconnect");
  });
});

// bead 53q: reconnect-nudge IDENTITY guard (single-connection hardening). The nudge registry is
// module-scoped: if two voice WS connections overlap, the second registration takes ownership, and the
// CLOSE of either connection used to call setVoiceReconnectNudge(null) unconditionally — so a stale/
// foreign connection's close could clear the SURVIVING connection's nudge. The fix makes register/clear
// identity-aware (an owner token). A connection may only clear the nudge when it is the CURRENT owner.
describe("setVoiceReconnectNudge identity guard (bead 53q)", () => {
  let setVoiceReconnectNudge: (fn: (() => void) | null, owner?: unknown) => void;
  let requestVoiceReconnect: () => void;

  before(async () => {
    const mod = await import("../server");
    setVoiceReconnectNudge = mod.setVoiceReconnectNudge;
    requestVoiceReconnect = mod.requestVoiceReconnect;
  });

  after(() => {
    // leave module scope clean for any later import of this server module in the same run.
    setVoiceReconnectNudge(null);
  });

  it("closing a STALE connection (A) does NOT clear the SURVIVING connection's (B) nudge", () => {
    const ownerA = { id: "A" };
    const ownerB = { id: "B" };
    let aCalls = 0;
    let bCalls = 0;

    // A registers, then B registers (overlap) — B is now the current owner.
    setVoiceReconnectNudge(() => { aCalls++; }, ownerA);
    setVoiceReconnectNudge(() => { bCalls++; }, ownerB);

    // A closes: a NON-owner clear must be a no-op (must NOT clear B's nudge).
    setVoiceReconnectNudge(null, ownerA);

    requestVoiceReconnect();
    assert.strictEqual(bCalls, 1, "B (current owner) still receives the nudge after A's stale close");
    assert.strictEqual(aCalls, 0, "A's overwritten nudge never fires");

    // B closes (it IS the owner): now the nudge is cleared.
    setVoiceReconnectNudge(null, ownerB);
    requestVoiceReconnect();
    assert.strictEqual(bCalls, 1, "after the owner (B) closes, the nudge is cleared — no further calls");
  });
});
