// tests/test_voice_journeys.ts — END-USER voice journeys through the REAL server pipeline.
//
// This lane replaces the mock-reimplementation style of tests/test_journeys.ts (which hand-copied
// the propose/approve decision logic into the test) with journeys driven END-TO-END through the
// genuine server code: the real Gemini onmessage dispatch (registry runAction), the real gating
// core (src/gating createGating: gateOrDefer / decideProposal / applyResolution / applyDeferral /
// reannounceSurvivors), the real voice-intercept path (serverContent.inputTranscription ->
// parseApprovalIntent -> resolveApprovalByVoice), the real SQLite ledger, and REAL PTY panes
// (/bin/sh -c bash via node-pty) so "the command executed" means bytes actually landed on a live
// shell and its OUTPUT proves it (shell arithmetic: `echo approved_$((40+2))` can only print
// `approved_42` if a real shell evaluated it — the PTY's input echo carries the unexpanded form).
//
// Boot follows the ce7 harness conventions (tests/test_voice_tools.ts / test_notes_recall.ts):
// JANUS_NO_AUTOSTART=1, tmp cwd isolated BEFORE importing ../server (boot-time store restore reads
// the cwd), installMockLive() swaps the injectable liveConnector, startServer({ port:0 }) gives an
// ephemeral headless server, and teardown AWAITS every pane stop() + teardownServerSuite so
// --test-force-exit can't abort on a half-closed libuv handle.
//
// Journeys:
//   1. SUPERVISED COMMAND — HiTL pane: propose_command stages a pending approval (the model gets
//      the pending-style tool response), the operator SPEAKS "approve" (real transcript frame),
//      the command executes on the real pane, and the operator-visible command_auto_executed
//      frame (approved+vocal) names pane + command. (The SPOKEN "Approving:…" narration is a
//      known dead path — see the journey-1 comment — so the frame is the asserted confirmation.)
//   2. REJECTION — spoken "reject": the command NEVER runs, the approval clears, and the
//      command_blocked / approval_resolved frames confirm.
//   3. DEFER — spoken "not now" (the Phase 4 defer verb, src/approvalIntent.ts): the approval
//      SURVIVES (TTL re-armed) instead of being claim+deleted, and stays resolvable afterwards.
//   4. STATUS TRUTH — a REAL busy pane (Full-Auto auto-execute of allowlisted `cat`, which then
//      holds the tty foreground) + a REAL idle pane; list_panes reports honest busy/idle derived
//      from the genuine status machine (authoritative /proc probe) — no manual term.status writes.
//   5. DROP-AND-RESUME — with an approval pending, the Gemini socket dies (emitClose 1006); the
//      bounded reconnect mints a fresh session, the survivor re-attaches, the resumption digest
//      ("Welcome back…", gating.reannounceSurvivors) names it, and the approval is still
//      resolvable by voice through the NEW session.
//
// Runner: npx tsx --test --test-force-exit tests/test_voice_journeys.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";
import type { MockLiveHandle, MockLiveSession } from "./helpers/mockLive";
import { teardownServerSuite } from "./helpers/teardown";
import type { RunningServer } from "../server";

const PROJECT = "vj_proj";

describe("voice journeys (real server, real gating, real PTY panes; no API key, no mic)", () => {
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

  // The currently-HOISTED live session (journey 5 swaps it on reconnect, so never cache it).
  const live = (): MockLiveSession => running._testActiveLiveSession!() as MockLiveSession;
  const approvals = () => running._testPendingApprovals!();
  const term = (paneId: string): any => (running.manager.terminals as any)[paneId];

  /** Everything the server has SPOKEN into a session (sendClientContent narration), flattened. */
  function narrationText(session: MockLiveSession): string {
    return session.clientContents
      .map((c: any) =>
        (c?.turns ?? [])
          .map((t: any) => (t?.parts ?? []).map((p: any) => p?.text ?? "").join(" "))
          .join(" ")
      )
      .join("\n");
  }

  /** Push a REAL operator transcript frame into the server's live onmessage handler — the exact
   *  shape Gemini Live delivers ASR on (serverContent.inputTranscription, src/liveTranscripts.ts),
   *  so the utterance walks the genuine route: extractTranscripts -> shouldRouteUtterance ->
   *  parseApprovalIntent -> selectApprovalTarget -> resolveApprovalByVoice / applyDeferral. */
  function speak(text: string, session: MockLiveSession = live()): void {
    session.emit({ serverContent: { inputTranscription: { text } } });
  }

  /** Create a REAL shell pane by VOICE (create_pane, gated Auto for the suite) — the genuine
   *  addTerminal -> node-pty spawn path. Custom preset derives the default shell command (bash on
   *  POSIX), and the create effect makes the new pane the ACTIVE write target (Issue #2 fix), so a
   *  follow-up propose_command on this pane passes the single-active-pane guard — exactly the
   *  voice-only create-then-command flow an operator drives. */
  async function createShellPane(
    paneId: string,
    permissionsMode?: "Full Auto" | "Human-in-the-Loop" | "Read-Only"
  ): Promise<any> {
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

  /** Propose a command by voice and return its callId + the FULL structured tool response. */
  async function propose(paneId: string, instruction: string): Promise<{ callId: string; resp: any }> {
    const callId = live().emitToolCall("propose_command", {
      pane_id: paneId,
      instruction,
      kind: "shell",
    });
    const resp: any = await waitFor(() => mock.rawResponseFor(callId));
    return { callId, resp };
  }

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";
    // Shrink the bounded reconnect backoff so the drop-and-resume journey runs deterministically
    // fast (read per WS connection in src/voice/index.ts, so setting them here is in time).
    process.env.JANUS_RECONNECT_MAX_ATTEMPTS = "3";
    process.env.JANUS_RECONNECT_BASE_DELAY_MS = "20";
    process.env.JANUS_RECONNECT_MAX_DELAY_MS = "60";

    // Isolate the .janus_* ledger/settings/DB files into a temp cwd BEFORE importing ../server.
    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-vj-"));
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

    // create_pane defaults to Ask, and voice LOOSENING is refused by design — the director loosens
    // via the Settings UI; mirror that by writing the matrix directly (same convention as
    // tests/test_voice_tools.ts U4). Cleaned up in after().
    if (!running.manager.settings.advanced.capabilityGates) {
      running.manager.settings.advanced.capabilityGates = {} as any;
    }
    (running.manager.settings.advanced.capabilityGates as any).create_pane = "Auto";
  });

  after(async () => {
    if (running?.manager?.settings?.advanced?.capabilityGates) {
      delete (running.manager.settings.advanced.capabilityGates as any).create_pane;
    }
    // Kill every REAL pane and AWAIT each stop(): node-pty's teardown must drain before
    // --test-force-exit's process.exit() or libuv aborts on a half-closed handle.
    if (running?.manager) {
      const terms = Object.values(running.manager.terminals) as any[];
      await Promise.all(terms.map((t) => Promise.resolve(t.stop()).catch(() => { /* already gone */ })));
      for (const id of Object.keys(running.manager.terminals)) {
        delete (running.manager.terminals as any)[id];
      }
    }
    // Drain the client socket BEFORE closing the server.
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
  // Journey 1 — the supervised command (HiTL approve).
  // ───────────────────────────────────────────────────────────────────────────────────────────
  it("supervised command: HiTL propose -> pending response -> spoken approve -> REAL execution + approved/vocal frame", async () => {
    const paneId = "vj-approve";
    const t = await createShellPane(paneId); // HiTL default; becomes the active pane.

    // $((40+2)) only becomes 42 if a REAL shell evaluates it — the PTY input echo carries the
    // unexpanded literal, so seeing "approved_42" is proof of execution, not of typing.
    const instruction = "echo approved_$((40+2))";
    const { callId, resp } = await propose(paneId, instruction);

    // The model got the NON-BLOCKING pending-style tool response (call.id answered exactly once).
    assert.strictEqual(resp.status, "pending_approval", `HiTL stages, never runs: ${JSON.stringify(resp)}`);
    assert.strictEqual(resp.messageId, callId, "pending entry is keyed by the functionCall id");
    assert.strictEqual(resp.pane_id, paneId);
    assert.match(String(resp.prompt), /approve or reject/i, "the model is told to read it back");

    // A pending approval exists in the REAL store; nothing has touched the pane.
    assert.ok(approvals().has(callId), "pending approval staged");
    assert.strictEqual(approvals().get(callId)?.instruction, instruction);
    assert.strictEqual(t.lastCommand, "", "no writeInput before the operator's decision");
    // The operator's UI got the approval_pending frame (the dialog the human approves from).
    const frame = clientMessages.find((m) => m.type === "approval_pending" && m.messageId === callId);
    assert.ok(frame, "approval_pending frame reached the operator's socket");
    assert.strictEqual(frame.terminalId, paneId);

    // The operator SPEAKS the approval — the real transcript-intercept path resolves it.
    speak("approve");

    // The command actually executed in the REAL pane: the shell printed the EXPANDED token.
    await waitFor(() => t.getRecentOutput(100).includes("approved_42"), 10000);
    assert.ok(!approvals().has(callId), "the approval was consumed exactly once");
    assert.strictEqual(t.lastCommand, instruction, "the approved instruction is what landed");

    // The operator-visible resolution: the command_auto_executed frame names the pane + command and
    // is flagged operator-APPROVED + vocal (the UI renders this as the voice-approval confirmation).
    //
    // KNOWN SERVER GAP (found by this real-path test, deliberately NOT asserted around): the SPOKEN
    // resolution narration ("Approving: run on pane … Dispatching now.", src/gating/index.ts:800)
    // is dead code on every terminal outcome — applyResolution calls resolveDecision FIRST, which
    // claim+DELETEs the record (src/pendingApprovals.ts resolveDecision -> store.delete), and
    // PendingApprovalStore.delete() also drops the session side-map entry, so the subsequent
    // pendingApprovals.sessionFor(messageId) (src/gating/index.ts:764) is always undefined and the
    // narration push is skipped. Fixing it means reading sessionFor BEFORE resolveDecision; until
    // then the broadcast frame below is the only operator-facing confirmation.
    const executed = clientMessages.find(
      (m) => m.type === "command_auto_executed" && m.terminalId === paneId
    );
    assert.ok(executed, "command_auto_executed frame reached the operator");
    assert.strictEqual(executed.approved, true, "flagged operator-approved, not an auto-run");
    assert.strictEqual(executed.vocal, true, "flagged as a VOICE approval");
    assert.ok(String(executed.cmd).includes("echo approved_"), "the frame names the command");
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // Journey 2 — the rejection.
  // ───────────────────────────────────────────────────────────────────────────────────────────
  it("rejection: spoken reject -> command NEVER runs, approval cleared, resolve + blocked frames confirm", async () => {
    const paneId = "vj-reject";
    const t = await createShellPane(paneId);

    const instruction = "echo rejected_$((40+2))";
    const { callId, resp } = await propose(paneId, instruction);
    assert.strictEqual(resp.status, "pending_approval");
    assert.ok(approvals().has(callId));

    const seen = clientMessages.length;
    speak("reject");

    await waitFor(() => !approvals().has(callId) || undefined, 5000);
    assert.ok(!approvals().has(callId), "approval cleared by the spoken rejection");

    // The pane was NEVER written: writeInput untouched, and the expanded token never appears.
    assert.strictEqual(t.lastCommand, "", "writeInput was never invoked");
    await new Promise((r) => setTimeout(r, 400)); // grace window: a wrong write would surface here
    assert.ok(!t.getRecentOutput(200).includes("rejected_42"), "the command did not execute");

    // The operator-visible rejection confirmation: the approval_resolved + command_blocked frames.
    // (The spoken "Rejecting the command on pane …" narration at src/gating/index.ts:806 is dead on
    // the live path for the same reason as journey 1's "Approving:" line — resolveDecision deletes
    // the record/side-map before sessionFor is read — so the frames are the real confirmation.)
    const resolved = clientMessages
      .slice(seen)
      .find((m) => m.type === "approval_resolved" && m.messageId === callId);
    assert.ok(resolved, "approval_resolved frame broadcast");
    assert.strictEqual(resolved.outcome, "rejected");
    const blocked = clientMessages
      .slice(seen)
      .find((m) => m.type === "command_blocked" && m.terminalId === paneId);
    assert.ok(blocked, "command_blocked frame broadcast");
    assert.match(String(blocked.reason), /cancelled by operator/i);
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // Journey 3 — the defer verb ("later" / "not now", Phase 4 4D.3).
  // ───────────────────────────────────────────────────────────────────────────────────────────
  it("defer: spoken 'not now' re-arms the approval (it SURVIVES) and it stays resolvable afterwards", async () => {
    const paneId = "vj-defer";
    const t = await createShellPane(paneId);

    const instruction = "echo deferred_$((40+2))";
    const { callId, resp } = await propose(paneId, instruction);
    assert.strictEqual(resp.status, "pending_approval");

    speak("not now"); // parseApprovalIntent -> "defer" -> gating.applyDeferral (never claim+delete)

    await waitFor(() => (narrationText(live()).includes("Holding it") ? true : undefined), 5000);
    assert.ok(approvals().has(callId), "the approval SURVIVED the defer (not cancelled)");
    assert.strictEqual(t.lastCommand, "", "defer never writes to the pane");
    assert.ok(!t.getRecentOutput(200).includes("deferred_42"), "defer never executes");

    // The deferred record is still a live, resolvable approval — a later spoken reject closes it
    // out through the same claim-gated choke-point (proves defer parked it without corrupting it).
    speak("reject");
    await waitFor(() => !approvals().has(callId) || undefined, 5000);
    assert.ok(!approvals().has(callId), "the deferred approval resolved normally afterwards");
    assert.strictEqual(t.lastCommand, "", "still nothing executed");
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // Journey 4 — status truth (honest busy/idle from the REAL status machine).
  // ───────────────────────────────────────────────────────────────────────────────────────────
  it("status truth: list_panes reports a REAL busy pane busy and a REAL idle pane idle (no manual status writes)", async () => {
    // Create the idle pane FIRST so the busy pane (created last) is the ACTIVE write target.
    await createShellPane("vj-idle");
    await createShellPane("vj-busy", "Full Auto");

    // Drive the busy work through the REAL voice pipe: Full-Auto + allowlisted `cat` auto-executes
    // (decideProposal -> auto_execute -> term.writeInput). `cat` then blocks reading the tty, so
    // the pane holds a genuine foreground command the authoritative /proc probe reports as busy.
    const callId = live().emitToolCall("propose_command", {
      pane_id: "vj-busy",
      instruction: "cat",
      kind: "shell",
    });
    const out = String(await waitFor(() => mock.responseFor(callId)));
    assert.match(out, /executed automatically/i, `Full Auto auto-executed: ${out}`);

    // Poll the REAL read tool until the status machine converges: the busy pane needs `cat` to be
    // probed in the foreground; the idle pane needs the resting-shell probe + the ~2s idle
    // debounce. No term.status is ever written by this test — list_panes reads machine truth.
    const deadline = Date.now() + 15000;
    let busyMeta: any;
    let idleMeta: any;
    for (;;) {
      const c = live().emitToolCall("list_panes");
      const tree: any = await waitFor(() => mock.responseFor(c));
      const panes = (Array.isArray(tree) ? tree : []).flatMap((p: any) => p?.panes ?? []);
      busyMeta = panes.find((p: any) => p?.pane_id === "vj-busy");
      idleMeta = panes.find((p: any) => p?.pane_id === "vj-idle");
      if (busyMeta?.is_busy === true && idleMeta?.is_busy === false) break;
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 400));
    }

    assert.ok(busyMeta, "list_panes lists the busy pane");
    assert.ok(idleMeta, "list_panes lists the idle pane");
    assert.strictEqual(busyMeta.is_busy, true, `busy pane honestly busy: ${JSON.stringify(busyMeta)}`);
    assert.strictEqual(busyMeta.last_known_state, "Running active command");
    assert.strictEqual(busyMeta.alive, true);
    assert.strictEqual(idleMeta.is_busy, false, `idle pane honestly idle: ${JSON.stringify(idleMeta)}`);
    assert.strictEqual(idleMeta.last_known_state, "Idle");
    assert.strictEqual(idleMeta.alive, true);
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // Journey 5 — drop-and-resume (LAST: it swaps the live session via the real reconnect path).
  // ───────────────────────────────────────────────────────────────────────────────────────────
  it("drop-and-resume: socket dies with an approval pending -> reconnect digests the survivor -> still resolvable", async () => {
    const paneId = "vj-drop";
    const t = await createShellPane(paneId);

    const instruction = "echo resumed_$((40+2))";
    const session1 = live();
    const { callId, resp } = await propose(paneId, instruction);
    assert.strictEqual(resp.status, "pending_approval");
    assert.strictEqual(approvals().sessionFor(callId), session1, "approval bound to the first session");

    // The Gemini socket dies (transient 1006). The server detaches the survivor, opens the
    // away window, broadcasts the loss, and the bounded reconnect mints a FRESH session.
    const sessionsBefore = mock.sessions.length;
    const lostBefore = clientMessages.filter((m) => m.type === "voice_channel_lost").length;
    session1.emitClose({ code: 1006, reason: "journey: network drop" });

    const session2 = await waitFor(
      () => (mock.sessions.length > sessionsBefore ? mock.latest() : undefined),
      8000
    );
    assert.notStrictEqual(session2, session1, "the reconnect minted a fresh session");
    await waitFor(() => running._testActiveLiveSession!() === session2);

    // The operator's UI heard about the loss AND the recovery.
    await waitFor(() => clientMessages.filter((m) => m.type === "voice_channel_lost").length > lostBefore);
    await waitFor(() => clientMessages.some((m) => m.type === "voice_channel_restored"));

    // The surviving approval re-attached to the NEW session and the resumption digest names it.
    assert.ok(approvals().has(callId), "the approval survived the drop");
    assert.strictEqual(approvals().sessionFor(callId), session2, "survivor re-attached to the new session");
    const digest = await waitFor(() => {
      const n = narrationText(session2 as MockLiveSession);
      return n.includes("Welcome back") ? n : undefined;
    }, 5000);
    assert.ok(digest.includes(paneId), `resumption digest names the pane: ${digest}`);
    assert.ok(digest.includes("echo resumed_"), `resumption digest names the command: ${digest}`);
    assert.match(digest, /still waiting|actions waiting/i, "digest frames it as awaiting the operator");

    // The survivor is STILL RESOLVABLE — spoken approve through the NEW session's real intercept
    // path executes the original command on the original (still-live) pane.
    speak("approve", session2 as MockLiveSession);
    await waitFor(() => t.getRecentOutput(100).includes("resumed_42"), 10000);
    assert.ok(!approvals().has(callId), "the resumed approval resolved exactly once");
    assert.strictEqual(t.lastCommand, instruction);
  });
});
