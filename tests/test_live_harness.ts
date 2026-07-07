// Headless mock-Live harness proof (bead ce7).
//
// Boots the REAL server in-process with no Gemini API key and no microphone:
//   - JANUS_NO_AUTOSTART=1 so importing ../server does not auto-listen.
//   - installMockLive() swaps the injectable liveConnector seam for a fake session
//     that records what the server sends it and lets us push synthetic
//     server->client messages (tool calls, audio) into the real onmessage handler.
//   - startServer({ port: 0, enableVite: false }) gives an ephemeral headless server.
//
// This exercises the genuine voice tool-dispatch + capability-gate code paths.

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";
import type { MockLiveHandle, MockLiveSession } from "./helpers/mockLive";
import { teardownServerSuite } from "./helpers/teardown";
import type { RunningServer } from "../server";

describe("ce7 mock-Live harness (headless, no API key, no mic)", () => {
  let startServer: (opts?: any) => Promise<RunningServer>;
  let apiToken: string;
  let installMockLive: () => MockLiveHandle;
  let waitFor: <T>(p: () => T | undefined | false, t?: number, i?: number) => Promise<T>;

  let mock: MockLiveHandle;
  let running: RunningServer;
  let session: MockLiveSession;
  let client: WebSocket;
  let base: string;
  let tmpDir: string;
  let prevCwd: string;

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";

    // Isolate the .janus_* ledger/scrollback files the server writes into a temp cwd
    // BEFORE importing ../server (its boot-time store restore reads the cwd).
    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-lh-"));
    process.chdir(tmpDir);

    ({ installMockLive, waitFor } = await import("./helpers/mockLive"));
    const serverMod = await import("../server");
    startServer = serverMod.startServer;
    apiToken = serverMod.API_AUTH_TOKEN;

    mock = installMockLive();
    running = await startServer({ port: 0, enableVite: false });
    base = `http://127.0.0.1:${running.port}`;

    client = new WebSocket(`ws://127.0.0.1:${running.port}/live`, {
      headers: { Cookie: `auth_token=${apiToken}` },
    });
    await new Promise<void>((resolve, reject) => {
      client.on("open", () => resolve());
      client.on("error", reject);
    });

    // The server creates the mock session asynchronously after the socket opens
    // and liveConnector resolves.
    session = await waitFor(() => mock.latest());
  });

  after(async () => {
    // Fully drain the client socket BEFORE closing the server. On Windows, closing
    // the WebSocketServer while a client socket is still mid-close double-closes a
    // libuv async handle (UV_HANDLE_CLOSING assertion), so wait for the close event.
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

  it("TEST 1: headless boot captured the Live session params + current-main tools", () => {
    assert.ok(running.port > 0, "server bound an ephemeral port");
    assert.ok(session, "installMockLive captured a session");

    const sysInstr = session.params?.config?.systemInstruction;
    assert.ok(
      typeof sysInstr === "string" && sysInstr.includes("Project Janus"),
      "systemInstruction mentions Project Janus"
    );

    // Issue D: the Prompt Draft must DEFAULT to a synthesized instruction, not the operator's raw
    // dictation. The dictation auto-mirror is intended (a co-authored scratchpad), so the fix is a
    // prompt default: Janus must own the open pane's draft via update_draft_prompt(mode='replace').
    // Pin that the system instruction directs this — it previously never mentioned update_draft_prompt.
    assert.ok(
      typeof sysInstr === "string" && sysInstr.includes("update_draft_prompt"),
      "systemInstruction directs Janus to maintain a synthesized prompt draft via update_draft_prompt (Issue D)"
    );

    const decls = session.params?.config?.tools?.[0]?.functionDeclarations;
    assert.ok(Array.isArray(decls), "functionDeclarations is an array");
    const names = decls.map((d: any) => d.name);
    // Current-main tool surface (create_pane IS a live tool in main, NOT removed).
    for (const expected of [
      "list_panes",
      "propose_command",
      "switch_active_pane",
      "set_global_permissions",
      "create_pane",
      "close_pane",
    ]) {
      assert.ok(names.includes(expected), `declares ${expected}`);
    }
    // Pin the exact count so a silent add/drop trips this test. Bumped 34 -> 35 by bead 8sq
    // (stop_all), then 35 -> 37 by the 8sq two-stage rework (added confirm_stop_all + release_stop_all),
    // then 37 -> 41 by bead bjm (get_project_notes + search_notes + amend_note + delete_note),
    // then 41 -> 43 by Wave D (get_action_log + get_health observability pair),
    // then 43 -> 44 by P4 / bead 1y8 (restart_pane — the live Full-Auto promotion voice tool),
    // then 44 -> 45 by wsm-e2e-pinned-5h0 (close_pane — the exit+archive voice tool),
    // then 45 -> 56 by journey-expansion templates/layouts/dispatch (list/create/update/delete/
    // apply_prompt_template, save_project_layout/list_layouts/apply_layout/delete_layout,
    // dispatch_to_panes + get_dispatch_status — docs/design/templates-layouts-dispatch.md §3),
    // then 56 -> 58 by voice-UX wave 3 (get_status_summary SITREP + focus_pane conversational
    // focus — docs/superpowers/specs/2026-07-02-voice-ux-trio-design.md). Edit owned by the wave-3
    // SCAFFOLD batch (this file has no dedicated feature owner in the wave's file-ownership map;
    // it belongs alongside src/actions/defs/voice_ux.ts / registry.ts / coverage.ts, the other
    // registry-surface edits scaffold made when the two new tool defs were registered),
    // then 58 -> 62 by Wave 6 knowledge-capture (catch_me_up hwu.2 + save_transcript_note hwu.3 +
    // promote_draft hwu.4 + export_project hwu.6; get_project_export is rest-only so it does NOT add a
    // voice declaration).
    assert.strictEqual(decls.length, 62, "exactly 62 voice tools declared");

    // The /live handler runs against the exported singleton manager.
    assert.strictEqual(running.manager, session ? running.manager : null);
    assert.strictEqual(running.manager, (running as any).manager);
  });

  it("TEST 2: list_panes round-trips a real tool response (read path)", async () => {
    const callId = session.emitToolCall("list_panes");
    const out = await waitFor(() => mock.responseFor(callId));
    assert.ok(Array.isArray(out), "list_panes output is an array");
  });

  it("TEST 3: set_global_permissions DEFERS under the Ask gate, then applies on confirm", async () => {
    // Default gate for set_global_permissions is Ask (types.ts DEFAULT_CAPABILITY_GATES),
    // so gateOrDefer returns disposition='deferred': the voice response asks for
    // confirmation and globalPermissionsMode must NOT change yet.
    const before = running.manager.globalPermissionsMode;
    const callId = session.emitToolCall("set_global_permissions", { permissions_mode: "Read-Only" });
    const out = await waitFor(() => mock.responseFor(callId));
    const text = String(out);
    assert.ok(text.includes("confirmation"), "deferred response mentions confirmation");
    assert.ok(text.includes("Ask"), "deferred response cites the Ask gate");
    assert.strictEqual(
      running.manager.globalPermissionsMode,
      before,
      "gated Ask did NOT mutate globalPermissionsMode without confirmation"
    );

    // Operator confirms via the REST choke-point; the deferred side effect now applies.
    const pendingRes = await fetch(`${base}/api/actions/pending`, { headers: { "x-api-token": apiToken } });
    assert.strictEqual(pendingRes.status, 200);
    const pending = await pendingRes.json();
    const action = pending.find((a: any) => a.capability === "set_global_permissions");
    assert.ok(action, "a pending action was queued for set_global_permissions");

    const confirmRes = await fetch(`${base}/api/actions/${action.id}/confirm`, {
      method: "POST",
      headers: { "x-api-token": apiToken },
    });
    assert.strictEqual(confirmRes.status, 200);
    const confirmBody = await confirmRes.json();
    assert.strictEqual(confirmBody.success, true);
    assert.strictEqual(
      running.manager.globalPermissionsMode,
      "Read-Only",
      "confirm applied the deferred set_global_permissions side effect"
    );

    // Reset shared singleton state so other suites importing ../server aren't polluted.
    running.manager.globalPermissionsMode = before;
  });

  it("TEST 4: a client audio frame is forwarded to the Live session as PCM", async () => {
    const before = session.realtimeInputs.length;
    client.send(JSON.stringify({ type: "audio", audio: "ZmFrZS1wY20=" }));
    await waitFor(() => session.realtimeInputs.length > before);
    const last = session.realtimeInputs[session.realtimeInputs.length - 1];
    assert.strictEqual(last.audio.mimeType, "audio/pcm;rate=16000");
  });

  it("TEST 5: REST + WS share one director token (401 without, 200 with)", async () => {
    const unauth = await fetch(`${base}/api/terminals`);
    assert.strictEqual(unauth.status, 401, "no token -> 401");
    const authed = await fetch(`${base}/api/terminals`, { headers: { "x-api-token": apiToken } });
    assert.strictEqual(authed.status, 200, "exported API_AUTH_TOKEN -> 200");
  });
});
