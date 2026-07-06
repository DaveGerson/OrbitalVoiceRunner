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
    const session = live1(running) as MockLiveSession;
    const contextPushes = session.clientContents.filter((c: any) =>
      c?.turns?.[0]?.parts?.[0]?.text?.startsWith("CONTEXT (situational, do not read aloud):")
    );
    assert.ok(contextPushes.length >= 1, "at least one CONTEXT payload was sent");
    const sentText = String(contextPushes[contextPushes.length - 1].turns[0].parts[0].text);
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

    // Whether THAT organic idle was DELIVERED is machine-speed dependent BY DESIGN: the bus's L1
    // cross-kind cooldown (crossKindCooldownMs=5000, src/paneSignalBus.ts) suppresses any signal
    // landing within 5s of the pane's last DELIVERED signal, and a fast probe (spawn running ->
    // probe running -> quiescing -> idle, idleTimeoutMs=2000) fits the whole cluster inside one
    // window on a fast runner (this failed deterministically on ubuntu CI while passing on slower
    // ConPTY). The injection leg inheriting the SPOKEN-turn anti-spam is a recorded product
    // question (bead wsm-e2e-pinned-1d6w: inject-leg vs L1 cooldown); the chain under test here is
    // idle-edge -> voice subscription -> gate -> telemetry. So: accept the organic row when the
    // runner was slow enough, otherwise REPLAY the same edge payload through the real bus (same
    // publish path, full bus semantics). A single fixed sleep is NOT enough to age the window: a
    // live shell can re-stamp it mid-wait (a late prompt redraw delivers a genuine running/idle
    // flap — observed locally on Windows), so retry until the bus accepts the replay. Dropped
    // publishes never stamp any bus state (src/paneSignalBus.ts), so polling is side-effect-free.
    const organicOutcomeRow = () => rowsSince(running, bootTs).find(
      (r) => r.trigger === "command_outcome" && r.active_pane_id === "outcome-a" && r.disposition === "injected");
    if (!organicOutcomeRow()) {
      const deadline = Date.now() + 20_000;
      let redelivered = false;
      while (!redelivered && !organicOutcomeRow() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1300));
        redelivered = running._testPublishPaneSignal!({
          paneId: "outcome-a", kind: "idle", detail: "completion replay (organic edge cooldown-suppressed)",
        });
      }
      assert.ok(redelivered || organicOutcomeRow(),
        "the replayed completion edge must outlive the pane's cooldown window and deliver");
    }
    const outcomeRow = await waitFor(organicOutcomeRow, 10000);
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

    // PaneSignalBus runs its OWN cross-kind cooldown (crossKindCooldownMs, default 5000ms —
    // src/paneSignalBus.ts): any signal below "exited" priority (idle included) published within
    // that window of ANY prior signal for the SAME pane is dropped at the bus itself, before it
    // ever reaches the InjectGate. That is a distinct anti-spam mechanism from the gate under test
    // here, so this waits it out rather than working around it — a duck-typed pane costs nothing to
    // wait on since nothing can spontaneously change its state in the meantime.
    await new Promise((r) => setTimeout(r, 5200));

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
