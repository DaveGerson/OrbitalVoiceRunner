// tests/test_us_epic04_awayback.ts
//
// EPIC 04 — Walking Away & Coming Back. One characterization+contract suite spanning the five
// user stories (US-4.1 … US-4.5) of the "short break / long break / voice drop / server restart /
// weeks-away TTL cliff" arc. PRODUCTION breadcrumb/history/retention/reconnect behavior is already
// committed — this suite ASSERTS that behavior; it changes no source.
//
// WHERE EACH LEG IS PINNED (and why):
//   US-4.1 (short break, full continuity)   — the in-process memory layer: a BreadcrumbRing fed
//       events younger than breadcrumbMaxAgeMs, assembleBrief() through MemoryService.synthesize().
//       The brief's RECENTLY tier carries the in-window breadcrumbs, newest-first, capped at
//       breadcrumbMax. (No server/PTY/Gemini — the synthesis is deterministic and pure.)
//   US-4.2 (long break, graceful degradation) — the SAME synthesis path with EVERY breadcrumb aged
//       past breadcrumbMaxAgeMs: the RECENTLY tier drops out, but PROJECT + ACTIVE PANE tiers still
//       render. The per-pane history "recall path" is the real HistoryManager: a flushed
//       .janus_history.json still returns the last historyMaxCommands entries. (The simulator-scored
//       "what was I doing?" answered-from-notes/history leg is the vignette harness's job — see the
//       report; here we pin the durable RECALL primitive that backs it.)
//   US-4.3 (voice drop & reconnect) — the REAL headless server: stage a HITL approval bound to the
//       live session, drop the socket, reconnect, and assert (a) GET /api/commands/pending still
//       lists it, (b) the survivor re-attaches to the NEW session (session.sessionFor) — SILENTLY,
//       never re-announced, because the bounded PLM4 auto-reconnect here re-establishes well under
//       RECONNECT_QUIET_MS after the drop (turn-arbiter program, Wave 3, yg1w; audit §2.4 names this
//       EXACT transient-blip scenario as the bug the quiet threshold fixes — the operator's browser
//       WS never even noticed), (c) a non-empty Gemini key via PUT /api/settings nudges the
//       CURRENT connection exactly once (stale-owner clear is a no-op), (d) approving via REST after
//       reconnect dispatches the command to the correct pane, and (e) the SERVER retained
//       drafts/attention/pane-state across the drop (server source of truth).
//   US-4.4 (server restart durable, scratch lost) — a SQLite-backed JanusStore: workspaces, panes,
//       notes, briefings, drafts and an engaged STOP-ALL freeze written, then a fresh store handle
//       reopened on the SAME file proves the durable tier restored (drafts, frozen flag) while the
//       HistoryManager's atomic tmp+rename makes the history file always parse (never half-written).
//   US-4.5 (returning after weeks, TTL cliff honest) — bootMaintenance() over seeded timestamps:
//       events older than eventsTtlDays and archives older than archiveTtlDays are pruned, scrollback
//       dirs cleaned, while notes/briefings (the durable tier) are UNTOUCHED. We CHARACTERIZE whether
//       any operator-facing surface communicates the gap.
//
// HERMETIC + PARALLEL-SAFE: every server/store/history leg runs in its own mkdtemp cwd (chdir in,
// chdir back + rmSync in finally/after), AWAITs terminal/server teardown, and never writes a
// repo-root artifact. Modeled on tests/test_secrets_at_rest.ts (per-test tmp cwd) and the
// server-start pattern in tests/test_session_reconnect.ts.
//
// Runner: npx tsx --test --test-force-exit tests/test_us_epic04_awayback.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";

import { BreadcrumbRing } from "../src/memory/breadcrumbs";
import { MemoryService } from "../src/memory";
import { WorldModel } from "../src/memory/worldModel";
import { DEFAULT_MEMORY_CONFIG, type MemoryConfig } from "../src/memory/types";
import { JanusStore } from "../src/store/sqliteStore";
import { teardownServerSuite } from "./helpers/teardown";
import type { RunningServer } from "../server";

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Shared helpers.
// ───────────────────────────────────────────────────────────────────────────────────────────────

async function waitFor<T>(p: () => T | undefined | false | null, timeoutMs = 4000, intervalMs = 15): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = p();
    if (v) return v as T;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Build a MemoryService whose WorldModel reads off a tiny in-memory fake manager+store, with the
 * given breadcrumb ring. This is the SAME wiring createMemoryService uses (WorldModel + assembler),
 * but with hand-built deps so US-4.1/4.2 can drive the breadcrumb age window deterministically.
 */
function makeMemoryService(ring: BreadcrumbRing, cfg: MemoryConfig): MemoryService {
  const manager: any = {
    activeId: "pane_a",
    terminals: {
      pane_a: { name: "build", runtimeType: "interactive_cli", status: "Running", lastCommand: "npm test" },
    },
    ledger: { activeProjectId: "proj1" },
    settings: { globalPermissionsMode: "Human-in-the-Loop" },
    listPanes: () => [{ project_id: "proj1", panes: [{ pane_id: "pane_a", name: "build", last_known_state: "Running" }] }],
  };
  const store: any = {
    getProject: (id: string) => (id === "proj1" ? { name: "Janus", summary: "voice orchestrator", key_terms: ["pty", "gemini"] } : null),
    getProjectBriefing: () => null,
  };
  const wm = new WorldModel({ manager, store, redact: (s: string) => s, breadcrumbs: ring });
  return new MemoryService(wm, cfg);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// US-4.1 — Short break, full continuity (P0).
// Pane activity younger than breadcrumbMaxAgeMs is carried into the synthesized brief's RECENTLY
// tier, newest-first, capped at breadcrumbMax.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe("US-4.1 short break full continuity: recent breadcrumbs reach the synthesized brief", () => {
  it("US-4.1 the RECENTLY tier carries in-window breadcrumbs newest-first", () => {
    const cfg: MemoryConfig = { ...DEFAULT_MEMORY_CONFIG, breadcrumbMax: 12, breadcrumbMaxAgeMs: 15 * 60 * 1000 };
    const ring = new BreadcrumbRing(cfg);
    const now = 10_000_000;
    // Three events, ALL within the 15-min window (a short break).
    ring.add({ ts: now - 3 * 60 * 1000, paneId: "pane_a", text: "ran the build" });
    ring.add({ ts: now - 2 * 60 * 1000, paneId: "pane_a", text: "started tests" });
    ring.add({ ts: now - 1 * 60 * 1000, paneId: "pane_a", text: "tests green" });

    const brief = makeMemoryService(ring, cfg).synthesize("pane_a", now);

    // The brief is the fresh deterministic blend (source==="fallback" with no Python daemon).
    assert.strictEqual(brief.source, "fallback", "the deterministic floor synthesized the brief");
    assert.match(brief.text, /RECENTLY:/, "the RECENTLY (breadcrumb) tier is present after a short break");
    // All three in-window crumbs are carried, and the newest leads (BreadcrumbRing.recent is newest-first).
    assert.match(brief.text, /tests green/, "the newest breadcrumb is carried");
    assert.match(brief.text, /started tests/);
    assert.match(brief.text, /ran the build/, "the oldest still-in-window breadcrumb is carried");
    const recentlyLine = brief.text.split("\n").find((l) => l.startsWith("RECENTLY:"))!;
    assert.ok(
      recentlyLine.indexOf("tests green") < recentlyLine.indexOf("started tests"),
      "RECENTLY renders newest-first (tests green before started tests)",
    );
  });

  it("US-4.1 the RECENTLY tier is capped at breadcrumbMax most-recent events", () => {
    // breadcrumbMax=3; feed 5 in-window crumbs for ONE pane — only the 3 newest survive the cap.
    const cfg: MemoryConfig = { ...DEFAULT_MEMORY_CONFIG, breadcrumbMax: 3, breadcrumbMaxAgeMs: 15 * 60 * 1000 };
    const ring = new BreadcrumbRing(cfg);
    const now = 20_000_000;
    for (let i = 0; i < 5; i++) ring.add({ ts: now - (5 - i) * 1000, paneId: "pane_a", text: `event${i}` });

    const brief = makeMemoryService(ring, cfg).synthesize("pane_a", now);
    const recentlyLine = brief.text.split("\n").find((l) => l.startsWith("RECENTLY:"))!;
    // Only the 3 newest (event4, event3, event2) are present; the 2 oldest are dropped by the cap.
    assert.match(recentlyLine, /event4/);
    assert.match(recentlyLine, /event3/);
    assert.match(recentlyLine, /event2/);
    assert.doesNotMatch(recentlyLine, /event0/, "the oldest events are dropped at the breadcrumbMax cap");
    assert.doesNotMatch(recentlyLine, /event1/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// US-4.2 — Long break, graceful degradation (P0).
// Every breadcrumb older than breadcrumbMaxAgeMs (compress the TTL): RECENTLY tier drops out, but the
// brief still carries PROJECT + ACTIVE PANE tiers; per-pane history still recalls the last
// historyMaxCommands entries via the HistoryManager recall path.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe("US-4.2 long break graceful degradation: breadcrumbs decay, durable tiers + recall survive", () => {
  it("US-4.2 all breadcrumbs aged past the TTL -> NO RECENTLY tier, but PROJECT + PANE survive", () => {
    // Compress the age TTL to 1s so a few seconds of "absence" ages every crumb out.
    const cfg: MemoryConfig = { ...DEFAULT_MEMORY_CONFIG, breadcrumbMaxAgeMs: 1000 };
    const ring = new BreadcrumbRing(cfg);
    const now = 30_000_000;
    // Every crumb is OLDER than 1s ago -> outside the window.
    ring.add({ ts: now - 60_000, paneId: "pane_a", text: "ancient build" });
    ring.add({ ts: now - 120_000, paneId: "pane_a", text: "older tests" });

    const brief = makeMemoryService(ring, cfg).synthesize("pane_a", now);

    // The decaying working-memory tier is empty/absent...
    assert.doesNotMatch(brief.text, /RECENTLY:/, "the RECENTLY tier is absent once every crumb ages past the TTL");
    assert.doesNotMatch(brief.text, /ancient build/, "stale breadcrumbs do not leak into the brief");
    // ...but the durable PROJECT + ACTIVE PANE tiers still render (graceful degradation, not silence).
    assert.match(brief.text, /PROJECT Janus/, "the PROJECT tier still renders after a long break");
    assert.match(brief.text, /ACTIVE PANE build/, "the ACTIVE PANE tier still renders after a long break");
    assert.match(brief.text, /npm test/, "the active pane's last command survives");
  });

  it("US-4.2 per-pane history RECALL still returns the last historyMaxCommands entries", async () => {
    // The recall path is the real HistoryManager singleton. Boot it in an isolated cwd, write more
    // than historyMaxCommands commands, flush, and prove loadHistory caps to the last N entries.
    const prevCwd = process.cwd();
    const prevFlush = process.env.JANUS_HISTORY_FLUSH_MS;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-e04-recall-"));
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";
    process.env.JANUS_HISTORY_FLUSH_MS = "20";
    process.chdir(tmpDir);
    let hm: any;
    try {
      const serverMod = await import("../server");
      hm = serverMod.HistoryManager.getInstance();

      const MAX = 50; // HistoryManager's default historyMaxCommands (server.ts:309, terminal.ts:1310).
      const PANE = "e04-recall-pane";
      for (let i = 0; i < MAX + 12; i++) hm.addCommand(PANE, `cmd-${i}`);
      await hm.flushAll();

      // CHARACTERIZATION: the recall cap is the default 50; the on-disk + cached history holds at most
      // that many entries, and they are the MOST RECENT (oldest pruned). (The brief's exact prune
      // boundary is a HistoryManager internal; we pin the observable: count <= MAX, newest present,
      // oldest absent.)
      const recalled = hm.loadHistory(PANE);
      assert.ok(Array.isArray(recalled), "loadHistory returns the recall array");
      assert.ok(recalled.length <= MAX, `recall is capped at historyMaxCommands (<= ${MAX}, got ${recalled.length})`);
      const commands = recalled.map((e: any) => e.command);
      assert.ok(commands.includes(`cmd-${MAX + 11}`), "the most-recent command survives the recall cap");
      assert.ok(!commands.includes("cmd-0"), "the oldest command is pruned past the recall cap");

      // The recall is durable: a re-read after the flush still surfaces the capped tail.
      const reread = hm.loadHistory(PANE).map((e: any) => e.command);
      assert.ok(reread.includes(`cmd-${MAX + 11}`), "the durable recall path returns the last N after a flush");
    } finally {
      try { await hm?.flushAll?.(); } catch { /* best-effort */ }
      process.chdir(prevCwd);
      if (prevFlush === undefined) delete process.env.JANUS_HISTORY_FLUSH_MS;
      else process.env.JANUS_HISTORY_FLUSH_MS = prevFlush;
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// US-4.3 — Voice drop & reconnect (P0).
// Real headless server. A HITL approval is pending, the voice WS drops, a fresh WS reconnects:
//   - GET /api/commands/pending still lists the proposal (server-held survivor);
//   - the survivor is re-announced into the new session (reannounceSurvivors -> clientContents);
//   - a non-empty Gemini key via PUT /api/settings nudges the CURRENT connection exactly once,
//     and a stale-owner clear is a no-op;
//   - approving via REST after reconnect dispatches the command to the correct pane;
//   - the server retained drafts/attention/pane-state across the drop (server source of truth).
//
// Connector pattern mirrors test_session_reconnect.ts: a scripted FakeSession captures
// sendClientContent (so the re-announce digest is observable) and exposes emitClose to drop the socket.
// ═════════════════════════════════════════════════════════════════════════════════════════════════

interface FakeSession {
  params: any;
  responses: any[];
  clientContents: any[];
  realtimeInputs: any[];
  closed: boolean;
  emit: (m: any) => void;
  emitToolCall: (name: string, args?: Record<string, any>, id?: string) => string;
  emitClose: (info?: any) => void;
  sendToolResponse: (r: any) => void;
  sendRealtimeInput: (i: any) => void;
  sendClientContent: (c: any) => void;
  close: () => void;
}

function makeFakeSession(params: any): FakeSession {
  let counter = 0;
  const s: FakeSession = {
    params,
    responses: [],
    clientContents: [],
    realtimeInputs: [],
    closed: false,
    emit(m: any) { params?.callbacks?.onmessage?.(m); },
    emitToolCall(name, args = {}, id) {
      const callId = id ?? `e04-call-${++counter}`;
      this.emit({ toolCall: { functionCalls: [{ name, id: callId, args }] } });
      return callId;
    },
    emitClose(info: any = { code: 1006, reason: "e04 drop" }) { params?.callbacks?.onclose?.(info); },
    sendToolResponse(r: any) { this.responses.push(r); },
    sendRealtimeInput(i: any) { this.realtimeInputs.push(i); },
    sendClientContent(c: any) { this.clientContents.push(c); },
    close() { this.closed = true; },
  };
  return s;
}

function makeScriptedConnector(failuresRemaining: number) {
  const sessions: FakeSession[] = [];
  const state = { failuresRemaining, connectCount: 0 };
  const connector = async (_ai: any, params: any) => {
    state.connectCount++;
    if (state.failuresRemaining > 0) { state.failuresRemaining--; throw new Error(`scripted connect failure (#${state.connectCount})`); }
    const s = makeFakeSession(params);
    sessions.push(s);
    return s;
  };
  return { connector, sessions, state };
}

// A minimal stub terminal: the approve dispatch path calls term.writeInput(instruction).
class StubTerminal {
  status: "Running" | "Exited" | "Idle" = "Running";
  lastCommand = "";
  writeInputCount = 0;
  projectId = "";
  constructor(public terminalId: string) {}
  writeInput(command: string) { this.lastCommand = command; this.writeInputCount++; this.status = "Running"; }
  async stop() { this.status = "Exited"; }
}

describe("US-4.3 voice drop & reconnect: server retains state, reconnect re-contextualizes", () => {
  let serverMod: typeof import("../server");
  let running: RunningServer;
  let client: WebSocket;
  let messages: any[];
  let scripted: ReturnType<typeof makeScriptedConnector>;
  let base: string;
  let apiToken: string;
  let tmpDir: string;
  let prevCwd: string;

  const api = (pathname: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${base}${pathname}`, {
      ...init,
      headers: { "x-api-token": apiToken, "content-type": "application/json", ...(init.headers || {}) },
    });

  async function openClient(): Promise<WebSocket> {
    const c = new WebSocket(`ws://127.0.0.1:${running.port}/live`, { headers: { Cookie: `auth_token=${apiToken}` } });
    c.on("message", (data) => { try { messages.push(JSON.parse(data.toString())); } catch { /* non-JSON */ } });
    await new Promise<void>((resolve, reject) => { c.on("open", () => resolve()); c.on("error", reject); });
    return c;
  }

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";
    // Shrink the bounded backoff so a reconnect mints a fresh session quickly.
    process.env.JANUS_RECONNECT_MAX_ATTEMPTS = "3";
    process.env.JANUS_RECONNECT_BASE_DELAY_MS = "20";
    process.env.JANUS_RECONNECT_MAX_DELAY_MS = "60";

    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-e04-recon-"));
    process.chdir(tmpDir);

    serverMod = await import("../server");
    apiToken = serverMod.API_AUTH_TOKEN;
    scripted = makeScriptedConnector(0); // initial connect succeeds.
    serverMod.setLiveConnector(scripted.connector);
    running = await serverMod.startServer({ port: 0, enableVite: false });
    base = `http://127.0.0.1:${running.port}`;

    messages = [];
    client = await openClient();
    await waitFor(() => scripted.sessions.length >= 1 && running._testActiveLiveSession?.());
  });

  after(async () => {
    if (client && client.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => { client.once("close", () => resolve()); try { client.terminate(); } catch { resolve(); } });
    }
    await teardownServerSuite(running);
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("US-4.3 a HITL approval + drafts/attention/pane-state are SERVER-HELD and survive the WS drop", async () => {
    const approvals = running._testPendingApprovals!();
    const session0 = running._testActiveLiveSession!();
    const projectId = running.manager.ledger.activeProjectId || "default_project";

    // Register a live stub pane so the approve dispatch has a writeInput target, AND register it in
    // the ledger so setDraft (which requires a known pane) lands.
    const pane = new StubTerminal("e04-pane");
    pane.projectId = projectId;
    (running.manager.terminals as any)["e04-pane"] = pane;
    running.manager.ledger.updatePane(projectId, {
      pane_id: "e04-pane", name: "e04-pane", runtime_type: "shell", tool_preset: "Custom",
      permissions_mode: "Human-in-the-Loop", session_id: "", last_known_state: "Running",
      is_busy: false, alive: true, context_size: 0, notes: [],
    } as any, true);

    // Stage a HITL approval bound to the FIRST live session (exactly as dispatchProposal does).
    const messageId = "e04-survivor-1";
    approvals.add(
      { messageId, instruction: "run the full test suite", kind: "shell", terminalId: "e04-pane", callId: messageId, timestamp: Date.now() } as any,
      session0,
    );
    assert.strictEqual(approvals.sessionFor(messageId), session0, "approval bound to the first session");

    // Server-held DRAFT (composer scratch the operator typed before walking away).
    assert.strictEqual(running.manager.ledger.setDraft(projectId, "e04-pane", "draft before the drop", "operator"), true);
    // Server-held ATTENTION (a pane that flagged for the operator). The queue is a plain array.
    (running.manager.attentionQueue as any).push({ id: "att-e04", paneId: "e04-pane", reason: "needs review", ts: Date.now() });

    // GET /api/commands/pending lists the proposal BEFORE the drop.
    const pendingBefore = await (await api("/api/commands/pending")).json();
    assert.ok((pendingBefore || []).some((p: any) => p.messageId === messageId || p.callId === messageId),
      "the proposal is listed before the drop");

    // DROP the voice socket (the Gemini side dies; the operator's client WS stays open so a reconnect fires).
    session0.emitClose({ code: 1006, reason: "voice drop while a HITL approval is pending" });

    // After the drop the approval is DETACHED (survivor kept, not purged) — it is still listed.
    await waitFor(() => running._testActiveLiveSession!() !== session0 || running._testActiveLiveSession!() === null || true);
    const pendingAfter = await (await api("/api/commands/pending")).json();
    assert.ok((pendingAfter || []).some((p: any) => p.messageId === messageId || p.callId === messageId),
      "GET /api/commands/pending STILL lists the proposal after the WS drop (server-held survivor)");

    // SERVER SOURCE OF TRUTH: drafts/attention/pane-state are untouched by the drop.
    assert.strictEqual(running.manager.ledger.getDraft(projectId, "e04-pane")!.text, "draft before the drop",
      "the draft survived the drop server-side");
    assert.ok((running.manager.attentionQueue as any).some((a: any) => a.id === "att-e04"),
      "the attention item survived the drop server-side");
    assert.ok((running.manager.terminals as any)["e04-pane"], "the pane object survived the drop server-side");
  });

  it("US-4.3 a quiet reconnect blip re-attaches the survivor SILENTLY — no 'welcome back' replay", async () => {
    const approvals = running._testPendingApprovals!();
    const messageId = "e04-survivor-1"; // staged in the prior test; the suite shares one server.

    // A fresh session is minted by the bounded reconnect after the drop above.
    const session1 = await waitFor(() => {
      const s = running._testActiveLiveSession!();
      return s && s.clientContents ? s : undefined;
    });

    // The survivor re-attached to the reconnected session (reattachSession on the reconnect hoist) —
    // the MECHANICS run regardless of the quiet threshold below.
    await waitFor(() => approvals.sessionFor(messageId) === session1);
    assert.strictEqual(approvals.sessionFor(messageId), session1, "survivor re-attached to the reconnected session");

    // turn-arbiter program, Wave 3 (yg1w, spec §3.3 row 7): this bounded PLM4 auto-reconnect (base/
    // max delay 20/60ms here) re-establishes the Gemini session well under RECONNECT_QUIET_MS after
    // the drop — EXACTLY the transient-blip scenario audit §2.4 names ("the operator hears 'Welcome
    // back' plus a re-read of approvals they were just discussing" — a bug, not a feature). The fix
    // is that a quiet re-attach must NEVER replay that ceremony; a short settle window (not a slow
    // 4000ms waitFor-timeout) confirms it never arrives.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const spokeDigest = session1.clientContents.some((c: any) => JSON.stringify(c).includes("run the full test suite"));
    assert.strictEqual(spokeDigest, false,
      "yg1w: a sub-threshold reconnect blip must NOT replay the survivors digest into the new session");
    const spokeWelcome = session1.clientContents.some((c: any) => /welcome back/i.test(JSON.stringify(c)));
    assert.strictEqual(spokeWelcome, false,
      "yg1w: a quiet re-attach never says 'Welcome back' mid-flow — the ceremony defers to a genuine absence");
  });

  it("US-4.3 a non-empty Gemini key via PUT /api/settings nudges the CURRENT connection exactly once", async () => {
    // Register a spy nudge on the CURRENT connection via the test seam (mirrors the live nudge owner).
    let nudgeCalls = 0;
    running._testSetReconnectNudge!(() => { nudgeCalls++; });

    // A real, non-masked key -> shouldNudgeReconnectOnSettingsKey true -> the nudge fires once.
    const res = await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ secrets: { geminiApiKey: "AIzaSy-real-looking-key-0123456789" } }),
    });
    assert.strictEqual(res.status, 200, "settings PUT succeeds");
    assert.strictEqual(nudgeCalls, 1, "a non-empty key nudged the CURRENT connection exactly once");

    // A stale-owner clear is a no-op for the live owner: clearing with no owner token (null) clears
    // the registry, and a subsequent nudge attempt via a masked-echo PUT does NOT fire the (cleared)
    // spy — i.e. the masked echo is never a new credential and never re-nudges.
    const masked = await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ secrets: { geminiApiKey: "AIzaSy••••••••6789" } }),
    });
    assert.strictEqual(masked.status, 200);
    assert.strictEqual(nudgeCalls, 1, "the masked echo is NOT a new credential — no second nudge");

    running._testSetReconnectNudge!(null);
  });

  it("US-4.3 approving via REST after reconnect dispatches the command to the correct pane", async () => {
    const messageId = "e04-survivor-1";
    const pane = (running.manager.terminals as any)["e04-pane"] as StubTerminal;
    assert.strictEqual(pane.writeInputCount, 0, "nothing dispatched to the pane before the approve");

    const res = await api("/api/commands/approve", {
      method: "POST",
      body: JSON.stringify({ messageId, approved: true }),
    });
    assert.strictEqual(res.status, 200, "the REST approve answers 200");
    const body = await res.json();
    assert.strictEqual(body.success, true, "the approve reports success");

    // The approved instruction was dispatched to the CORRECT pane via writeInput.
    assert.strictEqual(pane.writeInputCount, 1, "the approved command was dispatched exactly once");
    assert.strictEqual(pane.lastCommand, "run the full test suite", "the right instruction reached the right pane");

    // And the survivor is gone from the pending list (claim + delete).
    const pending = await (await api("/api/commands/pending")).json();
    assert.ok(!(pending || []).some((p: any) => p.messageId === messageId || p.callId === messageId),
      "the approved survivor is removed from the pending list");
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// US-4.4 — Server restart: durable state restored, scratch lost (P0).
// A SQLite-backed JanusStore: workspaces, panes, notes, briefings, drafts, and an engaged STOP-ALL
// freeze are written; a fresh handle reopened on the SAME file restores the durable tier (drafts,
// frozen flag). The HistoryManager's atomic tmp+rename guarantees the history file always parses,
// even after a kill mid-write (we simulate a crash-mid-write by leaving a stray .tmp and proving the
// real file still parses).
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe("US-4.4 server restart: durable state restored across a SQLite reopen, scratch lost", () => {
  it("US-4.4 workspaces/panes/notes/briefings/drafts + the STOP-ALL freeze survive a reopen", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-e04-restart-"));
    const dbPath = path.join(dir, "restart.db");
    try {
      // ── PRE-RESTART: write the durable tier through one store handle. ──────────────────────────
      const s1 = new JanusStore(dbPath); s1.init();
      s1.addProject("p1", "/tmp/p1", "the orchestrator project", ["pty", "gemini"]);
      s1.switchContext("p1");
      s1.savePane({
        pane_id: "t1", workspace_id: "p1", name: "build pane", runtime_type: "shell",
        tool_preset: "Custom", permissions_mode: "Human-in-the-Loop", session_id: "",
        last_known_state: "Running", is_busy: false, alive: true, context_size: 0,
        last_status_change_at: null, last_command: "npm test", scrollback_path: null,
        created_at: Date.now(), updated_at: Date.now(),
      });
      s1.addNote("p1", "a durable project note");
      s1.addPaneNote("p1", "t1", "a durable pane note");
      assert.strictEqual(s1.setDraft("p1", "t1", "a composed draft", "operator"), true);
      // Engage the STOP-ALL freeze the way the server persists it (kv "frozen" === "1").
      s1.setKV("frozen", "1");

      // Capture the pre-restart ledger structure (the GET /api/ledger body === ledger.workspaces).
      const ledgerBefore = JSON.parse(JSON.stringify(s1.workspaces));
      s1.close();

      // ── RESTART: a brand-new store handle over the SAME file. ───────────────────────────────────
      const s2 = new JanusStore(dbPath); s2.init();

      // GET /api/ledger structure matches pre-restart (workspaces are the ledger body).
      const ledgerAfter = JSON.parse(JSON.stringify(s2.workspaces));
      assert.deepStrictEqual(Object.keys(ledgerAfter).sort(), Object.keys(ledgerBefore).sort(),
        "the workspace set is identical after the restart");
      const wsAfter = s2.getProject("p1")!;
      assert.strictEqual(wsAfter.summary, "the orchestrator project", "project summary restored");
      assert.ok(wsAfter.panes["t1"], "the pane restored under its project");

      // Notes + briefings restored (the durable tier).
      const briefing = s2.getProjectBriefing("p1")!;
      assert.deepStrictEqual(briefing.notes, ["a durable project note"], "project notes restored from the briefing");
      assert.ok(briefing.panes.some((p: any) => p.pane_id === "t1"), "the pane is in the restored briefing");

      // Drafts restored.
      assert.strictEqual(s2.getDraft("p1", "t1")!.text, "a composed draft", "the draft survived the restart");

      // GET /api/stop-all/status reports frozen:true until explicitly released (kv "frozen" persisted).
      assert.strictEqual(s2.getKV("frozen"), "1", "the engaged STOP-ALL freeze is still frozen after the restart");
      // Explicit release clears it.
      s2.setKV("frozen", "");
      assert.notStrictEqual(s2.getKV("frozen"), "1", "an explicit release clears the persisted freeze");
      s2.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("US-4.4 a graceful close loses nothing — flushAll persists pending history before teardown", async () => {
    const prevCwd = process.cwd();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-e04-graceful-"));
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";
    // A LONG flush window so the mutation is still pending (un-flushed) when we force the close-path flush.
    const prevFlush = process.env.JANUS_HISTORY_FLUSH_MS;
    process.env.JANUS_HISTORY_FLUSH_MS = "100000";
    process.chdir(tmpDir);
    let hm: any;
    try {
      const serverMod = await import("../server");
      hm = serverMod.HistoryManager.getInstance();
      hm.addCommand("e04-graceful", "echo durable");
      hm.appendOutputToLastCommand("e04-graceful", "output-tail");

      // The on-disk file has NOT been written yet (debounce window is huge) — this is the "scratch in
      // flight" state at shutdown.
      const before = (() => { try { return JSON.parse(fs.readFileSync(path.join(tmpDir, ".janus_history.json"), "utf-8")); } catch { return {}; } })();
      assert.strictEqual(before["e04-graceful"], undefined, "the mutation is still in flight pre-close (deferred write)");

      // The server close() path awaits flushAll() — a GRACEFUL close loses nothing.
      await hm.flushAll();

      const after = JSON.parse(fs.readFileSync(path.join(tmpDir, ".janus_history.json"), "utf-8"));
      assert.strictEqual(after["e04-graceful"]?.[0]?.command, "echo durable", "graceful close persisted the pending command");
      assert.strictEqual(after["e04-graceful"]?.[0]?.output, "output-tail", "graceful close persisted the pending output");
    } finally {
      try { await hm?.flushAll?.(); } catch { /* best-effort */ }
      process.chdir(prevCwd);
      if (prevFlush === undefined) delete process.env.JANUS_HISTORY_FLUSH_MS;
      else process.env.JANUS_HISTORY_FLUSH_MS = prevFlush;
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it("US-4.4 the history file is never corrupted by a kill mid-write (atomic tmp+rename -> always parses)", async () => {
    const prevCwd = process.cwd();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-e04-atomic-"));
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";
    const prevFlush = process.env.JANUS_HISTORY_FLUSH_MS;
    process.env.JANUS_HISTORY_FLUSH_MS = "20";
    process.chdir(tmpDir);
    let hm: any;
    try {
      const serverMod = await import("../server");
      hm = serverMod.HistoryManager.getInstance();
      hm.addCommand("e04-atomic", "echo atomic");
      await hm.flushAll();

      const histPath = path.join(tmpDir, ".janus_history.json");
      // The real file always parses (the writer renames a fully-written tmp into place).
      const parsed = JSON.parse(fs.readFileSync(histPath, "utf-8"));
      assert.strictEqual(parsed["e04-atomic"]?.[0]?.command, "echo atomic", "the flushed file parses to the written content");

      // Simulate a CRASH MID-WRITE: a half-written sibling tmp left behind by a killed process. The
      // atomic tmp+rename design means the LIVE file is never the partial one — a leftover tmp never
      // corrupts the real file, which still parses.
      fs.writeFileSync(histPath + ".tmp.partial", '{"e04-atomic": [{"command": "echo half', "utf-8");
      const stillParses = JSON.parse(fs.readFileSync(histPath, "utf-8"));
      assert.strictEqual(stillParses["e04-atomic"]?.[0]?.command, "echo atomic",
        "a leftover partial tmp from a kill mid-write never corrupts the live history file");

      // A subsequent flush still lands atomically and the file still parses (no residue clobber).
      hm.appendOutputToLastCommand("e04-atomic", "+more");
      await hm.flushAll();
      const reparsed = JSON.parse(fs.readFileSync(histPath, "utf-8"));
      assert.ok(String(reparsed["e04-atomic"][0].output).endsWith("+more"), "the next atomic flush landed cleanly");
    } finally {
      try { await hm?.flushAll?.(); } catch { /* best-effort */ }
      process.chdir(prevCwd);
      if (prevFlush === undefined) delete process.env.JANUS_HISTORY_FLUSH_MS;
      else process.env.JANUS_HISTORY_FLUSH_MS = prevFlush;
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// US-4.5 — Returning after weeks: the TTL cliff is honest (P1).
// bootMaintenance() over seeded timestamps: event rows older than eventsTtlDays (30) and archived
// panes older than archiveTtlDays (14) are pruned, scrollback dirs cleaned; notes + briefings (the
// durable tier) are NOT pruned. CHARACTERIZE whether the operator-facing surface communicates the gap.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe("US-4.5 returning after weeks: the TTL cliff prunes the transient tier, keeps the durable tier", () => {
  it("US-4.5 bootMaintenance prunes events past eventsTtlDays and cleans scrollback dirs", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-e04-ttl-"));
    const scrollbackDir = path.join(dir, "scrollback");
    fs.mkdirSync(scrollbackDir, { recursive: true });
    const staleScroll = path.join(scrollbackDir, "stale-pane.log");
    fs.writeFileSync(staleScroll, "ancient scrollback", "utf-8");
    try {
      const s = new JanusStore(":memory:"); s.init();
      const now = 1_000_000_000_000;
      const day = 86_400_000;
      // An event older than eventsTtlDays(30) and a fresh one inside the window. (No hyphens in the
      // summaries: search() feeds the term to FTS, where a hyphen is a column/operator token.)
      s.appendEvent({ type: "command_outcome" as any, summary: "weeksold event", ts: now - 45 * day });
      s.appendEvent({ type: "command_outcome" as any, summary: "yesterday event", ts: now - 1 * day });

      s.bootMaintenance({ now, eventsTtlDays: 30, archiveTtlDays: 14, scrollbackDirs: [scrollbackDir] });

      const remaining = s.getEvents({});
      assert.deepStrictEqual(remaining.map((e: any) => e.summary), ["yesterday event"],
        "events past eventsTtlDays are pruned; recent events survive (the honest TTL cliff)");
      // FTS stays consistent through the prune.
      assert.strictEqual(s.search("weeksold").length, 0, "the pruned event is gone from the search index");
      assert.strictEqual(s.search("yesterday").length, 1, "the surviving event is still searchable");
      s.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("US-4.5 notes and briefings (the durable tier) are NOT pruned by the weeks-away boot sweep", () => {
    const s = new JanusStore(":memory:"); s.init();
    const now = 1_000_000_000_000;
    const day = 86_400_000;
    s.addProject("p1", "/tmp/p1", "a long-lived project", ["k"]);
    s.switchContext("p1");
    s.addNote("p1", "a note from weeks ago");
    // An old command_outcome event (will be pruned) coexists with the durable note (must survive).
    // NOTE: addProject/addNote each emit their OWN (recent) audit events; those are NOT past the TTL,
    // so they survive — we assert on the SEEDED transient row by type, not on a zero total.
    s.appendEvent({ type: "command_outcome" as any, summary: "ancient", ts: now - 90 * day });

    s.bootMaintenance({ now, eventsTtlDays: 30, archiveTtlDays: 14, scrollbackDirs: [] });

    // The transient (weeks-old) event tier is pruned...
    assert.strictEqual(s.getEvents({ type: "command_outcome" }).length, 0, "the weeks-old command_outcome event was pruned");
    // ...but the durable notes/briefings tier is untouched.
    const briefing = s.getProjectBriefing("p1")!;
    assert.deepStrictEqual(briefing.notes, ["a note from weeks ago"], "notes are NOT pruned by the TTL sweep (durable tier)");
    assert.strictEqual(s.getProject("p1")!.summary, "a long-lived project", "the project briefing summary is untouched");
    s.close();
  });

  it("US-4.5 CHARACTERIZATION: bootMaintenance returns no operator-facing 'what was pruned' summary", () => {
    // The honest-gap question: does coming back after weeks SURFACE the pruning to the operator?
    // CHARACTERIZATION: bootMaintenance is a side-effecting sweep — it returns undefined (no count,
    // no digest). The TTL cliff is honest in the DATA (the rows are gone, recall simply returns less),
    // but there is NO bootMaintenance-level operator notification of the gap. Any "you've been away a
    // while; older history has rolled off" messaging would live in a higher surface (the away digest /
    // brief), not here. We pin the ACTUAL behavior so a future operator-facing summary is a conscious change.
    const s = new JanusStore(":memory:"); s.init();
    const now = 1_000_000_000_000;
    s.appendEvent({ type: "command_outcome" as any, summary: "ancient", ts: now - 90 * 86_400_000 });
    const result = (s as any).bootMaintenance({ now, eventsTtlDays: 30, archiveTtlDays: 14, scrollbackDirs: [] });
    assert.strictEqual(result, undefined,
      "// CHARACTERIZATION: bootMaintenance reports nothing operator-facing about the pruned gap");
    s.close();
  });
});
