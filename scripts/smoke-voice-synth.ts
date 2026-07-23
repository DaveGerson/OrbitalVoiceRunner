/**
 * Live-spawn smoke for the synthetic voice operator lane (bead wsm-e2e-pinned-t5hb).
 *
 * Exercises the end-to-end synthetic voice pipeline: key resolution (Unit 4) -> server boot ->
 * WebSocket live session -> Unit 1 score turn taking (Unit 2 conductor) -> SAPI TTS rendering (Unit 3).
 *
 * Exit 0 = PASS (all four synthetic scores completed and structural assertions matched).
 * Exit 1 = FAIL (a scenario failed after retry, or server boot failed, or wall cap exceeded).
 * Exit 2 = SKIP (no Gemini API key resolved from environment or Windows Credential Manager).
 *
 *   npm run smoke:voice-synth
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

import { resolveGeminiKey, describeKeyResult, type KeyResult } from "../src/voice/synthLane/keySource";
import { SCORES, type Score, type ScoreName } from "../src/voice/synthLane/scores";
import { createConductor, type Conductor, type Outcome } from "../src/voice/synthLane/conductor";
import {
  renderUtteranceToWav,
  wavToPcm,
  padTrailingSilence,
  chunkToFrames,
  frameToBase64,
} from "../src/voice/synthLane/ttsRenderer";
import { teardownServerSuite } from "../tests/helpers/teardown";

export interface SmokeDeps {
  env?: Record<string, string | undefined>;
  setEnv?: (key: string, val: string) => void;
  resolveKey?: (opts?: any) => Promise<KeyResult>;
  log?: (line: string) => void;
  startServer?: (opts?: any) => Promise<any>;
  teardownServer?: (running: any) => Promise<void>;
  runScore?: (
    scoreName: ScoreName,
    score: Score,
    running: any,
    deps: SmokeDeps
  ) => Promise<{ ok: boolean; reason?: string }>;
}

class StubTerminal {
  lastCommand = "";
  writeInputCalls = 0;
  permissionsMode: "Full Auto" | "Human-in-the-Loop" | "Read-Only" = "Human-in-the-Loop";
  status: "Running" | "Exited" | "Idle" = "Running";
  projectId = "synth_proj";
  cwd = "/stub/cwd";
  runtimeType: "interactive_cli" | "shell" = "interactive_cli";
  toolPreset = "Claude Code";
  sessionId = "stub-session";
  contextSize = 0;
  lastStatusChangeAt = Date.now();
  constructor(public terminalId: string) {}
  writeInput(command: string) {
    this.lastCommand = command;
    this.writeInputCalls += 1;
    this.status = "Running";
  }
  getRecentOutput(_lines = 10): string { return ""; }
  consumeDelta(): { lines: string; dropped: number } { return { lines: "", dropped: 0 }; }
  setPermissionsMode(mode: "Full Auto" | "Human-in-the-Loop" | "Read-Only") { this.permissionsMode = mode; }
  async stop() { this.status = "Exited"; }
}

function registerActivePane(
  running: any,
  projectId: string,
  paneId: string,
  capabilityGates?: Record<string, string>,
): void {
  if (!running?.manager?.ledger) return;
  running.manager.ledger.activeProjectId = projectId;
  if (!running.manager.ledger.getProject(projectId)) {
    running.manager.ledger.addProject(projectId, "/stub/cwd", `${projectId} fixture project`);
  }
  // Gate arming rides the pane record itself (review fix): pane.capabilityGates is the per-pane
  // override the gate matrix reads (see set_pane_gates, src/actions/defs/locks.ts) — the previous
  // approach (session.emitToolCall) only exists on the MOCK live session and was a silent no-op
  // against the real connector, so the approval score could never arm.
  running.manager.ledger.updatePane(projectId, {
    pane_id: paneId, name: paneId, runtime_type: "interactive_cli",
    last_known_state: "Running active command", is_busy: true, alive: true,
    notes: [], permissions_mode: "Human-in-the-Loop", session_id: "stub-session",
    tool_preset: "Claude Code", context_size: 0,
    ...(capabilityGates ? { capabilityGates } : {}),
  } as any, true);
  running._testSetActivePane?.(paneId);

  const stub = new StubTerminal(paneId);
  if (running.manager.terminals) {
    (running.manager.terminals as any)[paneId] = stub;
  }
}

function checkSpike(outcome: Outcome): { ok: boolean; reason?: string } {
  return outcome.userTranscripts >= 1
    ? { ok: true }
    : { ok: false, reason: `spike requires >=1 User transcript_text, got ${outcome.userTranscripts}` };
}

function checkDictation(outcome: Outcome): { ok: boolean; reason?: string } {
  // DETERMINISTIC assertion (keyed-run incident 2026-07-22, run 5): assert on OPERATOR ASR
  // landing across both turns — that is the real multi-turn-dictation invariant and it always
  // holds (the server transcribes whatever we speak). The model's spoken reply is NOT asserted:
  // it legitimately varies run-to-run between speaking and acting (tool call), so gating on
  // janusTranscripts made the smoke flaky. Coalescing of model speech is already pinned
  // deterministically by tests/test_voice_thought_buffer.ts; the live lane proves the pipe.
  return outcome.userTranscripts >= 2
    ? { ok: true }
    : { ok: false, reason: `dictation requires >=2 operator (User) transcripts across the two turns, got ${outcome.userTranscripts}` };
}

function checkApproval(outcome: Outcome): { ok: boolean; reason?: string } {
  return outcome.approvalResolved && outcome.approvalResolvedCount >= 1
    ? { ok: true }
    : { ok: false, reason: `approval requires approval_resolved outcome approved, got resolved=${outcome.approvalResolved}` };
}

function checkBargein(outcome: Outcome): { ok: boolean; reason?: string } {
  return outcome.interrupted && outcome.interruptedCount >= 1 && outcome.janusTranscripts >= 1
    ? { ok: true }
    : { ok: false, reason: `bargein requires interrupted frame and partial Janus transcript, got interrupted=${outcome.interrupted}, janusTranscripts=${outcome.janusTranscripts}` };
}

const SCORE_CHECKERS: Record<ScoreName, (outcome: Outcome) => { ok: boolean; reason?: string }> = {
  spike: checkSpike,
  dictation: checkDictation,
  approval: checkApproval,
  bargein: checkBargein,
};

function checkStructuralAssertions(scoreName: ScoreName, outcome: Outcome): { ok: boolean; reason?: string } {
  if (outcome.status !== "DONE") {
    return { ok: false, reason: outcome.failureReason || `Status is ${outcome.status} (expected DONE)` };
  }
  return SCORE_CHECKERS[scoreName](outcome);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function renderAndSendAudio(ws: WebSocket, text: string): Promise<void> {
  const tmpFile = nodePath.join(os.tmpdir(), `synth_utt_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`);
  try {
    await renderUtteranceToWav(text, tmpFile);
    const wavBuf = fs.readFileSync(tmpFile);
    const pcm = wavToPcm(wavBuf);
    // >= 800ms trailing silence (plan requirement — review fix, was 400): Gemini VAD needs the
    // sustained gap to end-point the utterance; too short and the turn never closes.
    const padded = padTrailingSilence(pcm, 800);
    const frames = chunkToFrames(padded, 4096);
    for (const frame of frames) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "audio", audio: frameToBase64(frame) }));
        await sleep(256);
      }
    }
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* best-effort */ }
  }
}

function connectWs(url: string, headers: Record<string, string>): Promise<WebSocket> {
  const ws = new WebSocket(url, { headers });
  return new Promise<WebSocket>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("WebSocket connection timeout")), 10000);
    ws.once("open", () => { clearTimeout(timeout); resolve(ws); });
    ws.once("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

async function closeWs(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
    await new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
      try { ws.close(); } catch { resolve(); }
    });
  }
}

async function runConductorLoop(conductor: Conductor, ws: WebSocket): Promise<void> {
  // Utterances are CHAINED, never dropped (review fix): the conductor emits each utterance
  // exactly once (fire-once guards), so a command that arrived while a previous render was
  // still streaming would have been silently lost forever under a "skip if busy" guard.
  let audioChain: Promise<void> = Promise.resolve();
  const deadline = Date.now() + 120_000; // per-score ceiling; the 5-min wall cap is the backstop

  while (Date.now() < deadline) {
    conductor.onClock(Date.now());
    const cmd = conductor.step();

    if ((cmd.type === "START_UTTERANCE" || cmd.type === "BARGE_IN") && cmd.text) {
      const text = cmd.text;
      audioChain = audioChain.then(() => renderAndSendAudio(ws, text)).catch(() => { /* fail-soft; assertions decide */ });
    } else if (cmd.type === "SCENARIO_DONE" || cmd.type === "SCENARIO_FAILED") {
      await audioChain;
      break;
    }

    await sleep(50);
  }
}

async function defaultRunScore(
  scoreName: ScoreName,
  score: Score,
  running: any,
  _deps: SmokeDeps
): Promise<{ ok: boolean; reason?: string }> {
  const projectId = `synth_proj_${scoreName}`;
  const paneId = `synth_pane_${scoreName}`;
  registerActivePane(
    running, projectId, paneId,
    scoreName === "approval" ? { write_to_pane: "Ask" } : undefined,
  );

  const token = process.env.API_AUTH_TOKEN;
  const ws = await connectWs(`ws://127.0.0.1:${running.port}/live`, { Cookie: `auth_token=${token}` });
  const conductor = createConductor(score, { quiescenceMs: 1200, maxTurnMs: 45_000 });

  const firstFrame = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 15_000); // proceed anyway if the server stays silent
    ws.once("message", () => { clearTimeout(timer); resolve(); });
  });
  ws.on("message", (data) => {
    try {
      conductor.onFrame(JSON.parse(data.toString()));
    } catch {
      /* ignore non-JSON */
    }
  });

  // Re-assert focus over the REAL wire protocol, but only once the server is provably
  // LISTENING (keyed-run incident #3, 2026-07-22): the voice connection handler binds its
  // message listener only AFTER `await doInitialConnect()` (the 1-2s Gemini connect), so a
  // set_active_pane sent right at open arrives listener-less and is silently dropped — while
  // the pre-connect _testSetActivePane call races the PREVIOUS score's server-side close
  // handler, which nulls activePaneId ("no UI connected -> no write permitted"). The first
  // inbound frame proves doInitialConnect completed, so the listener is bound (250ms grace
  // for the same-tick window); the frame is exactly what the browser client sends
  // (src/voice/index.ts:2566) and propose_command's active-pane guard then passes.
  await firstFrame;
  await sleep(250);
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "set_active_pane", paneId }));
  }

  await runConductorLoop(conductor, ws);
  // Drain window: Gemini's inputTranscription of OUR utterance can arrive after the model
  // turn already quiesced (turn-over fires on the model's side, not the ASR echo's). The
  // outcome counters accumulate in onFrame independent of the state machine, so a short
  // drain before closing lets stragglers land and keeps the spike assertion honest.
  await sleep(4000);
  await closeWs(ws);

  return checkStructuralAssertions(scoreName, conductor.outcome());
}

function setupEnv(keyResult: KeyResult, env: Record<string, string | undefined>, setEnv: (k: string, v: string) => void, log: (l: string) => void): void {
  log(`[smoke:voice-synth] Resolved key source: ${keyResult.source}`);
  setEnv("GEMINI_API_KEY", keyResult.key!);
  setEnv("JANUS_CAPTURE_LIVE_TRACES", "1");
  // MUST be set before the first ../server import (review fix): server.ts's module tail
  // auto-starts a REAL server on :3000 when this guard is absent — the epic01/PR#137 failure
  // class (rogue second server, or process.exitCode poisoned when :3000 is already held).
  setEnv("JANUS_NO_AUTOSTART", "1");
  if (!env.API_AUTH_TOKEN) {
    setEnv("API_AUTH_TOKEN", crypto.randomUUID());
  }
}

// Set by the real boot path only (never by injected test seams): the smoke chdirs into a fresh
// temp dir before the server import so the in-process server roots its JanusStore (.janus.db)
// and .janus_traces/ THERE — never in the operator's real repo checkout (review fix: booting
// from the repo root would mutate the operator's actual ledger DB with synth panes/projects).
let smokeWorkDir: string | null = null;
let prevCwd: string | null = null;

async function defaultBootServer(opts: any): Promise<any> {
  prevCwd = process.cwd();
  smokeWorkDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "janus-voice-synth-"));
  process.chdir(smokeWorkDir);
  const serverMod = await import("../server.js");
  return serverMod.startServer(opts);
}

async function defaultTeardownServer(srv: any): Promise<void> {
  await teardownServerSuite(srv);
  if (prevCwd) {
    process.chdir(prevCwd);
    prevCwd = null;
  }
}

async function runScoreWithRetry(
  scoreName: ScoreName,
  runnerFn: SmokeDeps["runScore"] & {},
  running: any,
  deps: SmokeDeps,
  log: (line: string) => void
): Promise<{ ok: boolean; reason?: string }> {
  const score = SCORES[scoreName];
  log(`[smoke:voice-synth] Running scenario: ${scoreName}`);

  let res = await runnerFn(scoreName, score, running, deps);
  if (!res.ok) {
    log(`[smoke:voice-synth] Scenario ${scoreName} failed (${res.reason}), retrying once...`);
    res = await runnerFn(scoreName, score, running, deps);
  }
  if (!res.ok) {
    log(`[smoke:voice-synth] Scenario ${scoreName} FAILED: ${res.reason}`);
  } else {
    log(`[smoke:voice-synth] Scenario ${scoreName} PASSED`);
  }
  return res;
}

async function runScoreLoop(
  scoreNames: ScoreName[],
  runnerFn: SmokeDeps["runScore"] & {},
  running: any,
  deps: SmokeDeps,
  log: (line: string) => void,
  isTimedOut: () => boolean
): Promise<string[]> {
  const failures: string[] = [];
  for (const scoreName of scoreNames) {
    if (isTimedOut()) {
      failures.push("Execution exceeded 5-minute wall cap");
      break;
    }
    const res = await runScoreWithRetry(scoreName, runnerFn, running, deps, log);
    if (!res.ok) {
      failures.push(`${scoreName}: ${res.reason}`);
      break;
    }
  }
  return failures;
}

interface ResolvedDeps {
  env: Record<string, string | undefined>;
  setEnv: (k: string, v: string) => void;
  log: (l: string) => void;
  resolver: (opts?: any) => Promise<KeyResult>;
  bootServer: (opts?: any) => Promise<any>;
  teardown: (srv: any) => Promise<void>;
  runnerFn: (
    scoreName: ScoreName,
    score: Score,
    running: any,
    deps: SmokeDeps
  ) => Promise<{ ok: boolean; reason?: string }>;
}

function resolveDeps(deps: SmokeDeps): ResolvedDeps {
  let env = process.env;
  if (deps.env) env = deps.env;

  let setEnv = (k: string, v: string) => { process.env[k] = v; };
  if (deps.setEnv) setEnv = deps.setEnv;

  let log = (line: string): void => { process.stdout.write(line + "\n"); };
  if (deps.log) log = deps.log;

  let resolver = resolveGeminiKey;
  if (deps.resolveKey) resolver = deps.resolveKey;

  let bootServer = defaultBootServer;
  if (deps.startServer) bootServer = deps.startServer;

  let teardown = defaultTeardownServer;
  if (deps.teardownServer) teardown = deps.teardownServer;

  let runnerFn = defaultRunScore;
  if (deps.runScore) runnerFn = deps.runScore;

  return { env, setEnv, log, resolver, bootServer, teardown, runnerFn };
}

async function executeScenarios(
  d: ResolvedDeps,
  running: any,
  deps: SmokeDeps,
  log: (l: string) => void
): Promise<string[]> {
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; }, 5 * 60 * 1000);
  let failures: string[] = [];
  try {
    failures = await runScoreLoop(["spike", "dictation", "approval", "bargein"], d.runnerFn, running, deps, log, () => timedOut);
  } finally {
    clearTimeout(timer);
    if (running) {
      await d.teardown(running);
    }
  }
  return failures;
}

function isKeyMissing(keyResult: KeyResult): boolean {
  return !keyResult.found || !keyResult.key;
}

function logSkip(keyResult: KeyResult, log: (l: string) => void): void {
  const desc = describeKeyResult(keyResult);
  const sourceStr = desc.source ? desc.source : "none";
  log(`[smoke:voice-synth] SKIP — no Gemini API key resolved (source: ${sourceStr})`);
}

async function tryBootServer(d: ResolvedDeps): Promise<{ running: any; error?: string }> {
  try {
    const running = await d.bootServer({ port: 0, enableVite: false });
    return { running };
  } catch (err: any) {
    const msg = err && err.message ? err.message : String(err);
    return { running: null, error: msg };
  }
}

export async function main(deps: SmokeDeps = {}): Promise<number> {
  const d = resolveDeps(deps);
  const keyResult = await d.resolver({ env: d.env });

  if (isKeyMissing(keyResult)) {
    logSkip(keyResult, d.log);
    return 2;
  }

  setupEnv(keyResult, d.env, d.setEnv, d.log);

  const boot = await tryBootServer(d);
  if (boot.error) {
    d.log(`[smoke:voice-synth] FAIL — Server boot failed: ${boot.error}`);
    return 1;
  }

  const failures = await executeScenarios(d, boot.running, deps, d.log);
  if (smokeWorkDir) {
    d.log(`[smoke:voice-synth] Raw traces (UNREDACTED — run scripts/redact-trace.mjs before committing): ${nodePath.join(smokeWorkDir, ".janus_traces")}`);
  }
  if (failures.length > 0) {
    d.log(`[smoke:voice-synth] FAIL — ${failures.join("; ")}`);
    return 1;
  }

  d.log("[smoke:voice-synth] PASS — all voice synthetic scenarios completed cleanly.");
  return 0;
}

const INVOKED_DIRECTLY =
  process.argv[1] != null && nodePath.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (INVOKED_DIRECTLY) {
  main().then((code) => process.exit(code)).catch((e) => {
    process.stdout.write(`[smoke:voice-synth] ERROR ${e?.stack ?? e}\n`);
    process.exit(1);
  });
}
