// tests/test_voice_thought_buffer.ts — RED spec for the modelThinking fragment-buffering fix
// (bead wsm-e2e-pinned-zmu5).
//
// BUG THIS PINS: Gemini Live streams serverContent.outputTranscription.text INCREMENTALLY (a few
// words per WS message). Today onmessage (src/voice/index.ts) calls handleModelUtterance() once per
// FRAGMENT (since audio-only mode leaves modelTurn.parts/modelUtterance always empty), so ONE spoken
// thought fans out into N separate "* **Agentic Thought**: ..." draft bullets, N transcript_text(Janus)
// WS frames, N `gemini_text` interaction-log legs, and N recentTurns pushes — burying the pane's staged
// command under a wall of sub-sentence bullets (see the 2026-07-16 .janus_scrollback_test-2.log capture:
// "My apologies" / "again." / "The draft" / "is ready" / "for test-2" / "now." / "Say" / "'send" /
// "it' to" / "submit." landing as 10 separate bullets instead of one).
//
// THE FIX THIS SPECIFIES: fragments accumulate in a per-session buffer (state.pendingModelThinking) via
// RAW concatenation (no inserted separator — production fragments already carry their own leading
// whitespace; see the forensics joinRule). The buffer is flushed EXACTLY ONCE per turn boundary
// (serverContent.turnComplete, serverContent.generationComplete, or serverContent.interrupted — the
// barge-in case flushes the PARTIAL thought so spoken words are never lost) through the EXISTING
// handleModelUtterance() single-shot path, then reset. A flush of an empty/blank buffer is a no-op (no
// stray empty bullet, no stray empty frame). The `length > 2` draft-append guard applies to the JOINED
// text, not to individual fragments.
//
// HARNESS: mirrors tests/test_voice_complexity_refactor.ts / tests/test_voice_tool_goldens.ts — boots
// the REAL server headless via tests/helpers/mockLive.ts (no Gemini key, no mic), drives the server's
// REAL onmessage closure with synthetic LiveServerMessages via session.emit(), and asserts on:
//   - the REAL WS frames the test's `ws` client receives (transcript_text/sender:"Janus"),
//   - the REAL SQLite-ledger draft (running.manager.ledger.getDraft) the pane composer reads,
//   - the REAL process-global recentTurns ring (src/voice/recentTurns.ts) save_transcript_note reads,
//   - the REAL interaction-log JSONL file the server appends to (kind:"gemini_text" / "gemini_thinking"),
// via BYTE-OFFSET reads (readLogSince) rather than marker-text sniffing, so counts are exact and cannot
// be polluted by earlier tests in this same file/session.
//
// Runner: npx tsx --test --test-force-exit tests/test_voice_thought_buffer.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";
import type { MockLiveHandle, MockLiveSession } from "./helpers/mockLive";
import { teardownServerSuite } from "./helpers/teardown";
import type { RunningServer } from "../server";
import { recentTurns } from "../src/voice/recentTurns";

describe("voice thought-buffer flush (modelThinking fragments coalesce to ONE bullet/frame per turn)", () => {
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

  // ── synthetic Gemini Live message senders ─────────────────────────────────────────────────────
  function emitThinking(text: string, session: MockLiveSession = live()): void {
    session.emit({ serverContent: { outputTranscription: { text } } });
  }
  function emitFragments(fragments: string[], session: MockLiveSession = live()): void {
    for (const f of fragments) emitThinking(f, session);
  }
  function emitTurnComplete(session: MockLiveSession = live()): void {
    session.emit({ serverContent: { turnComplete: true } });
  }
  function emitGenerationComplete(session: MockLiveSession = live()): void {
    session.emit({ serverContent: { generationComplete: true } } as any);
  }
  function emitInterrupted(session: MockLiveSession = live()): void {
    session.emit({ serverContent: { interrupted: true } });
  }

  /** Let any in-flight WS frames (server -> test client, real loopback socket) land. Every emit() call
   *  above runs the server's onmessage synchronously up to its first await, so the ONLY genuinely async
   *  hop is the WS delivery itself — 200ms is generous headroom for a loopback socket. */
  async function settle(ms = 200): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
  }

  function janusFramesSince(seenIdx: number): any[] {
    return clientMessages.slice(seenIdx).filter((m) => m.type === "transcript_text" && m.sender === "Janus");
  }

  // ── interaction-log JSONL: byte-offset reads so counts are exact per-test, never marker-text sniffed ──
  function logFilePath(): string {
    return path.join(tmpDir, ".janus_interaction_log.jsonl");
  }
  function logSize(): number {
    try { return fs.statSync(logFilePath()).size; } catch { return 0; }
  }
  function readLogSince(offset: number): any[] {
    let raw = "";
    try { raw = fs.readFileSync(logFilePath(), "utf8"); } catch { return []; }
    return raw
      .slice(offset)
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((r): r is any => r != null);
  }

  // ── ledger pane/project registration + activation (mirrors tests/test_voice_tool_goldens.ts) ──────
  function registerActivePane(projectId: string, paneId: string): void {
    running.manager.ledger.activeProjectId = projectId;
    if (!running.manager.ledger.getProject(projectId)) {
      running.manager.ledger.addProject(projectId, "/stub/cwd", `${projectId} fixture project`);
    }
    running.manager.ledger.updatePane(projectId, {
      pane_id: paneId, name: paneId, runtime_type: "interactive_cli",
      last_known_state: "Running active command", is_busy: true, alive: true,
      notes: [], permissions_mode: "Human-in-the-Loop", session_id: "stub-session",
      tool_preset: "Claude Code", context_size: 0,
    } as any, true);
    running._testSetActivePane!(paneId);
  }
  function draftText(projectId: string, paneId: string): string | undefined {
    return running.manager.ledger.getDraft(projectId, paneId)?.text;
  }
  function agenticBullet(text: string): string {
    return `* **Agentic Thought**: *${text}*`;
  }

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";

    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-vtb-"));
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

  // ── (a) N fragments + turnComplete => exactly ONE of everything ───────────────────────────────────
  it("(a) N fragments + turnComplete => ONE Janus transcript_text frame, ONE draft bullet, ONE recentTurns push, ONE gemini_text log; gemini_thinking logs once per fragment", async () => {
    const PROJECT = "vtb_a_proj";
    const PANE = "vtb-a-pane";
    registerActivePane(PROJECT, PANE);
    recentTurns.clear();

    // Verbatim forensics fragments (ixn_mro7cpfy_9, 2026-07-16 20:31 incident) — raw concatenation
    // reproduces the spoken sentence byte-for-byte with correct spacing/punctuation.
    const fragments = [
      "My apologies", " again.", " The draft", " is ready", " for test-2",
      " now.", " Say", " 'send", " it' to", " submit.",
    ];
    const joined = "My apologies again. The draft is ready for test-2 now. Say 'send it' to submit.";

    const seen = clientMessages.length;
    const logOffset = logSize();

    emitFragments(fragments);
    emitTurnComplete();
    await settle();

    const frames = janusFramesSince(seen);
    assert.strictEqual(frames.length, 1, `expected exactly ONE Janus transcript_text frame, got ${frames.length}: ${JSON.stringify(frames.map((f) => f.text))}`);
    assert.strictEqual(frames[0].text, joined, "the single flushed frame carries the correctly-joined whole thought");

    assert.strictEqual(draftText(PROJECT, PANE), undefined, "draft is untouched, no Agentic Thought bullet");

    assert.strictEqual(recentTurns.size(), 1, `expected exactly ONE recentTurns push for this turn, got ${recentTurns.size()}`);
    assert.strictEqual(recentTurns.latest("janus")?.text, joined, "the recentTurns entry holds the joined text, not just the last fragment");

    const legs = readLogSince(logOffset);
    const thinkingLegs = legs.filter((l) => l.kind === "gemini_thinking");
    const textLegs = legs.filter((l) => l.kind === "gemini_text");
    assert.strictEqual(thinkingLegs.length, fragments.length, `gemini_thinking logs once per fragment (${fragments.length})`);
    assert.strictEqual(textLegs.length, 1, `expected exactly ONE gemini_text log entry, got ${textLegs.length}`);
    assert.strictEqual(textLegs[0]?.text, joined, "the single gemini_text log entry holds the joined text");
  });

  // ── (b) fragments then interrupted (no turnComplete) => partial thought flushed once ──────────────
  it("(b) fragments then serverContent.interrupted (no turnComplete) => the partial joined thought is flushed exactly once", async () => {
    const PROJECT = "vtb_b_proj";
    const PANE = "vtb-b-pane";
    registerActivePane(PROJECT, PANE);
    recentTurns.clear();

    const fragments = ["Wait", " I need", " to stop."];
    const joined = "Wait I need to stop.";

    const seen = clientMessages.length;
    emitFragments(fragments);
    emitInterrupted();
    await settle();

    const frames = janusFramesSince(seen);
    assert.strictEqual(frames.length, 1, `barge-in must flush the partial thought exactly once, got ${frames.length} frame(s): ${JSON.stringify(frames.map((f) => f.text))}`);
    assert.strictEqual(frames[0].text, joined, "the flushed partial thought is the correctly-joined fragments (spoken words not lost)");
    assert.strictEqual(draftText(PROJECT, PANE), undefined, "the partial thought appends NO draft bullet");
  });

  // ── (c) turnComplete with an empty buffer => no output, both virgin and immediately after a flush ──
  it("(c) turnComplete with an empty buffer emits nothing — neither before any speech nor right after a flush drains the buffer", async () => {
    const PROJECT = "vtb_c_proj";
    const PANE = "vtb-c-pane";
    registerActivePane(PROJECT, PANE);
    recentTurns.clear();

    // Step 1: a bare turnComplete with nothing said yet this turn -> no frame, no draft.
    let seen = clientMessages.length;
    emitTurnComplete();
    await settle();
    assert.strictEqual(janusFramesSince(seen).length, 0, "a bare turnComplete with nothing said emits NO transcript_text frame");
    assert.strictEqual(draftText(PROJECT, PANE), undefined, "a bare turnComplete with nothing said appends NO draft bullet");

    // Step 2: a real thought, flushed once (the buffer is now drained back to empty).
    const fragments = ["Something", " to say."];
    const joined = "Something to say.";
    seen = clientMessages.length;
    emitFragments(fragments);
    emitTurnComplete();
    await settle();
    const flushFrames = janusFramesSince(seen);
    assert.strictEqual(flushFrames.length, 1, `expected exactly ONE flush frame for the real thought, got ${flushFrames.length}`);
    assert.strictEqual(flushFrames[0].text, joined);
    assert.strictEqual(draftText(PROJECT, PANE), undefined, "draft remains untouched");

    // Step 3: immediately after that flush, the buffer is empty again — a second boundary must add
    // NOTHING (no stray empty bullet, no stray empty/duplicate frame).
    seen = clientMessages.length;
    const draftBefore = draftText(PROJECT, PANE);
    emitTurnComplete();
    await settle();
    assert.strictEqual(janusFramesSince(seen).length, 0, "a turnComplete immediately after a flush (buffer already drained) emits NO additional frame");
    assert.strictEqual(draftText(PROJECT, PANE), draftBefore, "a turnComplete on an already-drained buffer appends NO additional draft bullet");
  });

  // ── (d) two consecutive turns => two independent whole-thought flushes, no bleed ──────────────────
  it("(d) two consecutive turns (fragments+turnComplete twice) => two independent whole-thought flushes, no bleed between turns", async () => {
    const PROJECT = "vtb_d_proj";
    const PANE = "vtb-d-pane";
    registerActivePane(PROJECT, PANE);
    recentTurns.clear();

    const turn1 = ["First", " thought", " here."];
    const joined1 = "First thought here.";
    const turn2 = ["Second", " thought", " arrives."];
    const joined2 = "Second thought arrives.";

    const seen = clientMessages.length;
    emitFragments(turn1);
    emitTurnComplete();
    emitFragments(turn2);
    emitTurnComplete();
    await settle();

    const frames = janusFramesSince(seen);
    assert.strictEqual(frames.length, 2, `expected exactly TWO Janus frames (one per turn), got ${frames.length}: ${JSON.stringify(frames.map((f) => f.text))}`);
    assert.strictEqual(frames[0].text, joined1, "turn 1 flushes its own joined text, uncontaminated by turn 2's fragments");
    assert.strictEqual(frames[1].text, joined2, "turn 2 flushes its own joined text, uncontaminated by turn 1's fragments");

    assert.strictEqual(
      draftText(PROJECT, PANE),
      undefined,
      "draft remains untouched across two thought turns"
    );

    assert.strictEqual(recentTurns.size(), 2, `expected exactly TWO recentTurns pushes (one per turn), got ${recentTurns.size()}`);
  });

  // ── (e) joined length<=2 => no draft append (guard on the JOINED text, not per-fragment) ──────────
  it("(e) joined utterance with trimmed length <= 2 => no draft append (the length guard applies to the JOINED text)", async () => {
    const PROJECT = "vtb_e_proj";
    const PANE = "vtb-e-pane";
    registerActivePane(PROJECT, PANE);
    recentTurns.clear();

    // "o" + "k" (no separator) => joined "ok", trimmed length 2 -> the `length > 2` guard must suppress
    // the draft append for the WHOLE joined turn, even though transcript_text itself is unconditional.
    const fragments = ["o", "k"];
    const joined = "ok";

    const seen = clientMessages.length;
    emitFragments(fragments);
    emitTurnComplete();
    await settle();

    const frames = janusFramesSince(seen);
    assert.strictEqual(frames.length, 1, `expected exactly ONE flush frame, got ${frames.length}: ${JSON.stringify(frames.map((f) => f.text))}`);
    assert.strictEqual(frames[0].text, joined, "the single flushed frame carries the joined (unguarded) text");
    assert.strictEqual(draftText(PROJECT, PANE), undefined, "trimmed joined length <= 2 suppresses the draft append entirely");
  });

  // ── (f) generationComplete behaves like turnComplete as a flush trigger ───────────────────────────
  it("(f) generationComplete (no turnComplete key) flushes the buffer exactly like turnComplete", async () => {
    const PROJECT = "vtb_f_proj";
    const PANE = "vtb-f-pane";
    registerActivePane(PROJECT, PANE);
    recentTurns.clear();

    const fragments = ["Gen", " complete", " test."];
    const joined = "Gen complete test.";

    const seen = clientMessages.length;
    emitFragments(fragments);
    emitGenerationComplete();
    await settle();

    const frames = janusFramesSince(seen);
    assert.strictEqual(frames.length, 1, `generationComplete must flush exactly once, got ${frames.length}: ${JSON.stringify(frames.map((f) => f.text))}`);
    assert.strictEqual(frames[0].text, joined);
    assert.strictEqual(draftText(PROJECT, PANE), undefined, "draft remains untouched");
  });
});
