// tests/test_scripted_live_gate.ts — BEAD wsm-e2e-pinned-s1ap gating tests (written FIRST, TDD).
//
// Pins the scripted-live gate's fail-closed behavior across every INDEPENDENT enforcement layer
// (src/voice/scriptedLiveConnector.ts + its wiring in server.ts's startServer()):
//   (a) JANUS_MOCK_LIVE absent            -> connector NOT installed; POST /__scripted_live__/emit
//                                             is a plain 404 (the route was never registered).
//   (b) JANUS_MOCK_LIVE="1" + production  -> REFUSED: not installed, endpoint absent, a loud warning
//                                             logged explaining exactly why.
//   (c) JANUS_MOCK_LIVE="1" + non-prod    -> installed; POST /__scripted_live__/emit reaches the
//                                             REAL onmessage handler (proven via a transcript_text WS
//                                             frame on a connected client) and POST
//                                             /__scripted_live__/close round-trips too.
//   (d) isScriptedLiveRequestAllowed (the loopback guard itself), unit-tested directly per the bead's
//       own allowance ("simulate however the harness allows, or unit-test the guard function
//       directly") — faking a non-loopback remoteAddress on a real loopback-bound test server isn't
//       possible without a second real network peer, so this is the guard's own decision function.
//
// Each scenario boots its OWN real server (port:0, enableVite:false) because the gate is read ONCE,
// synchronously, at startServer() time (mirrors the existing boundLiveConnector snapshot rationale) —
// there is no way to flip JANUS_MOCK_LIVE on an already-running server. `resetToRealConnector()` runs
// before every scenario so each one's "was the scripted connector installed?" assertion is
// order-independent (never inherits an install left behind by an earlier scenario in this same
// tsx --test process).
//
// Runner: npx tsx --test --test-force-exit tests/test_scripted_live_gate.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";
import { closeFetchPool } from "./helpers/teardown";
import type { RunningServer } from "../server";
import { isScriptedLiveRequestAllowed } from "../src/voice/scriptedLiveConnector";

describe("wsm-e2e-pinned-s1ap — scripted-live gate", () => {
  let serverMod: typeof import("../server");
  let tmpDir: string;
  let prevCwd: string;

  const prevEnv: Record<string, string | undefined> = {};
  function setEnv(k: string, v: string | undefined): void {
    if (!(k in prevEnv)) prevEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }

  before(async () => {
    setEnv("JANUS_NO_AUTOSTART", "1");
    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-scripted-live-gate-"));
    process.chdir(tmpDir);
    serverMod = await import("../server");
  });

  after(async () => {
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    // ONE global fetch-pool close for the whole file (not per-scenario): every scenario below still
    // needs a working global `fetch` for its OWN assertions, and closing/re-using the undici keep-alive
    // pool mid-file is untested territory — see teardown.ts's own note that this is meant to run once,
    // at the very end of a suite. Real settle window mirrors teardownServerSuite's default.
    await closeFetchPool();
    await new Promise((r) => setTimeout(r, 250));
  });

  /** Reset the module-level liveConnector to the REAL one. Called before every scenario so each
   *  scenario's install assertion is order-independent (never inherits a scripted install a PRIOR
   *  scenario in this file left behind). */
  function resetToRealConnector(): void {
    serverMod.setLiveConnector(serverMod.realLiveConnector);
  }

  /** Server-only teardown (drains WS + HTTP for THIS scenario's server) — deliberately does NOT touch
   *  the global fetch pool (see the file-level `after` above for why). */
  async function closeServerOnly(running: RunningServer | undefined): Promise<void> {
    try { await running?.close(); } catch { /* best-effort */ }
    await new Promise((r) => setTimeout(r, 100));
  }

  async function withCapturedWarn<T>(fn: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      const result = await fn();
      return { result, warnings };
    } finally {
      console.warn = original;
    }
  }

  // ── (a) JANUS_MOCK_LIVE absent ──────────────────────────────────────────────────────────────────
  describe("(a) JANUS_MOCK_LIVE absent", () => {
    let running: RunningServer;
    let base: string;

    before(async () => {
      resetToRealConnector();
      setEnv("JANUS_MOCK_LIVE", undefined);
      setEnv("NODE_ENV", "test");
      running = await serverMod.startServer({ port: 0, enableVite: false });
      base = `http://127.0.0.1:${running.port}`;
    });
    after(async () => { await closeServerOnly(running); });

    it("does NOT install the scripted connector (liveConnector stays the real one)", () => {
      assert.equal(serverMod.getLiveConnector(), serverMod.realLiveConnector);
    });

    it("POST /__scripted_live__/emit is a plain 404 — the route was never registered", async () => {
      const res = await fetch(`${base}/__scripted_live__/emit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: { serverContent: {} } }),
      });
      assert.equal(res.status, 404);
    });
  });

  // ── (b) JANUS_MOCK_LIVE="1" + NODE_ENV=production -> refused ───────────────────────────────────
  describe('(b) JANUS_MOCK_LIVE="1" + NODE_ENV=production', () => {
    let running: RunningServer;
    let base: string;
    let warnings: string[] = [];

    before(async () => {
      resetToRealConnector();
      setEnv("JANUS_MOCK_LIVE", "1");
      setEnv("NODE_ENV", "production");
      const captured = await withCapturedWarn(() => serverMod.startServer({ port: 0, enableVite: false }));
      running = captured.result;
      warnings = captured.warnings;
      base = `http://127.0.0.1:${running.port}`;
    });
    after(async () => {
      await closeServerOnly(running);
      setEnv("NODE_ENV", "test");
    });

    it("does NOT install the scripted connector (NODE_ENV=production refuses it)", () => {
      assert.equal(serverMod.getLiveConnector(), serverMod.realLiveConnector);
    });

    it("POST /__scripted_live__/emit is a plain 404 — the route was never registered", async () => {
      const res = await fetch(`${base}/__scripted_live__/emit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: { serverContent: {} } }),
      });
      assert.equal(res.status, 404);
    });

    it("logs a loud warning explaining the refusal", () => {
      assert.ok(
        warnings.some((w) => /JANUS_MOCK_LIVE=1/.test(w) && /REFUSED/.test(w) && /production/.test(w)),
        `expected a refusal warning mentioning JANUS_MOCK_LIVE=1 / REFUSED / production; got: ${JSON.stringify(warnings)}`
      );
    });
  });

  // ── (c) JANUS_MOCK_LIVE="1" + non-production -> installed + round-trips ────────────────────────
  describe('(c) JANUS_MOCK_LIVE="1" + non-production', () => {
    let running: RunningServer;
    let base: string;
    let wsBase: string;
    let client: WebSocket;
    let clientMessages: any[];

    before(async () => {
      resetToRealConnector();
      setEnv("JANUS_MOCK_LIVE", "1");
      setEnv("NODE_ENV", "test");
      running = await serverMod.startServer({ port: 0, enableVite: false });
      base = `http://127.0.0.1:${running.port}`;
      wsBase = `ws://127.0.0.1:${running.port}`;

      clientMessages = [];
      client = new WebSocket(`${wsBase}/live`, {
        headers: { Cookie: `auth_token=${serverMod.API_AUTH_TOKEN}` },
      });
      client.on("message", (data) => {
        try { clientMessages.push(JSON.parse(data.toString())); } catch { /* non-JSON */ }
      });
      await new Promise<void>((resolve, reject) => {
        client.on("open", () => resolve());
        client.on("error", reject);
      });
      // The scripted connector resolves via a real Promise (not synchronous) inside connectLiveSession's
      // initial connect — give it a settle window before the first control-channel POST.
      await new Promise((r) => setTimeout(r, 200));
    });
    after(async () => {
      if (client && client.readyState !== WebSocket.CLOSED) {
        await new Promise<void>((resolve) => {
          client.once("close", () => resolve());
          try { client.terminate(); } catch { resolve(); }
        });
      }
      await closeServerOnly(running);
    });

    it("installs the scripted connector (liveConnector is no longer the real one)", () => {
      assert.notEqual(serverMod.getLiveConnector(), serverMod.realLiveConnector);
    });

    it("POST /__scripted_live__/emit reaches the REAL onmessage handler (transcript_text frame)", async () => {
      const seen = clientMessages.length;
      const res = await fetch(`${base}/__scripted_live__/emit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: { serverContent: { inputTranscription: { text: "hello from the scripted control channel" } } },
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);

      await new Promise((r) => setTimeout(r, 200));
      const frame = clientMessages.slice(seen).find((m) => m.type === "transcript_text" && m.sender === "User");
      assert.ok(frame, `expected a transcript_text/User frame; got: ${JSON.stringify(clientMessages.slice(seen))}`);
      assert.equal(frame.text, "hello from the scripted control channel");
    });

    it("POST /__scripted_live__/emit is 400 on a non-object message", async () => {
      const res = await fetch(`${base}/__scripted_live__/emit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "not-an-object" }),
      });
      assert.equal(res.status, 400);
    });

    it("POST /__scripted_live__/close round-trips (simulates the Gemini socket dropping)", async () => {
      const res = await fetch(`${base}/__scripted_live__/close`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
    });
  });

  // ── (d) isScriptedLiveRequestAllowed — the loopback guard, unit-tested directly ────────────────
  describe("(d) isScriptedLiveRequestAllowed (loopback guard)", () => {
    it("allows 127.0.0.1 / ::1 / localhost", () => {
      assert.equal(isScriptedLiveRequestAllowed("127.0.0.1"), true);
      assert.equal(isScriptedLiveRequestAllowed("::1"), true);
      assert.equal(isScriptedLiveRequestAllowed("localhost"), true);
    });

    it("rejects a non-loopback remote peer, and absent/null addresses", () => {
      assert.equal(isScriptedLiveRequestAllowed("203.0.113.7"), false);
      assert.equal(isScriptedLiveRequestAllowed(undefined), false);
      assert.equal(isScriptedLiveRequestAllowed(null), false);
    });
  });
});
