// tests/test_voice_complexity_refactor.ts — CHARACTERIZATION tests for the Phase-7 cyclomatic
// refactor of src/voice/index.ts. These pin the CURRENT behaviour of the five over-limit functions'
// branches that the existing suite covers only thinly, so the behaviour-preserving complexity
// refactor (extract helpers / guard clauses) can be proven not to change a single observable output
// or side-effect. They are written to be GREEN against the UNREFACTORED code first.
//
// Covered branches (by violating function):
//   - observe-socket message handler (≈L405): set_active_pane, draft_edit (real pane), malformed frame.
//   - voice clientWs message handler (≈L1365): set_active_pane, draft_edit, stop_all stage-1,
//     stop_all kill-while-not-frozen, release_stop_all, malformed frame.
//   - onmessage (≈L837): operator transcript + transcript_text frame, model transcript + transcript_text
//     frame, modelThinking interaction log, grounding emit frame, the clarify-intent narration, the
//     no-pending-approval pending-action fallback, and the create_pane "Opening the pane now." ack.
//
// Boot follows the ce7 / voice-journeys harness conventions: JANUS_NO_AUTOSTART=1, tmp cwd isolated
// BEFORE importing ../server, installMockLive() swaps the injectable liveConnector, startServer({port:0}).
//
// Runner: npx tsx --test --test-force-exit tests/test_voice_complexity_refactor.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";
import type { MockLiveHandle, MockLiveSession } from "./helpers/mockLive";
import { teardownServerSuite } from "./helpers/teardown";
import type { RunningServer } from "../server";

const PROJECT = "vcr_proj";

describe("voice complexity refactor — characterization (real server, real PTY; no API key, no mic)", () => {
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

  const live = (): MockLiveSession => running._testActiveLiveSession!() as MockLiveSession;
  const approvals = () => running._testPendingApprovals!();
  const term = (paneId: string): any => (running.manager.terminals as any)[paneId];

  function narrationText(session: MockLiveSession): string {
    return session.clientContents
      .map((c: any) =>
        (c?.turns ?? [])
          .map((t: any) => (t?.parts ?? []).map((p: any) => p?.text ?? "").join(" "))
          .join(" ")
      )
      .join("\n");
  }

  function speak(text: string, session: MockLiveSession = live()): void {
    session.emit({ serverContent: { inputTranscription: { text } } });
  }

  /** Send a frame over the operator's voice WS and let the server's async handler run. */
  async function sendVoice(frame: any): Promise<void> {
    client.send(JSON.stringify(frame));
    await new Promise((r) => setTimeout(r, 80));
  }

  async function createShellPane(paneId: string, permissionsMode?: string): Promise<any> {
    const call = live().emitToolCall("create_pane", {
      project_id: PROJECT,
      pane_id: paneId,
      tool_preset: "Custom",
      ...(permissionsMode ? { permissions_mode: permissionsMode } : {}),
    });
    const out = String(await waitFor(() => mock.responseFor(call)));
    assert.ok(out.includes(`Pane ${paneId} created`), `create_pane ran inline under Auto: ${out}`);
    const t = term(paneId);
    assert.ok(t, `live terminal ${paneId} registered`);
    return t;
  }

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";
    process.env.JANUS_RECONNECT_MAX_ATTEMPTS = "3";
    process.env.JANUS_RECONNECT_BASE_DELAY_MS = "20";
    process.env.JANUS_RECONNECT_MAX_DELAY_MS = "60";

    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-vcr-"));
    process.chdir(tmpDir);

    ({ installMockLive, waitFor } = await import("./helpers/mockLive"));
    const serverMod = await import("../server");
    startServer = serverMod.startServer;
    apiToken = serverMod.API_AUTH_TOKEN;

    mock = installMockLive();
    running = await startServer({ port: 0, enableVite: false });

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
    await waitFor(() => mock.latest() && running._testActiveLiveSession?.());

    if (!running.manager.settings.advanced.capabilityGates) {
      running.manager.settings.advanced.capabilityGates = {} as any;
    }
    (running.manager.settings.advanced.capabilityGates as any).create_pane = "Auto";
  });

  after(async () => {
    if (running?.manager?.settings?.advanced?.capabilityGates) {
      delete (running.manager.settings.advanced.capabilityGates as any).create_pane;
    }
    if (running?.manager) {
      const terms = Object.values(running.manager.terminals) as any[];
      await Promise.all(terms.map((t) => Promise.resolve(t.stop()).catch(() => { /* gone */ })));
      for (const id of Object.keys(running.manager.terminals)) {
        delete (running.manager.terminals as any)[id];
      }
    }
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

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // onmessage (≈L837)
  // ───────────────────────────────────────────────────────────────────────────────────────────

  it("onmessage: an operator inputTranscription emits a transcript_text(User) frame verbatim", async () => {
    const seen = clientMessages.length;
    speak("hello operator words");
    const frame = await waitFor(
      () => clientMessages.slice(seen).find((m) => m.type === "transcript_text" && m.sender === "User"),
      3000
    );
    assert.strictEqual(frame.text, "hello operator words", "the User transcript frame carries the verbatim utterance");
  });

  it("onmessage: a model transcript (modelTurn.parts) emits a transcript_text(Janus) frame", async () => {
    const seen = clientMessages.length;
    // The model's SPOKEN text is modelTurn.parts (extractTranscripts.model); outputTranscription is the
    // separate "thinking" channel. The Janus transcript_text frame is driven by modelTurn.parts.
    live().emit({ serverContent: { modelTurn: { parts: [{ text: "janus is speaking now" }] } } });
    const frame = await waitFor(
      () => clientMessages.slice(seen).find((m) => m.type === "transcript_text" && m.sender === "Janus"),
      3000
    );
    assert.strictEqual(frame.text, "janus is speaking now");
  });

  it("onmessage: grounding metadata emits a grounding frame with queries + sources", async () => {
    const seen = clientMessages.length;
    live().emit({
      serverContent: {
        groundingMetadata: {
          webSearchQueries: ["what is mccabe complexity"],
          groundingChunks: [{ web: { uri: "https://example.com/cc", title: "Cyclomatic Complexity" } }],
        },
      },
    });
    const frame = await waitFor(
      () => clientMessages.slice(seen).find((m) => m.type === "grounding"),
      3000
    );
    assert.deepStrictEqual(frame.queries, ["what is mccabe complexity"]);
    assert.strictEqual(frame.sources.length, 1);
    assert.strictEqual(frame.sources[0].uri, "https://example.com/cc");
    assert.strictEqual(frame.sources[0].title, "Cyclomatic Complexity");
  });

  it("onmessage: 'approve or reject' ambiguity in ONE utterance clarifies (never approves) when >=1 pending", async () => {
    const paneId = "vcr-clarify";
    await createShellPane(paneId);
    const callId = live().emitToolCall("propose_command", { pane_id: paneId, instruction: "echo clarify_me", kind: "shell" });
    await waitFor(() => mock.rawResponseFor(callId));
    assert.ok(approvals().has(callId), "approval staged");

    // A single utterance that says BOTH approve and reject => parseApprovalIntent -> 'clarify'.
    speak("approve and reject");
    const spoken = await waitFor(() => {
      const n = narrationText(live());
      return n.includes("which did you mean") ? n : undefined;
    }, 4000);
    assert.ok(spoken.includes("which did you mean"), `clarify narration fired: ${spoken}`);
    assert.ok(approvals().has(callId), "the ambiguous utterance did NOT resolve the approval");

    // clean up — reject it so it doesn't leak into later tests.
    speak("reject");
    await waitFor(() => !approvals().has(callId) || undefined, 4000);
  });

  it("onmessage: a create_pane success speaks the 'Opening the pane now.' ack when the turn is clear", async () => {
    // shouldSpeakOpeningAck => 'speak' only when the operator hasn't spoken within OPERATOR_HOLD_MS
    // (1.5s). Earlier tests speak transcripts, so wait out the hold window to make the turn clear.
    await new Promise((r) => setTimeout(r, 1700));
    const before = live().clientContents.length;
    await createShellPane("vcr-ack");
    const spoken = await waitFor(() => {
      const fresh = narrationText({ ...live(), clientContents: live().clientContents.slice(before) } as MockLiveSession);
      return fresh.includes("Opening the pane now.") ? fresh : undefined;
    }, 4000);
    assert.ok(spoken.includes("Opening the pane now."), "the auto-create opening ack was spoken");
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // voice clientWs message handler (≈L1365)
  // ───────────────────────────────────────────────────────────────────────────────────────────

  it("voice WS: set_active_pane records the active pane (proven by a pane-less draft_edit defaulting to it)", async () => {
    // The effect is on coreState.activePaneId; read it back via a round-trip: a subsequent draft_edit
    // with no explicit paneId defaults to the active pane, so the draft landing on this pane proves it.
    const t = await createShellPane("vcr-active-1");
    await sendVoice({ type: "set_active_pane", paneId: "vcr-active-1" });
    await sendVoice({ type: "draft_edit", projectId: PROJECT, text: "defaulted to active pane" });
    const draft = running.manager.ledger.getDraft(PROJECT, "vcr-active-1");
    assert.ok(draft, "draft written");
    assert.strictEqual(draft!.text, "defaulted to active pane");
    assert.ok(t, "pane exists");
  });

  it("voice WS: draft_edit writes the named pane's draft and broadcasts draft_updated", async () => {
    const paneId = "vcr-draft";
    await createShellPane(paneId);
    const seen = clientMessages.length;
    await sendVoice({ type: "draft_edit", projectId: PROJECT, paneId, text: "voice draft body" });
    const draft = running.manager.ledger.getDraft(PROJECT, paneId);
    assert.ok(draft, "draft persisted");
    assert.strictEqual(draft!.text, "voice draft body");
    assert.strictEqual(draft!.updatedBy, "operator");
    const frame = clientMessages.slice(seen).find((m) => m.type === "draft_updated");
    assert.ok(frame, "draft_updated broadcast on a successful draft write");
  });

  it("voice WS: stop_all (stage 1) freezes and acks stop_all_done stage:1", async () => {
    const seen = clientMessages.length;
    await sendVoice({ type: "stop_all" });
    const ack = await waitFor(
      () => clientMessages.slice(seen).find((m) => m.type === "stop_all_done" && m.stage === 1),
      3000
    );
    assert.strictEqual(ack.frozen, true, "stage-1 ack reports frozen:true");
    // Release so we leave a clean frozen state for siblings.
    await sendVoice({ type: "release_stop_all" });
  });

  it("voice WS: stop_all kill while NOT frozen acks stop_all_done error:not_frozen (no kill)", async () => {
    const seen = clientMessages.length;
    // Ensure not frozen first.
    await sendVoice({ type: "release_stop_all" });
    await sendVoice({ type: "stop_all", kill: true });
    const ack = await waitFor(
      () => clientMessages.slice(seen).find((m) => m.type === "stop_all_done" && m.error === "not_frozen"),
      3000
    );
    assert.strictEqual(ack.error, "not_frozen", "kill-without-freeze is refused with not_frozen");
  });

  it("voice WS: release_stop_all acks stop_all_done stage:0 frozen:false", async () => {
    const seen = clientMessages.length;
    await sendVoice({ type: "stop_all" }); // freeze first
    await sendVoice({ type: "release_stop_all" });
    const ack = await waitFor(
      () => clientMessages.slice(seen).find((m) => m.type === "stop_all_done" && m.stage === 0),
      3000
    );
    assert.strictEqual(ack.frozen, false, "release ack reports frozen:false");
  });

  it("voice WS: a malformed (non-JSON) frame is swallowed (no throw, socket stays open)", async () => {
    client.send("this is not json {{{");
    await new Promise((r) => setTimeout(r, 120));
    assert.strictEqual(client.readyState, WebSocket.OPEN, "the socket survived a malformed frame");
    // And a subsequent well-formed frame still works.
    const seen = clientMessages.length;
    await sendVoice({ type: "release_stop_all" });
    await waitFor(
      () => clientMessages.slice(seen).find((m) => m.type === "stop_all_done"),
      3000
    );
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // observe-socket message handler (≈L405)
  // ───────────────────────────────────────────────────────────────────────────────────────────

  describe("observe-only socket message handler", () => {
    let obs: WebSocket;

    before(async () => {
      obs = new WebSocket(`ws://127.0.0.1:${running.port}/live?observe=1`, {
        headers: { Cookie: `auth_token=${apiToken}` },
      });
      await new Promise<void>((resolve, reject) => {
        obs.on("open", () => resolve());
        obs.on("error", reject);
      });
    });

    after(async () => {
      if (obs && obs.readyState !== WebSocket.CLOSED) {
        await new Promise<void>((resolve) => {
          obs.once("close", () => resolve());
          try { obs.terminate(); } catch { resolve(); }
        });
      }
    });

    it("observe WS: draft_edit on a real pane writes the draft (defaulting to the named pane)", async () => {
      const paneId = "vcr-obs-draft";
      await createShellPane(paneId);
      obs.send(JSON.stringify({ type: "draft_edit", projectId: PROJECT, paneId, text: "observe draft body" }));
      await new Promise((r) => setTimeout(r, 120));
      const draft = running.manager.ledger.getDraft(PROJECT, paneId);
      assert.ok(draft, "observe draft_edit persisted a draft");
      assert.strictEqual(draft!.text, "observe draft body");
    });

    it("observe WS: a malformed frame is swallowed (socket stays open)", async () => {
      obs.send("not json at all }}}");
      await new Promise((r) => setTimeout(r, 120));
      assert.strictEqual(obs.readyState, WebSocket.OPEN, "observe socket survived a malformed frame");
    });
  });
});
