// tests/test_context_injection_telemetry.ts — Phase B gap-fill: the ACTUAL injectMemoryBrief choke
// point instrumented in src/voice/index.ts (spec docs/superpowers/specs/2026-07-02-cortex-context-
// telemetry.md, §18.1/18.2/18.3/18.5). Driven through a REAL server boot (startServer +
// installMockLive — the tests/test_voice_journeys.ts / tests/test_us_epic02_switching.ts idiom) so
// these tests exercise the GENUINE four call sites end-to-end, not a reimplementation of the guard
// logic (that reimplementation style already exists for the underlying refocus guard in
// tests/test_memory_injector_guard.ts / tests/test_memory_refocus.ts — this file does not repeat it).
//
// UT-ID mapping (spec §9 + §18.5) — what is genuinely NEW here vs. already covered elsewhere:
//   Per-trigger rows, all four call sites (session_start / pane_switch x2 call sites /
//     project_switch / reconnect)                                    → NEW, this file
//   Disposition reachability: injected, skipped_stale_brief, failed  → NEW, this file (via a REAL
//     race — coreState.activePaneId yanked mid-await — and a REAL throwing sendClientContent)
//   Disposition reachability: skipped_no_session, skipped_empty_brief → NOT independently reachable
//     through this real-server harness (see the note above the "known-unreachable" describe block
//     below for why, and where their CONTRACT is already verified instead)
//   inject_id JOIN integrity (context_injections ⟷ cortex_decision ⟷ gemini_turn_usage) → NEW,
//     this file (the v9-only two-table join sanity is tests/test_cortex_measurement.ts; the v10 leg
//     joining all three is new)
//   UT-FOCUS-002/003 (A->B->A: durable pane rows not duplicated; brief_hash repeats)  → the
//     durable-no-dup + refocus CONTENT behavior is tests/test_memory_refocus.ts; the TELEMETRY view
//     of it (repeat brief_hash visible in context_injections) is new here
//   Focus correctness (brief_active_pane_id === active_pane_id on injected rows)      → NEW, this file
// Neighbors explicitly NOT duplicated (delta 18.5's mapping): approval exactly-once
// (test_approval_dupsend.ts et al.), stop-all (test_stop_all_two_stage.ts et al.), drafts
// (test_store_drafts.ts et al.), wrong-pane/stale-brief GUARD semantics (test_memory_injector_guard.ts,
// test_memory_refocus.ts), breadcrumb bounds (test_memory_breadcrumbs.ts), observe-only socket
// (test_observe_socket.ts), the v9 spine + migration v10 + writer/reader round-trip + hash/token
// helpers (test_cortex_measurement.ts, test_context_telemetry_store.ts — Phase A).
//
// Runner: npx tsx --test --test-force-exit tests/test_context_injection_telemetry.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";
import type { MockLiveHandle, MockLiveSession } from "./helpers/mockLive";
import { teardownServerSuite } from "./helpers/teardown";
import type { RunningServer } from "../server";
import type { JanusStore } from "../src/store/sqliteStore";
import { DEFAULT_VOICE_UX } from "../src/types";
import type { ContextInjectionEvent } from "../src/memory/contextTelemetry";
import { setCortexPrimary } from "../src/memory/cortexShadow";

const PROJECT = "cti_proj";

describe("cortex context-injection telemetry (real server, real choke point — spec 2026-07-02 §18)", () => {
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

  const live = (): MockLiveSession => running._testActiveLiveSession!() as MockLiveSession;
  const store = (): JanusStore => running._testStore!()!;
  /** Every context_injections row recorded since boot, newest-first (matches the store's own order). */
  const rows = (): ContextInjectionEvent[] =>
    store().getContextInjections({ since: bootTs - 1, limit: 1000 }) as unknown as ContextInjectionEvent[];

  /** Register a pane WITHOUT spawning a real PTY: a duck-typed manager.terminals entry carrying only
   *  the fields production code actually reads off it (WorldModel.getPaneTier + terminal.ts's
   *  syncLedger/buildPaneMeta — both plain field reads, never method calls), so switch_active_pane's
   *  `!!term` existence guard passes and the ACTIVE PANE tier resolves. Mirrors the fake-manager idiom
   *  already established in tests/test_memory_refocus.ts / tests/test_us_epic02_switching.ts, wired
   *  into the REAL running.manager instead of a standalone fake. */
  function seedPane(paneId: string, projectId: string): void {
    if (!running.manager.ledger.getProject(projectId)) {
      running.manager.ledger.addProject(projectId, tmpDir, `Project ${projectId}`, []);
    }
    (running.manager.terminals as any)[paneId] = {
      name: paneId,
      runtimeType: "interactive_cli",
      status: "Idle",
      lastCommand: null,
      projectId,
      cwd: tmpDir,
      toolPreset: "Custom",
      sessionId: "",
      permissionsMode: "Human-in-the-Loop",
      contextSize: 0,
      lastStatusChangeAt: Date.now(), // buildPaneMeta/syncLedger reads this to stamp last_status_change_at
    };
    running.manager.refreshLedger(); // syncs the terminal into ledger.workspaces[projectId].panes[paneId]
  }

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";
    // Shrink the bounded reconnect backoff (read per WS connection — src/voice/index.ts) so the
    // reconnect-trigger test runs deterministically fast, mirroring tests/test_voice_journeys.ts.
    process.env.JANUS_RECONNECT_MAX_ATTEMPTS = "3";
    process.env.JANUS_RECONNECT_BASE_DELAY_MS = "20";
    process.env.JANUS_RECONNECT_MAX_DELAY_MS = "60";

    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-cti-"));
    process.chdir(tmpDir);

    ({ installMockLive, waitFor } = await import("./helpers/mockLive"));
    const serverMod = await import("../server");
    startServer = serverMod.startServer;
    apiToken = serverMod.API_AUTH_TOKEN;

    mock = installMockLive();
    bootTs = Date.now();
    running = await startServer({ port: 0, enableVite: false });
    assert.ok(running._testStore, "the server exposes the JanusStore test seam");
    assert.ok(running._testStore!(), "the SQLite store booted (default backend — delta 18.4 requires it non-null)");
    // Wave 4 (D5) fixer note, 2026-07-03: cortex-primary is now the boot-time DEFAULT (server.ts's
    // resolveCortexPrimaryFlagFromEnv), but this suite is about the injectMemoryBrief choke point's
    // OWN telemetry/disposition-reachability contract (session_start/pane_switch/reconnect rows,
    // inject_id joins, ...), not cortex curation — and it boots with no warm daemon. Pin cortex
    // primary explicitly OFF so every `disposition, "injected"` assertion below stays a floor-path
    // assertion regardless of the ambient default (cortex-primary curation itself is exercised
    // separately, with a controllable fake client, by tests/test_cortex_cutover_journeys.ts).
    setCortexPrimary(false);
    // Wave 4 (D2, cortex cutover design): the InjectGate's debounce floor (default 3000ms) now sits
    // in front of every non-session-start injection. This suite drives many DISTINCT-pane triggers
    // back-to-back with no real-clock pacing — its own concern is per-trigger disposition/telemetry
    // labeling (the gate's own timing behavior is covered by tests/test_inject_gate.ts and
    // tests/test_cortex_cutover_journeys.ts), so zero the floor to isolate that concern.
    running.manager.settings.voiceUx = { ...(running.manager.settings.voiceUx ?? DEFAULT_VOICE_UX), contextInjectDebounceMs: 0 };

    client = new WebSocket(`ws://127.0.0.1:${running.port}/live`, {
      headers: { Cookie: `auth_token=${apiToken}` },
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
    // seedPane() registers duck-typed fake terminals (no real PTY, no .stop()) directly onto
    // running.manager.terminals — drop them before close() so its terminal-teardown loop (which
    // calls term.stop() on every entry) doesn't log a caught-but-noisy TypeError per fake pane.
    for (const id of Object.keys(running.manager.terminals)) {
      delete (running.manager.terminals as any)[id];
    }
    await teardownServerSuite(running);
    process.chdir(prevCwd);
    delete process.env.JANUS_RECONNECT_MAX_ATTEMPTS;
    delete process.env.JANUS_RECONNECT_BASE_DELAY_MS;
    delete process.env.JANUS_RECONNECT_MAX_DELAY_MS;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // Call site 1 — the post-connect injection (src/voice/index.ts ~1498), first connect.
  // ───────────────────────────────────────────────────────────────────────────────────────────
  it("the initial connect records exactly one session_start row (first connect, not a reconnect)", async () => {
    await waitFor(() => rows().find((r) => r.trigger === "session_start"));
    const sessionStartRows = rows().filter((r) => r.trigger === "session_start");
    assert.strictEqual(sessionStartRows.length, 1, "exactly one session_start row after the initial connect");
    assert.strictEqual(sessionStartRows[0].source, "fallback", "no python daemon in this suite -> fallback synthesizer");
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // Call site 2 — the setActivePane ctx hook (src/voice/index.ts ~964, switch_active_pane tool).
  // ───────────────────────────────────────────────────────────────────────────────────────────
  it("switch_active_pane (setActivePane ctx hook) records pane_switch/injected with focus correctness", async () => {
    seedPane("cti-pane-a", PROJECT);
    const before = rows().length;

    const callId = live().emitToolCall("switch_active_pane", { pane_id: "cti-pane-a" });
    await waitFor(() => mock.responseFor(callId));

    await waitFor(() => rows().length > before);
    const row = rows()[0];
    assert.strictEqual(row.trigger, "pane_switch");
    assert.strictEqual(row.disposition, "injected");
    assert.strictEqual(row.active_pane_id, "cti-pane-a");
    // Focus correctness: the brief actually synthesized FOR the pane we asked it to focus.
    assert.strictEqual(row.brief_active_pane_id, "cti-pane-a", "brief_active_pane_id === active_pane_id on an injected row");
    assert.ok(row.inject_id, "an injected row always carries the minted inject_id");
    assert.ok(row.brief_hash, "an injected row carries a brief hash");
    assert.ok(row.brief_chars > 0);
    assert.strictEqual(row.estimated_tokens, Math.ceil(row.brief_chars / 4));
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // Call site 3 — handleSetActivePaneFrame (src/voice/index.ts ~1694, UI set_active_pane WS frame).
  // Distinct code path from call site 2 even though both emit trigger "pane_switch".
  // ───────────────────────────────────────────────────────────────────────────────────────────
  it("the UI set_active_pane WS frame (handleSetActivePaneFrame) ALSO records pane_switch/injected", async () => {
    seedPane("cti-pane-b", PROJECT);
    const before = rows().length;

    client.send(JSON.stringify({ type: "set_active_pane", paneId: "cti-pane-b" }));

    await waitFor(() => rows().length > before);
    const row = rows()[0];
    assert.strictEqual(row.trigger, "pane_switch");
    assert.strictEqual(row.disposition, "injected");
    assert.strictEqual(row.active_pane_id, "cti-pane-b");
    assert.strictEqual(row.brief_active_pane_id, "cti-pane-b");
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // Call site 4 — the ctx.injectMemoryBrief hook (src/voice/index.ts ~971, switch_context tool ->
  // src/actions/defs/orient.ts, which now passes trigger "project_switch" explicitly).
  // ───────────────────────────────────────────────────────────────────────────────────────────
  it("switch_context (ctx.injectMemoryBrief hook) records project_switch/injected", async () => {
    const before = rows().length;

    const callId = live().emitToolCall("switch_context", { project_id: PROJECT });
    await waitFor(() => mock.responseFor(callId));

    await waitFor(() => rows().length > before);
    const row = rows()[0];
    assert.strictEqual(row.trigger, "project_switch");
    assert.strictEqual(row.disposition, "injected");
    assert.strictEqual(row.active_project_id, PROJECT);
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // Call site 1 again — the reconnect leg (isReconnect=true -> trigger "reconnect", NOT
  // "session_start"; src/voice/index.ts's connectLiveSession(isReconnect) param, in closure scope).
  // ───────────────────────────────────────────────────────────────────────────────────────────
  it("a reconnect after a socket drop records trigger=reconnect (the session_start count stays at 1)", async () => {
    const session1 = live();
    const sessionsBefore = mock.sessions.length;
    const before = rows().length;

    session1.emitClose({ code: 1006, reason: "telemetry suite: simulated drop" });

    const session2 = await waitFor(
      () => (mock.sessions.length > sessionsBefore ? mock.latest() : undefined),
      8000
    );
    assert.notStrictEqual(session2, session1, "the bounded reconnect minted a fresh session");
    await waitFor(() => running._testActiveLiveSession!() === session2, 8000);

    await waitFor(() => rows().length > before, 8000);
    const reconnectRow = rows().find((r) => r.trigger === "reconnect");
    assert.ok(reconnectRow, "a reconnect row was recorded on the post-hoist injection");
    assert.strictEqual(reconnectRow!.disposition, "injected");
    assert.strictEqual(
      rows().filter((r) => r.trigger === "session_start").length,
      1,
      "the reconnect must NOT be mis-labeled session_start"
    );
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // A -> B -> A: no durable pane duplication + brief_hash repeats across the two A-visits
  // (UT-FOCUS-002/003's telemetry angle — the durable/refocus CONTENT behavior itself is
  // tests/test_memory_refocus.ts).
  // ───────────────────────────────────────────────────────────────────────────────────────────
  it("A->B->A: the ledger keeps exactly the seeded panes (no dup), and the two A-visit brief_hashes match", async () => {
    const AB_PROJECT = "cti_ab_proj";
    seedPane("ab-pane-a", AB_PROJECT); // both seeded BEFORE any switch so BOARD tier is stable
    seedPane("ab-pane-b", AB_PROJECT); // across both A-visits (no confound from a pane appearing later)

    const paneIdsBefore = Object.keys(running.manager.ledger.getProject(AB_PROJECT)!.panes).sort();
    assert.deepStrictEqual(paneIdsBefore, ["ab-pane-a", "ab-pane-b"]);

    // A
    let before = rows().length;
    let callId = live().emitToolCall("switch_active_pane", { pane_id: "ab-pane-a" });
    await waitFor(() => mock.responseFor(callId));
    await waitFor(() => rows().length > before);
    const hashA1 = rows()[0].brief_hash;
    assert.ok(hashA1);

    // B
    before = rows().length;
    callId = live().emitToolCall("switch_active_pane", { pane_id: "ab-pane-b" });
    await waitFor(() => mock.responseFor(callId));
    await waitFor(() => rows().length > before);

    // A again
    before = rows().length;
    callId = live().emitToolCall("switch_active_pane", { pane_id: "ab-pane-a" });
    await waitFor(() => mock.responseFor(callId));
    await waitFor(() => rows().length > before);
    const secondARow = rows()[0];
    assert.strictEqual(secondARow.active_pane_id, "ab-pane-a");
    assert.strictEqual(secondARow.brief_active_pane_id, "ab-pane-a", "focus correctness holds on the SECOND A-visit too");

    assert.strictEqual(secondARow.brief_hash, hashA1, "nothing changed for pane A between visits -> the brief_hash repeats");

    const paneIdsAfter = Object.keys(running.manager.ledger.getProject(AB_PROJECT)!.panes).sort();
    assert.deepStrictEqual(paneIdsAfter, paneIdsBefore, "A->B->A creates NO durable pane duplication");
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // Disposition: skipped_stale_brief. A DETERMINISTIC race (not timing-luck): switch_active_pane's
  // handler synchronously calls ctx.setActivePane (which flips coreState.activePaneId and fires
  // injectMemoryBrief WITHOUT awaiting it) before returning; running._testSetActivePane then yanks
  // focus elsewhere in the SAME synchronous tick, guaranteed to land before injectMemoryBrief's own
  // `await memory.service.synthesizeAsync(...)` can possibly have resolved (a real Promise settle
  // requires at least one microtask tick, which cannot happen inside this synchronous test body).
  // ───────────────────────────────────────────────────────────────────────────────────────────
  it("a pane switch raced by focus moving elsewhere before synthesis completes records skipped_stale_brief", async () => {
    const RACE_PROJECT = "cti_race_proj";
    seedPane("race-pane-a", RACE_PROJECT);
    seedPane("race-pane-elsewhere", RACE_PROJECT);
    const before = rows().length;

    const callId = live().emitToolCall("switch_active_pane", { pane_id: "race-pane-a" });
    // Synchronously yank focus elsewhere — see the block comment above for why this beats the await.
    running._testSetActivePane!("race-pane-elsewhere");
    await waitFor(() => mock.responseFor(callId));

    await waitFor(() => rows().length > before);
    const row = rows()[0];
    assert.strictEqual(row.trigger, "pane_switch");
    assert.strictEqual(row.disposition, "skipped_stale_brief");
    assert.strictEqual(row.active_pane_id, "race-pane-a", "the row records the REQUESTED pane, not where focus ended up");
    assert.ok(row.inject_id, "skipped_stale_brief happens AFTER the mint — inject_id is non-null");
    assert.strictEqual(row.skipped_reason, "operator switched the active pane before synthesis completed");
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // Disposition: failed. A genuine throw from the send path, caught by injectMemoryBrief's own
  // try/catch — proves telemetry records the failure AND that it never surfaces into the live loop
  // (the tool call itself must still complete normally).
  // ───────────────────────────────────────────────────────────────────────────────────────────
  it("a throwing sendClientContent records disposition=failed with a redacted error, and never breaks the tool call", async () => {
    seedPane("fail-pane", PROJECT);
    const session = live();
    const original = session.sendClientContent;
    session.sendClientContent = () => { throw new Error("boom: sendClientContent exploded"); };
    const before = rows().length;
    try {
      const callId = live().emitToolCall("switch_active_pane", { pane_id: "fail-pane" });
      // The tool call itself must complete normally — the throw is confined to the fire-and-forget brief.
      const out = await waitFor(() => mock.responseFor(callId));
      assert.match(String(out), /Opened pane 'fail-pane'/);

      await waitFor(() => rows().length > before);
      const row = rows()[0];
      assert.strictEqual(row.disposition, "failed");
      assert.strictEqual(row.trigger, "pane_switch");
      assert.ok(row.error, "the redacted error string is recorded");
      assert.match(row.error!, /boom: sendClientContent exploded/);
    } finally {
      session.sendClientContent = original;
    }
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // inject_id JOIN integrity: one context_injections row's inject_id ties to the SAME row in
  // cortex_decision and, once a Gemini turn lands, gemini_turn_usage — a genuine three-way join,
  // not just the pairwise v9 sanity check already covered by tests/test_cortex_measurement.ts.
  //
  // NOTE on cortex_decision here: observeCortexShadow's SHADOW tap is a no-op whenever
  // `cortexClient.available()` is false (src/memory/index.ts:84) — true in this harness, since no
  // Python cortex daemon runs under `npm test`. So the decision leg below writes DIRECTLY via
  // store.recordCortexDecision using the SAME REAL injectId the live choke point minted and
  // recorded on the context_injections row — this proves the JOIN KEY is share-compatible across
  // both tables end-to-end (same string, same DB, queryable together), which is the thing genuinely
  // new here. The SHADOW tap's OWN wiring (that it fires unconditionally with that exact injectId
  // when a cortex client IS available) is already unit-tested directly against MemoryService in
  // tests/test_cortex_measurement.ts (Task 5/6).
  // ───────────────────────────────────────────────────────────────────────────────────────────
  it("inject_id joins context_injections, cortex_decision, and (once a turn lands) gemini_turn_usage", async () => {
    seedPane("join-pane", PROJECT);
    const before = rows().length;
    const callId = live().emitToolCall("switch_active_pane", { pane_id: "join-pane" });
    await waitFor(() => mock.responseFor(callId));
    await waitFor(() => rows().length > before);

    const row = rows()[0];
    assert.strictEqual(row.disposition, "injected");
    const injectId = row.inject_id!;
    assert.ok(injectId);

    store().recordCortexDecision({
      ts: Date.now(), injectId, sessionId: null, activePaneId: row.active_pane_id,
      trigger: "brief-inject", ruleFired: "baseline-identity", applied: false, traceJson: "{}",
    });
    const decisionRows = store().getCortexDecisions(0).filter((r) => r.inject_id === injectId);
    assert.strictEqual(decisionRows.length, 1, "the decision row shares the SAME inject_id the live choke point minted");

    // A Gemini turn lands on the CURRENTLY-hoisted session (may be a post-reconnect session from an
    // earlier test — `live()` always reads the current one) carrying usageMetadata at turn-complete.
    live().emit({
      serverContent: { turnComplete: true },
      usageMetadata: { promptTokenCount: 11, responseTokenCount: 7, totalTokenCount: 18 },
    });

    const usageRows = await waitFor(() => {
      const u = store().getGeminiTurnUsages(0).filter((r) => r.inject_id === injectId);
      return u.length > 0 ? u : undefined;
    });
    assert.strictEqual(usageRows.length, 1);
    assert.strictEqual(usageRows[0].total_tokens, 18);

    // Three-way join on the SAME key.
    const ctxRows = rows().filter((r) => r.inject_id === injectId);
    assert.strictEqual(ctxRows.length, 1);
  });

  it("skipped_dedupe_candidate is never emitted this PR (dedupe is metric-only — delta 18.3)", () => {
    for (const r of rows()) {
      assert.notStrictEqual(r.disposition, "skipped_dedupe_candidate");
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Dispositions NOT independently reachable through the real-server harness above, with why:
//
//   skipped_no_session ("!sess" guard, BEFORE the mint) fires only when state.session is null at
//   one of the four call sites. Under a real (or mock) Gemini Live connect, state.session becomes
//   non-null immediately after the post-connect hoist and stays non-null for the rest of the
//   connection's life in every scenario these tests can deterministically construct — driving it to
//   null again mid-test would mean tearing down the live session out from under the very call sites
//   being exercised. Its CONTRACT (inject_id recorded as null, source "none") is already verified by
//   Phase A's store round-trip: tests/test_context_telemetry_store.ts, "recordContextInjection
//   accepts a skipped event with inject_id=null (pre-mint disposition)". Its DISPOSITION-MAPPING
//   correctness (the literal string used in src/voice/index.ts is a valid ContextInjectionDisposition
//   member) is enforced statically by `npm run lint` (tsc --noEmit) — the field is a strict literal
//   union, so a typo there would fail the type check, not just this test file.
//
//   skipped_empty_brief (brief.text.trim() === "") is, by construction of src/memory/assembler.ts's
//   frameBlock (spec-verified: "FRAME <role> | gates: <posture>" is unconditional and the role string
//   is a non-empty literal), NEVER actually empty from the real fallback assembler at ANY budget —
//   even a zero-width budget renders a single-character "…" via `cap()`'s truncation, which is still
//   truthy after .trim(). This is a defensive guard for a hypothetical degenerate Python/cortex-primary
//   brief (source "python"/"cortex-primary") that legitimately renders empty text; reaching it would
//   require faking memory.service.synthesizeAsync's return value directly, which requires bypassing
//   the real server's memory subsystem wiring (no test seam for it exists, deliberately — the seam
//   surface for this suite is scoped to what src/voice/index.ts's instrumentation needed reviewed).
//   Same static-mapping guarantee as above applies (npm run lint).
// ═════════════════════════════════════════════════════════════════════════════════════════════
