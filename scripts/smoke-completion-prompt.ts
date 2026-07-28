/**
 * scripts/smoke-completion-prompt.ts — bead o2mf: the live end-to-end exercise of
 * JANUS_AGENT_COMPLETION_PROMPT=on that 05ee335 (spine default → record) explicitly deferred
 * ("it has not been exercised end to end").
 *
 * WHAT IT PROVES, on a REAL running server + REAL Claude pane:
 *   1. A voice-side instruction dispatch (draft_instruction → send_instruction, the production
 *      envelope flow) renders the COMPLETION_REQUEST_LINE and — with the completion prompt on and
 *      the spine at its production default `record` — appends the live exchange's own id as the
 *      prose correlation hint (withExchangeCorrelationHint).
 *   2. The hinted text reaches the real pane (visible in its PTY output).
 *   3. A real Claude agent, given only that prose hint, echoes a structured result envelope.
 *   4. The observe pipeline's scanner picks the envelope up and the exchange settles CORRELATED
 *      (state agent_complete, exchangeId matching the id the hint delivered).
 *
 * WHY THE SCRIPTED LIVE CONNECTOR (JANUS_MOCK_LIVE=1): under the production default
 * JANUS_EXCHANGE_SPINE=record, only the VOICE dispatch path mints an exchange (the workbench
 * draft/send path requires `authoritative`, and the REST dispatch wrapper does not hint). The
 * scripted connector stands in for the Gemini MODEL only — the server, WS auth, tool dispatch,
 * gate, pane, agent, scanner, and settlement are all real. The real-Gemini leg is a separate
 * concern (bead qkyr / verify:live-voice).
 *
 * Run:  npm run smoke:completion-prompt   (requires Claude Code installed + authenticated)
 * Exit: 0 = full correlated round-trip observed; 1 = any leg failed (evidence printed).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { COMPLETION_REQUEST_LINE } from "../src/exchanges/instructionEnvelope";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const PORT = Number(process.env.JANUS_SMOKE_PORT) || 3121;
const TOKEN = "completion-smoke";
const BASE = `http://127.0.0.1:${PORT}`;
const H = { "x-api-token": TOKEN, "Content-Type": "application/json" };
const PROJECT_ID = "default_project";
const PANE_ID = `cpsmoke_${process.pid}`;
const STARTUP_MS = Number(process.env.JANUS_SMOKE_STARTUP_MS) || 60000;
const RESPONSE_MS = Number(process.env.JANUS_SMOKE_RESPONSE_MS) || 120000;

/** The task the real agent performs: echo the hinted id back as a compact result envelope. The
 *  prose deliberately never spells the quoted JSON key (the scanner's prefilter is the QUOTED
 *  key), so the pane's ECHO of this instruction can never be self-parsed as an envelope — only
 *  the agent's own JSON reply can settle the exchange. */
const OBJECTIVE =
  "This is an automated smoke test of completion reporting. Reply with exactly one line and " +
  "nothing else: a compact single-line JSON object with exactly two keys — exchange_id, a string " +
  "holding the id shown in the parenthetical at the very end of this message (after the words " +
  "'this exchange id', copied exactly), and status, the string complete. No code fence, no " +
  "commentary, no extra keys, no line breaks inside the JSON.";

const failures: string[] = [];
function log(...a: unknown[]) { console.log("[smoke:completion]", ...a); }
function ok(cond: boolean, label: string) {
  console.log(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures.push(label);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pollUntil<T>(label: string, capMs: number, stepMs: number, probe: () => Promise<T | null>): Promise<T | null> {
  const deadline = Date.now() + capMs;
  while (Date.now() < deadline) {
    try {
      const v = await probe();
      if (v !== null && v !== undefined) return v;
    } catch { /* transient — keep polling */ }
    await sleep(stepMs);
  }
  log(`TIMEOUT waiting for: ${label}`);
  return null;
}

async function api(pathname: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE}${pathname}`, { ...init, headers: { ...H, ...(init?.headers ?? {}) } });
}

async function paneRecord(): Promise<any | null> {
  const r = await api("/api/terminals");
  if (r.status !== 200) return null;
  const arr = await r.json();
  return Array.isArray(arr) ? (arr.find((t: any) => t.id === PANE_ID) ?? null) : null;
}

function paneText(rec: any): string {
  return `${rec?.backfill ?? ""}${rec?.output ?? ""}`;
}

async function emitFunctionCall(name: string, args: Record<string, unknown>): Promise<boolean> {
  const r = await api("/__scripted_live__/emit", {
    method: "POST",
    body: JSON.stringify({ message: { toolCall: { functionCalls: [{ name, id: `smoke-${name}-${Date.now()}`, args }] } } }),
  });
  return r.status === 200;
}

/** Confirm any pending approval parked for OUR pane (covers a HiTL-postured gate — the smoke's
 *  point is the hint round-trip, not the approval posture, so it approves its own send). */
async function confirmPendingForPane(): Promise<void> {
  const r = await api("/api/actions/pending");
  if (r.status !== 200) return;
  const pending = await r.json();
  if (!Array.isArray(pending)) return;
  for (const a of pending) {
    if ((a.summary || "").includes(PANE_ID) || a.terminalId === PANE_ID || a.paneId === PANE_ID) {
      const c = await api(`/api/actions/${a.id}/confirm`, { method: "POST" });
      log(`confirmed pending action ${a.id} (${a.capability ?? "?"}) → ${c.status}`);
    }
  }
}

function killTree(child: ChildProcess) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: "ignore" });
    else child.kill("SIGTERM");
  } catch { /* best-effort */ }
}

// ── phase helpers (one per numbered smoke step; each reports via ok() and returns what the next
// phase needs, so main() stays a linear sequence under the complexity gate) ─────────────────────

/** 1) boot the REAL server: spine at its production default (record), completion prompt ON. */
async function bootServer(tmp: string, serverLog: string[]): Promise<ChildProcess | null> {
  const server = spawn("npx", ["tsx", "server.ts"], {
    cwd: repoRoot,
    shell: true,
    env: {
      ...process.env,
      PORT: String(PORT),
      API_AUTH_TOKEN: TOKEN,
      JANUS_MOCK_LIVE: "1",
      JANUS_EXCHANGE_SPINE: "record",
      JANUS_AGENT_COMPLETION_PROMPT: "on",
      JANUS_DB: path.join(tmp, "janus.db"),
      JANUS_SETTINGS_PATH: path.join(tmp, ".janus_settings.json"),
      JANUS_INTERACTION_LOG: path.join(tmp, "interaction_log.jsonl"),
    },
  });
  server.stdout?.on("data", (d) => serverLog.push(d.toString()));
  server.stderr?.on("data", (d) => serverLog.push(d.toString()));
  const up = await pollUntil("server REST up", 45000, 500, async () => {
    const r = await api("/api/terminals");
    return r.status === 200 ? true : null;
  });
  ok(up === true, "server booted with spine=record + completion-prompt=on (REST authed)");
  return up ? server : null;
}

/** 2) spawn a REAL Claude pane (confirming the gated create if parked) and wait for TUI settle. */
async function spawnPaneAndSettle(tmp: string): Promise<boolean> {
  const spawnRes = await api("/api/terminals", {
    method: "POST",
    body: JSON.stringify({ terminalId: PANE_ID, cwd: tmp, command: "claude", toolPreset: "Claude Code", permissionsMode: "Full Auto", projectId: PROJECT_ID }),
  });
  ok([200, 202].includes(spawnRes.status), `POST /api/terminals (real claude pane) → ${spawnRes.status}`);
  if (spawnRes.status === 202) { await sleep(500); await confirmPendingForPane(); }

  let lastLen = -1;
  const ready = await pollUntil("claude TUI ready (output quiescent)", STARTUP_MS, 1500, async () => {
    const rec = await paneRecord();
    if (!rec) return null;
    const len = paneText(rec).length;
    const settled = len > 200 && len === lastLen;
    lastLen = len;
    return settled ? true : null;
  });
  ok(ready === true, `claude pane TUI came up and settled (${lastLen} bytes)`);
  return ready === true;
}

/** 3) open the REAL voice /live WS (the scripted connector answers the model side). */
async function openVoiceSession(): Promise<WebSocket> {
  const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/live`, { headers: { Cookie: `auth_token=${TOKEN}` } });
  await new Promise<void>((res, rej) => {
    ws.on("open", () => res());
    ws.on("error", rej);
    setTimeout(() => rej(new Error("voice ws open timeout")), 8000);
  });
  ok(true, "voice /live WS connected (scripted Gemini session established)");
  ws.send(JSON.stringify({ type: "set_active_pane", paneId: PANE_ID }));
  await sleep(750);
  return ws;
}

/** 4) the production envelope flow: draft_instruction → (readiness asserts) → send_instruction. */
async function driveEnvelopeFlow(): Promise<void> {
  ok(await emitFunctionCall("draft_instruction", { objective: OBJECTIVE }), "scripted model called draft_instruction");
  const draftText = await pollUntil("draft mirrored to ledger", 8000, 400, async () => {
    const r = await api(`/api/panes/${PROJECT_ID}/${PANE_ID}/draft`);
    if (r.status !== 200) return null;
    const body = await r.json();
    const text: string = body?.draft?.text ?? body?.text ?? "";
    return text.length > 0 ? text : null;
  });
  ok(!!draftText, "draft rendered + mirrored to the pane's ledger draft");
  ok(!!draftText && draftText.includes(COMPLETION_REQUEST_LINE), "rendered draft contains the COMPLETION_REQUEST_LINE (Claude Code render profile)");

  ok(await emitFunctionCall("send_instruction", {}), "scripted model called send_instruction");
  await sleep(1000);
  await confirmPendingForPane(); // no-op under Full Auto; approves the send under a HiTL posture
}

/** 5) the hint reached the real pane: "(this exchange id: <id>)" in its PTY output. */
async function awaitCorrelationHint(): Promise<string | null> {
  const hintedId = await pollUntil("correlation hint visible in pane output", 20000, 1000, async () => {
    const rec = await paneRecord();
    const m = paneText(rec ?? {}).match(/\(this exchange id: ([A-Za-z0-9._-]+)\)/);
    return m ? m[1] : null;
  });
  ok(!!hintedId, `delivered text carried the correlation hint (exchange id: ${hintedId ?? "NOT FOUND"})`);
  return hintedId;
}

/** 6) the real agent echoes the envelope; the scanner settles the exchange. */
async function awaitSettlement(): Promise<any | null> {
  return pollUntil("exchange settles agent_complete", RESPONSE_MS, 2000, async () => {
    const r = await api("/api/fleet/exchange-summary");
    if (r.status !== 200) return null;
    const body = await r.json();
    const s = body?.summaries?.[PANE_ID];
    const rec = await paneRecord();
    if (s) log(`  exchange ${s.exchangeId} state=${s.state} paneStatus=${rec?.status ?? "?"}${s.resultSummary ? ` result=${JSON.stringify(s.resultSummary)}` : ""}`);
    return s && s.state === "agent_complete" ? s : null;
  });
}

/** Evidence either way: the agent's actual PTY tail + the exchange's replay timeline. */
async function dumpEvidence(settled: any | null, hintedId: string | null): Promise<void> {
  const rec = await paneRecord();
  const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1B\][^\x07]*\x07/g, "");
  log("pane tail:\n" + stripAnsi(paneText(rec ?? {})).slice(-1800));
  const replayId = settled?.exchangeId ?? hintedId;
  if (!replayId) return;
  const replay = await api(`/api/exchanges/${replayId}/replay`);
  if (replay.status === 200) {
    log(`replay timeline${settled ? "" : " (timeout diagnostics)"}:`, JSON.stringify(await replay.json()).slice(0, 2000));
  }
}

/** Repo-root hygiene (adversarial-review Finding 4): the DB/settings/interaction-log are pinned
 *  into tmp, but pane scrollback and HistoryManager resolve at process.cwd() with no env knob.
 *  The scrollback file is namespaced by this run's unique PANE_ID (always ours — delete);
 *  .janus_history.json is shared, so delete it only when THIS run created it, and warn about the
 *  co-mingled entry otherwise. */
function cleanRepoRootArtifacts(hadHistoryFile: boolean): void {
  try { fs.rmSync(path.join(repoRoot, `.janus_scrollback_${PANE_ID}.log`), { force: true }); } catch { /* best-effort */ }
  const historyPath = path.join(repoRoot, ".janus_history.json");
  if (!hadHistoryFile) {
    try { fs.rmSync(historyPath, { force: true }); } catch { /* best-effort */ }
  } else if (fs.existsSync(historyPath)) {
    log(`note: ${historyPath} pre-existed — this smoke's pane history entry is co-mingled in it (harmless, keyed by ${PANE_ID}).`);
  }
}

async function teardown(tmp: string, server: ChildProcess | undefined, ws: WebSocket | undefined, serverLog: string[], hadHistoryFile: boolean): Promise<never> {
  try { ws?.close(); } catch { /* best-effort */ }
  try { await api(`/api/terminals/${PANE_ID}`, { method: "DELETE" }); } catch { /* best-effort */ }
  await sleep(500);
  if (server) killTree(server);
  await sleep(500);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  cleanRepoRootArtifacts(hadHistoryFile);
  if (failures.length > 0) {
    log(`FAILED (${failures.length}):`);
    for (const f of failures) log(`  ✗ ${f}`);
    log("server log tail:\n" + serverLog.join("").slice(-3000));
  } else {
    log("PASS: completion-prompt correlated round-trip verified end to end on a real pane.");
  }
  process.exit(failures.length === 0 ? 0 : 1);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "janus-cpsmoke-"));
  const serverLog: string[] = [];
  const hadHistoryFile = fs.existsSync(path.join(repoRoot, ".janus_history.json"));
  let server: ChildProcess | undefined;
  let ws: WebSocket | undefined;

  try {
    server = (await bootServer(tmp, serverLog)) ?? undefined;
    if (server && (await spawnPaneAndSettle(tmp))) {
      ws = await openVoiceSession();
      await driveEnvelopeFlow();
      const hintedId = await awaitCorrelationHint();
      const settled = await awaitSettlement();
      ok(!!settled, "exchange settled agent_complete from the agent's echoed result envelope");
      if (settled && hintedId) {
        ok(settled.exchangeId === hintedId, `settled exchange id matches the hinted id (${settled.exchangeId} === ${hintedId}) — CORRELATED settlement`);
      }
      await dumpEvidence(settled, hintedId);
    }
  } catch (e) {
    ok(false, `unhandled error: ${(e as Error).message}`);
  } finally {
    await teardown(tmp, server, ws, serverLog, hadHistoryFile);
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((e) => { console.error("[smoke:completion] ERROR:", e); process.exit(1); });
}
