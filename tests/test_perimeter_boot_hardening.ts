// tests/test_perimeter_boot_hardening.ts — bead wsm-e2e-pinned-xge: "Harden UI/API perimeter token
// model for local process control".
//
// Covers the boot-time / server-level pieces of the hardening that need a real module import (the
// pure src/security/perimeter.ts helpers are pinned standalone in tests/test_perimeter_helpers.ts):
//   1. API_AUTH_TOKEN fallback is a fresh random 64-hex token, not the old deterministic cwd-hash.
//   2. resolveBindHost defaults to loopback in ALL modes (no more prod->0.0.0.0), honors JANUS_BIND_HOST,
//      and an explicit option always wins.
//   3. assertBindHostAuthorized / startServer FAIL CLOSED: non-loopback bind + no explicit
//      API_AUTH_TOKEN env throws; loopback never throws; non-loopback + explicit env starts fine.
//   4. shouldSeedAuthCookie (the cookie-auto-seed decision): loopback peer seeds, non-loopback peer
//      does not (unless it proves the token via ?auth_token=), already-correct cookie is a no-op.
//   5. The WS Origin fence on the real /live upgrade: cross-host Origin rejected, same-host Origin
//      accepted, absent Origin + valid cookie accepted (unchanged — the existing suite's coverage).
//
// Runner: npx tsx --test --test-force-exit tests/test_perimeter_boot_hardening.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";
import type { MockLiveHandle } from "./helpers/mockLive";
import { teardownServerSuite } from "./helpers/teardown";
import type { RunningServer, StartServerOptions } from "../server";

describe("wsm-e2e-pinned-xge — perimeter token model hardening", () => {
  let serverMod: typeof import("../server");
  let apiToken: string;
  let installMockLive: () => MockLiveHandle;
  let running: RunningServer;
  let base: string;
  let wsBase: string;
  let tmpDir: string;
  let prevCwd: string;
  const sockets: WebSocket[] = [];

  const prevEnv: Record<string, string | undefined> = {};
  function setEnv(k: string, v: string | undefined) {
    if (!(k in prevEnv)) prevEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";
    // Deliberately UNSET so the module-load-time API_AUTH_TOKEN takes the random-fallback branch —
    // proves the fallback is live-generated, not fixed to a value some other suite pinned.
    delete process.env.API_AUTH_TOKEN;

    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-perimeter-"));
    process.chdir(tmpDir);

    ({ installMockLive } = await import("./helpers/mockLive"));
    serverMod = await import("../server");
    apiToken = serverMod.API_AUTH_TOKEN;

    installMockLive();
    running = await serverMod.startServer({ port: 0, enableVite: false });
    base = `http://127.0.0.1:${running.port}`;
    wsBase = `ws://127.0.0.1:${running.port}`;
  });

  after(async () => {
    for (const ws of sockets) {
      if (ws.readyState !== WebSocket.CLOSED) {
        await new Promise<void>((resolve) => {
          ws.once("close", () => resolve());
          try { ws.terminate(); } catch { resolve(); }
        });
      }
    }
    await teardownServerSuite(running);
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  // ── 1. Token fallback shape ──────────────────────────────────────────────────────────────────
  describe("API_AUTH_TOKEN random fallback", () => {
    it("is 64 lowercase hex characters (crypto.randomBytes(32).toString('hex'))", () => {
      assert.match(apiToken, /^[0-9a-f]{64}$/);
    });

    it("is NOT the old deterministic cwd-hash value (sha256('janus-auth:' + cwd))", () => {
      const oldStyleToken = crypto.createHash("sha256").update(`janus-auth:${tmpDir}`).digest("hex");
      assert.notEqual(apiToken, oldStyleToken);
    });

    it("exported API_AUTH_TOKEN is STILL the value the /api auth middleware accepts (load-bearing seam)", async () => {
      const res = await fetch(`${base}/api/terminals`, { headers: { "x-api-token": apiToken } });
      assert.equal(res.status, 200);
    });
  });

  // ── 2. resolveBindHost defaults ──────────────────────────────────────────────────────────────
  describe("resolveBindHost", () => {
    it("defaults to 127.0.0.1 when no option and no JANUS_BIND_HOST env, in ANY NODE_ENV", () => {
      const prevNodeEnv = process.env.NODE_ENV;
      const prevBindHostEnv = process.env.JANUS_BIND_HOST;
      delete process.env.JANUS_BIND_HOST;
      try {
        process.env.NODE_ENV = "production";
        assert.equal(serverMod.resolveBindHost(undefined), "127.0.0.1");
        process.env.NODE_ENV = "development";
        assert.equal(serverMod.resolveBindHost(undefined), "127.0.0.1");
        delete process.env.NODE_ENV;
        assert.equal(serverMod.resolveBindHost(undefined), "127.0.0.1");
      } finally {
        if (prevNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevNodeEnv;
        if (prevBindHostEnv === undefined) delete process.env.JANUS_BIND_HOST; else process.env.JANUS_BIND_HOST = prevBindHostEnv;
      }
    });

    it("honors JANUS_BIND_HOST when no explicit option is given", () => {
      const prev = process.env.JANUS_BIND_HOST;
      try {
        process.env.JANUS_BIND_HOST = "0.0.0.0";
        assert.equal(serverMod.resolveBindHost(undefined), "0.0.0.0");
      } finally {
        if (prev === undefined) delete process.env.JANUS_BIND_HOST; else process.env.JANUS_BIND_HOST = prev;
      }
    });

    it("an explicit option always wins over JANUS_BIND_HOST", () => {
      const prev = process.env.JANUS_BIND_HOST;
      try {
        process.env.JANUS_BIND_HOST = "0.0.0.0";
        assert.equal(serverMod.resolveBindHost("192.168.1.5"), "192.168.1.5");
      } finally {
        if (prev === undefined) delete process.env.JANUS_BIND_HOST; else process.env.JANUS_BIND_HOST = prev;
      }
    });
  });

  // ── 3. Fail-closed matrix ────────────────────────────────────────────────────────────────────
  describe("assertBindHostAuthorized (fail-closed non-loopback bind)", () => {
    it("never throws for a loopback host, with or without an explicit API_AUTH_TOKEN env", () => {
      const prev = process.env.API_AUTH_TOKEN;
      try {
        delete process.env.API_AUTH_TOKEN;
        assert.doesNotThrow(() => serverMod.assertBindHostAuthorized("127.0.0.1"));
        assert.doesNotThrow(() => serverMod.assertBindHostAuthorized("::1"));
        assert.doesNotThrow(() => serverMod.assertBindHostAuthorized("localhost"));
        process.env.API_AUTH_TOKEN = "some-explicit-token";
        assert.doesNotThrow(() => serverMod.assertBindHostAuthorized("127.0.0.1"));
      } finally {
        if (prev === undefined) delete process.env.API_AUTH_TOKEN; else process.env.API_AUTH_TOKEN = prev;
      }
    });

    it("throws for a non-loopback host with NO explicit API_AUTH_TOKEN env", () => {
      const prev = process.env.API_AUTH_TOKEN;
      try {
        delete process.env.API_AUTH_TOKEN;
        assert.throws(
          () => serverMod.assertBindHostAuthorized("0.0.0.0"),
          /API_AUTH_TOKEN/,
        );
        assert.throws(() => serverMod.assertBindHostAuthorized("192.168.1.10"));
      } finally {
        if (prev === undefined) delete process.env.API_AUTH_TOKEN; else process.env.API_AUTH_TOKEN = prev;
      }
    });

    it("does NOT throw for a non-loopback host when API_AUTH_TOKEN is explicitly set", () => {
      const prev = process.env.API_AUTH_TOKEN;
      try {
        process.env.API_AUTH_TOKEN = "explicit-operator-token";
        assert.doesNotThrow(() => serverMod.assertBindHostAuthorized("0.0.0.0"));
      } finally {
        if (prev === undefined) delete process.env.API_AUTH_TOKEN; else process.env.API_AUTH_TOKEN = prev;
      }
    });

    it("startServer({bindHost:'0.0.0.0'}, listen:false) REJECTS without an explicit API_AUTH_TOKEN env", async () => {
      setEnv("API_AUTH_TOKEN", undefined);
      const opts: StartServerOptions = { port: 0, enableVite: false, listen: false, bindHost: "0.0.0.0" };
      await assert.rejects(() => serverMod.startServer(opts), /API_AUTH_TOKEN/);
    });

    it("startServer({bindHost:'0.0.0.0'}, listen:false) STARTS when API_AUTH_TOKEN is explicit", async () => {
      setEnv("API_AUTH_TOKEN", "explicit-operator-token-2");
      const opts: StartServerOptions = { port: 0, enableVite: false, listen: false, bindHost: "0.0.0.0" };
      const extraServer = await serverMod.startServer(opts);
      try {
        assert.ok(extraServer);
      } finally {
        await teardownServerSuite(extraServer, 0);
        setEnv("API_AUTH_TOKEN", undefined);
      }
    });
  });

  // ── 4. Cookie auto-seed decision ─────────────────────────────────────────────────────────────
  describe("shouldSeedAuthCookie", () => {
    it("seeds for a loopback peer with no/stale cookie", () => {
      assert.equal(
        serverMod.shouldSeedAuthCookie({
          currentToken: null,
          apiToken: "tok",
          remoteAddress: "127.0.0.1",
          authTokenQuery: undefined,
        }),
        true,
      );
    });

    it("does NOT seed for a non-loopback peer with no proving query param", () => {
      assert.equal(
        serverMod.shouldSeedAuthCookie({
          currentToken: null,
          apiToken: "tok",
          remoteAddress: "203.0.113.7",
          authTokenQuery: undefined,
        }),
        false,
      );
    });

    it("does NOT seed for a non-loopback peer with a WRONG ?auth_token= value", () => {
      assert.equal(
        serverMod.shouldSeedAuthCookie({
          currentToken: null,
          apiToken: "tok",
          remoteAddress: "203.0.113.7",
          authTokenQuery: "wrong-value",
        }),
        false,
      );
    });

    it("SEEDS for a non-loopback peer with the EXACT ?auth_token= match (remote-operator path)", () => {
      assert.equal(
        serverMod.shouldSeedAuthCookie({
          currentToken: null,
          apiToken: "tok",
          remoteAddress: "203.0.113.7",
          authTokenQuery: "tok",
        }),
        true,
      );
    });

    it("is a no-op when the cookie already equals apiToken, regardless of peer", () => {
      assert.equal(
        serverMod.shouldSeedAuthCookie({
          currentToken: "tok",
          apiToken: "tok",
          remoteAddress: "203.0.113.7",
          authTokenQuery: "tok",
        }),
        false,
      );
    });
  });

  // ── 5. WS Origin fence (real /live socket) ───────────────────────────────────────────────────
  // The server-side reject happens INSIDE the wss.on("connection") handler (after the WS handshake
  // completes — the `ws` library gives no pre-handshake hook without noServer mode, matching the
  // recon's documented pre-existing exposure), so a rejected client sees 'open' fire and THEN an
  // immediate server-initiated 'close' with code 4003 — it never sees a promise-rejecting handshake
  // failure. Race 'open' vs 'close' and assert on the terminal state instead of assuming rejection.
  describe("WS Origin fence on /live", () => {
    type ConnectOutcome = { openedFirst: boolean; closeCode: number | null };

    const connect = (opts: { origin?: string } = {}): Promise<ConnectOutcome> => {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${wsBase}/live?observe=1`, {
          headers: { Cookie: `auth_token=${apiToken}` },
          origin: opts.origin,
        });
        sockets.push(ws);
        let openedFirst = false;
        const timer = setTimeout(() => reject(new Error("connect() timed out waiting for open/close")), 3000);
        ws.on("open", () => { openedFirst = true; });
        ws.on("close", (code) => {
          clearTimeout(timer);
          resolve({ openedFirst, closeCode: code });
        });
        ws.on("error", () => { /* surfaced via the close/timeout path above */ });
      });
    };

    it("rejects a cross-host Origin BEFORE the cookie check (valid cookie, wrong Origin still closes 4003)", async () => {
      const outcome = await connect({ origin: "https://evil.example" });
      assert.equal(outcome.closeCode, 4003);
    });

    it("accepts a same-host Origin (matches the request Host header) — connection stays open", async () => {
      const ws = new WebSocket(`${wsBase}/live?observe=1`, {
        headers: { Cookie: `auth_token=${apiToken}` },
        origin: base,
      });
      sockets.push(ws);
      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
        ws.on("close", (code, reason) => reject(new Error(`unexpected close ${code} ${reason.toString()}`)));
      });
      assert.equal(ws.readyState, WebSocket.OPEN);
    });

    it("accepts an ABSENT Origin with a valid cookie (existing non-browser client behavior, unchanged)", async () => {
      const ws = new WebSocket(`${wsBase}/live?observe=1`, {
        headers: { Cookie: `auth_token=${apiToken}` },
      });
      sockets.push(ws);
      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
        ws.on("close", (code, reason) => reject(new Error(`unexpected close ${code} ${reason.toString()}`)));
      });
      assert.equal(ws.readyState, WebSocket.OPEN);
    });
  });
});
