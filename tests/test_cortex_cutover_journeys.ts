// tests/test_cortex_cutover_journeys.ts — Wave 4 journeys (spec docs/superpowers/specs/
// 2026-07-02-cortex-cutover-design.md D7).
//
// Same "mockLive in-proc" idiom as tests/test_context_smoke_journeys.ts / tests/
// test_context_injection_telemetry.ts: a REAL server boot (startServer on port 0, vite disabled,
// installMockLive's fake liveConnector) — no live Gemini key, no real python daemon race. Cortex
// primary curation is driven through an in-process FAKE PythonCortexClient (the same idiom
// tests/test_cortex_flip.ts already established at the MemoryService-unit level) wired into the
// REAL running server via the `testCortexClientOverride` seam (server.ts, this wave's periphery
// addition) — deterministic, no real subprocess spawn/handshake timing involved.
//
// Every journey below sets voiceUx.contextInjectDebounceMs to 0 right after boot (D6's live
// getter — server.ts threads `() => (settings.voiceUx ?? DEFAULT_VOICE_UX).contextInjectDebounceMs`
// into the InjectGate, read fresh on every evaluate() call) so a rapid sequence of pane
// switches/idle-signals in a single test isn't incidentally swallowed by the debounce floor —
// the point of these journeys is the CORTEX/gate HASH behavior, not real-clock pacing.
//
// Journeys covered (spec D7's "New journeys" bullet):
//   1. daemon killed mid-session -> the FLOOR takes over on that one call, and the session loop
//      is uninterrupted (subsequent pane switches keep working).
//   2. decision determinism across identical snapshots — an unchanged pane's brief (and the fake
//      cortex's own call args) are byte-identical across two visits (A->B->A).
//   3. brief redaction-clean under cortex composition — a secret-shaped string surviving into a
//      tier is redacted in the ACTUAL payload sent to Gemini, even when the cortex is primary.
//   4. command-outcome -> gate -> inject round-trip (changed vs unchanged snapshot) — a REAL
//      command run on a Full-Auto pane drives the observe layer's genuine onIdle -> paneSignalBus
//      'idle' publish (src/observe/index.ts, unchanged) into injectMemoryBrief(trigger
//      "command_outcome") (src/voice/index.ts D1) through the InjectGate (src/memory/injectGate.ts
//      D2): the first (changed-snapshot) event injects; a second signal for the SAME pane with an
//      UNCHANGED world (published directly via the `_testPublishPaneSignal` seam — a real second
//      command run would itself add a new breadcrumb, changing the snapshot and defeating the
//      "unchanged" case) is gate-skipped as "unchanged-brief".
//
// Runner: npx tsx --test --test-force-exit tests/test_cortex_cutover_journeys.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";
import type { MockLiveHandle, MockLiveSession } from "./helpers/mockLive";
import { teardownServerSuite } from "./helpers/teardown";
import type { RunningServer } from "../server";
import type { ContextInjectionEvent } from "../src/memory/contextTelemetry";
import { setCortexPrimary, resetCortexFallbackStats } from "../src/memory/cortexShadow";
import type { PythonCortexClient, CortexResult } from "../src/memory/cortexClient";
import type { MemoryTiers, CortexCtx } from "../src/memory/types";
import { DEFAULT_VOICE_UX } from "../src/types";
import type { ContextDelivery } from "../src/exchanges/types";
import { redactSecrets, classifySecrets } from "../src/terminal";

// ── Fake in-process PythonCortexClient — no real daemon, fully controllable ─────────────────────
interface FakeCortexCall { tiers: MemoryTiers; ctx: CortexCtx; now: number }
interface FakeCortex {
  client: PythonCortexClient;
  calls: FakeCortexCall[];
  kill: () => void; // simulate "daemon killed mid-session": decide() starts rejecting.
}

/** Deterministic fake: while alive, always answers `ok:true` keeping the given tier list (a pure
 *  function of its arguments — no randomness, no Date.now() dependency in the DECISION itself, so
 *  identical calls produce identical decisions — mirrors I-P4). Once killed, decide() rejects,
 *  exercising resolveWithCortex's fail-closed catch (src/memory/cortexShadow.ts) exactly as a real
 *  daemon dying mid-session would. */
function makeFakeCortex(keep: string[]): FakeCortex {
  let alive = true;
  const calls: FakeCortexCall[] = [];
  const client: PythonCortexClient = {
    available: () => alive,
    decide: async (tiers, ctx, now): Promise<CortexResult> => {
      calls.push({ tiers, ctx, now });
      if (!alive) throw new Error("mock cortex daemon killed mid-session");
      return {
        ok: true,
        decision: { keep, drop: [], rerank: [] },
        trace: {
          cortexVersion: "0.1.0",
          strategy: "baseline-identity",
          ruleFired: "baseline-identity",
          inputs: { activePaneId: ctx.activePaneId, sessionId: ctx.sessionId ?? null, trigger: ctx.trigger, tierKeys: keep, tierChars: {} },
          output: { orderedKeep: keep, dropped: [] },
          ts: now,
        },
      };
    },
  };
  return { client, calls, kill: () => { alive = false; } };
}

/** Register a pane WITHOUT spawning a real PTY (tests/test_context_injection_telemetry.ts idiom). */
function makeSeedPane(running: RunningServer, tmpDir: string) {
  return (paneId: string, projectId: string, lastCommand: string | null = null): void => {
    if (!running.manager.ledger.getProject(projectId)) {
      running.manager.ledger.addProject(projectId, tmpDir, `Project ${projectId}`, []);
    }
    (running.manager.terminals as any)[paneId] = {
      name: paneId, runtimeType: "interactive_cli", status: "Idle", lastCommand,
      projectId, cwd: tmpDir, toolPreset: "Custom", sessionId: "",
      permissionsMode: "Human-in-the-Loop", contextSize: 0, lastStatusChangeAt: Date.now(),
    };
    running.manager.refreshLedger();
  };
}

/** D6: zero out the inject gate's debounce floor so a rapid sequence of triggers within one test
 *  isn't swallowed by the (default 3000ms) debounce skip — these journeys are about hash/cortex
 *  behavior, not real-clock pacing. The live getter (server.ts) reads this fresh on every
 *  gate.evaluate() call, so mutating it after boot takes effect immediately. */
function disableDebounce(running: RunningServer): void {
  running.manager.settings.voiceUx = { ...(running.manager.settings.voiceUx ?? DEFAULT_VOICE_UX), contextInjectDebounceMs: 0 };
}

function live1(running: RunningServer): MockLiveSession {
  return running._testActiveLiveSession!() as MockLiveSession;
}

/** Rows recorded since `sinceTs`, newest-first (matches the store's own ordering). */
function rowsSince(running: RunningServer, sinceTs: number): ContextInjectionEvent[] {
  return running._testStore!()!.getContextInjections({ since: sinceTs - 1, limit: 5000 }) as unknown as ContextInjectionEvent[];
}

async function connectOperator(running: RunningServer, apiToken: string): Promise<WebSocket> {
  const client = new WebSocket(`ws://127.0.0.1:${running.port}/live`, { headers: { Cookie: `auth_token=${apiToken}` } });
  await new Promise<void>((resolve, reject) => {
    client.on("open", () => resolve());
    client.on("error", reject);
  });
  return client;
}

async function closeClient(client: WebSocket): Promise<void> {
  if (client && client.readyState !== WebSocket.CLOSED) {
    await new Promise<void>((resolve) => {
      client.once("close", () => resolve());
      try { client.terminate(); } catch { resolve(); }
    });
  }
}

function execProbe(verb: string): string {
  return process.platform === "win32" ? `echo ${verb}_%VJ42%` : `echo ${verb}_\${VJ42}`;
}

// ── Phase 2 Step 2.4 shared helpers (cross-project journeys below) ─────────────────────────────

/** Highest numeric context_version among a set of context_deliveries rows (0 if empty). */
function maxVersion(rows: ContextDelivery[]): number {
  return rows.reduce((m, r) => Math.max(m, Number(r.context_version)), 0);
}

/** WS2 (wsm-e2e-pinned-fikj.8): the memory-brief send is a passive injection, so it now carries a
 *  ONE-LINE "BACKGROUND — ..." preamble (src/voice/index.ts applyBackgroundFraming; shape pinned by
 *  tests/test_answer_first_ordering.ts). It is transport framing, not brief content — unwrap it so
 *  the "CONTEXT (situational...)" shape filters below keep matching the same payload they always did. */
function unwrapBackgroundFraming(text: string): string {
  return text.replace(/^BACKGROUND\b[^\n]*\n/, "");
}

/** The rendered "CONTEXT (situational...)" payload texts pushed to Gemini, in order, from a given
 *  index onward in the mock session's own `clientContents` log (BACKGROUND framing unwrapped). */
function contextTextsSince(session: MockLiveSession, fromIdx: number): string[] {
  return session.clientContents
    .slice(fromIdx)
    .map((c: any) => c?.turns?.[0]?.parts?.[0]?.text)
    .filter((t: unknown): t is string => typeof t === "string")
    .map(unwrapBackgroundFraming)
    .filter((t) => t.startsWith("CONTEXT (situational, do not read aloud):"));
}

/** Like execProbe, but with a short built-in delay so the command is still RUNNING at the moment
 *  a test switches focus away from it — needed to genuinely exercise "a command completes while
 *  backgrounded" rather than "a command that already finished before we switched". */
function delayedExecProbe(verb: string): string {
  return process.platform === "win32"
    ? `ping -n 2 127.0.0.1 >nul && echo ${verb}_%VJ42%`
    : `sleep 1 && echo ${verb}_\${VJ42}`;
}

/** A deterministic fake cortex whose decide() can be BLOCKED/RELEASED on demand — the seam Journey
 *  4 (stale focus mid-assembly) needs to open a real await window inside injectMemoryBrief without
 *  a real daemon or timing-dependent sleeps. */
function makeBlockableCortex(keep: string[]): { client: PythonCortexClient; block: () => void; release: () => void } {
  let gate: Promise<void> = Promise.resolve();
  let releaseFn: (() => void) | null = null;
  const client: PythonCortexClient = {
    available: () => true,
    decide: async (tiers, ctx, now): Promise<CortexResult> => {
      await gate;
      return {
        ok: true,
        decision: { keep, drop: [], rerank: [] },
        trace: {
          cortexVersion: "0.1.0",
          strategy: "baseline-identity",
          ruleFired: "baseline-identity",
          inputs: { activePaneId: ctx.activePaneId, sessionId: ctx.sessionId ?? null, trigger: ctx.trigger, tierKeys: keep, tierChars: {} },
          output: { orderedKeep: keep, dropped: [] },
          ts: now,
        },
      };
    },
  };
  return {
    client,
    block() { gate = new Promise((resolve) => { releaseFn = resolve; }); },
    release() { const fn = releaseFn; releaseFn = null; fn?.(); },
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Journey 1 — daemon killed mid-session: the floor takes over on THAT call; the loop continues.
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe("cortex cutover journey — daemon killed mid-session (spec D7)", () => {
  const PROJECT = "cutj-kill";
  let startServer: (opts?: any) => Promise<RunningServer>;
  let apiToken: string;
  let installMockLive: () => MockLiveHandle;
  let waitFor: <T>(p: () => T | undefined | false, t?: number, i?: number) => Promise<T>;

  let mock: MockLiveHandle;
  let running: RunningServer;
  let client: WebSocket;
  let tmpDir: string;
  let prevCwd: string;
  let bootTs: number;
  let seedPane: (paneId: string, projectId: string, lastCommand?: string | null) => void;
  let fake: FakeCortex;

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";
    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-cutj-kill-"));
    process.chdir(tmpDir);

    ({ installMockLive, waitFor } = await import("./helpers/mockLive"));
    const serverMod = await import("../server");
    startServer = serverMod.startServer;
    apiToken = serverMod.API_AUTH_TOKEN;

    mock = installMockLive();
    fake = makeFakeCortex(["project", "pane", "board", "breadcrumbs"]);
    bootTs = Date.now();
    running = await startServer({ port: 0, enableVite: false, testCortexClientOverride: fake.client });
    setCortexPrimary(true); // AFTER boot: the disabled/init-failure paths inside boot force it OFF.
    disableDebounce(running);

    client = await connectOperator(running, apiToken);
    await waitFor(() => mock.latest() && running._testActiveLiveSession?.());
    seedPane = makeSeedPane(running, tmpDir);
  });

  after(async () => {
    setCortexPrimary(false);
    resetCortexFallbackStats();
    await closeClient(client);
    for (const id of Object.keys(running.manager.terminals)) delete (running.manager.terminals as any)[id];
    await teardownServerSuite(running);
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("the cortex is healthy, then dies mid-session — that call floors, and the loop keeps going", async () => {
    seedPane("kill-a", PROJECT);
    seedPane("kill-b", PROJECT);

    // 1. Healthy: the first switch is curated by the (fake) cortex.
    let before = rowsSince(running, bootTs).length;
    let callId = live1(running).emitToolCall("switch_active_pane", { pane_id: "kill-a" });
    await waitFor(() => mock.responseFor(callId));
    await waitFor(() => rowsSince(running, bootTs).length > before);
    const healthyRow = rowsSince(running, bootTs)[0];
    assert.strictEqual(healthyRow.disposition, "injected");
    assert.strictEqual(healthyRow.source, "cortex-primary", "cortex healthy -> curated brief");
    assert.ok(healthyRow.brief_chars > 0);

    // 2. Kill the daemon mid-session.
    fake.kill();

    // 3. The VERY NEXT call floors: still injected (a real brief reaches Gemini), but no longer
    // cortex-curated — proving the miss narrows nothing and never breaks the tool call. Disposition
    // is "cortex-miss" (Wave 4 D5): primary mode + a non-cortex-primary source is STILL an injected
    // row for reporting purposes, just floored.
    before = rowsSince(running, bootTs).length;
    callId = live1(running).emitToolCall("switch_active_pane", { pane_id: "kill-b" });
    const resp = await waitFor(() => mock.responseFor(callId));
    assert.match(String(resp), /Opened pane 'kill-b'/, "the tool call itself completes normally");
    await waitFor(() => rowsSince(running, bootTs).length > before);
    const flooredRow = rowsSince(running, bootTs)[0];
    assert.strictEqual(flooredRow.disposition, "cortex-miss", "the floor still delivers a brief, flagged as a cortex miss");
    assert.notStrictEqual(flooredRow.source, "cortex-primary", "the miss falls to the TS floor, not the cortex");
    assert.ok(flooredRow.brief_chars > 0, "the floored brief is non-empty (full-tier synth, not a blank)");

    // 4. The loop continues uninterrupted: one more switch still works end-to-end.
    before = rowsSince(running, bootTs).length;
    callId = live1(running).emitToolCall("switch_active_pane", { pane_id: "kill-a" });
    await waitFor(() => mock.responseFor(callId));
    await waitFor(() => rowsSince(running, bootTs).length > before);
    assert.strictEqual(rowsSince(running, bootTs)[0].disposition, "cortex-miss", "the session survives a dead cortex indefinitely");
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Journey 2 — decision determinism across identical snapshots (A -> B -> A).
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe("cortex cutover journey — decision determinism across identical snapshots (spec D7)", () => {
  const PROJECT = "cutj-det";
  let startServer: (opts?: any) => Promise<RunningServer>;
  let apiToken: string;
  let installMockLive: () => MockLiveHandle;
  let waitFor: <T>(p: () => T | undefined | false, t?: number, i?: number) => Promise<T>;

  let mock: MockLiveHandle;
  let running: RunningServer;
  let client: WebSocket;
  let tmpDir: string;
  let prevCwd: string;
  let bootTs: number;
  let seedPane: (paneId: string, projectId: string, lastCommand?: string | null) => void;
  let fake: FakeCortex;

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";
    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-cutj-det-"));
    process.chdir(tmpDir);

    ({ installMockLive, waitFor } = await import("./helpers/mockLive"));
    const serverMod = await import("../server");
    startServer = serverMod.startServer;
    apiToken = serverMod.API_AUTH_TOKEN;

    mock = installMockLive();
    fake = makeFakeCortex(["project", "pane", "frame"]);
    bootTs = Date.now();
    running = await startServer({ port: 0, enableVite: false, testCortexClientOverride: fake.client });
    setCortexPrimary(true);
    disableDebounce(running);

    client = await connectOperator(running, apiToken);
    await waitFor(() => mock.latest() && running._testActiveLiveSession?.());
    seedPane = makeSeedPane(running, tmpDir);
  });

  after(async () => {
    setCortexPrimary(false);
    resetCortexFallbackStats();
    await closeClient(client);
    for (const id of Object.keys(running.manager.terminals)) delete (running.manager.terminals as any)[id];
    await teardownServerSuite(running);
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("A -> B -> A: the two A-visit briefs and the fake cortex's own call args are byte-identical", async () => {
    seedPane("det-a", PROJECT, "same command every time");
    seedPane("det-b", PROJECT);

    let before = rowsSince(running, bootTs).length;
    let callId = live1(running).emitToolCall("switch_active_pane", { pane_id: "det-a" });
    await waitFor(() => mock.responseFor(callId));
    await waitFor(() => rowsSince(running, bootTs).length > before);
    const firstA = rowsSince(running, bootTs)[0];
    assert.strictEqual(firstA.source, "cortex-primary");

    before = rowsSince(running, bootTs).length;
    callId = live1(running).emitToolCall("switch_active_pane", { pane_id: "det-b" });
    await waitFor(() => mock.responseFor(callId));
    await waitFor(() => rowsSince(running, bootTs).length > before);

    before = rowsSince(running, bootTs).length;
    callId = live1(running).emitToolCall("switch_active_pane", { pane_id: "det-a" });
    await waitFor(() => mock.responseFor(callId));
    await waitFor(() => rowsSince(running, bootTs).length > before);
    const secondA = rowsSince(running, bootTs)[0];
    assert.strictEqual(secondA.source, "cortex-primary");

    // Output determinism: the rendered brief is byte-identical across both A-visits.
    assert.strictEqual(secondA.brief_hash, firstA.brief_hash, "identical snapshot -> identical brief hash");
    assert.strictEqual(secondA.brief_chars, firstA.brief_chars);

    // Input determinism: the fake cortex's own recorded call args for pane A are structurally
    // equal across both visits (modulo `now`, per I-P4's own "modulo ts" carve-out) — EXCLUDING
    // `ctx.history`, which is INTENTIONALLY sequence-dependent (the D4 ring buffer grows by one
    // entry per successful decide anywhere in the session, by design — that is hysteresis, not
    // nondeterminism in the decision itself; the fake's own decision output ignores ctx entirely).
    const aCalls = fake.calls.filter((c) => c.ctx.activePaneId === "det-a");
    assert.strictEqual(aCalls.length, 2, "the cortex was consulted on both A-visits");
    assert.deepStrictEqual(aCalls[0].tiers, aCalls[1].tiers, "identical tiers snapshot on both A-visits");
    const { history: _h0, ...ctx0 } = aCalls[0].ctx;
    const { history: _h1, ...ctx1 } = aCalls[1].ctx;
    assert.deepStrictEqual(ctx0, ctx1, "identical ctx (excluding the sequence-dependent D4 history) on both A-visits");
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Journey 3 — brief redaction-clean under cortex composition.
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe("cortex cutover journey — brief redaction-clean under cortex composition (spec D7)", () => {
  const PROJECT = "cutj-redact";
  const SECRET = "AKIAABCDEFGHIJKLMNOP"; // matches redactSecrets' AWS-access-key-id pattern.
  let startServer: (opts?: any) => Promise<RunningServer>;
  let apiToken: string;
  let installMockLive: () => MockLiveHandle;
  let waitFor: <T>(p: () => T | undefined | false, t?: number, i?: number) => Promise<T>;

  let mock: MockLiveHandle;
  let running: RunningServer;
  let client: WebSocket;
  let tmpDir: string;
  let prevCwd: string;
  let bootTs: number;
  let seedPane: (paneId: string, projectId: string, lastCommand?: string | null) => void;
  let fake: FakeCortex;

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";
    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-cutj-redact-"));
    process.chdir(tmpDir);

    ({ installMockLive, waitFor } = await import("./helpers/mockLive"));
    const serverMod = await import("../server");
    startServer = serverMod.startServer;
    apiToken = serverMod.API_AUTH_TOKEN;

    mock = installMockLive();
    // Keeps EVERY tier — the adversarial case: if redaction only ran on the FLOOR path (not the
    // cortex-primary composition), keeping everything is what would leak the secret.
    fake = makeFakeCortex(["project", "pane", "board", "breadcrumbs"]);
    bootTs = Date.now();
    running = await startServer({ port: 0, enableVite: false, testCortexClientOverride: fake.client });
    setCortexPrimary(true);
    disableDebounce(running);

    client = await connectOperator(running, apiToken);
    await waitFor(() => mock.latest() && running._testActiveLiveSession?.());
    seedPane = makeSeedPane(running, tmpDir);
  });

  after(async () => {
    setCortexPrimary(false);
    resetCortexFallbackStats();
    await closeClient(client);
    for (const id of Object.keys(running.manager.terminals)) delete (running.manager.terminals as any)[id];
    await teardownServerSuite(running);
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("a secret-shaped lastCommand never reaches Gemini raw, even when the cortex composes the brief", async () => {
    // The raw secret sits on the pane's lastCommand — WorldModel.getPaneTier redacts it BEFORE the
    // cortex (or anything else) ever sees the tiers snapshot (src/memory/worldModel.ts). The
    // choke-point's own `redactSecrets(brief.text)` wrap (src/voice/index.ts D2) is identity on
    // already-clean text, so this proves both layers hold, not just the upstream one.
    seedPane("redact-a", PROJECT, `aws configure set aws_access_key_id ${SECRET}`);

    const before = rowsSince(running, bootTs).length;
    const callId = live1(running).emitToolCall("switch_active_pane", { pane_id: "redact-a" });
    await waitFor(() => mock.responseFor(callId));
    await waitFor(() => rowsSince(running, bootTs).length > before);
    const row = rowsSince(running, bootTs)[0];
    assert.strictEqual(row.disposition, "injected");
    assert.strictEqual(row.source, "cortex-primary", "the cortex composed this brief (the adversarial case)");

    // The ACTUAL payload sent to Gemini (sess.sendClientContent) — not a re-derivation — is clean.
    // (contextTextsSince unwraps the WS2 BACKGROUND framing before matching the CONTEXT shape.)
    const session = live1(running) as MockLiveSession;
    const contextPushes = contextTextsSince(session, 0);
    assert.ok(contextPushes.length >= 1, "at least one CONTEXT payload was sent");
    const sentText = contextPushes[contextPushes.length - 1];
    assert.ok(!sentText.includes(SECRET), "the raw secret never reached the wire");
    assert.ok(sentText.includes("[REDACTED:aws-key]"), "the redaction token is present instead");
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Journey 4 — command-outcome -> gate -> inject round-trip (changed vs unchanged snapshot).
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe("cortex cutover journey — command-outcome -> gate -> inject round-trip (spec D7)", () => {
  const PROJECT = "cutj-outcome";
  let startServer: (opts?: any) => Promise<RunningServer>;
  let apiToken: string;
  let installMockLive: () => MockLiveHandle;
  let waitFor: <T>(p: () => T | undefined | false, t?: number, i?: number) => Promise<T>;

  let mock: MockLiveHandle;
  let running: RunningServer;
  let client: WebSocket;
  let tmpDir: string;
  let prevCwd: string;
  let bootTs: number;

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";
    process.env.JANUS_SHELL_ALLOWLIST = "echo";
    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-cutj-outcome-"));
    process.chdir(tmpDir);

    ({ installMockLive, waitFor } = await import("./helpers/mockLive"));
    const serverMod = await import("../server");
    startServer = serverMod.startServer;
    apiToken = serverMod.API_AUTH_TOKEN;

    mock = installMockLive();
    bootTs = Date.now();
    running = await startServer({ port: 0, enableVite: false });
    // Wave 4 (D5) fixer note, 2026-07-03: unlike Journeys 1-3 above, this journey never wires a
    // fake `testCortexClientOverride` and relies on whatever the boot-time default currently is.
    // Cortex-primary is now that default (server.ts's resolveCortexPrimaryFlagFromEnv), but this
    // journey's own concern is D1/D2 (the command-outcome trigger -> gate hash-skip round-trip),
    // not cortex curation, and it boots with no warm daemon. Pin it explicitly OFF so the
    // `disposition, "injected"` assertions below stay floor-path assertions regardless of the
    // ambient default.
    setCortexPrimary(false);
    disableDebounce(running); // isolate the HASH behavior under test from real-clock pacing.
    if (!running.manager.settings.advanced.capabilityGates) (running.manager.settings.advanced as any).capabilityGates = {};
    (running.manager.settings.advanced.capabilityGates as any).create_pane = "Auto";
    (running.manager.settings.advanced.capabilityGates as any).propose_command = "Auto";
    process.env.VJ42 = "42";

    client = await connectOperator(running, apiToken);
    await waitFor(() => mock.latest() && running._testActiveLiveSession?.());
  });

  after(async () => {
    await closeClient(client);
    if (running?.manager) {
      const terms = Object.values(running.manager.terminals) as any[];
      await Promise.all(terms.map((t) => Promise.resolve(t?.stop?.()).catch(() => undefined)));
      for (const id of Object.keys(running.manager.terminals)) delete (running.manager.terminals as any)[id];
    }
    await teardownServerSuite(running);
    process.chdir(prevCwd);
    delete process.env.VJ42;
    delete process.env.JANUS_SHELL_ALLOWLIST;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("a real command completion fires command_outcome -> gate -> inject; a repeat with an unchanged world is gate-skipped", async () => {
    const createCallId = live1(running).emitToolCall("create_pane", {
      project_id: PROJECT, pane_id: "outcome-a", tool_preset: "Custom", permissions_mode: "Full Auto",
    });
    const createOut = String(await waitFor(() => mock.responseFor(createCallId)));
    assert.ok(createOut.includes("Pane outcome-a created"));
    const term = (running.manager.terminals as any)["outcome-a"];

    const instruction = execProbe("cmdout");
    const proposeCallId = live1(running).emitToolCall("propose_command", { pane_id: "outcome-a", instruction, kind: "shell" });
    await waitFor(() => mock.responseFor(proposeCallId));

    // The D1 precondition, exercised for real: the command actually runs and the pane genuinely
    // quiesces (src/observe/index.ts's onIdle -> paneSignalBus.publish({kind:"idle", ...})), which
    // is the SAME edge src/voice/index.ts's paneSignalBus subscription turns into
    // injectMemoryBrief(trigger:"command_outcome", affectedPaneId: sig.paneId) (D1).
    await waitFor(() => term.getRecentOutput(100).includes("cmdout_42"), 10000);
    await waitFor(() => term.status === "Idle", 10000);

    // z5c slice 1 (spec 2026-07-07 D1, closed bead wsm-e2e-pinned-1d6w): the inject leg rides
    // its own bus delivery class and is NOT subject to the L1 cross-kind cooldown, so the organic
    // idle edge above ALWAYS reaches injectMemoryBrief — even on a fast runner where the whole
    // spawn->running->quiescing->idle cluster lands inside one 5s window (the exact machine-speed
    // dependence that used to require a replay-through-the-bus fallback here). The organic row is
    // now a hard requirement: if this waitFor times out, the delivery-class regression is real.
    const outcomeRow = await waitFor(() => rowsSince(running, bootTs).find(
      (r) => r.trigger === "command_outcome" && r.active_pane_id === "outcome-a" && r.disposition === "injected"), 15000);
    assert.ok(outcomeRow, "a command_outcome-triggered injection was recorded");
    assert.strictEqual(outcomeRow!.disposition, "injected", "a genuinely changed snapshot passes the gate");
    assert.strictEqual(outcomeRow!.active_pane_id, "outcome-a", "the currently-active pane (the one that just ran) is what got injected");

    // Changed vs UNCHANGED snapshot, on a STABLE pane (no real PTY). The BOARD tier reflects EVERY
    // pane, not just the active one (WorldModel.getBoardTier reads manager.listPanes() wholesale),
    // so the still-alive real "outcome-a" PTY must be stopped first — its shell can otherwise
    // legitimately re-draw a prompt after the command completes, firing another genuine onIdle +
    // status flap in the background and perturbing the snapshot during any real-clock wait. A
    // stopped/duck-typed pane has no such background activity, so the world stays byte-identical
    // for as long as we don't touch it — the precondition this half of the test actually needs.
    await Promise.resolve(term?.stop?.()).catch(() => undefined);

    // PROJECT already exists (create_pane created it above) — just seed the duck-typed pane into it.
    (running.manager.terminals as any)["stable-outcome"] = {
      name: "stable-outcome", runtimeType: "interactive_cli", status: "Idle", lastCommand: "stable, never changes",
      projectId: PROJECT, cwd: tmpDir, toolPreset: "Custom", sessionId: "",
      permissionsMode: "Human-in-the-Loop", contextSize: 0, lastStatusChangeAt: Date.now(),
    };
    running.manager.refreshLedger();
    running._testSetActivePane!("stable-outcome"); // focus change WITHOUT firing an injection itself.

    // First publish: a genuinely CHANGED snapshot (new active pane, never hashed before) -> injects.
    let beforeRepeat = rowsSince(running, bootTs).length;
    let delivered = running._testPublishPaneSignal!({ paneId: "stable-outcome", kind: "idle", detail: "stable pane settled" });
    assert.strictEqual(delivered, true, "the bus delivered the first stable-pane signal");
    const changedRow = await waitFor(() => {
      const rows = rowsSince(running, bootTs);
      return rows.length > beforeRepeat ? rows[0] : undefined;
    });
    assert.strictEqual(changedRow!.trigger, "command_outcome");
    assert.strictEqual(changedRow!.disposition, "injected", "a genuinely changed snapshot (new active pane) passes the gate");
    assert.strictEqual(changedRow!.active_pane_id, "stable-outcome");

    // z5c slice 1: the inject lane has NO cross-kind cooldown, and the repeat probe below uses a
    // DIFFERENT detail string, which passes the lane's identical-repeat collapse (4D.2 semantics,
    // per lane) — so no cooldown wait is needed before the second publish. Gate-order note: the
    // InjectGate checks hash-equality BEFORE the debounce floor, so the unchanged world yields
    // "unchanged-brief" (not "debounce") regardless of how quickly this follows the first inject.

    // Second publish: the world is UNCHANGED since the first stable-pane injection (still the
    // active pane, nothing about it was touched) — a DIFFERENT `detail` string bypasses the bus's
    // OWN identical-repeat collapse (a separate mechanism from the InjectGate) so this genuinely
    // reaches injectMemoryBrief and exercises the gate's hash-equality skip.
    beforeRepeat = rowsSince(running, bootTs).length;
    delivered = running._testPublishPaneSignal!({ paneId: "stable-outcome", kind: "idle", detail: "stable pane settled (repeat probe)" });
    assert.strictEqual(delivered, true, "the bus delivered the repeat signal to the subscriber");

    // The gate STILL records the skip (telemetry sees every attempt, D2) — but it costs zero cortex
    // round-trips and never reaches sendClientContent. Exactly one new row lands: the skip itself.
    await waitFor(() => rowsSince(running, bootTs).length > beforeRepeat);
    const skipRow = rowsSince(running, bootTs)[0];
    assert.strictEqual(skipRow.trigger, "command_outcome");
    assert.strictEqual(skipRow.disposition, "unchanged-brief", "an UNCHANGED snapshot is gate-skipped, not re-injected");
    assert.strictEqual(rowsSince(running, bootTs).length, beforeRepeat + 1, "exactly one new row — the skip — no duplicate/extra rows");
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Phase 2 Step 2.4 — cross-project context/session journeys (docs/superpowers/specs/
// 2026-07-07-z5c-session-pool-design.md). Each journey asserts EXACT project/pane/session/
// context-version identity across BOTH durable SQLite rows and frame-level (delivered brief text)
// evidence, not just "something happened". Same mockLive-in-proc idiom as the journeys above.
// ═════════════════════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Journey — A -> B -> A isolation: project A's context/gate/version state survives a switch to B
// and back; nothing of A leaks into B's briefs or vice versa.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("cross-project journey — A -> B -> A isolation (Phase 2 Step 2.4)", () => {
  const PROJECT_A = "xproj-a";
  const PROJECT_B = "xproj-b";
  const ALPHA_MARKER = "ALPHA_MARKER_9f2";
  const BETA_MARKER = "BETA_MARKER_7c1";
  const ALPHA_NOTE_MARKER = "ALPHA_NOTE_MARKER_3e8";

  let startServer: (opts?: any) => Promise<RunningServer>;
  let apiToken: string;
  let installMockLive: () => MockLiveHandle;
  let waitFor: <T>(p: () => T | undefined | false, t?: number, i?: number) => Promise<T>;

  let mock: MockLiveHandle;
  let running: RunningServer;
  let client: WebSocket;
  let tmpDir: string;
  let prevCwd: string;
  let bootTs: number;
  let seedPane: (paneId: string, projectId: string, lastCommand?: string | null) => void;

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";
    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-xpj-iso-"));
    process.chdir(tmpDir);

    ({ installMockLive, waitFor } = await import("./helpers/mockLive"));
    const serverMod = await import("../server");
    startServer = serverMod.startServer;
    apiToken = serverMod.API_AUTH_TOKEN;

    mock = installMockLive();
    bootTs = Date.now();
    running = await startServer({ port: 0, enableVite: false });
    setCortexPrimary(false); // this journey's concern is cross-project isolation, not cortex curation.
    disableDebounce(running);

    client = await connectOperator(running, apiToken);
    await waitFor(() => mock.latest() && running._testActiveLiveSession?.());
    seedPane = makeSeedPane(running, tmpDir);
  });

  after(async () => {
    await closeClient(client);
    for (const id of Object.keys(running.manager.terminals)) delete (running.manager.terminals as any)[id];
    await teardownServerSuite(running);
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("A's delivered content/versions/gate state are untouched by a full A->B->A round trip; nothing of A leaks into B", async () => {
    seedPane("xa-pane", PROJECT_A, `build the ${ALPHA_MARKER} service`);
    seedPane("xb-pane", PROJECT_B, `deploy the ${BETA_MARKER} service`);

    // ── Visit A ──────────────────────────────────────────────────────────────────────────────
    let before = rowsSince(running, bootTs).length;
    let callId = live1(running).emitToolCall("switch_context", { project_id: PROJECT_A });
    await waitFor(() => mock.responseFor(callId));
    await waitFor(() => rowsSince(running, bootTs).length > before);
    before = rowsSince(running, bootTs).length;
    callId = live1(running).emitToolCall("switch_active_pane", { pane_id: "xa-pane" });
    await waitFor(() => mock.responseFor(callId));
    await waitFor(() => rowsSince(running, bootTs).length > before);

    const sessionId = rowsSince(running, bootTs)[0].session_id!;
    assert.ok(sessionId, "a real voice_session_id is stamped on every delivery/injection row");

    const store = running._testStore!()!;
    const aDeliveriesFirst = store.listContextDeliveries(sessionId).filter(d => d.project_id === PROJECT_A);
    assert.ok(aDeliveriesFirst.length >= 1, "A got at least one context_deliveries row");
    const aVersionAfterFirstVisit = maxVersion(aDeliveriesFirst);

    const session = live1(running) as MockLiveSession;
    const aTexts = contextTextsSince(session, 0);
    assert.ok(aTexts.some(t => t.includes(ALPHA_MARKER)), "A's own brief mentions A's marker");
    assert.ok(!aTexts.some(t => t.includes(BETA_MARKER)), "A's brief never mentions B's marker");

    // ── Visit B ──────────────────────────────────────────────────────────────────────────────
    // Phase 2 Step 2.5 fix of the Step 2.4 pinned bug: switch_context alone does NOT move
    // coreState.activePaneId (only switch_active_pane does), so its own project_switch injection
    // used to render the PRIOR project's still-focused pane into a genuinely MIXED brief (PROJECT
    // tier = B, ACTIVE PANE tier = A's stale pane/lastCommand) stamped under B's delivery row.
    // src/voice/index.ts's resolveBriefPane now drops a cross-project stale pane from the
    // project_switch brief entirely — the pane tier arrives on the operator's next
    // switch_active_pane (the settled state every real call site pairs a switch_context with).
    const beforeBSwitchContextIdx = session.clientContents.length;
    before = rowsSince(running, bootTs).length;
    callId = live1(running).emitToolCall("switch_context", { project_id: PROJECT_B });
    await waitFor(() => mock.responseFor(callId));
    await waitFor(() => rowsSince(running, bootTs).length > before);
    const switchContextOnlyTexts = contextTextsSince(session, beforeBSwitchContextIdx);
    for (const t of switchContextOnlyTexts) {
      assert.ok(
        !t.includes(ALPHA_MARKER),
        "switch_context's OWN injection carries NOTHING of the prior project's pane — the stale " +
        "cross-project pane tier is dropped from the project_switch brief (resolveBriefPane fix)",
      );
    }

    // The operator's very next real action (an explicit switch_active_pane) is what actually
    // settles focus onto B's own pane — the full (pane-bearing) brief lands there, and it is
    // exactly what every existing switch_context call site in this codebase is always paired with
    // (see tests/test_context_smoke_journeys.ts).
    const beforeBPaneIdx = session.clientContents.length;
    before = rowsSince(running, bootTs).length;
    callId = live1(running).emitToolCall("switch_active_pane", { pane_id: "xb-pane" });
    await waitFor(() => mock.responseFor(callId));
    await waitFor(() => rowsSince(running, bootTs).length > before);

    const bTexts = contextTextsSince(session, beforeBPaneIdx);
    assert.ok(bTexts.some(t => t.includes(BETA_MARKER)), "B's own settled brief mentions B's marker");
    assert.ok(!bTexts.some(t => t.includes(ALPHA_MARKER)), "once focus actually settles on B's own pane, A's marker is gone — no STEADY-STATE leak");

    const bDeliveries = store.listContextDeliveries(sessionId).filter(d => d.project_id === PROJECT_B);
    assert.ok(bDeliveries.length >= 1);
    assert.strictEqual(Math.min(...bDeliveries.map(d => Number(d.context_version))), 1, "B's context_version counter starts at 1, fully independent of A's");

    // A's OWN rows are untouched by B's visit.
    const aDeliveriesAfterB = store.listContextDeliveries(sessionId).filter(d => d.project_id === PROJECT_A);
    assert.strictEqual(maxVersion(aDeliveriesAfterB), aVersionAfterFirstVisit, "A's version counter did not advance while B was foreground");

    // ── Add A-only content while B is foreground (background write, no injection) ──────────────
    store.addNote(PROJECT_A, `${ALPHA_NOTE_MARKER}: internal-only decision`, { type: "decision" });

    // ── Return to A ──────────────────────────────────────────────────────────────────────────
    // Same switch_context/switch_active_pane decoupling as the "Visit B" step above — and the same
    // Step 2.5 guarantee: the switch_context(A) brief drops B's still-focused stale pane, so
    // nothing of B rides along even on the switch injection itself.
    const beforeReturnSwitchIdx = session.clientContents.length;
    before = rowsSince(running, bootTs).length;
    callId = live1(running).emitToolCall("switch_context", { project_id: PROJECT_A });
    await waitFor(() => mock.responseFor(callId));
    await waitFor(() => rowsSince(running, bootTs).length > before);
    for (const t of contextTextsSince(session, beforeReturnSwitchIdx)) {
      assert.ok(!t.includes(BETA_MARKER), "the return switch_context(A) brief carries nothing of B's stale pane either");
    }
    const beforeReturnPaneIdx = session.clientContents.length;
    before = rowsSince(running, bootTs).length;
    callId = live1(running).emitToolCall("switch_active_pane", { pane_id: "xa-pane" });
    await waitFor(() => mock.responseFor(callId));
    await waitFor(() => rowsSince(running, bootTs).length > before);

    const returnTexts = contextTextsSince(session, beforeReturnPaneIdx);
    assert.ok(returnTexts.some(t => t.includes(ALPHA_MARKER)), "returning to A still surfaces A's own marker");
    assert.ok(returnTexts.some(t => t.includes(ALPHA_NOTE_MARKER)), "the note added to A while B was foreground now surfaces — A's own state, correctly caught up");
    assert.ok(!returnTexts.some(t => t.includes(BETA_MARKER)), "once settled, no trace of B leaks back into A's re-injected brief");

    const aDeliveriesFinal = store.listContextDeliveries(sessionId).filter(d => d.project_id === PROJECT_A);
    assert.ok(maxVersion(aDeliveriesFinal) > aVersionAfterFirstVisit, "A's context_version genuinely advanced on the CONTENT change, not merely the switch");

    // ── Gate isolation: a THIRD, unchanged visit to A gate-skips; nothing about B is touched ────
    before = rowsSince(running, bootTs).length;
    callId = live1(running).emitToolCall("switch_active_pane", { pane_id: "xa-pane" }); // same pane, unchanged world
    await waitFor(() => mock.responseFor(callId));
    await waitFor(() => rowsSince(running, bootTs).length > before);
    const repeatRow = rowsSince(running, bootTs)[0];
    assert.strictEqual(repeatRow.disposition, "unchanged-brief", "A's per-project gate correctly remembers A's own last-injected hash, unaffected by the B excursion");
    assert.strictEqual(repeatRow.active_project_id, PROJECT_A);

    // Exact identity integrity across every delivery row THIS TEST'S own A/B traffic produced (not
    // the connection's very first automatic session_start row, which predates any project_id this
    // test chose and is out of scope here).
    const abRows = store.listContextDeliveries(sessionId).filter(d => d.project_id === PROJECT_A || d.project_id === PROJECT_B);
    assert.ok(abRows.length >= 3, "at least A's two visits + B's one visit each minted a delivery row");
    for (const row of abRows) {
      assert.strictEqual(row.voice_session_id, sessionId, "every delivery row carries the SAME real voice_session_id");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Journey — background command-outcome is DROPPED (D6 "no event queue for the handle tier"),
// never misrouted into the foreground project's live brief; the fact itself is durable and
// surfaces on A's own next promotion (nothing is silently lost, only deferred).
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("cross-project journey — background command-outcome dropped while another project is foreground (Phase 2 Step 2.4)", () => {
  const PROJECT_A = "xproj-bg-a";
  const PROJECT_B = "xproj-bg-b";

  let startServer: (opts?: any) => Promise<RunningServer>;
  let apiToken: string;
  let installMockLive: () => MockLiveHandle;
  let waitFor: <T>(p: () => T | undefined | false, t?: number, i?: number) => Promise<T>;

  let mock: MockLiveHandle;
  let running: RunningServer;
  let client: WebSocket;
  let tmpDir: string;
  let prevCwd: string;
  let bootTs: number;
  let seedPane: (paneId: string, projectId: string, lastCommand?: string | null) => void;

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";
    process.env.JANUS_SHELL_ALLOWLIST = "echo,sleep,ping"; // lets a command still be RUNNING when we switch away (test-only override — "ping" is deliberately excluded from the production default, see src/pendingApprovals.ts)
    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-xpj-bg-"));
    process.chdir(tmpDir);

    ({ installMockLive, waitFor } = await import("./helpers/mockLive"));
    const serverMod = await import("../server");
    startServer = serverMod.startServer;
    apiToken = serverMod.API_AUTH_TOKEN;

    mock = installMockLive();
    bootTs = Date.now();
    running = await startServer({ port: 0, enableVite: false });
    setCortexPrimary(false);
    disableDebounce(running);
    if (!running.manager.settings.advanced.capabilityGates) (running.manager.settings.advanced as any).capabilityGates = {};
    (running.manager.settings.advanced.capabilityGates as any).create_pane = "Auto";
    (running.manager.settings.advanced.capabilityGates as any).propose_command = "Auto";
    process.env.VJ42 = "42";

    client = await connectOperator(running, apiToken);
    await waitFor(() => mock.latest() && running._testActiveLiveSession?.());
    seedPane = makeSeedPane(running, tmpDir);
  });

  after(async () => {
    await closeClient(client);
    if (running?.manager) {
      const terms = Object.values(running.manager.terminals) as any[];
      await Promise.all(terms.map((t) => Promise.resolve(t?.stop?.()).catch(() => undefined)));
      for (const id of Object.keys(running.manager.terminals)) delete (running.manager.terminals as any)[id];
    }
    await teardownServerSuite(running);
    process.chdir(prevCwd);
    delete process.env.VJ42;
    delete process.env.JANUS_SHELL_ALLOWLIST;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("a real command completing in a backgrounded project is dropped from B's live brief; A picks it up organically on its own next promotion", async () => {
    seedPane("bg-b-pane", PROJECT_B);
    // Step 2.5 review fix to this journey's own setup: project A must EXIST before switch_context(A)
    // below — ledger.switchContext is a documented no-op on an unknown id (src/store/sqliteStore.ts
    // "Only switches if it exists"), so without this line activeProjectId never actually became A,
    // the pool never tracked A as foreground, A was never demoted to "handle" on the switch to B,
    // and the background 'idle' signal was NOT dropped (stateFor(A) === "cold" keeps pre-pool
    // inject behavior BY DESIGN — see backgroundProjectForSignal's doc). The journey's stated
    // premise ("A becomes the pool-tracked foreground project") silently didn't hold.
    running.manager.ledger.addProject(PROJECT_A, tmpDir, `Project ${PROJECT_A}`, []);

    // A becomes the pool-tracked foreground project (an explicit switch_context — the ONLY trigger
    // that registers pool foreground/backgrounded state; see backgroundProjectForSignal's doc).
    let before = rowsSince(running, bootTs).length;
    let callId = live1(running).emitToolCall("switch_context", { project_id: PROJECT_A });
    await waitFor(() => mock.responseFor(callId));
    await waitFor(() => rowsSince(running, bootTs).length > before);

    // A real Full-Auto shell pane in A.
    const createCallId = live1(running).emitToolCall("create_pane", {
      project_id: PROJECT_A, pane_id: "bg-a-pane", tool_preset: "Custom", permissions_mode: "Full Auto",
    });
    const createOut = String(await waitFor(() => mock.responseFor(createCallId)));
    assert.ok(createOut.includes("Pane bg-a-pane created"));
    const term = (running.manager.terminals as any)["bg-a-pane"];

    // Start a real, SLOW command on A's pane WHILE A is still the active project/pane — propose_command
    // only accepts the CURRENTLY-active pane (src/actions/registry.ts's propose_command description:
    // "You can ONLY propose to that pane"), so this must be kicked off before switching away.
    const instruction = delayedExecProbe("bgdrop");
    const proposeCallId = live1(running).emitToolCall("propose_command", { pane_id: "bg-a-pane", instruction, kind: "shell" });
    await waitFor(() => mock.responseFor(proposeCallId));
    await waitFor(() => term.status === "Running", 5000);
    assert.strictEqual(term.lastCommand, instruction, "the slow command genuinely started in A's pane");
    assert.ok(!term.getRecentOutput(100).includes("bgdrop_42"), "the command has not finished yet — it is still in flight when we switch away");

    // NOW switch away — A's pool entry demotes hot-foreground -> handle (D2/D4) WHILE the command
    // is still running in its pane. Wait for B's OWN switch injections to actually LAND (not just
    // the tool responses, which return before the fire-and-forget injectMemoryBrief completes —
    // the same "before < after" idiom every other journey in this file uses) before establishing
    // the baseline below, so a merely-slow-to-land B injection is never mistaken for a NEW leak.
    before = rowsSince(running, bootTs).length;
    callId = live1(running).emitToolCall("switch_context", { project_id: PROJECT_B });
    await waitFor(() => mock.responseFor(callId));
    await waitFor(() => rowsSince(running, bootTs).length > before);
    before = rowsSince(running, bootTs).length;
    callId = live1(running).emitToolCall("switch_active_pane", { pane_id: "bg-b-pane" });
    await waitFor(() => mock.responseFor(callId));
    await waitFor(() => rowsSince(running, bootTs).length > before);

    const session = live1(running) as MockLiveSession;
    const contentsBeforeCommand = session.clientContents.length;
    const rowsBeforeCommand = rowsSince(running, bootTs).length;

    // The command now completes in A's (now-backgrounded) pane while B is live/foreground.
    await waitFor(() => term.getRecentOutput(100).includes("bgdrop_42"), 10000);
    await waitFor(() => term.status === "Idle", 10000);

    // The observe -> paneSignalBus -> voice pipeline is async but fire-and-forget; there is nothing
    // to WAIT for here (D6 says the signal is dropped, not queued — that IS the assertion). A short
    // grace window, not a race we are trying to win.
    await new Promise((r) => setTimeout(r, 200));

    // ── ROUTING correctness (the D6 mechanism itself): no context_injections row was recorded for
    // the backgrounded project A during this window — the idle signal was dropped at the routing
    // choke point (src/voice/index.ts's backgroundProjectForSignal), not queued/injected/misrouted.
    const rowsNow = rowsSince(running, bootTs);
    const rowsDuring = rowsNow.slice(0, rowsNow.length - rowsBeforeCommand);
    assert.ok(!rowsDuring.some(r => r.active_project_id === PROJECT_A), "no context_injections row was recorded for the backgrounded project A during this window");
    // Step 2.5 (strengthened, now that the setup genuinely tracks A — see the addProject note
    // above): the backgrounded command-outcome signal produced NO injection row AT ALL, under any
    // project — dropped at the routing choke point, not injected-under-B (the pre-fix journey run
    // showed a command_outcome row stamped under B here).
    assert.ok(!rowsDuring.some(r => r.trigger === "command_outcome"), "the backgrounded 'idle' signal minted NO command_outcome injection row at all — dropped, not misrouted under the foreground project");
    const newTexts = contextTextsSince(session, contentsBeforeCommand);
    assert.strictEqual(newTexts.length, 0, "no NEW context brief of any kind was delivered during the backgrounded-command window");

    // ── Breadcrumb project scoping (Phase 2 Step 2.5 fix of the Step 2.4 pinned bug): breadcrumbs
    // are now stamped with the pane's owning project (src/observe/index.ts) and filtered per
    // project at render time (src/memory/breadcrumbs.ts recent(now, projectId)). Drive a REAL new
    // brief for B while A's fresh "started/wrapping up/finished" crumbs for bg-a-pane exist and
    // prove none of them leak into B's brief. (The BOARD tier still lists every pane NAME across
    // projects by long-standing design — the crumb text's distinctive "pane bg-a-pane" prefix is
    // what must never appear.)
    const beforeBOutcomeIdx = session.clientContents.length;
    before = rowsSince(running, bootTs).length;
    const deliveredProbe = running._testPublishPaneSignal!({ paneId: "bg-b-pane", kind: "idle", detail: "b pane settled (crumb-scope probe)" });
    assert.strictEqual(deliveredProbe, true, "the bus delivered the foreground-project probe signal");
    await waitFor(() => rowsSince(running, bootTs).length > before);
    const bProbeTexts = contextTextsSince(session, beforeBOutcomeIdx);
    assert.ok(bProbeTexts.length >= 1, "the foreground project's own command-outcome still injects");
    for (const t of bProbeTexts) {
      assert.ok(!t.includes("pane bg-a-pane"), "B's fresh brief carries NONE of A's pane breadcrumbs ('pane bg-a-pane started/wrapping up/finished') — crumbs are project-scoped now");
    }

    // A picks the fact up organically on its own next promotion — nothing was silently lost, only
    // deferred (D6's documented contract), proving the drop is correct routing, not data loss.
    before = rowsSince(running, bootTs).length;
    callId = live1(running).emitToolCall("switch_context", { project_id: PROJECT_A });
    await waitFor(() => mock.responseFor(callId));
    await waitFor(() => rowsSince(running, bootTs).length > before);
    before = rowsSince(running, bootTs).length;
    callId = live1(running).emitToolCall("switch_active_pane", { pane_id: "bg-a-pane" });
    await waitFor(() => mock.responseFor(callId));
    await waitFor(() => rowsSince(running, bootTs).length > before);

    const returnTexts = contextTextsSince(session, session.clientContents.length - 6 < 0 ? 0 : session.clientContents.length - 6);
    assert.ok(returnTexts.some(t => t.includes("bgdrop")), "A's own re-promotion organically surfaces the command it ran while backgrounded");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Journey — a sendClientContent THROW leaves the delivery row permanently unacknowledged and the
// InjectGate un-advanced; the very next attempt mints a strictly newer context_version and (once
// it succeeds) is the one that actually acknowledges/advances state.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("cross-project journey — failed context send (sendClientContent throws) never advances version/gate (Phase 2 Step 2.4)", () => {
  const PROJECT = "xproj-fail";
  let startServer: (opts?: any) => Promise<RunningServer>;
  let apiToken: string;
  let installMockLive: () => MockLiveHandle;
  let waitFor: <T>(p: () => T | undefined | false, t?: number, i?: number) => Promise<T>;

  let mock: MockLiveHandle;
  let running: RunningServer;
  let client: WebSocket;
  let tmpDir: string;
  let prevCwd: string;
  let bootTs: number;
  let seedPane: (paneId: string, projectId: string, lastCommand?: string | null) => void;

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";
    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-xpj-fail-"));
    process.chdir(tmpDir);

    ({ installMockLive, waitFor } = await import("./helpers/mockLive"));
    const serverMod = await import("../server");
    startServer = serverMod.startServer;
    apiToken = serverMod.API_AUTH_TOKEN;

    mock = installMockLive();
    bootTs = Date.now();
    running = await startServer({ port: 0, enableVite: false });
    setCortexPrimary(false);
    disableDebounce(running);

    client = await connectOperator(running, apiToken);
    await waitFor(() => mock.latest() && running._testActiveLiveSession?.());
    seedPane = makeSeedPane(running, tmpDir);
  });

  after(async () => {
    await closeClient(client);
    for (const id of Object.keys(running.manager.terminals)) delete (running.manager.terminals as any)[id];
    await teardownServerSuite(running);
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("a thrown sendClientContent leaves the row unacked/gate un-advanced; the retry mints a newer version and succeeds", async () => {
    seedPane("fail-pane", PROJECT, "first command");

    let before = rowsSince(running, bootTs).length;
    let callId = live1(running).emitToolCall("switch_context", { project_id: PROJECT });
    await waitFor(() => mock.responseFor(callId));
    await waitFor(() => rowsSince(running, bootTs).length > before);
    before = rowsSince(running, bootTs).length;
    callId = live1(running).emitToolCall("switch_active_pane", { pane_id: "fail-pane" });
    await waitFor(() => mock.responseFor(callId));
    await waitFor(() => rowsSince(running, bootTs).length > before);

    const sessionId = rowsSince(running, bootTs)[0].session_id!;
    const store = running._testStore!()!;
    const preFailDeliveries = store.listContextDeliveries(sessionId).filter(d => d.project_id === PROJECT);
    assert.ok(preFailDeliveries.length >= 1);
    const versionBeforeFailure = maxVersion(preFailDeliveries);

    // New world state (so the NEXT trigger is genuinely a fresh snapshot) — then make the send
    // itself throw, exactly like a network drop mid-sendClientContent.
    (running.manager.terminals as any)["fail-pane"].lastCommand = "second command, changed world";
    const session = live1(running) as MockLiveSession;
    const originalSend = session.sendClientContent.bind(session);
    let sendAttempts = 0;
    session.sendClientContent = () => {
      sendAttempts++;
      throw new Error("mock: sendClientContent failed (simulated network drop)");
    };

    before = rowsSince(running, bootTs).length;
    callId = live1(running).emitToolCall("switch_active_pane", { pane_id: "fail-pane" }); // re-affirm the same pane -> a genuinely CHANGED snapshot vs. the gate's last hash
    await waitFor(() => mock.responseFor(callId));
    await waitFor(() => rowsSince(running, bootTs).length > before);
    assert.strictEqual(sendAttempts, 1, "sendClientContent was actually attempted");
    const failedRow = rowsSince(running, bootTs)[0];
    assert.strictEqual(failedRow.disposition, "failed", "the choke point records the send failure honestly, not a fabricated success");

    const deliveriesAfterFailure = store.listContextDeliveries(sessionId).filter(d => d.project_id === PROJECT);
    const failedDeliveryRow = deliveriesAfterFailure.find(d => Number(d.context_version) > versionBeforeFailure);
    assert.ok(failedDeliveryRow, "the failed attempt still MINTED a delivery row — recordDelivery happens BEFORE the send");
    assert.strictEqual(failedDeliveryRow!.acknowledged_at, null, "the failed send's row is NEVER acknowledged");

    // Restore the real send — the retry (same trigger, same still-changed world) mints a STRICTLY
    // newer version and this time succeeds/acknowledges. The gate was never advanced by the failed
    // attempt (noteInjected sits AFTER the send in the choke point), so the retry sees the SAME
    // "changed vs. last-injected-hash" verdict without needing to touch the world again.
    session.sendClientContent = originalSend;
    before = rowsSince(running, bootTs).length;
    callId = live1(running).emitToolCall("switch_active_pane", { pane_id: "fail-pane" });
    await waitFor(() => mock.responseFor(callId));
    await waitFor(() => rowsSince(running, bootTs).length > before);
    const retryRow = rowsSince(running, bootTs)[0];
    assert.strictEqual(retryRow.disposition, "injected", "the retry actually lands this time");

    const deliveriesAfterRetry = store.listContextDeliveries(sessionId).filter(d => d.project_id === PROJECT);
    const retryDeliveryRow = deliveriesAfterRetry
      .filter(d => Number(d.context_version) > Number(failedDeliveryRow!.context_version))
      .sort((a, b) => Number(a.context_version) - Number(b.context_version))[0];
    assert.ok(retryDeliveryRow, "the retry mints a version strictly newer than the failed attempt's — never reuses it");
    assert.ok(retryDeliveryRow!.acknowledged_at, "the retry's row IS acknowledged (the successful send)");

    // The failed row stays permanently unacknowledged even after the retry succeeds.
    const failedRowFinal = store.listContextDeliveries(sessionId).find(d => d.delivery_id === failedDeliveryRow!.delivery_id)!;
    assert.strictEqual(failedRowFinal.acknowledged_at, null, "the original failure is never retroactively acknowledged");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Journey — stale focus mid-assembly: a focus change that lands WHILE a brief is still being
// assembled (awaiting the cortex) can never stamp the wrong pane/project on a context_deliveries
// row. Uses a BLOCKABLE fake cortex to open a real await window deterministically.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("cross-project journey — stale focus mid-assembly never mis-stamps a delivery row (Phase 2 Step 2.4)", () => {
  const PROJECT_A = "xproj-stale-a";
  const PROJECT_B = "xproj-stale-b";
  let startServer: (opts?: any) => Promise<RunningServer>;
  let apiToken: string;
  let installMockLive: () => MockLiveHandle;
  let waitFor: <T>(p: () => T | undefined | false, t?: number, i?: number) => Promise<T>;

  let mock: MockLiveHandle;
  let running: RunningServer;
  let client: WebSocket;
  let tmpDir: string;
  let prevCwd: string;
  let bootTs: number;
  let seedPane: (paneId: string, projectId: string, lastCommand?: string | null) => void;
  let fake: ReturnType<typeof makeBlockableCortex>;

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";
    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-xpj-stale-"));
    process.chdir(tmpDir);

    ({ installMockLive, waitFor } = await import("./helpers/mockLive"));
    const serverMod = await import("../server");
    startServer = serverMod.startServer;
    apiToken = serverMod.API_AUTH_TOKEN;

    mock = installMockLive();
    fake = makeBlockableCortex(["project", "pane"]);
    bootTs = Date.now();
    running = await startServer({ port: 0, enableVite: false, testCortexClientOverride: fake.client });
    setCortexPrimary(true);
    disableDebounce(running);

    client = await connectOperator(running, apiToken);
    await waitFor(() => mock.latest() && running._testActiveLiveSession?.());
    seedPane = makeSeedPane(running, tmpDir);
  });

  after(async () => {
    setCortexPrimary(false);
    resetCortexFallbackStats();
    await closeClient(client);
    for (const id of Object.keys(running.manager.terminals)) delete (running.manager.terminals as any)[id];
    await teardownServerSuite(running);
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("concurrent in-flight requests raced by a project switch: every stale one is dropped BEFORE recordDelivery; every delivered row belongs to the winning project", async () => {
    seedPane("stale-a-pane", PROJECT_A, "alpha work");
    seedPane("stale-b-pane", PROJECT_B, "beta work");

    // Establish both projects with an uncontested (unblocked) round trip first, so the LATER raced
    // attempt isn't confused with either project's very-first-ever injection.
    for (const [proj, pane] of [[PROJECT_A, "stale-a-pane"], [PROJECT_B, "stale-b-pane"], [PROJECT_A, "stale-a-pane"]] as const) {
      let before = rowsSince(running, bootTs).length;
      let callId = live1(running).emitToolCall("switch_context", { project_id: proj });
      await waitFor(() => mock.responseFor(callId));
      await waitFor(() => rowsSince(running, bootTs).length > before);
      before = rowsSince(running, bootTs).length;
      callId = live1(running).emitToolCall("switch_active_pane", { pane_id: pane });
      await waitFor(() => mock.responseFor(callId));
      await waitFor(() => rowsSince(running, bootTs).length > before);
    }
    // A is active again heading into the race.
    assert.strictEqual(running.manager.ledger.activeProjectId, PROJECT_A);

    const sessionId = rowsSince(running, bootTs)[0].session_id!;
    const store = running._testStore!()!;
    const priorRowCount = store.listContextDeliveries(sessionId).length;
    const priorStaleCount = rowsSince(running, bootTs).filter(r => r.disposition === "skipped_stale_brief").length;

    // Change B's world so the FINAL winning request (the real switch_active_pane(stale-b-pane) that
    // settles the race) is a genuinely changed snapshot — otherwise the per-project InjectGate would
    // gate-skip it synchronously (before ever reaching the cortex) as an exact repeat of the warmup
    // visit above, leaving nothing to observe as "the winner".
    (running.manager.terminals as any)["stale-b-pane"].lastCommand = "beta work, updated for the race";

    // The race: block the cortex, fire a re-affirm of A (a genuine in-flight assembly), then — while
    // it is still awaiting — switch all the way to B before releasing the gate. The tool calls
    // themselves return immediately (injectMemoryBrief is fire-and-forget from every call site), so
    // this reliably opens the window without any real-clock sleep.
    fake.block();
    const staleCallId = live1(running).emitToolCall("switch_active_pane", { pane_id: "stale-a-pane" });
    await waitFor(() => mock.responseFor(staleCallId)); // the TOOL response returns instantly; the brief assembly is still blocked
    const switchCallId = live1(running).emitToolCall("switch_context", { project_id: PROJECT_B });
    await waitFor(() => mock.responseFor(switchCallId));
    const paneCallId = live1(running).emitToolCall("switch_active_pane", { pane_id: "stale-b-pane" });
    await waitFor(() => mock.responseFor(paneCallId));
    fake.release(); // let every blocked decide() resolve now that the world has moved on to B

    // Wait for the race to fully settle: at least one NEW stale-drop recorded, and the durable
    // store reflecting whatever legitimately landed.
    await waitFor(() => rowsSince(running, bootTs).filter(r => r.disposition === "skipped_stale_brief").length > priorStaleCount, 8000);
    await new Promise((r) => setTimeout(r, 150)); // let any winning in-flight delivery finish landing too

    const newRowCount = store.listContextDeliveries(sessionId).length - priorRowCount;
    assert.ok(newRowCount >= 1, "at least the WINNING (B) request still delivered normally — the race doesn't wedge the session");

    const newRows = store.listContextDeliveries(sessionId).slice(-newRowCount);
    for (const row of newRows) {
      assert.strictEqual(row.project_id, PROJECT_B, "every delivery row minted during the race belongs to B — a stale A attempt never reaches recordDelivery at all, so it can never mis-stamp a row with the wrong project");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Journey — browser reconnect: a new WS connection gets a fresh SessionPool/voice_session_id, but
// the SERVER-scoped InjectGateRegistry (memory.service.gates) and ContextVersionRegistry survive
// unchanged — so an explicit post-reconnect catch-up for an UNCHANGED world is gate-skipped (no
// duplicate injection), while the pre-reconnect session's own durable rows remain readable.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("cross-project journey — browser reconnect: gate/version continuity, no duplicate catch-up injection (Phase 2 Step 2.4)", () => {
  const PROJECT = "xproj-reconnect";
  let startServer: (opts?: any) => Promise<RunningServer>;
  let apiToken: string;
  let installMockLive: () => MockLiveHandle;
  let waitFor: <T>(p: () => T | undefined | false, t?: number, i?: number) => Promise<T>;

  let mock: MockLiveHandle;
  let running: RunningServer;
  let client: WebSocket;
  let tmpDir: string;
  let prevCwd: string;
  let bootTs: number;
  let seedPane: (paneId: string, projectId: string, lastCommand?: string | null) => void;

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";
    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-xpj-recon-"));
    process.chdir(tmpDir);

    ({ installMockLive, waitFor } = await import("./helpers/mockLive"));
    const serverMod = await import("../server");
    startServer = serverMod.startServer;
    apiToken = serverMod.API_AUTH_TOKEN;

    mock = installMockLive();
    bootTs = Date.now();
    running = await startServer({ port: 0, enableVite: false });
    setCortexPrimary(false);
    disableDebounce(running);

    client = await connectOperator(running, apiToken);
    await waitFor(() => mock.latest() && running._testActiveLiveSession?.());
    seedPane = makeSeedPane(running, tmpDir);
  });

  after(async () => {
    await closeClient(client);
    for (const id of Object.keys(running.manager.terminals)) delete (running.manager.terminals as any)[id];
    await teardownServerSuite(running);
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("a fresh WS connection mints a NEW voice_session_id, but the server-scoped gate/version state survives — an unchanged catch-up is skipped, not re-delivered; the old session's durable rows persist", async () => {
    seedPane("recon-pane", PROJECT, "steady work");

    let before = rowsSince(running, bootTs).length;
    let callId = live1(running).emitToolCall("switch_context", { project_id: PROJECT });
    await waitFor(() => mock.responseFor(callId));
    await waitFor(() => rowsSince(running, bootTs).length > before);
    before = rowsSince(running, bootTs).length;
    callId = live1(running).emitToolCall("switch_active_pane", { pane_id: "recon-pane" });
    await waitFor(() => mock.responseFor(callId));
    await waitFor(() => rowsSince(running, bootTs).length > before);

    const sessionIdBefore = rowsSince(running, bootTs)[0].session_id!;
    const store = running._testStore!()!;
    const deliveriesBefore = store.listContextDeliveries(sessionIdBefore).filter(d => d.project_id === PROJECT);
    assert.ok(deliveriesBefore.length >= 1);
    assert.ok(deliveriesBefore.every(d => d.acknowledged_at != null), "every pre-reconnect delivery for this project actually acknowledged");

    // ── The browser reconnect: close the operator WS, open a fresh one ─────────────────────────
    const sessionsBeforeReconnect = mock.sessions.length;
    await closeClient(client);
    client = await connectOperator(running, apiToken);
    await waitFor(() => mock.sessions.length > sessionsBeforeReconnect && running._testActiveLiveSession?.());

    // ── An explicit post-reconnect catch-up for the SAME (unchanged) project/world ──────────────
    before = rowsSince(running, bootTs).length;
    callId = live1(running).emitToolCall("switch_context", { project_id: PROJECT });
    await waitFor(() => mock.responseFor(callId));
    await waitFor(() => rowsSince(running, bootTs).length > before);
    const catchUpRow = rowsSince(running, bootTs)[0];

    assert.notStrictEqual(catchUpRow.session_id, sessionIdBefore, "the new WS connection minted its OWN voice_session_id — a fresh pool, per D5");
    assert.strictEqual(catchUpRow.disposition, "unchanged-brief", "the server-scoped gate remembers this project's last-injected hash across the reconnect — no duplicate catch-up injection for an unchanged brief");
    assert.strictEqual(catchUpRow.active_project_id, PROJECT);

    // The OLD session's own durable rows are untouched — acknowledged versions survive in the store.
    const deliveriesAfter = store.listContextDeliveries(sessionIdBefore).filter(d => d.project_id === PROJECT);
    assert.strictEqual(deliveriesAfter.length, deliveriesBefore.length, "the pre-reconnect session's own delivery rows are neither mutated nor duplicated by the reconnect");
    assert.deepStrictEqual(
      deliveriesAfter.map(d => d.context_version).sort(),
      deliveriesBefore.map(d => d.context_version).sort(),
      "same versions, same acknowledgement state, before and after the reconnect",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Journey — planted-secret redaction on every delivery path: a representative secret token is
// planted in a project note, a pane's lastCommand, a handoff, and a real propose_command
// instruction; the DELIVERED brief text must never contain it, on both the foreground path AND
// the post-reconnect catch-up path.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("cross-project journey — planted-secret redaction on every delivery path, foreground + catch-up (Phase 2 Step 2.4)", () => {
  const PROJECT = "xproj-secret";
  // NOTE: an AWS-access-key-id-shaped token (a pattern redactSecrets DOES cover — same choice as
  // the existing "brief redaction-clean under cortex composition" journey above). The task's own
  // suggested example, a bare "sk-ant-..." token, is NOT covered by src/terminal.ts's redactSecrets
  // at all — see the dedicated BUG test immediately below this journey, which pins that gap
  // directly rather than silently working around it here.
  const SECRET = "AKIAABCDEFGHIJKLMNOP";
  let startServer: (opts?: any) => Promise<RunningServer>;
  let apiToken: string;
  let installMockLive: () => MockLiveHandle;
  let waitFor: <T>(p: () => T | undefined | false, t?: number, i?: number) => Promise<T>;

  let mock: MockLiveHandle;
  let running: RunningServer;
  let client: WebSocket;
  let tmpDir: string;
  let prevCwd: string;
  let bootTs: number;
  let seedPane: (paneId: string, projectId: string, lastCommand?: string | null) => void;

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";
    process.env.JANUS_SHELL_ALLOWLIST = "echo";
    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-xpj-secret-"));
    process.chdir(tmpDir);

    ({ installMockLive, waitFor } = await import("./helpers/mockLive"));
    const serverMod = await import("../server");
    startServer = serverMod.startServer;
    apiToken = serverMod.API_AUTH_TOKEN;

    mock = installMockLive();
    bootTs = Date.now();
    running = await startServer({ port: 0, enableVite: false });
    setCortexPrimary(false);
    disableDebounce(running);
    if (!running.manager.settings.advanced.capabilityGates) (running.manager.settings.advanced as any).capabilityGates = {};
    (running.manager.settings.advanced.capabilityGates as any).create_pane = "Auto";
    (running.manager.settings.advanced.capabilityGates as any).propose_command = "Auto";
    process.env.VJ42 = "42";

    client = await connectOperator(running, apiToken);
    await waitFor(() => mock.latest() && running._testActiveLiveSession?.());
    seedPane = makeSeedPane(running, tmpDir);
  });

  after(async () => {
    await closeClient(client);
    if (running?.manager) {
      const terms = Object.values(running.manager.terminals) as any[];
      await Promise.all(terms.map((t) => Promise.resolve(t?.stop?.()).catch(() => undefined)));
      for (const id of Object.keys(running.manager.terminals)) delete (running.manager.terminals as any)[id];
    }
    await teardownServerSuite(running);
    process.chdir(prevCwd);
    delete process.env.VJ42;
    delete process.env.JANUS_SHELL_ALLOWLIST;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("a secret planted in a note/lastCommand/handoff/command-instruction never reaches Gemini raw, on the foreground path or the post-reconnect catch-up path", async () => {
    seedPane("secret-b-pane", PROJECT, `a stable pane, secret in lastCommand: ${SECRET}`);

    // Plant the secret across multiple durable sources WorldModel reads from.
    running.manager.ledger.addProject(PROJECT, tmpDir, `Project ${PROJECT}`, []);
    const store = running._testStore!()!;
    store.addNote(PROJECT, `internal decision: rotate to ${SECRET}`, { type: "decision" });
    store.createHandoff({ workspace_id: PROJECT, to_pane: "secret-b-pane", state: "delivered", composed_prompt: `please review, key is ${SECRET}` });

    // A real command with the secret in its instruction (exercises the assembled ACTIVE PANE tier's
    // lastCommand for a genuinely-run pane, not just a duck-typed fixture).
    const createCallId = live1(running).emitToolCall("create_pane", {
      project_id: PROJECT, pane_id: "secret-a-pane", tool_preset: "Custom", permissions_mode: "Full Auto",
    });
    await waitFor(() => mock.responseFor(createCallId));
    const instruction = `echo start && echo ${SECRET} && echo done`; // never actually run (allowlist is "echo" only, but the secret is in the TEXT, which is what we assert on)
    const proposeCallId = live1(running).emitToolCall("propose_command", { pane_id: "secret-a-pane", instruction, kind: "shell" });
    await waitFor(() => mock.responseFor(proposeCallId));

    // ── Foreground delivery path ─────────────────────────────────────────────────────────────
    const session = live1(running) as MockLiveSession;
    const beforeIdx = session.clientContents.length;
    const before = rowsSince(running, bootTs).length;
    const switchCallId = live1(running).emitToolCall("switch_context", { project_id: PROJECT });
    await waitFor(() => mock.responseFor(switchCallId));
    await waitFor(() => rowsSince(running, bootTs).length > before);

    const foregroundTexts = contextTextsSince(session, beforeIdx);
    assert.ok(foregroundTexts.length >= 1, "at least one CONTEXT payload was delivered on the foreground path");
    for (const t of foregroundTexts) {
      assert.ok(!t.includes(SECRET), "foreground path: the raw secret never reaches Gemini");
    }
    const store2 = running._testStore!()!;
    const deliveryRows = store2.listContextDeliveries(rowsSince(running, bootTs)[0].session_id!).filter(d => d.project_id === PROJECT);
    for (const row of deliveryRows) {
      const raw = JSON.stringify(row);
      assert.ok(!raw.includes(SECRET), "context_deliveries rows carry only hashes/ids, never the raw brief text — and indeed never the secret");
    }

    // ── Post-reconnect catch-up delivery path ────────────────────────────────────────────────
    const sessionsBeforeReconnect = mock.sessions.length;
    await closeClient(client);
    client = await connectOperator(running, apiToken);
    await waitFor(() => mock.sessions.length > sessionsBeforeReconnect && running._testActiveLiveSession?.());

    const session2 = live1(running) as MockLiveSession;
    const beforeIdx2 = session2.clientContents.length;
    const before2 = rowsSince(running, bootTs).length;
    // Change the project's world slightly (a fresh secret-bearing note) so the post-reconnect catch-up
    // is a genuine NEW injection, not a gate-skip — otherwise there is no NEW payload to inspect.
    store2.addNote(PROJECT, `catch-up decision: re-confirm ${SECRET}`, { type: "decision" });
    const catchUpCallId = live1(running).emitToolCall("switch_context", { project_id: PROJECT });
    await waitFor(() => mock.responseFor(catchUpCallId));
    await waitFor(() => rowsSince(running, bootTs).length > before2);

    const catchUpTexts = contextTextsSince(session2, beforeIdx2);
    assert.ok(catchUpTexts.length >= 1, "at least one CONTEXT payload was delivered on the catch-up path");
    for (const t of catchUpTexts) {
      assert.ok(!t.includes(SECRET), "catch-up path: the raw secret never reaches Gemini either");
      assert.ok(t.includes("[REDACTED"), "the redaction marker IS present in its place");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Phase 2 Step 2.5 fix of the Step 2.4 pinned gap: redactSecrets/classifySecrets (src/terminal.ts,
// the ONLY secret scrubber in this codebase) now cover bare Anthropic/OpenAI-style "sk-..." keys
// with two deliberately BOUNDED shapes — a known vendor prefix (sk-ant-…/sk-proj-… with a >= 8
// char tail) and a generic long token (>= 20 chars after "sk-", the legacy OpenAI shape) — so a
// pasted bare key with NO surrounding "api_key=" label is scrubbed before any model-bound sink and
// hard-blocked by the prompt-delivery guard, while ordinary prose ("sk-learn") stays untouched.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("redactSecrets/classifySecrets cover bare Anthropic/OpenAI-style 'sk-...' API keys (Step 2.5 fix)", () => {
  it("a bare sk-ant-... token (no surrounding label) is redacted — the task's own example secret shape", () => {
    const withSecret = "please rotate the key to sk-ant-SECRET123 before you continue";
    const redacted = redactSecrets(withSecret);
    assert.ok(!redacted.includes("sk-ant-SECRET123"), "the bare key never survives redactSecrets");
    assert.ok(redacted.includes("[REDACTED:api-key]"), "the api-key redaction marker takes its place");
    // sk-proj-… (the OpenAI project-key prefix) and the generic long legacy shape are covered too.
    assert.ok(!redactSecrets("use sk-proj-AbCdEf123456 now").includes("sk-proj-AbCdEf123456"));
    assert.ok(!redactSecrets("legacy sk-AbCdEfGhIjKlMnOpQrStUv123 key").includes("sk-AbCdEfGhIjKlMnOpQrStUv123"));
  });

  it("the patterns stay BOUNDED — short/prose sk- shapes are never mangled", () => {
    for (const benign of ["pip install sk-learn", "task sk-1 is done", "sk-ant-x", "the sk- prefix itself"]) {
      assert.strictEqual(redactSecrets(benign), benign, `benign text must pass untouched: ${benign}`);
    }
  });

  it("classifySecrets flags a bare sk-... token HIGH-confidence so the prompt-delivery guard can block it", () => {
    const scan = classifySecrets("export ANTHROPIC_API_KEY_LITERAL sk-ant-SECRET123");
    assert.strictEqual(scan.confidence, "high", "a bare vendor-prefixed key is as format-distinctive as ghp_/AKIA — high confidence");
    assert.ok(scan.labels.includes("api-key"));
    assert.strictEqual(classifySecrets("pip install sk-learn").confidence, "none", "benign prose stays unflagged");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Journey — single-session floor regression: with the pool degenerating to exactly one project
// (never switching to a second one), the complete pre-pool behavior holds end-to-end through the
// real server — session-start, changed-vs-unchanged gate skip, and monotonic per-pair versions.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("cross-project journey — single-session floor regression: one project behaves exactly as pre-pool (Phase 2 Step 2.4)", () => {
  const PROJECT = "xproj-floor";
  let startServer: (opts?: any) => Promise<RunningServer>;
  let apiToken: string;
  let installMockLive: () => MockLiveHandle;
  let waitFor: <T>(p: () => T | undefined | false, t?: number, i?: number) => Promise<T>;

  let mock: MockLiveHandle;
  let running: RunningServer;
  let client: WebSocket;
  let tmpDir: string;
  let prevCwd: string;
  let bootTs: number;
  let seedPane: (paneId: string, projectId: string, lastCommand?: string | null) => void;

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";
    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-xpj-floor-"));
    process.chdir(tmpDir);

    ({ installMockLive, waitFor } = await import("./helpers/mockLive"));
    const serverMod = await import("../server");
    startServer = serverMod.startServer;
    apiToken = serverMod.API_AUTH_TOKEN;

    mock = installMockLive();
    bootTs = Date.now();
    running = await startServer({ port: 0, enableVite: false });
    setCortexPrimary(false);
    disableDebounce(running);

    client = await connectOperator(running, apiToken);
    await waitFor(() => mock.latest() && running._testActiveLiveSession?.());
    seedPane = makeSeedPane(running, tmpDir);
  });

  after(async () => {
    await closeClient(client);
    for (const id of Object.keys(running.manager.terminals)) delete (running.manager.terminals as any)[id];
    await teardownServerSuite(running);
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("session_start, a genuinely changed switch, an unchanged repeat, and monotonic per-pair versioning — all byte-identical to the pre-pool single-session world", async () => {
    seedPane("floor-a", PROJECT, "first work");
    seedPane("floor-b", PROJECT, "second work");

    let before = rowsSince(running, bootTs).length;
    let callId = live1(running).emitToolCall("switch_context", { project_id: PROJECT });
    await waitFor(() => mock.responseFor(callId));
    await waitFor(() => rowsSince(running, bootTs).length > before);
    before = rowsSince(running, bootTs).length;
    callId = live1(running).emitToolCall("switch_active_pane", { pane_id: "floor-a" });
    await waitFor(() => mock.responseFor(callId));
    await waitFor(() => rowsSince(running, bootTs).length > before);
    const firstRow = rowsSince(running, bootTs)[0];
    assert.strictEqual(firstRow.disposition, "injected");
    const sessionId = firstRow.session_id!;

    const store = running._testStore!()!;
    const v1 = maxVersion(store.listContextDeliveries(sessionId).filter(d => d.project_id === PROJECT));
    assert.ok(v1 >= 1);

    // Genuinely changed (a different pane) -> injects, version strictly advances.
    before = rowsSince(running, bootTs).length;
    callId = live1(running).emitToolCall("switch_active_pane", { pane_id: "floor-b" });
    await waitFor(() => mock.responseFor(callId));
    await waitFor(() => rowsSince(running, bootTs).length > before);
    assert.strictEqual(rowsSince(running, bootTs)[0].disposition, "injected");
    const v2 = maxVersion(store.listContextDeliveries(sessionId).filter(d => d.project_id === PROJECT));
    assert.ok(v2 > v1, "version strictly advances on a genuinely changed switch");

    // Unchanged repeat (same pane, same world) -> gate-skips, version stays put.
    before = rowsSince(running, bootTs).length;
    callId = live1(running).emitToolCall("switch_active_pane", { pane_id: "floor-b" });
    await waitFor(() => mock.responseFor(callId));
    await waitFor(() => rowsSince(running, bootTs).length > before);
    assert.strictEqual(rowsSince(running, bootTs)[0].disposition, "unchanged-brief");
    const v3 = maxVersion(store.listContextDeliveries(sessionId).filter(d => d.project_id === PROJECT));
    assert.strictEqual(v3, v2, "a gate-skipped repeat never mints a new version");

    // Every delivery row THIS TEST'S own PROJECT traffic produced belongs to the ONE (project,
    // session) pair — a single-project world never fragments its own version counter (this
    // excludes the connection's very first automatic session_start row, which predates any
    // project_id this test chose and is a fixed pre-existing behavior out of scope here).
    const projectRows = store.listContextDeliveries(sessionId).filter(d => d.project_id === PROJECT);
    assert.ok(projectRows.length >= 3, "at least the three explicit switches above each minted or reused exactly one row's worth of state");
    assert.ok(projectRows.every(r => r.voice_session_id === sessionId), "every one of THIS project's rows carries the SAME session id — no fragmentation");
  });
});
