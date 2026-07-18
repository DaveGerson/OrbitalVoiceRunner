// tests/test_trace_replay.ts — BEAD wsm-e2e-pinned-arkr deliverable 4: replay the committed
// incident trace through the REAL server and pin the post-PR-135 (wsm-e2e-pinned-zmu5) contract,
// plus a tap round-trip test proving capture -> replay reproduces identical downstream behavior.
//
// PROVENANCE (fixture): tests/fixtures/traces/incident-2026-07-16-chunked-thought.jsonl is a
// hand-reconstructed RAW envelope for the incident already documented (and already committed) in
// tests/test_voice_thought_buffer.ts / tests/test_convo_scenarios.ts (ixn_mro7cpfy_9, 2026-07-16
// 20:31) — the 10 fragment strings are copied verbatim from those files' existing `fragments`
// constants; nothing new was extracted from a real .janus_interaction_log.jsonl or .janus_traces/
// capture. Full provenance note: tests/fixtures/traces/README.md.
//
// Runner: npx tsx --test --test-force-exit tests/test_trace_replay.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocket } from "ws";
import type { MockLiveHandle, MockLiveSession } from "./helpers/mockLive";
import { teardownServerSuite } from "./helpers/teardown";
import type { RunningServer } from "../server";
import { recentTurns } from "../src/voice/recentTurns";
import { loadTrace, replayTrace, replayTraceFile } from "./helpers/traceReplay";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INCIDENT_TRACE = path.join(HERE, "fixtures", "traces", "incident-2026-07-16-chunked-thought.jsonl");
const JOINED_INCIDENT = "My apologies again. The draft is ready for test-2 now. Say 'send it' to submit.";

// ── shared boot scaffolding (mirrors tests/test_voice_thought_buffer.ts / test_convo_scenarios.ts) ──
async function bootServer(tmpDir: string, opts: { captureTraces?: boolean } = {}): Promise<{
  running: RunningServer;
  mock: MockLiveHandle;
  client: WebSocket;
  clientMessages: any[];
  apiToken: string;
  waitFor: <T>(p: () => T | undefined | false, t?: number, i?: number) => Promise<T>;
}> {
  process.env.NODE_ENV = "test";
  process.env.JANUS_NO_AUTOSTART = "1";
  if (opts.captureTraces) process.env.JANUS_CAPTURE_LIVE_TRACES = "1";
  else delete process.env.JANUS_CAPTURE_LIVE_TRACES;

  const { installMockLive, waitFor } = await import("./helpers/mockLive");
  const serverMod = await import("../server");
  const apiToken = serverMod.API_AUTH_TOKEN;

  const mock = installMockLive();
  const running = await serverMod.startServer({ port: 0, enableVite: false });

  const clientMessages: any[] = [];
  const client = new WebSocket(`ws://127.0.0.1:${running.port}/live`, {
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

  return { running, mock, client, clientMessages, apiToken, waitFor };
}

function registerActivePane(running: RunningServer, projectId: string, paneId: string): void {
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

function draftText(running: RunningServer, projectId: string, paneId: string): string | undefined {
  return running.manager.ledger.getDraft(projectId, paneId)?.text;
}

function agenticBullet(text: string): string {
  return `* **Agentic Thought**: *${text}*`;
}

async function closeClient(client: WebSocket): Promise<void> {
  if (client && client.readyState !== WebSocket.CLOSED) {
    await new Promise<void>((resolve) => {
      client.once("close", () => resolve());
      try { client.terminate(); } catch { resolve(); }
    });
  }
}

// ── (1) replay the committed incident trace => the post-PR-135 contract ────────────────────────
describe("trace replay — committed incident trace reproduces the coalesced-thought contract", () => {
  let running: RunningServer;
  let client: WebSocket;
  let clientMessages: any[];
  let tmpDir: string;
  let prevCwd: string;

  const live = (): MockLiveSession => running._testActiveLiveSession!() as MockLiveSession;

  before(async () => {
    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-trace-replay-"));
    process.chdir(tmpDir);
    ({ running, client, clientMessages } = await bootServer(tmpDir));
  });

  after(async () => {
    await closeClient(client);
    await teardownServerSuite(running);
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("exactly ONE Janus transcript_text frame + ONE Agentic Thought draft bullet, carrying the raw-concatenated sentence", async () => {
    const PROJECT = "trace_replay_proj";
    const PANE = "trace-replay-pane";
    registerActivePane(running, PROJECT, PANE);
    recentTurns.clear();

    const seen = clientMessages.length;
    await replayTraceFile(live(), INCIDENT_TRACE);
    await new Promise((r) => setTimeout(r, 200));

    const janusFrames = clientMessages.slice(seen).filter((m) => m.type === "transcript_text" && m.sender === "Janus");
    assert.strictEqual(janusFrames.length, 1, `expected exactly ONE Janus transcript_text frame, got ${janusFrames.length}: ${JSON.stringify(janusFrames.map((f) => f.text))}`);
    assert.strictEqual(janusFrames[0].text, JOINED_INCIDENT, "the replayed trace reproduces the raw-concatenated incident sentence byte-for-byte");

    assert.strictEqual(draftText(running, PROJECT, PANE), agenticBullet(JOINED_INCIDENT), "exactly one Agentic Thought bullet, holding the joined text");
    assert.strictEqual(recentTurns.size(), 1, "exactly one recentTurns push for the replayed turn");
  });

  it("loadTrace + replayTrace (two-step form) produce the identical outcome as replayTraceFile", async () => {
    const PROJECT = "trace_replay_twostep_proj";
    const PANE = "trace-replay-twostep-pane";
    registerActivePane(running, PROJECT, PANE);
    recentTurns.clear();

    const entries = loadTrace(INCIDENT_TRACE);
    assert.strictEqual(entries.length, 11, "10 outputTranscription fragments + 1 turnComplete");
    entries.forEach((e, i) => assert.strictEqual(e.seq, i, `entry ${i} carries the correct seq`));

    const seen = clientMessages.length;
    await replayTrace(live(), entries);
    await new Promise((r) => setTimeout(r, 200));

    const janusFrames = clientMessages.slice(seen).filter((m) => m.type === "transcript_text" && m.sender === "Janus");
    assert.strictEqual(janusFrames.length, 1);
    assert.strictEqual(janusFrames[0].text, JOINED_INCIDENT);
  });
});

// ── (2) tap round-trip: capture a synthetic session, replay the CAPTURED file, compare outcomes ──
describe("trace replay — tap round-trip (capture with flag ON, then replay the captured file)", () => {
  let running: RunningServer;
  let client: WebSocket;
  let clientMessages: any[];
  let tmpDir: string;
  let prevCwd: string;
  let prevEnv: string | undefined;

  const live = (): MockLiveSession => running._testActiveLiveSession!() as MockLiveSession;

  before(async () => {
    prevEnv = process.env.JANUS_CAPTURE_LIVE_TRACES;
    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-trace-roundtrip-"));
    process.chdir(tmpDir);
    ({ running, client, clientMessages } = await bootServer(tmpDir, { captureTraces: true }));
  });

  after(async () => {
    await closeClient(client);
    await teardownServerSuite(running);
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    if (prevEnv === undefined) delete process.env.JANUS_CAPTURE_LIVE_TRACES;
    else process.env.JANUS_CAPTURE_LIVE_TRACES = prevEnv;
  });

  it("capturing a synthetic turn, then replaying the CAPTURED file into a fresh pane, produces identical downstream frame counts", async () => {
    const ORIGINAL_PROJECT = "roundtrip_original_proj";
    const ORIGINAL_PANE = "roundtrip-original-pane";
    registerActivePane(running, ORIGINAL_PROJECT, ORIGINAL_PANE);
    recentTurns.clear();

    const fragments = ["Round", " trip", " test."];
    const joined = "Round trip test.";

    // Pass 1: drive the ORIGINAL synthetic messages directly. Capture is ON (booted with
    // captureTraces:true), so the tap appends these to .janus_traces/<sessionId>.jsonl as a side
    // effect of the very same real onmessage dispatch this assertion is checking.
    const seenOriginal = clientMessages.length;
    for (const f of fragments) live().emit({ serverContent: { outputTranscription: { text: f } } });
    live().emit({ serverContent: { turnComplete: true } });
    await new Promise((r) => setTimeout(r, 200));

    const originalFrames = clientMessages.slice(seenOriginal).filter((m) => m.type === "transcript_text" && m.sender === "Janus");
    assert.strictEqual(originalFrames.length, 1, "sanity: the original synthetic turn produced exactly one Janus frame");
    assert.strictEqual(originalFrames[0].text, joined);

    // Locate the file the tap just wrote — exactly one trace file for this one connection.
    const traceDir = path.join(tmpDir, ".janus_traces");
    assert.ok(fs.existsSync(traceDir), "the tap must have created .janus_traces/ (capture was ON)");
    const files = fs.readdirSync(traceDir);
    assert.strictEqual(files.length, 1, "exactly one trace file for this one connection");
    const capturedPath = path.join(traceDir, files[0]);

    const capturedEntries = loadTrace(capturedPath);
    assert.strictEqual(capturedEntries.length, fragments.length + 1, "the capture recorded every fragment + the turnComplete, nothing more/less");

    // Pass 2: replay the CAPTURED file (not the original hand-authored messages) into a FRESH
    // project/pane, so its counts cannot be contaminated by pass 1's state.
    const REPLAY_PROJECT = "roundtrip_replay_proj";
    const REPLAY_PANE = "roundtrip-replay-pane";
    registerActivePane(running, REPLAY_PROJECT, REPLAY_PANE);
    recentTurns.clear();

    const seenReplay = clientMessages.length;
    await replayTraceFile(live(), capturedPath);
    await new Promise((r) => setTimeout(r, 200));

    const replayFrames = clientMessages.slice(seenReplay).filter((m) => m.type === "transcript_text" && m.sender === "Janus");
    assert.strictEqual(replayFrames.length, originalFrames.length, "capture -> replay round-trip reproduces an IDENTICAL downstream frame count");
    assert.strictEqual(replayFrames[0].text, originalFrames[0].text, "and identical frame content");
    assert.strictEqual(draftText(running, REPLAY_PROJECT, REPLAY_PANE), agenticBullet(joined), "and an identical single Agentic Thought bullet");
    assert.strictEqual(recentTurns.size(), 1, "and an identical single recentTurns push");
  });
});
