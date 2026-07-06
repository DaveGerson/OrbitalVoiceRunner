/**
 * Live Gemini voice verification — bead wsm-e2e-pinned-vpy1.
 *
 * Hands-free Gemini Live voice (real ASR + speakGate + voice approvals + degradation) has only
 * ever been exercised against fixtures (tests/test_live_transcripts.ts, tests/test_speak_gate.ts)
 * or a fully mocked liveConnector (scripts/simulate-voice.ts). Nothing exercises a REAL
 * `ai.live.connect()` session end to end, so a full-stack review could only ever say
 * "audited by code," never "observed live." This script closes that gap for everything that does
 * NOT require a physical microphone or speaker:
 *
 *   1. Transcript channel — a canned PCM16 clip round-trips through Gemini's real ASR and the
 *      operator utterance arrives on the client WS as `{type:"transcript_text", sender:"User"}`
 *      (src/voice/index.ts handleOperatorUtterance / src/liveTranscripts.ts inputTranscription).
 *   2. speakGate — a "thinking aloud" clip is muted (a `speak_gate` action-log entry appears)
 *      once `voiceAi.silenceGate` is on.
 *   3. Voice-driven approval — best-effort: asks the REAL model (by voice) to run a command on a
 *      Human-in-the-Loop pane, and if it actually calls `propose_command` (real-model tool
 *      selection is inherently nondeterministic — this is NOT guaranteed every run), confirms the
 *      resulting pending approval clears after a spoken "approve it". If the model never calls the
 *      tool for this phrasing, this step is reported INCONCLUSIVE (not a hard failure) rather than
 *      falsely claiming automation over LLM behavior this script does not control. The mechanical
 *      approval-resolution logic itself is deterministically covered by tests/test_approvals_wse.ts.
 *   4. Degradation signal — flip Settings to a deliberately invalid Gemini key and open a fresh
 *      voice session: the resulting `voice_channel_lost` broadcast (src/voice/index.ts:805) is the
 *      exact signal the UI shows the operator on any real disconnect — reachable without severing
 *      a live network link mid-session.
 *
 * What this CANNOT verify (irreducibly manual — see docs/runbooks/live-voice-verify.md):
 *   - Browser getUserMedia mic capture and its audio encode path.
 *   - Actual speaker playback / audible confirmation that muting truly silences audio.
 *   - Subjective audio quality / latency "feel".
 *
 * COST WARNING: with GEMINI_API_KEY set, this makes real, metered Gemini Live API calls (several
 * short live sessions per run). Do not wire this into predev/setup/test — it is opt-in only,
 * exactly like verify:agy-resume and verify:modeswitch:agy.
 *
 * Run:  GEMINI_API_KEY=<real key> npm run verify:live-voice
 * Exit: 0 = all mandatory checks passed (voice approval may be INCONCLUSIVE and still exit 0).
 *       2 = transcript channel did not round-trip (ASR text never arrived / didn't fuzzy-match).
 *       3 = speakGate assertion failed (no mute entry for the thinking-aloud clip).
 *       4 = a pending approval WAS created but never resolved by the "approve it" voice clip
 *           (a real behavioral failure, distinct from the model simply not calling the tool).
 *       5 = degradation signal (voice_channel_lost) missing on a bad-key connect.
 *       0 (SKIP) = no GEMINI_API_KEY in the environment — never fails CI for lacking a live key.
 *       1 = harness/setup error.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocket } from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(here, "..", "tests", "fixtures", "voice");
const RUNBOOK = "docs/runbooks/live-voice-verify.md";

function log(...a: unknown[]) {
  console.log("[live-voice]", ...a);
}

function skip(reason: string): never {
  log(`SKIP: ${reason}`);
  log(`SKIP: no live Gemini call was made. For the manual/mic checklist see ${RUNBOOK}.`);
  process.exit(0);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// WAV -> raw PCM16. Scans chunks rather than assuming a fixed 44-byte header —
// the SAPI-generated fixtures carry an 18-byte fmt chunk, not the "classic" 16-byte one.
// ---------------------------------------------------------------------------
function pcm16FromWav(buf: Buffer): Buffer {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file");
  }
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "data") return buf.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2); // chunks are word-aligned
  }
  throw new Error("no data chunk found in WAV");
}

function loadFixture(name: string): Buffer {
  return pcm16FromWav(fs.readFileSync(path.join(FIXTURES_DIR, name)));
}

/** Feed a PCM16 clip in ~100ms chunks, roughly mirroring realtime mic pacing. */
async function streamAudio(client: WebSocket, pcm: Buffer): Promise<void> {
  const BYTES_PER_CHUNK = 3200; // 16kHz * 2 bytes/sample * 0.1s
  for (let i = 0; i < pcm.length; i += BYTES_PER_CHUNK) {
    client.send(JSON.stringify({ type: "audio", audio: pcm.subarray(i, i + BYTES_PER_CHUNK).toString("base64") }));
    await sleep(100);
  }
  await sleep(1500); // let Gemini's VAD register end-of-turn before we start waiting on a reply
}

/** Loose, case-insensitive token-overlap match — real ASR output is never byte-exact. */
function fuzzyMatch(actual: string, expected: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  const actualTokens = new Set(norm(actual));
  const expectedTokens = norm(expected);
  if (expectedTokens.length === 0) return false;
  const hits = expectedTokens.filter((t) => actualTokens.has(t)).length;
  return hits / expectedTokens.length >= 0.6;
}

async function waitFor<T>(fn: () => T | undefined | Promise<T | undefined>, timeoutMs = 15000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v !== undefined) return v;
    await sleep(150);
  }
  throw new Error("waitFor timed out");
}

interface Ctx {
  port: number;
  apiToken: string;
  api: (p: string, init?: RequestInit) => Promise<Response>;
}

function connectClient(port: number, apiToken: string): { ws: WebSocket; messages: any[] } {
  const messages: any[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/live`, { headers: { Cookie: `auth_token=${apiToken}` } });
  ws.on("message", (d) => {
    try {
      messages.push(JSON.parse(d.toString()));
    } catch {
      /* ignore non-JSON frames */
    }
  });
  return { ws, messages };
}

async function openWs(ws: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
}

function apiFor(port: number, apiToken: string) {
  return (p: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${port}${p}`, {
      ...init,
      headers: { "content-type": "application/json", "x-api-token": apiToken, ...(init.headers || {}) },
    });
}

// ---------------------------------------------------------------------------
// Check 1 — transcript channel round trip via a real Gemini ASR turn.
// ---------------------------------------------------------------------------
async function checkTranscriptChannel(ctx: Ctx): Promise<void> {
  log("check 1/4: transcript channel (real Gemini ASR round trip)...");
  const { ws, messages } = connectClient(ctx.port, ctx.apiToken);
  await openWs(ws);
  await streamAudio(ws, loadFixture("command-list-panes.wav"));
  const heard = await waitFor(
    () => messages.find((m) => m.type === "transcript_text" && m.sender === "User"),
    20000
  ).catch(() => undefined);
  ws.close();
  if (!heard || !fuzzyMatch(heard.text ?? "", "janus list panes")) {
    log(`FAIL(2) — no transcript_text arrived matching "Janus, list panes". Got: ${JSON.stringify(heard)}`);
    process.exit(2);
  }
  log(`  ok: transcript_text = ${JSON.stringify(heard.text)}`);
}

// ---------------------------------------------------------------------------
// Check 2 — speakGate mutes a thinking-aloud utterance.
// ---------------------------------------------------------------------------
async function checkSpeakGate(ctx: Ctx): Promise<void> {
  log("check 2/4: speakGate mute on a thinking-aloud clip...");
  await ctx.api("/api/settings", { method: "PUT", body: JSON.stringify({ voiceAi: { silenceGate: true } }) });

  const before: any[] = await ctx.api("/api/action-log").then((r) => r.json()).catch(() => []);
  const beforeCount = Array.isArray(before) ? before.length : 0;

  const { ws, messages } = connectClient(ctx.port, ctx.apiToken);
  await openWs(ws);
  await streamAudio(ws, loadFixture("thinking-aloud.wav"));
  await waitFor(() => messages.find((m) => m.type === "transcript_text" && m.sender === "User"), 20000).catch(() => undefined);
  ws.close();

  const after: any[] = await ctx.api("/api/action-log").then((r) => r.json()).catch(() => []);
  const newEntries = Array.isArray(after) ? after.slice(beforeCount) : [];
  const muted = newEntries.some((e) => e?.data?.tag === "speak_gate" && e?.data?.speak === false);
  if (!muted) {
    log("FAIL(3) — expected a speak_gate mute entry in /api/action-log after the thinking-aloud clip; none found.");
    process.exit(3);
  }
  log("  ok: speak_gate mute entry observed");
}

// ---------------------------------------------------------------------------
// Check 3 — best-effort: real-model tool call + voice-driven approval resolution.
// ---------------------------------------------------------------------------
async function checkVoiceApproval(ctx: Ctx, shell: string): Promise<void> {
  log("check 3/4: voice-driven approval resolution (best-effort — depends on real-model tool choice)...");
  await ctx
    .api("/api/terminals", {
      method: "POST",
      body: JSON.stringify({ terminalId: "hitl", projectId: "live-voice-verify", toolPreset: "Custom", command: shell, permissionsMode: "Human-in-the-Loop" }),
    })
    .catch(() => undefined);

  const { ws, messages } = connectClient(ctx.port, ctx.apiToken);
  await openWs(ws);
  await streamAudio(ws, loadFixture("command-list-panes.wav")); // orient the model first
  await waitFor(() => messages.find((m) => m.type === "transcript_text" && m.sender === "User"), 20000).catch(() => undefined);

  const pending = await waitFor(
    () =>
      ctx
        .api("/api/commands/pending")
        .then((r) => r.json())
        .then((list: any[]) => list.find((p) => p.paneId === "hitl" || p.pane_id === "hitl"))
        .catch(() => undefined),
    8000
  ).catch(() => undefined);

  if (!pending) {
    log("  INCONCLUSIVE: the real model did not call propose_command for this run — nothing to approve. " +
      "This is expected LLM-tool-choice variance, not a failure; approval-resolution mechanics are " +
      "deterministically covered by tests/test_approvals_wse.ts.");
    ws.close();
    return;
  }

  await streamAudio(ws, loadFixture("approve-it.wav"));
  const resolved = await waitFor(async () => {
    const list: any[] = await ctx.api("/api/commands/pending").then((r) => r.json()).catch(() => []);
    return list.find((p) => p.messageId === pending.messageId) ? undefined : true;
  }, 15000).catch(() => undefined);
  ws.close();

  if (!resolved) {
    log(`FAIL(4) — pending approval ${pending.messageId} was created but never cleared after the "approve it" voice clip.`);
    process.exit(4);
  }
  log("  ok: pending approval resolved by voice");
}

// ---------------------------------------------------------------------------
// Check 4 — a bad key produces the visible degradation signal (voice_channel_lost).
// Flips manager.settings.secrets.geminiApiKey (read fresh at each connect — see
// resolveSessionKey in src/voice/index.ts) rather than restarting the server, so a
// deliberately invalid-key connect exercises the exact broadcast the UI shows on any
// real disconnect (src/voice/index.ts:805) without needing to sever a live network link.
// ---------------------------------------------------------------------------
async function checkDegradationSignal(ctx: Ctx): Promise<void> {
  log("check 4/4: degradation signal (voice_channel_lost) on an invalid key...");
  await ctx.api("/api/settings", { method: "PUT", body: JSON.stringify({ secrets: { geminiApiKey: "invalid-key-for-verify-live-voice" } }) });
  try {
    const { ws, messages } = connectClient(ctx.port, ctx.apiToken);
    await openWs(ws).catch(() => undefined);
    const lost = await waitFor(() => messages.find((m) => m.type === "voice_channel_lost"), 10000).catch(() => undefined);
    ws.close();
    if (!lost) {
      log("FAIL(5) — expected a voice_channel_lost broadcast on an invalid-key connect; none observed.");
      process.exit(5);
    }
    log(`  ok: voice_channel_lost observed (reason=${lost.reason})`);
  } finally {
    // Restore: fall back to env var by sending the "keep unchanged" sentinel the settings route
    // recognizes (src/appHelpers / server.ts keyKeptUnchanged), so the real env-configured key wins.
    await ctx.api("/api/settings", { method: "PUT", body: JSON.stringify({ secrets: { geminiApiKey: "CONFIGURED_IN_ENV" } }) }).catch(() => undefined);
  }
}

async function main() {
  const key = process.env.GEMINI_API_KEY;
  if (!key || key.trim() === "") {
    skip(
      "GEMINI_API_KEY not set — live Gemini Live verification requires a real key. " +
        `Set GEMINI_API_KEY and re-run, or follow ${RUNBOOK} for the manual/mic checklist.`
    );
  }

  for (const name of ["command-list-panes.wav", "thinking-aloud.wav", "approve-it.wav"]) {
    if (!fs.existsSync(path.join(FIXTURES_DIR, name))) {
      log(`FAIL(1) — missing fixture ${name} under ${FIXTURES_DIR}; see tests/fixtures/voice/README.md.`);
      process.exit(1);
    }
  }

  log("COST WARNING: this makes real, metered Gemini Live API calls (several short sessions).");
  process.env.NODE_ENV = "test";
  process.env.JANUS_NO_AUTOSTART = "1";
  // Run against a throwaway working dir, like scripts/simulate-voice.ts, so this never pollutes the
  // repo with .janus_* runtime files. server.ts must be imported AFTER chdir (module-load-time cwd read).
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-live-voice-"));
  process.chdir(tmpDir);

  // Real connector: import the server WITHOUT installing tests/helpers/mockLive, so
  // src/voice/index.ts's default liveConnector runs the genuine `ai.live.connect(...)`.
  const { startServer, API_AUTH_TOKEN } = await import("../server");
  const running = await startServer({ port: 0, enableVite: false });
  const ctx: Ctx = { port: running.port as number, apiToken: API_AUTH_TOKEN, api: apiFor(running.port as number, API_AUTH_TOKEN) };

  try {
    await checkTranscriptChannel(ctx);
    await checkSpeakGate(ctx);
    await checkVoiceApproval(ctx, process.platform === "win32" ? "cmd.exe" : "/bin/sh");
    await checkDegradationSignal(ctx);
  } finally {
    await running.close().catch(() => undefined);
  }

  log("RESULT: PASS — transcript channel, speakGate, and degradation signal verified live (voice-approval may be INCONCLUSIVE — see above).");
  log(`Manual/mic-only checklist remains — see ${RUNBOOK}.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[live-voice] harness error:", err);
  process.exit(1);
});
