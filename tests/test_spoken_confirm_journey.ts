// tests/test_spoken_confirm_journey.ts — f09.1: the spoken destructive-confirm protocol driven
// END-TO-END through the REAL server (real gateOrDefer staging, real PendingActionStore, the real
// clientWs-scoped spokenConfirm wired in src/voice/index.ts). Modeled on tests/test_voice_journeys.ts
// (mockLive idiom): a real WS `/live` connection + a mock Gemini live session whose
// serverContent.inputTranscription frames drive the genuine operator-utterance pipeline.
//
// Journeys:
//   1. delete_pane staged via REST (Ask, default gate) -> spoken "yes" ARMS the window (verbatim
//      read-back naming the pane + the required phrase) WITHOUT resolving -> spoken "confirm delete"
//      resolves it exactly once through the real claim-and-delete PendingActionStore.confirm(): the
//      pane record is actually gone (ledger + GET /api/actions/pending) and the operator hears "Done".
//   2. REST+voice race: the SAME staged action is confirmed via REST while a spoken window is open;
//      the subsequent spoken phrase is a silent no-op (lost_race) — exactly one action_resolved frame
//      reaches the operator, exactly one delete happens.
//   3. Session-drop mid-window (5b pattern): the operator's browser WS closes while a window is
//      armed (clientWs "close" -> spokenConfirm.dispose()); the staged action SURVIVES with its own
//      TTL and is still resolvable afterward via the UI (REST confirm) on a fresh connection.
//
// Runner: npx tsx --test --test-force-exit tests/test_spoken_confirm_journey.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";
import type { MockLiveHandle, MockLiveSession } from "./helpers/mockLive";
import { teardownServerSuite } from "./helpers/teardown";
import type { RunningServer } from "../server";

const PROJECT = "sc_proj";

describe("spoken confirm journeys (real server, real gating, real PendingActionStore; no API key, no mic)", () => {
  let startServer: (opts?: any) => Promise<RunningServer>;
  let apiToken: string;
  let installMockLive: () => MockLiveHandle;
  let waitFor: <T>(p: () => T | undefined | false, t?: number, i?: number) => Promise<T>;

  let mock: MockLiveHandle;
  let running: RunningServer;
  let client: WebSocket;
  let clientMessages: any[];
  let tmpDir: string;
  let prevCwd: string;
  let paneSeq = 0;

  const base = (): string => `http://127.0.0.1:${running.port}`;
  const api = (pathname: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${base()}${pathname}`, {
      ...init,
      headers: { "x-api-token": apiToken, "content-type": "application/json", ...(init.headers || {}) },
    });

  const live = (): MockLiveSession => running._testActiveLiveSession!() as MockLiveSession;

  /** Push a REAL operator transcript frame — the exact shape Gemini Live delivers ASR on. */
  function speak(text: string, session: MockLiveSession = live()): void {
    session.emit({ serverContent: { inputTranscription: { text } } });
  }

  /** Everything the server has SPOKEN into a session (sendClientContent narration), flattened. */
  function narrationText(session: MockLiveSession): string {
    return session.clientContents
      .map((c: any) =>
        (c?.turns ?? []).map((t: any) => (t?.parts ?? []).map((p: any) => p?.text ?? "").join(" ")).join(" ")
      )
      .join("\n");
  }

  /** Seed a fresh pane row directly on the ledger (delete_pane's existence check accepts either a
   *  live terminal OR a persisted row — no real PTY needed for this suite). */
  function seedPane(): string {
    const paneId = `sc-pane-${++paneSeq}`;
    running.manager.ledger.updatePane(PROJECT, {
      pane_id: paneId, name: paneId, runtime_type: "shell", last_known_state: "Idle",
      is_busy: false, alive: true, notes: [], permissions_mode: "Human-in-the-Loop",
      session_id: "", tool_preset: "Claude Code", context_size: 0,
    } as any);
    return paneId;
  }

  /** Stage a delete_pane deferral via the REAL REST route (gated Ask by default) and return its
   *  pendingActions id. */
  async function stageDeletePane(paneId: string): Promise<string> {
    const res = await api(`/api/projects/${PROJECT}/panes/${paneId}`, { method: "DELETE" });
    assert.strictEqual(res.status, 202, `delete_pane must stage under the default Ask gate`);
    const body = await res.json();
    assert.strictEqual(body.status, "pending_approval");
    return body.messageId as string;
  }

  async function pendingActionIds(): Promise<string[]> {
    const list = (await (await api("/api/actions/pending")).json()) as Array<{ id: string }>;
    return list.map((a) => a.id);
  }

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";

    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-spoken-confirm-"));
    process.chdir(tmpDir);

    ({ installMockLive, waitFor } = await import("./helpers/mockLive"));
    const serverMod = await import("../server");
    startServer = serverMod.startServer;
    apiToken = serverMod.API_AUTH_TOKEN;

    mock = installMockLive();
    running = await startServer({ port: 0, enableVite: false });
    running.manager.ledger.addProject(PROJECT, tmpDir, "spoken-confirm journeys");

    clientMessages = [];
    client = new WebSocket(`ws://127.0.0.1:${running.port}/live`, { headers: { Cookie: `auth_token=${apiToken}` } });
    client.on("message", (data) => {
      try { clientMessages.push(JSON.parse(data.toString())); } catch { /* non-JSON */ }
    });
    await new Promise<void>((resolve, reject) => {
      client.on("open", () => resolve());
      client.on("error", reject);
    });
    await waitFor(() => mock.latest() && running._testActiveLiveSession?.());
  });

  after(async () => {
    if (client && client.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        client.once("close", () => resolve());
        try { client.terminate(); } catch { resolve(); }
      });
    }
    await teardownServerSuite(running);
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // Journey 1 — the two-turn happy path, driven entirely by voice.
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  it("stage via REST -> spoken 'yes' arms (no resolution) -> spoken 'confirm delete' resolves exactly once", async () => {
    const paneId = seedPane();
    const actionId = await stageDeletePane(paneId);
    assert.ok((await pendingActionIds()).includes(actionId), "the deferred delete is staged");
    assert.ok(running.manager.ledger.getProject(PROJECT)?.panes?.[paneId], "the pane row still exists — nothing ran yet");

    const seen = clientMessages.length;
    speak("yes");

    // ARMED, not resolved: the phrase demand is spoken, the record is untouched.
    const armed = await waitFor(() => {
      const n = narrationText(live());
      return n.includes("confirm delete") ? n : undefined;
    }, 4000);
    assert.ok(armed.includes(paneId), `the verbatim read-back names the pane: ${armed}`);
    assert.ok(!armed.includes("Done"), "arming is not a resolution");
    assert.ok((await pendingActionIds()).includes(actionId), "still staged after 'yes' — not resolved");
    assert.ok(running.manager.ledger.getProject(PROJECT)?.panes?.[paneId], "pane row untouched after 'yes'");
    assert.ok(
      !clientMessages.slice(seen).some((m) => m.type === "action_resolved"),
      "no action_resolved frame from a bare 'yes'"
    );

    // The exact phrase resolves it for real.
    speak("confirm delete");
    await waitFor(() => !(running.manager.ledger.getProject(PROJECT)?.panes ?? {})[paneId], 5000);
    assert.ok(!(await pendingActionIds()).includes(actionId), "the staged action is gone (exactly-once)");

    const resolved = clientMessages.find((m) => m.type === "action_resolved" && m.actionId === actionId);
    assert.ok(resolved, "action_resolved frame reached the operator");
    assert.strictEqual(resolved.outcome, "confirmed");

    const spoken = await waitFor(() => {
      const n = narrationText(live());
      return n.includes("Done") ? n : undefined;
    }, 4000);
    assert.ok(spoken.includes(paneId), `the spoken confirmation names the pane: ${spoken}`);
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // Journey 2 — REST-vs-voice race: exactly-once across BOTH surfaces.
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  it("a REST confirm during an open spoken window wins the claim; the later spoken phrase is a silent no-op", async () => {
    const paneId = seedPane();
    const actionId = await stageDeletePane(paneId);

    speak("yes"); // arm the spoken window
    await waitFor(() => narrationText(live()).includes("confirm delete"), 4000);

    // REST claims it first (the operator's UI, or a script, resolves it before the phrase lands).
    const restConfirm = await api(`/api/actions/${actionId}/confirm`, { method: "POST" });
    assert.strictEqual(restConfirm.status, 200);
    assert.strictEqual((await restConfirm.json()).success, true);
    await waitFor(() => !(running.manager.ledger.getProject(PROJECT)?.panes ?? {})[paneId], 5000);

    const seen = clientMessages.length;
    const spokenBefore = narrationText(live());
    speak("confirm delete"); // the voice lane's claim has already lost the race.

    // Give the (real, unfaked) event loop a moment; a wrong second delete or a crash would surface here.
    await new Promise((r) => setTimeout(r, 400));
    assert.strictEqual(
      clientMessages.slice(seen).filter((m) => m.type === "action_resolved").length,
      0,
      "the lost-race voice attempt broadcasts nothing — exactly one action_resolved total"
    );
    assert.strictEqual(narrationText(live()), spokenBefore, "the voice lane stays silent on a lost race");
    assert.ok(!(await pendingActionIds()).includes(actionId), "still gone — no resurrection, no double-delete");
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // Journey 3 — session drop mid-window (the 5b pattern): the staged action survives.
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  it("the operator's WS drops while a window is armed; the staged action survives and stays resolvable via REST", async () => {
    const paneId = seedPane();
    const actionId = await stageDeletePane(paneId);

    speak("yes"); // arm the spoken window on THIS connection
    await waitFor(() => narrationText(live()).includes("confirm delete"), 4000);

    // The operator's browser WS drops (clientWs close -> spokenConfirm.dispose()).
    await new Promise<void>((resolve) => {
      client.once("close", () => resolve());
      try { client.terminate(); } catch { resolve(); }
    });

    // The staged action is untouched — dispose() cancels the SPOKEN PROMPT only.
    assert.ok((await pendingActionIds()).includes(actionId), "the pending action survives the WS drop");
    assert.ok(running.manager.ledger.getProject(PROJECT)?.panes?.[paneId], "pane row untouched by the drop");

    // Still resolvable via the UI (REST) after the drop, per D5.
    const confirm = await api(`/api/actions/${actionId}/confirm`, { method: "POST" });
    assert.strictEqual(confirm.status, 200);
    assert.ok(!(await pendingActionIds()).includes(actionId), "resolved via REST after the session drop");
    assert.ok(!(running.manager.ledger.getProject(PROJECT)?.panes ?? {})[paneId], "the pane was actually deleted");

    // Reconnect a fresh client so any LATER test in this file (if added) has a live connection again.
    clientMessages = [];
    client = new WebSocket(`ws://127.0.0.1:${running.port}/live`, { headers: { Cookie: `auth_token=${apiToken}` } });
    client.on("message", (data) => {
      try { clientMessages.push(JSON.parse(data.toString())); } catch { /* non-JSON */ }
    });
    await new Promise<void>((resolve, reject) => {
      client.on("open", () => resolve());
      client.on("error", reject);
    });
    await waitFor(() => running._testActiveLiveSession?.());
  });
});
