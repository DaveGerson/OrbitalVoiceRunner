// tests/test_failure_injection_persist_reimport.ts — bead res5, injection family (c): a full server
// stop -> a fresh server boot on the SAME ledger -> durable state round-trips.
//
// THE GENUINE GAP (recon): every existing "persist + re-import" suite (tests/test_boot_recovery_summary.ts,
// tests/test_resumption_server_roundtrip.ts, tests/test_restore_respawn.ts) is either a single cold boot
// against a store SEEDED by a second raw JanusStore handle, or an in-process reconnect within ONE
// server instance — never a literal "server A was up, took durable writes, died WITHOUT a clean
// shutdown, and server B boots against the exact same .janus.db and must reconcile everything."
//
// server.ts's `manager`/`store`/`API_AUTH_TOKEN` are constructed ONCE at module top-level import, so a
// plain `await import("../server")` a second time in the SAME test file returns the SAME cached module
// (same manager/store) — not a second boot. The fix (verified empirically before writing this suite,
// mirroring the PLM4/QW3 "await import" idiom): a CACHE-BUSTED dynamic import (`../server?fi=<unique>`)
// forces Node's ESM loader to re-evaluate server.ts's top-level module body from scratch — a genuine
// second `initStoreWithQuarantine` + `new OrchestratorManager({ledger: store})` against the SAME
// on-disk JANUS_DB path (SQLite WAL mode allows the sequential JanusStore handles). This is the
// in-process analogue of "kill the process, boot a fresh one" the recon flagged the true OS-process
// variant of as expensive/flaky to require on Windows CI — this suite gets the same ledger-durability
// proof without spawning a second OS process.
//
// Four durable categories are seeded on server A (one of each NEVER cleanly resolved before "death"),
// then asserted to round-trip on server B:
//   1. A pending COMMAND approval (PendingApprovalStore — WS-F durable rows).
//   2. A deferred NON-PTY action (PendingActionStore — kzt hydration). Staged via a VOICE toolCall
//      (set_global_permissions, capability defaults to Ask) — deliberately NOT a REST-staged deferral:
//      REST action-context construction never stamps ctx.versionStamp (src/actions/rest.ts has no
//      versionStamp wiring), so a REST-originated intent's persisted params carry no {actionName,
//      schemaHash} and checkActionVersion (src/actionEffects.ts) QUARANTINES it on rehydrate instead of
//      restaging it — a real product asymmetry, not a bug this TESTS-only bead may paper over. The
//      voice path (src/voice/index.ts buildActionContext) DOES stamp versionStamp, so it is the
//      currently-supported way to durably round-trip a deferred action; that is what this suite proves.
//      Server B doesn't just LIST it — POST .../confirm proves the REHYDRATED `run` closure actually
//      executes the real effect (not just cosmetic).
//   3. A pane that was "alive" when server A died (never cleanly stopped) — server B's boot-time
//      reconcilePanesInert flips it inert (res2/res3) instead of leaving a stale "Running" ledger row.
//   4. res3's boot-recovery summary — server B's boot pushes the "N panes were running before this
//      restart" attention item naming that same pane.
//
// Runner: npx tsx --test --test-force-exit tests/test_failure_injection_persist_reimport.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";
import { teardownServerSuite } from "./helpers/teardown";
import type { RunningServer } from "../server";
import type { JanusStore } from "../src/store/sqliteStore";
import type { StoredPane } from "../src/store/types";

interface FakeSession {
  params: any;
  responses: any[];
  emit: (m: any) => void;
  emitToolCall: (name: string, args?: Record<string, any>, id?: string) => string;
  sendToolResponse: (r: any) => void;
  sendRealtimeInput: (i: any) => void;
  sendClientContent: (c: any) => void;
  close: () => void;
}

function makeFakeSession(params: any): FakeSession {
  let counter = 0;
  return {
    params,
    responses: [],
    emit(m: any) { params?.callbacks?.onmessage?.(m); },
    emitToolCall(name: string, args: Record<string, any> = {}, id?: string) {
      const callId = id ?? `fi-c-call-${++counter}`;
      this.emit({ toolCall: { functionCalls: [{ name, id: callId, args }] } });
      return callId;
    },
    sendToolResponse(r: any) { this.responses.push(r); },
    sendRealtimeInput() {},
    sendClientContent() {},
    close() {},
  };
}

function makeScriptedConnector() {
  const sessions: FakeSession[] = [];
  const connector = async (_ai: any, params: any) => {
    const s = makeFakeSession(params);
    sessions.push(s);
    return s;
  };
  return { connector, sessions };
}

async function waitFor<T>(p: () => T | undefined | false | null, timeoutMs = 4000, intervalMs = 15): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = p();
    if (v) return v as T;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function openClient(running: RunningServer, apiToken: string, sink: any[]): Promise<WebSocket> {
  const client = new WebSocket(`ws://127.0.0.1:${running.port}/live`, {
    headers: { Cookie: `auth_token=${apiToken}` },
  });
  client.on("message", (data) => { try { sink.push(JSON.parse(data.toString())); } catch { /* non-JSON */ } });
  await new Promise<void>((resolve, reject) => {
    client.on("open", () => resolve());
    client.on("error", reject);
  });
  return client;
}

async function closeClient(client: WebSocket): Promise<void> {
  if (client.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    client.once("close", () => resolve());
    try { client.close(); } catch { resolve(); }
  });
}

function paneRow(id: string, workspaceId: string): StoredPane {
  return {
    pane_id: id, workspace_id: workspaceId, name: id, runtime_type: "interactive_cli",
    tool_preset: "Claude Code", permissions_mode: "Human-in-the-Loop", session_id: "",
    last_known_state: "Running", is_busy: true, alive: true, context_size: 0,
    last_status_change_at: null, last_command: null, scrollback_path: null,
    created_at: 0, updated_at: 0,
  };
}

describe("res5(c): full server stop -> fresh boot on the same ledger — durable state round-trips", () => {
  let tmpDir: string;
  let dbPath: string;
  let prevCwd: string;
  let running1: RunningServer | undefined;
  let running2: RunningServer | undefined;
  let mod1: typeof import("../server");
  let mod2: typeof import("../server");
  let client1: WebSocket | undefined;
  const messageId = "fi-c-survivor-1";
  let deferredActionId: string;

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";
    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-persist-reimport-"));
    dbPath = path.join(tmpDir, "reimport.db");
    process.env.JANUS_DB = dbPath;
    process.chdir(tmpDir);
  });

  after(async () => {
    if (client1) await closeClient(client1);
    await teardownServerSuite(running1);
    await teardownServerSuite(running2);
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("server A: stage a survivor approval, a deferred voice action, and an unclean-alive pane", async () => {
    mod1 = await import(`../server?fi-a-${Date.now()}`);
    const scripted = makeScriptedConnector();
    mod1.setLiveConnector(scripted.connector);
    running1 = await mod1.startServer({ port: 0, enableVite: false });
    const base1 = `http://127.0.0.1:${running1.port}`;
    const headers1 = { "x-api-token": mod1.API_AUTH_TOKEN, "content-type": "application/json" };

    // (1) A pending command approval, durable, with NO live session — exactly the shape a survivor
    // has the instant the process dies (already detached; PendingApprovalStore.add(record, null, ...)
    // is the same durable-row path detachSession leaves behind, see src/pendingApprovals.ts).
    const approvals = running1._testPendingApprovals!();
    approvals.add(
      {
        messageId,
        instruction: "npm run release",
        kind: "shell",
        terminalId: "fi-c-pane",
        callId: messageId,
        timestamp: Date.now(),
      } as any,
      null,
      { workspaceId: "default_project", ttlMs: 5 * 60 * 1000 },
    );
    const preRes = await fetch(`${base1}/api/commands/pending`, { headers: headers1 });
    const pre = await preRes.json();
    assert.ok((pre.pending ?? pre).some((p: any) => p.messageId === messageId), "the survivor approval is listed on server A before death");

    // (2) A deferred set_global_permissions action, staged over a REAL voice toolCall (capability
    // set_global_permissions defaults to Ask — see file header for why voice, not REST).
    client1 = await openClient(running1, mod1.API_AUTH_TOKEN, []);
    const session0 = await waitFor(() => scripted.sessions[scripted.sessions.length - 1]);
    await waitFor(() => running1!._testActiveLiveSession!() === session0);
    session0.emitToolCall("set_global_permissions", { permissions_mode: "Read-Only" }, "fi-c-perm-call");
    await waitFor(() => session0.responses.length >= 1);
    assert.match(
      String(session0.responses[0]?.functionResponses?.[0]?.response?.output ?? ""),
      /needs operator confirmation/i,
      "set_global_permissions deferred (Ask), did not run immediately",
    );
    assert.notStrictEqual(running1.manager.globalPermissionsMode, "Read-Only", "the effect has NOT applied yet — only staged");

    const pendingActionsRes = await fetch(`${base1}/api/actions/pending`, { headers: headers1 });
    const pendingActions = await pendingActionsRes.json();
    const staged = pendingActions.find((a: any) => a.capability === "set_global_permissions");
    assert.ok(staged, "the deferred set_global_permissions action is listed on server A");
    deferredActionId = staged.id;

    // (3) A pane that is "alive" in the ledger but was NEVER registered as a live term (never
    // gracefully stopped by running1.close()) — models the operator's pane still running when the
    // whole process died uncleanly.
    (running1.manager.ledger as JanusStore).savePane(paneRow("fi-c-pane", "default_project"));
    const proj1 = running1.manager.ledger.getProject("default_project")!;
    assert.strictEqual(proj1.panes["fi-c-pane"].alive, true, "the pane is alive in the ledger before server A dies");

    // Server A "dies": close() does NOT touch this pane (it was never in manager.terminals) and does
    // NOT close the JanusStore (a process-wide singleton by design — see server.ts's comment near its
    // `process.once("exit", ...)` handler) — an unclean death, exactly what this suite needs.
    await closeClient(client1);
    client1 = undefined;
    await running1.close();
  });

  it("server B: a fresh boot on the SAME ledger round-trips all four durable categories", async () => {
    mod2 = await import(`../server?fi-b-${Date.now()}_${Math.random()}`);
    assert.notStrictEqual(mod2, mod1, "the cache-busted import re-evaluated server.ts (a genuine second boot)");
    running2 = await mod2.startServer({ port: 0, enableVite: false });
    assert.notStrictEqual(running2.manager, running1!.manager, "server B constructed a FRESH OrchestratorManager, not the reused singleton");
    const base2 = `http://127.0.0.1:${running2.port}`;
    const headers2 = { "x-api-token": mod2.API_AUTH_TOKEN, "content-type": "application/json" };

    // (1) The survivor approval round-tripped — a fresh PendingApprovalStore rehydrated it from the
    // durable row with no live session attached.
    const approvals2 = running2._testPendingApprovals!();
    assert.strictEqual(approvals2.sessionFor(messageId), undefined, "rehydrated with no live session (as expected for a dead-process survivor)");
    const pendingRes = await fetch(`${base2}/api/commands/pending`, { headers: headers2 });
    const pending = await pendingRes.json();
    assert.ok((pending.pending ?? pending).some((p: any) => p.messageId === messageId), "the survivor approval round-tripped onto server B over REST");

    // (2) The deferred set_global_permissions action round-tripped AND is genuinely re-confirmable —
    // the rehydrated `run` closure (kzt hydration, src/gating/index.ts hydrateDeferredActions) actually
    // executes the real effect, not just a cosmetic listing.
    const pendingActionsRes = await fetch(`${base2}/api/actions/pending`, { headers: headers2 });
    const pendingActions = await pendingActionsRes.json();
    const rehydrated = pendingActions.find((a: any) => a.id === deferredActionId);
    assert.ok(rehydrated, "the deferred set_global_permissions action round-tripped onto server B");
    assert.strictEqual(rehydrated.capability, "set_global_permissions");
    assert.notStrictEqual(running2.manager.globalPermissionsMode, "Read-Only", "the effect still has not run on server B before confirm");

    const confirmRes = await fetch(`${base2}/api/actions/${deferredActionId}/confirm`, { method: "POST", headers: headers2 });
    assert.strictEqual(confirmRes.status, 200);
    const confirmBody = await confirmRes.json();
    assert.strictEqual(confirmBody.success, true, "the rehydrated action confirms successfully");
    assert.strictEqual(running2.manager.globalPermissionsMode, "Read-Only", "confirming the REHYDRATED action ran the REAL effect");

    // (3) The unclean-alive pane was reconciled to inert on server B's boot (res2/res3), not left as
    // a stale "Running" row nobody will ever revisit.
    const proj2 = running2.manager.ledger.getProject("default_project")!;
    assert.strictEqual(proj2.panes["fi-c-pane"].alive, false, "the pane was flipped inert on server B's boot");
    assert.strictEqual(proj2.panes["fi-c-pane"].last_known_state, "Exited", "the pane's durable state is Exited, not a stale Running");
    const terminalsRes = await fetch(`${base2}/api/terminals`, { headers: headers2 });
    assert.deepStrictEqual(await terminalsRes.json(), [], "nothing auto-spawned on server B's boot despite the previously-alive pane");

    // (4) res3's boot-recovery summary named the pane over the real REST attention endpoint.
    const attentionRes = await fetch(`${base2}/api/attention`, { headers: headers2 });
    const attention = await attentionRes.json();
    const recovery = attention.filter((it: any) => /before this restart/.test(it.message));
    assert.strictEqual(recovery.length, 1, "exactly one boot-recovery summary item on server B");
    assert.match(recovery[0].message, /fi-c-pane/, "the boot-recovery summary names the previously-alive pane");
  });
});
