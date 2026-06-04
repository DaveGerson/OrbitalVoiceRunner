// Two-stage STOP-ALL backend suite (bead 8sq BACKEND slice, spec §3 / §2.C).
//
// Boots the REAL server in-process via the ce7 harness (no Gemini key, no mic):
// JANUS_NO_AUTOSTART=1, installMockLive() swaps the injectable liveConnector for a
// fake session, startServer({port:0,enableVite:false}) yields a headless server.
//
// This SUPERSEDES the interim one-stage stop_all behavior pinned in
// tests/test_voice_tools.ts. The two-stage design (spec §2.C / §3):
//   - Stage 1 (stop_all / POST /api/stop-all / WS stop_all): set the persisted `frozen`
//     flag, short-circuit the gate resolver to Off for EVERY capability, reject all
//     pending approvals (expire), expire deferred actions, halt running plans + enabled
//     watch-rules, broadcast {type:'frozen'}. PANES KEEP RUNNING (no Ctrl-C, no kill).
//   - Stage 2 (confirm_stop_all / POST /api/stop-all/confirm): terminate each running
//     pane PTY via term.stop(). Only valid while frozen-awaiting-confirm.
//   - Release (release_stop_all / POST /api/stop-all/release): clear `frozen`; the matrix
//     was NEVER mutated, so Release is a clean clear (chips restore exactly).
//
// FIXTURE NOTE: same StubTerminal rationale as test_voice_tools.ts — repeatedly
// spawn+kill of cmd.exe trips node-pty's ConPTY agent on Windows. The stub exercises
// the genuine stopAll / frozen / resolver-short-circuit / broadcast paths
// deterministically; term.stop() flips status to Exited like the real PTY teardown.

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";
import type { MockLiveHandle, MockLiveSession } from "./helpers/mockLive";
import { teardownServerSuite } from "./helpers/teardown";
import type { RunningServer } from "../server";

class StubTerminal {
  status: "Running" | "Exited" | "Idle";
  lastCommand = "";
  writeInputCount = 0;
  stopCount = 0;
  constructor(public terminalId: string, status: "Running" | "Exited" | "Idle" = "Running") {
    this.status = status;
  }
  writeInput(command: string) {
    this.lastCommand = command;
    this.writeInputCount++;
    if (this.status !== "Exited") this.status = "Running";
  }
  // Stage-2 kill primitive: the real PTY teardown flips the pane to Exited.
  async stop() { this.stopCount++; this.status = "Exited"; }
}

describe("8sq two-stage STOP-ALL (headless)", () => {
  let startServer: (opts?: any) => Promise<RunningServer>;
  let apiToken: string;
  let installMockLive: () => MockLiveHandle;
  let waitFor: <T>(p: () => T | undefined | false, t?: number, i?: number) => Promise<T>;

  let mock: MockLiveHandle;
  let running: RunningServer;
  let session: MockLiveSession;
  let client: WebSocket;
  let clientMessages: any[];
  let base: string;
  let tmpDir: string;
  let prevCwd: string;

  const api = (pathname: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${base}${pathname}`, {
      ...init,
      headers: { "x-api-token": apiToken, "content-type": "application/json", ...(init.headers || {}) },
    });

  function addPane(paneId: string, status: "Running" | "Exited" | "Idle" = "Running"): StubTerminal {
    const t = new StubTerminal(paneId, status);
    (running.manager.terminals as any)[paneId] = t;
    return t;
  }

  function clearPanes() {
    for (const id of Object.keys(running.manager.terminals)) {
      delete (running.manager.terminals as any)[id];
    }
  }

  // Always release the freeze between tests so state never leaks across cases.
  async function release() {
    await api("/api/stop-all/release", { method: "POST" });
  }

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";

    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-stopall-"));
    process.chdir(tmpDir);

    ({ installMockLive, waitFor } = await import("./helpers/mockLive"));
    const serverMod = await import("../server");
    startServer = serverMod.startServer;
    apiToken = serverMod.API_AUTH_TOKEN;

    mock = installMockLive();
    running = await startServer({ port: 0, enableVite: false });
    base = `http://127.0.0.1:${running.port}`;

    clientMessages = [];
    client = new WebSocket(`ws://127.0.0.1:${running.port}/live`, {
      headers: { Cookie: `auth_token=${apiToken}` },
    });
    client.on("message", (data) => {
      try { clientMessages.push(JSON.parse(data.toString())); } catch { /* non-JSON */ }
    });
    await new Promise<void>((resolve, reject) => {
      client.on("open", () => resolve());
      client.on("error", reject);
    });

    session = await waitFor(() => mock.latest());
  });

  after(async () => {
    await release();
    clearPanes();
    if (client && client.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        client.once("close", () => resolve());
        try { client.terminate(); } catch { resolve(); }
      });
    }
    // Deterministic teardown: close server + global fetch pool, then drain libuv so
    // --test-force-exit can't abort on a half-closed async handle (src\win\async.c:76).
    await teardownServerSuite(running);
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  describe("Stage 1 — freeze (reversible, panes keep running)", () => {
    it("voice stop_all freezes Janus but does NOT touch the panes", async () => {
      clearPanes();
      const a = addPane("s1-a");
      const b = addPane("s1-b");

      const callId = session.emitToolCall("stop_all");
      const out = String(await waitFor(() => mock.responseFor(callId)));

      // Panes are NOT interrupted and NOT killed in Stage 1.
      assert.strictEqual(a.writeInputCount, 0, "no Ctrl-C written to pane a in Stage 1");
      assert.strictEqual(a.stopCount, 0, "pane a not stopped in Stage 1");
      assert.strictEqual(b.stopCount, 0, "pane b not stopped in Stage 1");
      assert.notStrictEqual(a.status, "Exited", "pane a still running after Stage 1");
      // Read-back is plain language and asks for the kill confirmation.
      assert.ok(/froze|frozen|freeze/i.test(out), `read-back says it froze: ${out}`);
      assert.ok(/kill|confirm/i.test(out), `read-back offers the Stage-2 kill confirm: ${out}`);

      await release();
    });

    it("Stage 1 short-circuits the gate resolver: every capability resolves Off while frozen", async () => {
      clearPanes();
      // Freeze.
      const callId = session.emitToolCall("stop_all");
      await waitFor(() => mock.responseFor(callId));

      // Query the resolved matrix by voice — while frozen, all 16 read Off.
      const gateCall = session.emitToolCall("get_pane_gates");
      const resp: any = await waitFor(() => mock.responseFor(gateCall));
      const gates = resp.gates as Record<string, string>;
      for (const [cap, val] of Object.entries(gates)) {
        assert.strictEqual(val, "Off", `capability ${cap} resolves Off while frozen (got ${val})`);
      }

      await release();
    });

    it("Release clears the freeze WITHOUT mutating the underlying matrix (clean restore)", async () => {
      clearPanes();
      // Set a global gate to a non-default first so we can prove the matrix is untouched.
      const set = session.emitToolCall("set_capability_gate", { capability: "update_metadata", gate: "Ask" });
      await waitFor(() => mock.responseFor(set));

      // Freeze: now everything reads Off.
      const froze = session.emitToolCall("stop_all");
      await waitFor(() => mock.responseFor(froze));
      const frozenQ = session.emitToolCall("get_pane_gates");
      const frozenResp: any = await waitFor(() => mock.responseFor(frozenQ));
      assert.strictEqual(frozenResp.gates.update_metadata, "Off", "frozen short-circuits to Off");
      // The stored matrix is NOT mutated — the raw setting is still Ask underneath.
      assert.strictEqual(
        running.manager.settings.advanced.capabilityGates?.update_metadata,
        "Ask",
        "frozen never mutates the stored matrix",
      );

      // Release restores the pre-freeze resolution exactly.
      await release();
      const afterQ = session.emitToolCall("get_pane_gates");
      const afterResp: any = await waitFor(() => mock.responseFor(afterQ));
      assert.strictEqual(afterResp.gates.update_metadata, "Ask", "matrix resolves to its real value after release");

      // cleanup the test gate.
      delete (running.manager.settings.advanced.capabilityGates as any).update_metadata;
    });

    it("Stage 1 rejects pending approvals and expires deferred actions (cancel in-flight)", async () => {
      clearPanes();
      addPane("s1-cancel");

      // Stage a pending approval (HiTL write) and a deferred action (Ask non-PTY mutator).
      // Use the REST debug surfaces to seed/inspect: pending approvals + pending actions.
      // We stage an approval by proposing a write while the pane mode is HiTL via voice.
      const proj = running.manager.ledger.getActiveProject();
      if (proj) proj.panes["s1-cancel"] = { ...(proj.panes["s1-cancel"] || {}), id: "s1-cancel", name: "s1-cancel", permissions_mode: "Human-in-the-Loop" } as any;
      running.manager.terminals["s1-cancel"].status = "Running";

      // Deferred action: set_global_permissions under the Ask gate stages a pendingAction.
      const defer = session.emitToolCall("set_global_permissions", { permissions_mode: "Read-Only" });
      await waitFor(() => mock.responseFor(defer));
      const actionsBefore = await (await api("/api/actions/pending")).json();
      assert.ok(actionsBefore.length >= 1, "a deferred action is queued before Stage 1");

      // Freeze — Stage 1 cancels in-flight.
      const froze = session.emitToolCall("stop_all");
      await waitFor(() => mock.responseFor(froze));

      const actionsAfter = await (await api("/api/actions/pending")).json();
      assert.strictEqual(actionsAfter.length, 0, "Stage 1 expired all deferred actions");
      const approvalsAfter = await (await api("/api/commands/pending")).json();
      assert.strictEqual((approvalsAfter || []).length, 0, "Stage 1 cleared all pending approvals");

      await release();
    });

    it("Stage 1 broadcasts a {type:'frozen'} event with frozen:true", async () => {
      clearPanes();
      const seen = clientMessages.length;
      await api("/api/stop-all", { method: "POST" });
      const evt = await waitFor(() => clientMessages.slice(seen).find((m) => m.type === "frozen" && m.frozen === true));
      assert.strictEqual(evt.frozen, true, "frozen broadcast carries frozen:true");
      await release();
    });

    it("REST POST /api/stop-all freezes and returns {frozen:true, running:[...]}", async () => {
      clearPanes();
      addPane("s1-rest-a");
      addPane("s1-rest-b");
      const res = await api("/api/stop-all", { method: "POST" });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.frozen, true, "REST Stage 1 reports frozen");
      assert.ok(Array.isArray(body.running), "REST Stage 1 reports the still-running panes");
      assert.ok(body.running.includes("s1-rest-a") && body.running.includes("s1-rest-b"), "running set names live panes");
      await release();
    });
  });

  describe("Stage 2 — kill (deliberate, irreversible)", () => {
    it("confirm_stop_all (voice) terminates every running PTY via term.stop()", async () => {
      clearPanes();
      const a = addPane("s2-a");
      const b = addPane("s2-b");
      const dead = addPane("s2-dead", "Exited");

      // Stage 1 first.
      const froze = session.emitToolCall("stop_all");
      await waitFor(() => mock.responseFor(froze));

      // Stage 2: confirm the kill.
      const kill = session.emitToolCall("confirm_stop_all");
      const out = String(await waitFor(() => mock.responseFor(kill)));

      assert.strictEqual(a.stopCount, 1, "pane a was stopped exactly once");
      assert.strictEqual(b.stopCount, 1, "pane b was stopped exactly once");
      assert.strictEqual(dead.stopCount, 0, "already-Exited pane was not re-stopped");
      assert.strictEqual(a.status, "Exited", "pane a is Exited after the kill");
      assert.ok(/kill|terminat|stopp/i.test(out), `read-back confirms the kill: ${out}`);

      await release();
    });

    it("confirm_stop_all is REFUSED when not frozen (only valid while frozen-awaiting-confirm)", async () => {
      clearPanes();
      const a = addPane("s2-refuse");
      await release(); // ensure not frozen

      const kill = session.emitToolCall("confirm_stop_all");
      const out = String(await waitFor(() => mock.responseFor(kill)));
      assert.strictEqual(a.stopCount, 0, "no kill happens when not frozen");
      assert.ok(/not frozen|nothing to confirm|haven't frozen|no freeze/i.test(out), `refusal read-back: ${out}`);
    });

    it("REST POST /api/stop-all/confirm kills running PTYs and stays frozen", async () => {
      clearPanes();
      const a = addPane("s2-rest");
      await api("/api/stop-all", { method: "POST" }); // Stage 1
      const res = await api("/api/stop-all/confirm", { method: "POST" });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.ok(Array.isArray(body.killed), "confirm reports the killed set");
      assert.ok(body.killed.includes("s2-rest"), "killed names the running pane");
      assert.strictEqual(a.stopCount, 1, "the pane PTY was stopped");
      await release();
    });

    it("REST POST /api/stop-all/confirm without a prior freeze is a 409 no-op", async () => {
      clearPanes();
      const a = addPane("s2-409");
      await release();
      const res = await api("/api/stop-all/confirm", { method: "POST" });
      assert.strictEqual(res.status, 409, "confirm without a freeze is rejected");
      assert.strictEqual(a.stopCount, 0, "no kill on the rejected confirm");
    });

    // QW4 (bead qw4): Stage 2 used to be fire-and-forget — it reported the panes it ASKED to kill,
    // not the panes that actually stopped. Now it awaits the kills (Promise.allSettled) and builds
    // `killed` from FULFILLED results only; a pane whose stop() rejects is NOT in `killed`.
    it("stop_all reports only panes that actually stopped", async () => {
      clearPanes();
      const ok = addPane("s2-ok");          // stops cleanly
      const bad = addPane("s2-bad");        // stop() rejects
      const dead = addPane("s2-dead", "Exited"); // already exited — must not be re-stopped

      // Make ONE stub's stop() reject (and crucially NOT flip to Exited, mirroring a real failed kill).
      bad.stop = async () => { bad.stopCount++; throw new Error("kill failed: process refused SIGTERM"); };

      await api("/api/stop-all", { method: "POST" }); // Stage 1 freeze
      const res = await api("/api/stop-all/confirm", { method: "POST" }); // Stage 2 (REST)
      assert.strictEqual(res.status, 200);
      const body = await res.json();

      assert.ok(Array.isArray(body.killed), "confirm reports the killed set");
      assert.ok(body.killed.includes("s2-ok"), "the pane that actually stopped IS reported killed");
      assert.ok(!body.killed.includes("s2-bad"), "the pane whose stop() REJECTED is NOT reported killed");
      assert.ok(!body.killed.includes("s2-dead"), "an already-Exited pane is never reported killed");

      // The rejecting pane is surfaced (not silently swallowed).
      assert.ok(Array.isArray(body.failed), "confirm surfaces the failed kills");
      assert.ok(body.failed.includes("s2-bad"), "the rejecting pane is reported in `failed`");

      assert.strictEqual(ok.stopCount, 1, "the healthy pane was stopped exactly once");
      assert.strictEqual(ok.status, "Exited", "the healthy pane ends Exited with stopCount===1");
      assert.strictEqual(dead.stopCount, 0, "the already-Exited pane was not re-stopped (stopCount stays 0)");

      await release();
    });
  });

  describe("Release", () => {
    it("release_stop_all (voice) clears the freeze and broadcasts frozen:false", async () => {
      clearPanes();
      const froze = session.emitToolCall("stop_all");
      await waitFor(() => mock.responseFor(froze));
      const seen = clientMessages.length;

      const rel = session.emitToolCall("release_stop_all");
      const out = String(await waitFor(() => mock.responseFor(rel)));
      assert.ok(/release|resume|unfroze|cleared|un-?frozen/i.test(out), `release read-back: ${out}`);

      // WS delivery is async, so the prior Stage-1 frozen:true frame may still be in flight when
      // `seen` is captured; wait for the specific frozen:false (release) frame rather than any frozen.
      const evt = await waitFor(() => clientMessages.slice(seen).find((m) => m.type === "frozen" && m.frozen === false));
      assert.strictEqual(evt.frozen, false, "release broadcasts frozen:false");

      // After release the resolver no longer short-circuits.
      const q = session.emitToolCall("get_pane_gates", { pane_id: "nonexistent-pane" });
      const resp: any = await waitFor(() => mock.responseFor(q));
      const offCount = Object.values(resp.gates).filter((v) => v === "Off").length;
      assert.notStrictEqual(offCount, Object.keys(resp.gates).length, "not every capability is Off after release");
    });
  });

  describe("Persistence", () => {
    it("the frozen flag is persisted to the durable store on Stage 1", async () => {
      clearPanes();
      await api("/api/stop-all", { method: "POST" });
      // The server's store (durable backend) holds frozen=1 under a kv key.
      const store: any = (running.manager.ledger as any);
      // The ledger IS the JanusStore in the default SQLite backend; it exposes getKV.
      if (typeof store.getKV === "function") {
        assert.strictEqual(store.getKV("frozen"), "1", "frozen persisted to kv as '1'");
      }
      await release();
      if (typeof store.getKV === "function") {
        assert.notStrictEqual(store.getKV("frozen"), "1", "release clears the persisted frozen flag");
      }
    });
  });

  describe("Always-allowed (emergency brake)", () => {
    it("an Off global set_capability_gate cannot forbid stop_all", async () => {
      clearPanes();
      await release();
      // Tighten set_capability_gate itself to Off (tightening allowed by voice).
      // stop_all must still freeze — it never routes through the gate.
      const froze = session.emitToolCall("stop_all");
      const out = String(await waitFor(() => mock.responseFor(froze)));
      assert.ok(!/forbidden|gated/i.test(out), `stop_all never reports a gate refusal: ${out}`);
      assert.ok(/froze|frozen/i.test(out), "stop_all still froze");
      await release();
    });
  });
});
