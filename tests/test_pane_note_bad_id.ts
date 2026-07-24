// BUG-029 (FIXED — this is a REGRESSION PIN, expected GREEN immediately).
//
// add_pane_note with an EXPLICIT stale/typo'd pane_id must narrate a 'not found' failure and write NO
// orphan note. addPaneNote returns StoredNote|null (null when the pane row is missing —
// src/store/sqliteStore.ts), and the handler (src/actions/defs/notes.ts:214-219) narrates
// "Could not add note: pane <id> not found ..." and only broadcasts/persists on success. Validation F
// recorded a TEST-ONLY gap: no explicit-bad-pane_id case. This pins it.
//
// Drives the REAL server voice path (add_pane_note is a voice-surface tool) via the notes-recall
// harness idiom (installMockLive + session.emitToolCall + mock.responseFor).
//
// Runner: npx tsx --test --test-force-exit tests/test_pane_note_bad_id.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";
import type { MockLiveHandle, MockLiveSession } from "./helpers/mockLive";
import { teardownServerSuite } from "./helpers/teardown";
import type { RunningServer } from "../server";

describe("BUG-029 — add_pane_note with a bad pane_id refuses and writes no orphan (regression pin)", () => {
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

  const PROJECT = "p_bug029";

  const api = (pathname: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${base}${pathname}`, {
      ...init,
      headers: { "x-api-token": apiToken, "content-type": "application/json", ...(init.headers || {}) },
    });

  const store = () => running.manager.ledger as any;

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";
    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-note-badid-"));
    process.chdir(tmpDir);

    ({ installMockLive, waitFor } = await import("./helpers/mockLive"));
    const serverMod = await import("../server");
    startServer = serverMod.startServer;
    apiToken = serverMod.API_AUTH_TOKEN;

    mock = installMockLive();
    running = await startServer({ port: 0, enableVite: false });
    base = `http://127.0.0.1:${running.port}`;
    client = new WebSocket(`ws://127.0.0.1:${running.port}/live`, { headers: { Cookie: `auth_token=${apiToken}` } });
    await new Promise<void>((resolve, reject) => { client.on("open", () => resolve()); client.on("error", reject); });
    session = await waitFor(() => mock.latest());

    // A real, ACTIVE project so projectId resolves — but we deliberately never seed the target pane
    // row, so the failure is unambiguously the (stale/typo'd) PANE lookup, not a missing project.
    await api("/api/projects", { method: "POST", body: JSON.stringify({ id: PROJECT, directory: ".", summary: "", keyTerms: [] }) });
    await api(`/api/projects/${PROJECT}/switch`, { method: "POST" });
  });

  after(async () => {
    if (client && client.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => { client.once("close", () => resolve()); try { client.terminate(); } catch { resolve(); } });
    }
    await teardownServerSuite(running);
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("narrates 'not found' and persists no note when pane_id is a stale/typo'd id", async () => {
    const before = store().getNotes({ projectId: PROJECT }).length;

    const callId = session.emitToolCall("add_pane_note", {
      project_id: PROJECT,
      pane_id: "ghost_pane_typo",
      note: "this must not become an orphan note",
    });
    const out: any = await waitFor(() => mock.responseFor(callId));

    assert.ok(/not found/i.test(String(out)), `bad pane_id -> 'not found' narration, got: ${JSON.stringify(out)}`);

    const after = store().getNotes({ projectId: PROJECT });
    assert.strictEqual(after.length, before, "no note row was written for the bad pane");
    assert.ok(!after.some((n: any) => n.text === "this must not become an orphan note"), "the orphan note text is absent from the store");
  });
});
